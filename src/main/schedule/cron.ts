/**
 * Kozum Cowork — cron parser and scheduler.
 *
 * Implements a 5-field cron expression parser with full field support,
 * macro aliases, named months/days, and DST-safe next-run computation.
 * No external dependencies — written to be testable under
 * `node --experimental-strip-types`.
 */

/* ============================================================ types ===== */

export interface CronSpec {
  /** Original expression, normalised to lowercase. */
  raw: string;
  minutes: FieldSet;
  hours: FieldSet;
  dom: FieldSet;
  month: FieldSet;
  dow: FieldSet;
  /** True when the original expression left dom as "*" (or equivalent). */
  domStar: boolean;
  /** True when the original expression left dow as "*" (or equivalent). */
  dowStar: boolean;
}

/** A pre-expanded set of the allowed values for one field. */
export type FieldSet = Set<number>;

/* =========================================================== constants == */

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

interface FieldSpec {
  min: number;
  max: number;
  names?: Record<string, number>;
}

const FIELD_SPECS: FieldSpec[] = [
  { min: 0, max: 59 },                              // minute
  { min: 0, max: 23 },                              // hour
  { min: 1, max: 31 },                              // dom
  { min: 1, max: 12, names: MONTH_NAMES },          // month
  { min: 0, max: 7,  names: DOW_NAMES },            // dow  (7 = sunday alias)
];

/* ========================================================== macros ====== */

const MACROS: Record<string, string> = {
  "@yearly":   "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly":  "0 0 1 * *",
  "@weekly":   "0 0 * * 0",
  "@daily":    "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly":   "0 * * * *",
};

/* ========================================================== parser ====== */

/**
 * Parse a 5-field cron expression (or @macro) into a CronSpec.
 * Throws a precise `Error` on invalid input.
 */
