import { promises as fs } from "fs";
import os from "os";
import path from "path";

/**
 * Backup chain data layer (read-only).
 *
 * Reads the personal encrypted backup directory:
 *   <dir>/pi-backup-<host>-<YYYYMMDDTHHMMSS>Z.tar.gz.gpg   encrypted archive
 *   <dir>/<archive>.sha256                                  checksum sidecar
 *   <dir>/index.log                                         append-only history
 * and the backup script header comments for a scope summary.
 *
 * V2 merges the on-disk archives with the full index.log history (rotated
 * archives reappear as `rotated` entries with the human size as logged), and
 * aggregates the last 14 local days for the continuity strip. It still never
 * executes anything and never touches remote replicas from here.
 */

export const BACKUP_DIR = path.join(os.homedir(), "kb", "pi-backups");
export const BACKUP_SCRIPT = path.join(os.homedir(), "bin", "pi-backup.sh");

/** RPO target: a fresh archive is expected at least every N hours. */
export const RPO_TARGET_HOURS = 24;

/** Days shown in the continuity heat strip. */
export const CONTINUITY_DAYS = 14;

const ARCHIVE_PATTERN = /^pi-backup-(.+)-(\d{8}T\d{6}Z)\.tar\.gz\.gpg$/;

export interface BackupArchive {
  file: string;
  host: string;
  /** Normalized UTC ISO timestamp. */
  timestamp: string;
  sizeBytes: number;
  hasSha256Sidecar: boolean;
  /** True when the archive was rotated off disk and only index.log remembers it. */
  rotated: boolean;
}

export interface BackupDayBucket {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  count: number;
  /** Local HH:MM of the newest backup that day; null when the day has none. */
  latestTime: string | null;
}

export interface BackupStatus {
  dir: string;
  dirExists: boolean;
  /** Newest first, on-disk archives merged with index.log history. */
  archives: BackupArchive[];
  latest: BackupArchive | null;
  /** Hours since the newest archive; null when there are no archives. */
  latestAgeHours: number | null;
  /** Sum of on-disk archive sizes (rotated history excluded). */
  totalSizeBytes: number;
  scriptPath: string;
  scriptExists: boolean;
  /** Leading `#` comment lines of the backup script, when present. */
  scriptSummary: string | null;
  rpoTargetHours: number;
  /** Last CONTINUITY_DAYS local days, oldest → newest. */
  continuity: BackupDayBucket[];
  /** Server-local calendar day (YYYY-MM-DD) the continuity strip ends on. */
  today: string;
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

/** Parse a `du -h` style size ("3.4M", "12M", "500K", "1.2G") into bytes; 0 when unparseable. */
export function parseHumanSize(text: string): number {
  const match = /^\s*([\d.]+)\s*([KMG]?)B?\s*$/i.exec(text);
  if (!match) return 0;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value < 0) return 0;
  const unit = match[2].toUpperCase();
  const factor = unit === "G" ? 1024 ** 3 : unit === "M" ? 1024 ** 2 : unit === "K" ? 1024 : 1;
  return Math.round(value * factor);
}

export interface IndexLogEntry {
  file: string;
  host: string;
  /** UTC ISO timestamp parsed from the archive name. */
  timestamp: string;
  /** Log line timestamp (local time with offset), normalized to ISO. */
  loggedAt: string;
  /** Raw human size as logged ("12M"). */
  sizeText: string;
  sizeBytes: number;
}

/**
 * Parse index.log lines of the form `<ISO>\t<du-size>\t<absolute-path>`.
 * Malformed lines (wrong field count, unparsable date, non-archive path)
 * are skipped, mirroring the append-only log written by pi-backup.sh.
 */
export function parseIndexLog(text: string): IndexLogEntry[] {
  const entries: IndexLogEntry[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length !== 3) continue;
    const [loggedAtText, sizeText, absPath] = parts;
    if (!sizeText || !absPath.includes("/")) continue;
    const loggedAt = new Date(loggedAtText);
    if (Number.isNaN(loggedAt.getTime())) continue;
    const file = absPath.slice(absPath.lastIndexOf("/") + 1);
    const parsed = parseBackupFilename(file);
    if (!parsed) continue;
    entries.push({
      file,
      host: parsed.host,
      timestamp: parsed.timestamp,
      loggedAt: loggedAt.toISOString(),
      sizeText,
      sizeBytes: parseHumanSize(sizeText),
    });
  }
  return entries;
}

