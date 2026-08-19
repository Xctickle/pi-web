import { execFile, spawn } from "child_process";
import { closeSync, openSync, promises as fs } from "fs";
import os from "os";
import path from "path";
import { BACKUP_DIR, BACKUP_SCRIPT, parseBackupFilename } from "./backup-status";

/**
 * Backup mutation layer (server only): manual trigger, checksum verification
 * and download-name validation. The spawn mirrors the crontab behaviour
 * (`~/bin/pi-backup.sh >> ~/.pi/backup.log 2>&1`); nothing here rewrites or
 * deletes archives — the backup script itself stays the only writer of
 * ~/kb/pi-backups.
 */

export class BackupMutationError extends Error {}

/** Where pi-backup.sh output is appended, matching the existing crontab entry. */
const BACKUP_LOG = path.join(os.homedir(), ".pi", "backup.log");

const execFileAsync = (file: string, args: string[], options?: { cwd?: string; timeout?: number }) =>
  new Promise<string>((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || stdout.trim() || error.message));
      else resolve(stdout);
    });
  });

export interface VerifyInfo {
  /** ISO timestamp of the verification run. */
  at: string;
  ok: boolean;
  error: string | null;
}

/** In-memory result of the last verify-latest run; lost on restart (accepted). */
let lastVerify: VerifyInfo | null = null;

export function getLatestVerify(): VerifyInfo | null {
  return lastVerify;
}

/**
 * True when a pi-backup.sh process is already running (best effort: when
 * pgrep itself is unavailable we optimistically report "not running").
 */
export async function isBackupRunning(): Promise<boolean> {
  try {
    await execFileAsync("pgrep", ["-f", "pi-backup.sh"]);
    return true;
  } catch {
    return false; // pgrep exits 1 when nothing matches; other failures also fall through
  }
}

/** Trigger one backup run now, detached from the HTTP request. */
export async function runBackup(): Promise<void> {
  if (await isBackupRunning()) throw new BackupMutationError("already running");
  try {
    await fs.access(BACKUP_SCRIPT);
  } catch {
    throw new BackupMutationError(`backup script missing: ${BACKUP_SCRIPT}`);
  }
  await fs.mkdir(path.dirname(BACKUP_LOG), { recursive: true });
  const logFd = openSync(BACKUP_LOG, "a");
  try {
    const child = spawn(BACKUP_SCRIPT, [], { detached: true, stdio: ["ignore", logFd, logFd] });
    child.unref();
  } finally {
    closeSync(logFd); // the child keeps its own duplicated descriptors
  }
}

/**
 * Verify the newest on-disk archive with `sha256sum -c` against its .sha256
 * sidecar (executed inside the backup directory, matching the script's own
 * semantics). The result is cached in memory and surfaced via GET.
 */
export async function verifyLatestArchive(): Promise<VerifyInfo> {
  const names = await fs.readdir(BACKUP_DIR).catch((error: NodeJS.ErrnoException) => {
    throw new BackupMutationError(`backup directory unreadable: ${BACKUP_DIR} (${error.code ?? error.message})`);
  });
  let latest: string | null = null;
  let latestTimestamp = "";
  for (const name of names) {
    const parsed = parseBackupFilename(name);
    if (parsed && parsed.timestamp > latestTimestamp) {
      latestTimestamp = parsed.timestamp;
      latest = name;
    }
  }
  if (latest === null) throw new BackupMutationError("no archives to verify");
  const sidecar = `${latest}.sha256`;
  try {
    await fs.access(path.join(BACKUP_DIR, sidecar));
  } catch {
    lastVerify = { at: new Date().toISOString(), ok: false, error: `missing sidecar: ${sidecar}` };
    return lastVerify;
  }
  try {
    await execFileAsync("sha256sum", ["-c", sidecar], { cwd: BACKUP_DIR, timeout: 120_000 });
    lastVerify = { at: new Date().toISOString(), ok: true, error: null };
  } catch (error) {
    lastVerify = { at: new Date().toISOString(), ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return lastVerify;
}

/**
 * Validate a download request: the name must be a plain archive file name —
 * no path separators, no `..`, and it must match the archive pattern — then
 * resolve it strictly inside BACKUP_DIR. Returns null for anything else.
 */
export function resolveArchivePath(name: string): string | null {
  if (!name || name.includes("/") || name.includes("\\") || name !== path.basename(name)) return null;
  if (!parseBackupFilename(name)) return null;
  return path.join(BACKUP_DIR, name);
}
