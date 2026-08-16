import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Async-task visualization data layer (read-only).
 *
 * Reads the personal async task infrastructure conventions:
 *   <dir>/<name>.md                  task brief (kebab-case name)
 *   <dir>/.done-<name>               done marker: "<ISO time> <one-line summary>"
 *   <dir>/run-<name>.log             run log, segments separated by
 *                                    "=== <ISO time> run ===" and closed by "=== exit=N ==="
 *   <dir>/failed-<name>-<YYYYMMDD>.log  failure log
 *   <dir>/.keep-awake                night keep-awake switch (missing=off, empty=always, date=until)
 *   <dir>/night-shutdown.log         night guard log
 *   crontab entries mentioning async-task.sh provide the schedule.
 *
 * Never writes or deletes anything under the task directory.
 */

export const ASYNC_TASKS_DIR = path.join(os.homedir(), ".pi", "async-tasks");
export const ASYNC_TASK_WRAPPER = path.join(os.homedir(), "bin", "async-task.sh");

const RUN_SEGMENT_SEPARATOR = /^===\s+(\S+)\s+run\s+===$/;
const RUN_EXIT_LINE = /^===\s+exit=(\d+)\s+===$/;
const FAILED_LOG_PATTERN = /^failed-(.+)-(\d{8})\.log$/;
const BRIEF_FILE_PATTERN = /^[a-z0-9][a-z0-9-]*\.md$/;

/** How many tail lines of each run segment / night log to expose. */
export const TAIL_LINES = 15;

export interface CronTaskRef {
  /** The raw crontab line. */
  rawLine: string;
  /** The five cron time fields, e.g. "10 9,11,14 * * 1". */
  expression: string;
  /** The command part of the line. */
  command: string;
  /** Task name extracted from "async-task.sh <name>", null when absent. */
  taskName: string | null;
  /** Preceding comment lines (joined), when any. */
  comment: string | null;
}

