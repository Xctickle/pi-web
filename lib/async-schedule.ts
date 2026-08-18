/**
 * Pure schedule-spec helpers shared between the async-task API (server) and
 * the kanban UI (client). Zero Node.js built-in imports so this module is
 * safe to bundle into client components.
 */

/** Structured, UI-editable form of a task's cron schedule. */
export interface ScheduleSpec {
  mode: "daily" | "weekly" | "monthly";
  /** "HH:MM" entries (normalized, deduplicated). At least one. */
  times: string[];
  /** 0=Sunday .. 6=Saturday. Weekly mode only. */
  weekdays: number[];
  /** 1..31. Monthly mode only. */
  dayOfMonth: number;
  /** Prepend an "rm -f .done-<name>" line a few minutes before the first run. */
  autoClear: boolean;
}

export function isValidTaskName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length > 0 && name.length <= 64;
}

export function isValidTime(time: string): boolean {
  return /^([01]?\d|2[0-3]):([0-5]\d)$/.test(time);
}

/** Normalize "9:5" → "09:05". Returns null for invalid input. */
export function normalizeTime(time: string): string | null {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(time.trim());
  if (!match) return null;
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Sort "HH:MM" strings chronologically. */
function timeSortValue(time: string): number {
  const [hour, minute] = time.split(":").map((part) => Number.parseInt(part, 10));
  return hour * 60 + minute;
}

/** Validate a spec; returns a message key suffix ("time" / "weekday") or null. */
export function scheduleSpecProblem(spec: ScheduleSpec): "time" | "weekday" | null {
  const times = spec.times.filter((time) => isValidTime(time));
  if (!times.length) return "time";
  if (spec.mode === "weekly" && (!spec.weekdays.length || spec.weekdays.some((day) => day < 0 || day > 6))) return "weekday";
  if (spec.mode === "monthly" && (!(spec.dayOfMonth >= 1 && spec.dayOfMonth <= 31))) return "time";
  return null;
}

function shiftEarlier(time: string, minutes: number): { hour: number; minute: number } {
  const value = Math.max(0, timeSortValue(time) - minutes);
  return { hour: Math.floor(value / 60), minute: value % 60 };
}

/** Build the crontab command lines for a task's schedule (no comment header). */
export function buildCronLines(opts: { name: string; spec: ScheduleSpec; wrapperPath: string; tasksDir: string }): string[] {
  const { name, spec, wrapperPath, tasksDir } = opts;
  const times = [...new Set(spec.times.filter(isValidTime))].sort((a, b) => timeSortValue(a) - timeSortValue(b));
  if (!times.length) return [];
  const domField = spec.mode === "monthly" ? String(spec.dayOfMonth) : "*";
  const dowField = spec.mode === "weekly" ? [...new Set(spec.weekdays)].sort((a, b) => a - b).join(",") : "*";
  const lines: string[] = [];
  if (spec.autoClear) {
    const { hour, minute } = shiftEarlier(times[0], 5);
    lines.push(`${minute} ${hour} ${domField} * ${dowField} rm -f ${tasksDir}/.done-${name}`);
  }
  for (const time of times) {
    const [hour, minute] = time.split(":").map((part) => Number.parseInt(part, 10));
    lines.push(`${minute} ${hour} ${domField} * ${dowField} ${wrapperPath} ${name}`);
  }
  return lines;
}

function expandList(field: string, min: number, max: number): number[] | null {
  const values: number[] = [];
  for (const part of field.split(",")) {
    const single = /^(\d+)$/.exec(part);
    if (!single) return null;
    const value = Number.parseInt(single[1], 10);
    if (value < min || value > max) return null;
    values.push(value);
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Best-effort reverse mapping from an existing cron expression back into a
 * ScheduleSpec. Returns null when the expression is beyond the structured
 * form (steps, ranges, month filters, multiple minutes).
 */
export function parseScheduleSpec(expression: string | null | undefined, autoClear: boolean): ScheduleSpec | null {
  if (!expression) return null;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField, hourField, domField, monthField, dowField] = fields;
  if (monthField !== "*") return null;
  const minutes = expandList(minuteField, 0, 59);
  const hours = expandList(hourField, 0, 23);
  if (!minutes || !hours || minutes.length !== 1) return null;
  const times = hours.map((hour) => `${String(hour).padStart(2, "0")}:${String(minutes[0]).padStart(2, "0")}`);
  const base = { times, autoClear, weekdays: [1], dayOfMonth: 1 };
  if (domField === "*" && dowField === "*") return { ...base, mode: "daily" };
  if (domField === "*" && dowField !== "*") {
    const days = expandList(dowField, 0, 7);
    if (!days) return null;
    const weekdays = days.map((day) => (day === 7 ? 0 : day));
    return { ...base, mode: "weekly", weekdays };
  }
  if (dowField === "*" && domField !== "*") {
    const days = expandList(domField, 1, 31);
    if (!days || days.length !== 1) return null;
    return { ...base, mode: "monthly", dayOfMonth: days[0] };
  }
  return null;
}
