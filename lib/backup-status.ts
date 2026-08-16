import { promises as fs } from "fs";
import os from "os";
import path from "path";

/**
 * Backup chain visualization data layer (read-only).
 *
 * Reads the personal encrypted backup directory:
 *   <dir>/pi-backup-<host>-<YYYYMMDD>T<HHMMSS>Z.tar.gz.gpg   encrypted archive
 *   <dir>/<archive>.sha256                                     checksum sidecar
 * and the backup script header comments for a scope summary.
 *
 * V1 checks sidecar presence only; it never executes sha256sum and never
 * touches remote replicas.
 */

export const BACKUP_DIR = path.join(os.homedir(), "kb", "pi-backups");
export const BACKUP_SCRIPT = path.join(os.homedir(), "bin", "pi-backup.sh");

/** RPO target: a fresh archive is expected at least every N hours. */
export const RPO_TARGET_HOURS = 24;

const ARCHIVE_PATTERN = /^pi-backup-(.+)-(\d{8}T\d{6}Z)\.tar\.gz\.gpg$/;

export interface BackupArchive {
  file: string;
  host: string;
  /** Normalized UTC ISO timestamp. */
  timestamp: string;
  sizeBytes: number;
  hasSha256Sidecar: boolean;
}

export interface BackupStatus {
  dir: string;
  dirExists: boolean;
  /** Newest first. */
  archives: BackupArchive[];
  latest: BackupArchive | null;
  /** Hours since the newest archive; null when there are no archives. */
  latestAgeHours: number | null;
  totalSizeBytes: number;
  scriptPath: string;
  scriptExists: boolean;
  /** Leading `#` comment lines of the backup script, when present. */
  scriptSummary: string | null;
  rpoTargetHours: number;
}

/** Convert a YYYYMMDDTHHMMSS token into an ISO timestamp (no milliseconds); null when invalid. */
export function parseArchiveTimestamp(token: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(token);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(Date.UTC(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    Number.parseInt(hour, 10),
    Number.parseInt(minute, 10),
    Number.parseInt(second, 10),
  ));
  // Reject calendar-overflow inputs (e.g. Feb 30) that Date rolls over.
  const pad = (value: string) => value.padStart(2, "0");
  const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}Z`;
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== iso.slice(0, 19)) return null;
  return iso;
}

/** Match an encrypted archive file name (sidecars and other files return null). */
export function parseBackupFilename(name: string): { host: string; timestamp: string } | null {
  const match = ARCHIVE_PATTERN.exec(name);
  if (!match) return null;
  const timestamp = parseArchiveTimestamp(match[2]);
  if (!timestamp) return null;
  return { host: match[1], timestamp };
}

/** The expected checksum sidecar name for an archive. */
export function expectedSidecarName(archiveFile: string): string {
  return `${archiveFile}.sha256`;
}

/**
 * Extract a scope summary from a shell script: the leading comment block
 * when present, otherwise the first standalone comment lines found anywhere
 * (scripts commonly document phases inline rather than in a header).
 */
export function extractScriptSummary(content: string, maxLines = 20): string | null {
  const allLines = content.split("\n");
  const leading: string[] = [];
  for (const rawLine of allLines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("#!")) continue; // shebang carries no scope information
    if (line.startsWith("#")) {
      const text = line.replace(/^#\s?/, "");
      if (text.trim()) leading.push(text.trim());
    } else if (line.trim() !== "") {
      break;
    }
    if (leading.length >= maxLines) break;
  }
  if (leading.length) return leading.slice(0, maxLines).join("\n");
  const inline: string[] = [];
  for (const rawLine of allLines) {
    const line = rawLine.trim();
    if (!line.startsWith("#") || line.startsWith("#!")) continue;
    const text = line.replace(/^#\s?/, "").trim();
    if (text) inline.push(text);
    if (inline.length >= maxLines) break;
  }
  return inline.length ? inline.join("\n") : null;
}

/** Collect backup chain status. Never mutates anything on disk. */
export async function collectBackupStatus(): Promise<BackupStatus> {
  const entries = await fs.readdir(BACKUP_DIR, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "EACCES") return null;
    throw error;
  });
  if (entries === null) {
    const scriptMissing = await readScriptSummary();
    return {
      dir: BACKUP_DIR,
      dirExists: false,
      archives: [],
      latest: null,
      latestAgeHours: null,
      totalSizeBytes: 0,
      scriptPath: BACKUP_SCRIPT,
      scriptExists: scriptMissing.exists,
      scriptSummary: scriptMissing.summary,
      rpoTargetHours: RPO_TARGET_HOURS,
    };
  }

  const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const archives: BackupArchive[] = [];
  for (const name of names) {
    const parsed = parseBackupFilename(name);
    if (!parsed) continue;
    let sizeBytes = 0;
    try {
      const stat = await fs.stat(path.join(BACKUP_DIR, name));
      sizeBytes = stat.size;
    } catch {
      sizeBytes = 0;
    }
    archives.push({
      file: name,
      host: parsed.host,
      timestamp: parsed.timestamp,
      sizeBytes,
      hasSha256Sidecar: names.has(expectedSidecarName(name)),
    });
  }
  archives.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const latest = archives[0] ?? null;
  let latestAgeHours: number | null = null;
  if (latest) {
    latestAgeHours = Math.max(0, (Date.now() - new Date(latest.timestamp).getTime()) / 3_600_000);
  }
  const totalSizeBytes = archives.reduce((sum, archive) => sum + archive.sizeBytes, 0);

  const script = await readScriptSummary();
  return {
    dir: BACKUP_DIR,
    dirExists: true,
    archives,
    latest,
    latestAgeHours,
    totalSizeBytes,
    scriptPath: BACKUP_SCRIPT,
    scriptExists: script.exists,
    scriptSummary: script.summary,
    rpoTargetHours: RPO_TARGET_HOURS,
  };
}

async function readScriptSummary(): Promise<{ exists: boolean; summary: string | null }> {
  try {
    const content = await fs.readFile(BACKUP_SCRIPT, "utf8");
    return { exists: true, summary: extractScriptSummary(content) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EISDIR") return { exists: false, summary: null };
    throw error;
  }
}
