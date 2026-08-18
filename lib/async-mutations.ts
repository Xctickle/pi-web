import { execFile, spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { ASYNC_TASKS_DIR, ASYNC_TASK_WRAPPER } from "./async-status";
import { buildCronLines, isValidTaskName, scheduleSpecProblem } from "./async-schedule";
import type { ScheduleSpec } from "./async-schedule";

const execFileAsync = (file: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });

/**
 * Async-task mutation layer (server only). Writes task briefs, done markers,
 * model overrides, and per-task crontab blocks. Crontab edits only touch the
 * lines that belong to one task (`async-task.sh <name>` / `rm -f .done-<name>`
 * plus comment blocks that mention the task name); everything else is carried
 * over verbatim. A timestamped crontab backup is kept next to the tasks dir
 * before every write.
 */

export class MutationError extends Error {}

function requireValidName(name: unknown): string {
  if (typeof name !== "string" || !isValidTaskName(name)) {
    throw new MutationError("invalid task name");
  }
  return name;
}

function requireValidSpec(spec: unknown): ScheduleSpec {
  if (typeof spec !== "object" || spec === null) throw new MutationError("invalid schedule");
  if (scheduleSpecProblem(spec as ScheduleSpec)) throw new MutationError("invalid schedule");
  return spec as ScheduleSpec;
}

async function readCrontab(): Promise<string> {
  return execFileAsync("crontab", ["-l"]);
}

async function writeCrontab(text: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backupPath = path.join(ASYNC_TASKS_DIR, `crontab.backup-${stamp}`);
  try {
    const previous = await readCrontab();
    await fs.mkdir(ASYNC_TASKS_DIR, { recursive: true });
    await fs.writeFile(backupPath, previous, "utf8");
  } catch {
    // No readable crontab yet — nothing to back up.
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("crontab", ["-"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr || `crontab exited ${code}`))));
    child.stdin?.write(text);
    child.stdin?.end();
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when a crontab line is a run/clear command belonging to the task. */
function isTaskCommandLine(line: string, name: string): boolean {
  const runMatch = new RegExp(`async-task\\.sh\\s+${escapeRegExp(name)}\\b`).test(line);
  const clearMatch = new RegExp(`rm\\s+-f\\s+\\S*\\.done-${escapeRegExp(name)}\\b`).test(line);
  return runMatch || clearMatch;
}

/**
 * Remove the task's crontab lines. A directly-preceding comment block is
 * treated as the task's own header (it is reattached to the rewritten block,
 * so no information is lost). Returns the rewritten text plus the captured
 * comment text (null when none).
 */
export function removeTaskFromCrontab(text: string, name: string): { text: string; comment: string | null } {
  const lines = text.split("\n");
  const drop = new Set<number>();
  let comment: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!isTaskCommandLine(lines[i].trim(), name)) continue;
    drop.add(i);
    const block: number[] = [];
    for (let j = i - 1; j >= 0 && lines[j].trim().startsWith("#"); j--) block.push(j);
    if (block.length) {
      if (comment === null) {
        comment = block
          .slice()
          .reverse()
          .map((idx) => lines[idx].trim().replace(/^#\s?/, ""))
          .join("\n");
      }
      block.forEach((idx) => drop.add(idx));
    }
  }
  if (!drop.size) return { text, comment: null };
  const kept = lines.filter((_, idx) => !drop.has(idx));
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  const next = kept.join("\n").replace(/\n{3,}/g, "\n\n");
  return { text: next.endsWith("\n") ? next : `${next}\n`, comment };
}