/**
 * Merge on-disk archives with index.log history, keyed by archive name.
 * Disk wins on collisions (real size, sidecar presence); log-only entries
 * come back flagged `rotated`. Result is newest first.
 */
export function mergeBackupArchives(disk: BackupArchive[], log: IndexLogEntry[]): BackupArchive[] {
  const byFile = new Map<string, BackupArchive>();
  for (const entry of log) {
    byFile.set(entry.file, {
      file: entry.file,
      host: entry.host,
      timestamp: entry.timestamp,
      sizeBytes: entry.sizeBytes,
      hasSha256Sidecar: false,
      rotated: true,
    });
  }
  for (const archive of disk) byFile.set(archive.file, archive);
  return [...byFile.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** Local calendar day key (YYYY-MM-DD) of a Date. */
function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Aggregate archive timestamps into the last `days` local calendar days,
 * oldest → newest. Empty days are included with count 0 so the caller can
 * paint them red; the caller decides which empty day is "today, not yet due".
 */
export function aggregateBackupDays(
  archives: ReadonlyArray<Pick<BackupArchive, "timestamp">>,
  now: Date,
  days = CONTINUITY_DAYS,
): BackupDayBucket[] {
  const byDay = new Map<string, { count: number; latest: string }>();
  for (const archive of archives) {
    const when = new Date(archive.timestamp);
    if (Number.isNaN(when.getTime())) continue;
    const key = localDayKey(when);
    const bucket = byDay.get(key);
    if (bucket) {
      bucket.count += 1;
      if (archive.timestamp > bucket.latest) bucket.latest = archive.timestamp;
    } else {
      byDay.set(key, { count: 1, latest: archive.timestamp });
    }
  }
  const buckets: BackupDayBucket[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const key = localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset));
    const bucket = byDay.get(key);
    if (bucket) {
      const latest = new Date(bucket.latest);
      buckets.push({ date: key, count: bucket.count, latestTime: `${pad2(latest.getHours())}:${pad2(latest.getMinutes())}` });
    } else {
      buckets.push({ date: key, count: 0, latestTime: null });
    }
  }
  return buckets;
}

/** Collect backup chain status. Never mutates anything on disk. */
export async function collectBackupStatus(): Promise<BackupStatus> {
  const now = new Date();
  const script = await readScriptSummary();
  const entries = await fs.readdir(BACKUP_DIR, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "EACCES") return null;
    throw error;
  });
  if (entries === null) {
    return {
      dir: BACKUP_DIR,
      dirExists: false,
      archives: [],
      latest: null,
      latestAgeHours: null,
      totalSizeBytes: 0,
      scriptPath: BACKUP_SCRIPT,
      scriptExists: script.exists,
      scriptSummary: script.summary,
      rpoTargetHours: RPO_TARGET_HOURS,
      continuity: [],
      today: localDayKey(now),
    };
  }

  const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const onDisk: BackupArchive[] = [];
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
    onDisk.push({
      file: name,
      host: parsed.host,
      timestamp: parsed.timestamp,
      sizeBytes,
      hasSha256Sidecar: names.has(expectedSidecarName(name)),
      rotated: false,
    });
  }

  const logEntries = await readIndexLogEntries();
  const archives = mergeBackupArchives(onDisk, logEntries);

  const latest = archives[0] ?? null;
  let latestAgeHours: number | null = null;
  if (latest) {
    latestAgeHours = Math.max(0, (Date.now() - new Date(latest.timestamp).getTime()) / 3_600_000);
  }
  const totalSizeBytes = onDisk.reduce((sum, archive) => sum + archive.sizeBytes, 0);

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
    continuity: aggregateBackupDays(archives, now),
    today: localDayKey(now),
  };
}

async function readIndexLogEntries(): Promise<IndexLogEntry[]> {
  const text = await fs.readFile(path.join(BACKUP_DIR, "index.log"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EISDIR") return null;
    throw error;
  });
  return text === null ? [] : parseIndexLog(text);
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