/** Structured view of a cron time expression (best effort). */
export interface CronDescriptor {
  minutes: number[];
  hours: number[];
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

export interface RunSegment {
  /** ISO timestamp as written into the log header. */
  startedAt: string;
  /** Exit code when the segment was closed with "=== exit=N ===", null otherwise. */
  exitCode: number | null;
  /** Tail of the segment body. */
  tail: string[];
}

export interface FailedLogRef {
  file: string;
  /** Date suffix YYYYMMDD parsed from the file name, null when unparseable. */
  date: string | null;
}

export interface DoneMarkerInfo {
  exists: boolean;
  /** Timestamp token (first whitespace-separated token) when parseable. */
  timestamp: string | null;
  /** Everything after the timestamp token. */
  summary: string | null;
  /** Raw marker content. */
  content: string | null;
}

export interface AsyncTaskReport {
  name: string;
  briefExists: boolean;
  briefContent: string | null;
  doneMarker: DoneMarkerInfo;
  lastRun: RunSegment | null;
  failedLogs: FailedLogRef[];
  cron: CronTaskRef | null;
}

export type KeepAwakeMode = "off" | "always" | "until";

export interface KeepAwakeState {
  exists: boolean;
  mode: KeepAwakeMode;
  /** Date written into the switch file for "until" mode. */
  until: string | null;
}

export interface AsyncStatus {
  dir: string;
  wrapperPath: string;
  wrapperExists: boolean;
  tasks: AsyncTaskReport[];
  keepAwake: KeepAwakeState;
  nightLogExists: boolean;
  nightLogTail: string[];
  /** false when `crontab -l` could not be executed. */
  cronAvailable: boolean;
  cronError: string | null;
}

/** True when a directory entry looks like a task brief (kebab-case name). */
export function isTaskBriefFile(name: string): boolean {
  return BRIEF_FILE_PATTERN.test(name);
}

/** Parse a failed log file name into its task name and date. */
export function parseFailedLogName(name: string): { taskName: string; date: string } | null {
  const match = FAILED_LOG_PATTERN.exec(name);
  if (!match) return null;
  return { taskName: match[1], date: match[2] };
}

/**
 * Split a run log into segments. Seggments without a closing exit line
 * (e.g. the wrapper died) still surface with exitCode null.
 */
export function parseRunLog(content: string, tailLines = TAIL_LINES): RunSegment[] {
  const segments: RunSegment[] = [];
  let current: { startedAt: string; body: string[] } | null = null;
  for (const line of content.split("\n")) {
    const header = RUN_SEGMENT_SEPARATOR.exec(line.trim());
    if (header) {
      if (current) segments.push(finishSegment(current, tailLines));
      current = { startedAt: header[1], body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) segments.push(finishSegment(current, tailLines));
  return segments;
}

function finishSegment(segment: { startedAt: string; body: string[] }, tailLines: number): RunSegment {
  // Trim trailing blanks first so an exit marker padded by blank lines is
  // still recognized, then pop the marker and trim again.
  let body = trimTrailingBlanks(segment.body);
  let exitCode: number | null = null;
  const last = body.length ? body[body.length - 1].trim() : "";
  const exitMatch = RUN_EXIT_LINE.exec(last);
  if (exitMatch) {
    exitCode = Number.parseInt(exitMatch[1], 10);
    body = trimTrailingBlanks(body.slice(0, -1));
  }
  return { startedAt: segment.startedAt, exitCode, tail: body.slice(-tailLines) };
}

function trimTrailingBlanks(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length && copy[copy.length - 1].trim() === "") copy.pop();
  return copy;
}

/** Parse done marker content: "<ISO time> <summary...>". */
export function parseDoneMarker(content: string): { timestamp: string | null; summary: string | null } {
  const trimmed = content.trim();
  if (!trimmed) return { timestamp: null, summary: null };
  const match = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
  if (!match) return { timestamp: null, summary: null };
  return { timestamp: match[1], summary: match[2]?.trim() || null };
}

/** Derive the keep-awake state from the switch file's existence and content. */
export function keepAwakeFrom(exists: boolean, content: string): KeepAwakeState {
  if (!exists) return { exists: false, mode: "off", until: null };
  const trimmed = content.trim();
  if (!trimmed) return { exists: true, mode: "always", until: null };
  return { exists: true, mode: "until", until: trimmed };
}

/**
 * Extract crontab lines that mention async-task.sh. Preceding comment lines
 * are captured as context. Comment lines themselves never become entries.
 */
export function parseCrontab(text: string): CronTaskRef[] {
  const entries: CronTaskRef[] = [];
  let pendingComments: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      pendingComments = [];
      continue;
    }
    if (line.startsWith("#")) {
      pendingComments.push(line.replace(/^#\s?/, ""));
      continue;
    }
    if (line.includes("async-task.sh")) {
      const fields = line.split(/\s+/);
      if (fields.length >= 6) {
        const expression = fields.slice(0, 5).join(" ");
        const command = fields.slice(5).join(" ");
        const taskMatch = /async-task\.sh\s+(\S+)/.exec(command);
        entries.push({
          rawLine: line,
          expression,
          command,
          taskName: taskMatch ? taskMatch[1] : null,
          comment: pendingComments.length ? pendingComments.join("\n") : null,
        });
      }
    }
    pendingComments = [];
  }
  return entries;
}

/** Expand a comma / range / step minute-or-hour field into numbers, null when unsupported. */
function expandNumericField(field: string, min: number, max: number): number[] | null {
  if (field === "*") {
    const all: number[] = [];
    for (let i = min; i <= max; i++) all.push(i);
    return all;
  }
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = /^\*\/(\d+)$/.exec(part);
    const rangeMatch = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part);
    const singleMatch = /^(\d+)$/.exec(part);
    if (stepMatch) {
      const step = Number.parseInt(stepMatch[1], 10);
      if (step <= 0) return null;
      for (let i = min; i <= max; i += step) values.add(i);
    } else if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      const step = rangeMatch[3] ? Number.parseInt(rangeMatch[3], 10) : 1;
      if (start < min || end > max || start > end || step <= 0) return null;
      for (let i = start; i <= end; i += step) values.add(i);
    } else if (singleMatch) {
      const value = Number.parseInt(singleMatch[1], 10);
      if (value < min || value > max) return null;
      values.add(value);
    } else {
      return null;
    }
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * Structured interpretation of a five-field cron expression. Returns null when
 * the expression uses syntax beyond numbers, lists, ranges, and steps.
 */
export function describeCron(expression: string): CronDescriptor | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = expandNumericField(fields[0], 0, 59);
  const hours = expandNumericField(fields[1], 0, 23);
  if (!minutes || !hours) return null;
  for (const field of fields.slice(2)) {
    if (!/^(\*|\d+(-\d+)?(\/\d+)?)(,(\*|\d+(-\d+)?(\/\d+)?))*$/.test(field) && !/^\*\/\d+$/.test(field)) {
      return null;
    }
  }
  return {
    minutes,
    hours,
    dayOfMonth: fields[2],
    month: fields[3],
    dayOfWeek: fields[4],
  };
}