async function unlinkIfPresent(file: string): Promise<void> {
  await fs.unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

/** Create or overwrite a task brief. */
export async function saveTaskBrief(name: string, content: string): Promise<void> {
  requireValidName(name);
  if (typeof content !== "string" || content.length > 128 * 1024) throw new MutationError("invalid brief content");
  await fs.mkdir(ASYNC_TASKS_DIR, { recursive: true });
  await fs.writeFile(path.join(ASYNC_TASKS_DIR, `${name}.md`), content, "utf8");
}

/** Write or remove the done marker. */
export async function setDoneMarker(name: string, done: boolean, summary?: string): Promise<void> {
  requireValidName(name);
  const markerPath = path.join(ASYNC_TASKS_DIR, `.done-${name}`);
  if (!done) {
    await unlinkIfPresent(markerPath);
    return;
  }
  const line = `${new Date().toISOString()} ${typeof summary === "string" && summary.trim() ? summary.trim() : "手动标记( pi-web )"}`;
  await fs.mkdir(ASYNC_TASKS_DIR, { recursive: true });
  await fs.writeFile(markerPath, line, "utf8");
}

/** Write or remove the per-task model override (`<name>.model`). */
export async function saveModelOverride(name: string, model: string | null): Promise<void> {
  requireValidName(name);
  const modelPath = path.join(ASYNC_TASKS_DIR, `${name}.model`);
  if (model === null || model.trim() === "") {
    await unlinkIfPresent(modelPath);
    return;
  }
  const trimmed = model.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:+-]*$/.test(trimmed)) throw new MutationError("invalid model id");
  await fs.writeFile(modelPath, `${trimmed}\n`, "utf8");
}

/** Replace the task's crontab block with the given spec (or clear it when spec is null). */
export async function saveTaskSchedule(name: string, spec: ScheduleSpec | null): Promise<void> {
  requireValidName(name);
  if (spec) requireValidSpec(spec);
  const text = await readCrontab();
  const { text: stripped, comment } = removeTaskFromCrontab(text, name);
  if (!spec) {
    if (stripped !== text) await writeCrontab(stripped);
    return;
  }
  const lines = buildCronLines({ name, spec, wrapperPath: ASYNC_TASK_WRAPPER, tasksDir: ASYNC_TASKS_DIR });
  if (!lines.length) throw new MutationError("empty schedule");
  const header = comment ?? `${name} (managed by pi-web)`;
  const base = stripped.replace(/\s+$/, "");
  const next = `${base ? `${base}\n\n` : ""}# ${header}\n${lines.join("\n")}\n`;
  await writeCrontab(next);
}

/** Trigger the wrapper immediately, detached from the HTTP request. */
export async function runTaskNow(name: string): Promise<void> {
  requireValidName(name);
  try {
    await fs.access(ASYNC_TASK_WRAPPER);
  } catch {
    throw new MutationError(`wrapper missing: ${ASYNC_TASK_WRAPPER}`);
  }
  try {
    await fs.access(path.join(ASYNC_TASKS_DIR, `${name}.md`));
  } catch {
    throw new MutationError(`brief missing: ${name}.md`);
  }
  const child = spawn(ASYNC_TASK_WRAPPER, [name], { detached: true, stdio: "ignore", cwd: ASYNC_TASKS_DIR });
  child.unref();
}

/** Remove failed logs for a task. */
export async function clearFailedLogs(name: string): Promise<void> {
  requireValidName(name);
  const entries = await fs.readdir(ASYNC_TASKS_DIR).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(`failed-${name}-`) && entry.endsWith(".log"))
      .map((entry) => unlinkIfPresent(path.join(ASYNC_TASKS_DIR, entry))),
  );
}

/** Delete a task entirely: crontab lines, brief, markers, model override, logs. */
export async function deleteTask(name: string): Promise<void> {
  requireValidName(name);
  await saveTaskSchedule(name, null);
  await Promise.all([
    unlinkIfPresent(path.join(ASYNC_TASKS_DIR, `${name}.md`)),
    unlinkIfPresent(path.join(ASYNC_TASKS_DIR, `.done-${name}`)),
    unlinkIfPresent(path.join(ASYNC_TASKS_DIR, `${name}.model`)),
    unlinkIfPresent(path.join(ASYNC_TASKS_DIR, `run-${name}.log`)),
  ]);
  await clearFailedLogs(name);
}
