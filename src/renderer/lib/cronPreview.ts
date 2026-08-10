// Pure cron-preview helper.
//
// Computes the next matching instant for the 5-field cron expressions that
// ScheduleDialog can produce. Returns null when the expression cannot be
// parsed rather than returning a wrong date.
//
// Supported field syntax (subset sufficient for the picker):
//   *          — every value
//   <number>   — exact value
//   * /N       — step from 0 (e.g. every N minutes/hours; no space in real expr)
//
// Fields (positions 0-4): minute  hour  day-of-month  month  day-of-week
// Day-of-week: 0=Sunday … 6=Saturday (0 and 7 both mean Sunday in standard
// cron, but the picker only emits 0-6).

export interface CronFields {
  minute: string;
  hour: string;
  dom: string;
  month: string;
  dow: string;
}

/** Parse a 5-field cron string into its five field strings, or null. */
export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  if (!minute || !hour || !dom || !month || !dow) return null;
  return { minute, hour, dom, month, dow };
}

/**
 * Resolve a single cron field against a concrete value.
 * Returns true when the concrete value satisfies the field.
 */
function matches(field: string, value: number): boolean {
  if (field === "*") return true;
  if (/^\d+$/.test(field)) return Number(field) === value;
  const stepMatch = field.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = Number(stepMatch[1]);
    if (step < 1) return false;
    return value % step === 0;
  }
  return false;
}

/**
 * Find the next instant (as a Date) after `from` that satisfies `fields`.
 * Searches up to 2 years forward; returns null if nothing matches.
 */
export function nextRun(fields: CronFields, from: Date = new Date()): Date | null {
  // Validate each field is parseable; reject step-of-zero early.
  const allFields = [fields.minute, fields.hour, fields.dom, fields.month, fields.dow];
  for (const f of allFields) {
    if (!/^(\*|\d+|\*\/\d+)$/.test(f)) return null;
    const stepMatch = f.match(/^\*\/(\d+)$/);
    if (stepMatch && Number(stepMatch[1]) < 1) return null;
  }

  // Start searching from the next whole minute
  const start = new Date(from);
  start.setSeconds(0, 0);
  start.setTime(start.getTime() + 60_000); // advance by one minute

  const limit = new Date(start);
  limit.setFullYear(limit.getFullYear() + 2);

  const candidate = new Date(start);

  while (candidate < limit) {
    const mo = candidate.getMonth() + 1; // 1-12
    const dom = candidate.getDate(); // 1-31
    const dow = candidate.getDay(); // 0-6
    const hr = candidate.getHours();
    const min = candidate.getMinutes();

    if (!matches(fields.month, mo)) {
      // Jump to 1st of next month
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    if (!matches(fields.dom, dom) || !matches(fields.dow, dow)) {
      // Jump to next day
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    if (!matches(fields.hour, hr)) {
      // Jump to next hour
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }

    if (!matches(fields.minute, min)) {
      candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
      continue;
    }

    return new Date(candidate);
  }

  return null;
}

/**
 * Given a raw 5-field cron string, return a human-readable "Next run" string
 * in the user's local timezone, or "—" if the expression cannot be parsed or
 * no matching time is found within 2 years.
 */
export function nextRunPreview(expr: string, from: Date = new Date()): string {
  const fields = parseCron(expr);
  if (!fields) return "—";
  const next = nextRun(fields, from);
  if (!next) return "—";
  return next.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Build a 5-field cron string from friendly picker state.
 */
export type CadenceKind =
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "custom";

export interface CadenceState {
  kind: CadenceKind;
  /** Hour 0-23, used by daily / weekdays / weekly */
  hour: number;
  /** Minute 0-59, used by daily / weekdays / weekly */
  minute: number;
  /** 0=Sunday … 6=Saturday, used by weekly */
  dayOfWeek: number;
  /** Raw cron string when kind === "custom" */
  customCron: string;
}

export function buildCron(c: CadenceState): string {
  switch (c.kind) {
    case "hourly":
      return "0 * * * *";
    case "daily":
      return `${c.minute} ${c.hour} * * *`;
    case "weekdays":
      return `${c.minute} ${c.hour} * * 1-5`;
    case "weekly":
      return `${c.minute} ${c.hour} * * ${c.dayOfWeek}`;
    case "custom":
      return c.customCron;
  }
}