async function readTextIfPresent(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EISDIR") return null;
    throw error;
  }
}

/** Collect the full async task status. Never mutates anything on disk. */
export async function collectAsyncStatus(): Promise<AsyncStatus> {
  const dir = ASYNC_TASKS_DIR;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "EACCES") return [] as import("fs").Dirent[];
    throw error;
  });

  let crontabText = "";
  let cronAvailable = true;
  let cronError: string | null = null;
  try {
    const { stdout } = await execFileAsync("crontab", ["-l"]);
    crontabText = stdout;
  } catch (error) {
    cronAvailable = false;
    cronError = error instanceof Error ? error.message : String(error);
  }
  const cronEntries = cronAvailable ? parseCrontab(crontabText) : [];
  const cronByName = new Map<string, CronTaskRef>();
  const cronUnnamed: CronTaskRef[] = [];
  for (const entry of cronEntries) {
    if (entry.taskName) cronByName.set(entry.taskName, entry);
    else cronUnnamed.push(entry);
  }

  const briefNames = entries
    .filter((entry) => entry.isFile() && isTaskBriefFile(entry.name))
    .map((entry) => entry.name.replace(/\.md$/, ""))
    .sort();

  const failedLogsByTask = new Map<string, FailedLogRef[]>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parsed = parseFailedLogName(entry.name);
    if (!parsed) continue;
    const list = failedLogsByTask.get(parsed.taskName) ?? [];
    list.push({ file: entry.name, date: parsed.date });
    failedLogsByTask.set(parsed.taskName, list);
  }
  for (const list of failedLogsByTask.values()) list.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  const tasks: AsyncTaskReport[] = [];
  for (const name of briefNames) {
    const briefContent = await readTextIfPresent(path.join(dir, `${name}.md`));
    const doneContent = await readTextIfPresent(path.join(dir, `.done-${name}`));
    const doneInfo: DoneMarkerInfo = doneContent === null
      ? { exists: false, timestamp: null, summary: null, content: null }
      : { exists: true, content: doneContent, ...parseDoneMarker(doneContent) };
    const runContent = await readTextIfPresent(path.join(dir, `run-${name}.log`));
    const segments = runContent !== null ? parseRunLog(runContent) : [];
    tasks.push({
      name,
      briefExists: briefContent !== null,
      briefContent,
      doneMarker: doneInfo,
      lastRun: segments.length ? segments[segments.length - 1] : null,
      failedLogs: failedLogsByTask.get(name) ?? [],
      cron: cronByName.get(name) ?? null,
    });
  }

  // Orphan crontab entries (task name not present as a brief) still surface so
  // the schedule gap is visible instead of silently hidden.
  for (const entry of cronUnnamed) {
    tasks.push({
      name: entry.taskName ?? entry.rawLine,
      briefExists: false,
      briefContent: null,
      doneMarker: { exists: false, timestamp: null, summary: null, content: null },
      lastRun: null,
      failedLogs: failedLogsByTask.get(entry.rawLine) ?? [],
      cron: entry,
    });
  }

  const keepAwakePath = path.join(dir, ".keep-awake");
  // readFile returns null only when the switch is missing/unreadable; an empty
  // file reads back as "" (always mode).
  const keepAwakeContent = await readTextIfPresent(keepAwakePath);
  const keepAwake = keepAwakeFrom(keepAwakeContent !== null, keepAwakeContent ?? "");

  const nightLogPath = path.join(dir, "night-shutdown.log");
  const nightLog = await readTextIfPresent(nightLogPath);
  const nightLogTail = nightLog !== null ? trimTrailingBlanks(nightLog.split("\n")).slice(-TAIL_LINES) : [];

  let wrapperExists = false;
  try {
    await fs.access(ASYNC_TASK_WRAPPER);
    wrapperExists = true;
  } catch {
    wrapperExists = false;
  }

  return {
    dir,
    wrapperPath: ASYNC_TASK_WRAPPER,
    wrapperExists,
    tasks,
    keepAwake,
    nightLogExists: nightLog !== null,
    nightLogTail,
    cronAvailable,
    cronError,
  };
}