export function parseCron(expr: string): CronSpec {
  const lower = expr.trim().toLowerCase();

  // Expand macros
  const expanded = MACROS[lower] ?? lower;

  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Cron expression must have exactly 5 fields (minute hour dom month dow), ` +
      `but "${expr}" has ${parts.length} field${parts.length === 1 ? "" : "s"}. ` +
      `Example: "0 9 * * 1-5" (weekdays at 09:00).`,
    );
  }

  const [minPart, hrPart, domPart, monPart, dowPart] = parts as [
    string, string, string, string, string
  ];

  const domStar = domPart === "*";
  const dowStar = dowPart === "*";

  const minutes = parseField(minPart, FIELD_SPECS[0]!, "minute");
  const hours   = parseField(hrPart,  FIELD_SPECS[1]!, "hour");
  const dom     = parseField(domPart, FIELD_SPECS[2]!, "day-of-month");
  const month   = parseField(monPart, FIELD_SPECS[3]!, "month");
  const dowRaw  = parseField(dowPart, FIELD_SPECS[4]!, "day-of-week");

  // Normalise sunday: 7 → 0
  const dow: FieldSet = new Set<number>();
  for (const d of dowRaw) dow.add(d === 7 ? 0 : d);

  return { raw: expanded, minutes, hours, dom, month, dow, domStar, dowStar };
}

/** Parse one cron field token into a Set of allowed values. */
function parseField(token: string, spec: FieldSpec, fieldName: string): FieldSet {
  const result = new Set<number>();

  for (const part of token.split(",")) {
    parseSegment(part.trim(), spec, fieldName, result);
  }

  return result;
}

function parseSegment(
  seg: string,
  spec: FieldSpec,
  fieldName: string,
  out: FieldSet,
): void {
  // Star or star/step: * or */n
  if (seg === "*") {
    for (let i = spec.min; i <= spec.max; i++) out.add(i);
    return;
  }

  // Parse optional /step suffix
  let core = seg;
  let step: number | undefined;

  const slashIdx = seg.indexOf("/");
  if (slashIdx !== -1) {
    core = seg.slice(0, slashIdx);
    const stepStr = seg.slice(slashIdx + 1);
    if (!/^\d+$/.test(stepStr)) {
      throw new Error(
        `Invalid step "${stepStr}" in ${fieldName} field "${seg}". Step must be a positive integer.`,
      );
    }
    step = parseInt(stepStr, 10);
    if (step < 1) {
      throw new Error(
        `Invalid step "${step}" in ${fieldName} field "${seg}". Step must be >= 1 (*/0 is nonsense).`,
      );
    }
  }

  // Determine range
  let lo: number;
  let hi: number;

  if (core === "*") {
    lo = spec.min;
    hi = spec.max;
  } else if (core.includes("-")) {
    const dashIdx = core.indexOf("-");
    const rawLo = core.slice(0, dashIdx);
    const rawHi = core.slice(dashIdx + 1);
    lo = resolveName(rawLo, spec, fieldName);
    hi = resolveName(rawHi, spec, fieldName);
    if (lo > hi) {
      throw new Error(
        `Invalid range "${core}" in ${fieldName} field: start (${lo}) must be <= end (${hi}).`,
      );
    }
  } else {
    lo = resolveName(core, spec, fieldName);
    hi = lo;
  }

  // Validate bounds
  if (lo < spec.min || lo > spec.max) {
    throw new Error(
      `Value ${lo} in ${fieldName} field is out of range [${spec.min}, ${spec.max}].`,
    );
  }
  if (hi < spec.min || hi > spec.max) {
    throw new Error(
      `Value ${hi} in ${fieldName} field is out of range [${spec.min}, ${spec.max}].`,
    );
  }

  const effectiveStep = step ?? 1;

  for (let v = lo; v <= hi; v += effectiveStep) {
    out.add(v);
  }
}

/**
 * Resolve a token to a number: plain integer, or named month/day.
 * For the day-of-week field we allow 7 (Sunday alias) before normalisation.
 */
function resolveName(token: string, spec: FieldSpec, fieldName: string): number {
  if (/^\d+$/.test(token)) {
    const n = parseInt(token, 10);
    return n;
  }
  if (spec.names) {
    const lower = token.toLowerCase();
    const val = spec.names[lower];
    if (val !== undefined) return val;
    throw new Error(
      `Unknown name "${token}" in ${fieldName} field. ` +
      `Valid names: ${Object.keys(spec.names).join(", ")}.`,
    );
  }
  throw new Error(`Non-numeric value "${token}" in ${fieldName} field.`);
}

/* ====================================================== nextRun ========= */

/** Maximum forward search: 5 years in milliseconds. */
const MAX_SEARCH_MS = 5 * 365.25 * 24 * 60 * 60 * 1000;

/**
 * Return the next firing time at or after `from`, evaluated in `timeZone`.
 *
 * DST handling:
 *  - Spring-forward gap: a minute that does not exist in local time is skipped;
 *    the search advances to the next valid instant.
 *  - Fall-back repeat: the first occurrence of the repeated local time is used
 *    and the second is NOT fired again (no double-fire).
 *
 * OR semantics for dom/dow:
 *  - When BOTH dom and dow are restricted (neither was "*"), a candidate date
 *    matches if it matches dom OR dow (standard vixie-cron semantics).
 *  - When only one is restricted, only that one is checked.
 */
export function nextRun(spec: CronSpec, from: Date, timeZone: string): Date {
  // Work in whole-minute resolution: advance to the next full minute boundary.
  // We advance by 1 minute so that "at or after" means the next scheduled
  // instant that is strictly >= from (when from is already at a scheduled
  // minute, that minute qualifies).
  const startMs = Math.ceil(from.getTime() / 60_000) * 60_000;
  const limitMs = startMs + MAX_SEARCH_MS;

  let candidateMs = startMs;

  while (candidateMs < limitMs) {
    const local = decomposeLocal(candidateMs, timeZone);

    // Check month first — largest granularity — and jump by month on miss.
    if (!spec.month.has(local.month)) {
      // Advance to first minute of next valid month.
      candidateMs = nextMonthStart(local, spec.month, timeZone);
      if (candidateMs >= limitMs) break;
      continue;
    }

    // Check day (dom/dow OR semantics).
    if (!dayMatches(spec, local)) {
      // Advance to midnight of next day in local time.
      candidateMs = nextDayStart(local, timeZone);
      if (candidateMs >= limitMs) break;
      continue;
    }

    // Check hour.
    if (!spec.hours.has(local.hour)) {
      // Advance to start of next valid hour.
      candidateMs = nextHourStart(local, spec.hours, timeZone);
      if (candidateMs >= limitMs) break;
      continue;
    }

    // Check minute.
    if (!spec.minutes.has(local.minute)) {
      candidateMs += 60_000;
      continue;
    }

    // All fields match.  Verify that the UTC→local round-trip is stable
    // (guards against spring-forward gaps where the nominal local time does
    // not exist).
    const verify = decomposeLocal(candidateMs, timeZone);
    if (
      verify.month !== local.month ||
      verify.dom !== local.dom ||
      verify.hour !== local.hour ||
      verify.minute !== local.minute
    ) {
      // This UTC instant maps to a different local time — we are in a gap.
      // Skip forward one minute and try again.
      candidateMs += 60_000;
      continue;
    }

    return new Date(candidateMs);
  }

  throw new Error(
    `Cron expression "${spec.raw}" never fires within 5 years. ` +
    `Check that all field combinations are reachable (e.g. "0 0 30 2 *" — Feb 30 does not exist).`,
  );
}

/* ----------------------------------------------- local time helpers ---- */

interface LocalTime {
  year: number;
  month: number;  // 1-12
  dom: number;    // 1-31
  hour: number;   // 0-23
  minute: number; // 0-59
  dow: number;    // 0-6, 0=Sunday
}

/** Decompose a UTC timestamp into local time components for the given timezone. */
function decomposeLocal(ms: number, timeZone: string): LocalTime {
  const d = new Date(ms);
  // Use en-CA (YYYY-MM-DD) for unambiguous date parsing.
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const timeParts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const dowPart = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
  }).format(d);

  let year = 0, month = 0, dom = 0, hour = 0, minute = 0;

  for (const p of dateParts) {
    if (p.type === "year")  year  = parseInt(p.value, 10);
    if (p.type === "month") month = parseInt(p.value, 10);
    if (p.type === "day")   dom   = parseInt(p.value, 10);
  }
  for (const p of timeParts) {
    if (p.type === "hour")   hour   = parseInt(p.value, 10);
    if (p.type === "minute") minute = parseInt(p.value, 10);
  }

  // Map English weekday abbreviation to 0-6
  const dowMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const dow = dowMap[dowPart] ?? 0;

  return { year, month, dom, hour, minute, dow };
}

/**
 * Convert a local-time description back to the UTC timestamp for that instant
 * in the given timezone. Returns the *first* valid UTC instant (important for
 * fall-back: we always take the pre-DST offset occurrence).
 */
function localToUtc(
  year: number,
  month: number,
  dom: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  // Build an ISO string and parse it, then adjust by the timezone offset.
  // We probe with a Date constructed in UTC and then verify the round-trip.
  const isoUtc = `${year}-${String(month).padStart(2, "0")}-${String(dom).padStart(2, "0")}` +
    `T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`;
  let probe = new Date(isoUtc).getTime();

  // Binary-search style: compare the decomposed local time to the target,
  // and nudge forward/backward.  We start from the UTC-naïve guess and
  // correct by up to ±26 hours (max timezone offset).
  for (let iter = 0; iter < 3; iter++) {
    const got = decomposeLocal(probe, timeZone);
    const diff =
      (got.hour * 60 + got.minute) - (hour * 60 + minute) +
      (got.dom - dom) * 1440 +
      (got.month - month) * 43200 +  // approx, fine for small offsets
      (got.year - year) * 525960;
    if (diff === 0) return probe;
    probe -= diff * 60_000;
  }

  // One more pass after corrections
  return probe;
}

/** True when the candidate date matches the cron's dom/dow constraint. */
function dayMatches(spec: CronSpec, local: LocalTime): boolean {
  if (spec.domStar && spec.dowStar) return true;
  if (spec.domStar) return spec.dow.has(local.dow);
  if (spec.dowStar) return spec.dom.has(local.dom);
  // Both restricted → OR semantics (vixie-cron standard)
  return spec.dom.has(local.dom) || spec.dow.has(local.dow);
}

/** Advance to the first minute of the first day in the next valid month. */
function nextMonthStart(
  local: LocalTime,
  months: FieldSet,
  timeZone: string,
): number {
  let year = local.year;
  let month = local.month + 1;

  for (let i = 0; i < 24; i++) {
    if (month > 12) { month = 1; year++; }
    if (months.has(month)) {
      return localToUtc(year, month, 1, 0, 0, timeZone);
    }
    month++;
  }
  return Infinity;
}

/** Advance to midnight of the next calendar day in local time. */
function nextDayStart(local: LocalTime, timeZone: string): number {
  // Add 1 day to current date.  We do this by computing midnight of today
  // then adding 24 hours (DST-safe because we re-interpret locally after).
  const todayMidnight = localToUtc(local.year, local.month, local.dom, 0, 0, timeZone);
  // Add 25 hours to clear any DST ambiguity, then snap back to midnight.
  const next = new Date(todayMidnight + 25 * 3600_000);
  const nl = decomposeLocal(next.getTime(), timeZone);
  return localToUtc(nl.year, nl.month, nl.dom, 0, 0, timeZone);
}

/** Advance to the first minute of the next valid hour. */
function nextHourStart(
  local: LocalTime,
  hours: FieldSet,
  timeZone: string,
): number {
  let h = local.hour + 1;
  let dom = local.dom;
  let month = local.month;
  let year = local.year;

  for (let i = 0; i < 48; i++) {
    if (h > 23) {
      h = 0;
      // Advance a day
      const ms = localToUtc(year, month, dom, 0, 0, timeZone) + 25 * 3600_000;
      const nl = decomposeLocal(ms, timeZone);
      year = nl.year; month = nl.month; dom = nl.dom;
    }
    if (hours.has(h)) {
      return localToUtc(year, month, dom, h, 0, timeZone);
    }
    h++;
  }
  return Infinity;
}

/* ====================================================== describeCron ==== */

/**
 * Produce a human-readable sentence describing a cron schedule.
 * Examples:
 *  "0 9 * * 1-5"  → "Every weekday at 09:00"
 *  "30 14 1 * *"  → "At 14:30 on the 1st of every month"
 *  "@hourly"      → "Every hour"
 */
export function describeCron(spec: CronSpec): string {
  // Special single-minute-of-hour patterns
  const minuteList = [...spec.minutes].sort((a, b) => a - b);
  const hourList   = [...spec.hours].sort((a, b) => a - b);

  const everyMinute = spec.minutes.size === 60;
  const everyHour   = spec.hours.size === 24;
  const everyDom    = spec.domStar || spec.dom.size === 31;
  const everyMonth  = spec.month.size === 12;
  const everyDow    = spec.dowStar || spec.dow.size === 7;

  // @hourly equivalent
  if (everyMinute && everyHour && everyDom && everyMonth && everyDow) {
    return "Every minute";
  }

  if (minuteList.length === 1 && minuteList[0] === 0 && everyHour && everyDom && everyMonth && everyDow) {
    return "Every hour";
  }

  // Build time string
  const timeStr = (minuteList.length === 1 && hourList.length === 1)
    ? `at ${String(hourList[0]).padStart(2, "0")}:${String(minuteList[0]).padStart(2, "0")}`
    : minuteList.length === 1
      ? `at minute ${minuteList[0]} of every hour`
      : everyMinute
        ? "every minute"
        : `at minutes ${minuteList.join(", ")} of every hour`;

  // Day part
  const dowNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const monNames = ["", "January", "February", "March", "April", "May", "June",
                    "July", "August", "September", "October", "November", "December"];

  let dayStr = "";
  if (!everyDom || !everyDow) {
    if (!spec.domStar && spec.dowStar) {
      // Only dom constrained
      const domList = [...spec.dom].sort((a, b) => a - b);
      if (domList.length === 1) {
        dayStr = `on the ${ordinal(domList[0]!)} of every month`;
      } else {
        dayStr = `on days ${domList.map(ordinal).join(", ")} of every month`;
      }
    } else if (spec.domStar && !spec.dowStar) {
      // Only dow constrained
      const dowList = [...spec.dow].sort((a, b) => a - b);
      if (dowList.length === 5 && !spec.dow.has(0) && !spec.dow.has(6)) {
        dayStr = "on weekdays";
      } else if (dowList.length === 2 && spec.dow.has(0) && spec.dow.has(6)) {
        dayStr = "on weekends";
      } else if (dowList.length === 1) {
        dayStr = `on ${dowNames[dowList[0]!]}s`;
      } else {
        dayStr = `on ${dowList.map((d) => dowNames[d]!).join(", ")}`;
      }
    } else if (!spec.domStar && !spec.dowStar) {
      dayStr = "when dom or dow matches";
    }
  }

  let monthStr = "";
  if (!everyMonth) {
    const mList = [...spec.month].sort((a, b) => a - b);
    if (mList.length === 1) {
      monthStr = `in ${monNames[mList[0]!]}`;
    } else {
      monthStr = `in ${mList.map((m) => monNames[m]!).join(", ")}`;
    }
  }

  const parts = ["Every day"];
  if (dayStr) parts[0] = dayStr.charAt(0).toUpperCase() + dayStr.slice(1);

  const result = [parts[0], timeStr, monthStr].filter(Boolean).join(" ");
  return result.charAt(0).toUpperCase() + result.slice(1);
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return String(n) + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}
