/**
 * Pure cron-expression helpers with zero Node.js built-in imports so this
 * module is safe to bundle into client components. The data collector in
 * lib/async-status.ts re-exports these for server-side and test consumers.
 */

/** Structured interpretation of a five-field cron expression. */
export interface CronDescriptor {
  minutes: number[];
  hours: number[];
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
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
