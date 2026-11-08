// A small five-field cron matcher (minute hour day-of-month month day-of-week), all in UTC. The scheduler asks it each
// minute which runs are due, so it only needs `matches`, plus `shortestGap` to bound how tight a schedule may be.

export class CronError extends Error {}

export interface Cron {
  expr: string;
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  // Whether the field was a bare `*`: only restricted day fields take part in the day rule.
  anyDay: boolean;
  anyWeekday: boolean;
}

interface Field {
  name: string;
  min: number;
  max: number;
}

const FIELDS: Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  // 7 is accepted as Sunday and folded to 0 afterwards.
  { name: "day of week", min: 0, max: 7 },
];

function parseNumber(text: string, field: Field): number {
  if (!/^\d+$/.test(text)) throw new CronError(`cron ${field.name}: "${text}" is not a number`);
  const n = Number(text);
  if (n < field.min || n > field.max) {
    throw new CronError(`cron ${field.name}: ${n} is outside ${field.min}-${field.max}`);
  }
  return n;
}

function parseField(text: string, field: Field): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range, step, extra] = part.split("/");
    if (extra !== undefined) throw new CronError(`cron ${field.name}: "${part}" has two steps`);
    let stride = 1;
    if (step !== undefined) {
      stride = parseNumber(step, { ...field, min: 1, max: field.max });
    }
    let from: number;
    let to: number;
    if (range === "*") {
      from = field.min;
      to = field.max;
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== undefined) throw new CronError(`cron ${field.name}: "${part}" is not a range`);
      from = parseNumber(a, field);
      to = parseNumber(b, field);
      if (from > to) throw new CronError(`cron ${field.name}: range ${range} runs backwards`);
    } else {
      from = parseNumber(range, field);
      to = step !== undefined ? field.max : from;
    }
    for (let v = from; v <= to; v += stride) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError(`cron needs 5 fields, got ${parts.length}: "${expr}"`);
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return { expr, minutes, hours, days, months, weekdays, anyDay: parts[2] === "*", anyWeekday: parts[4] === "*" };
}

export function matches(cron: Cron, at: Date): boolean {
  if (!cron.minutes.has(at.getUTCMinutes()) || !cron.hours.has(at.getUTCHours())) return false;
  if (!cron.months.has(at.getUTCMonth() + 1)) return false;
  const day = cron.days.has(at.getUTCDate());
  const weekday = cron.weekdays.has(at.getUTCDay());
  // Like classic cron: with both day fields restricted, either one matching is enough.
  if (!cron.anyDay && !cron.anyWeekday) return day || weekday;
  return day && weekday;
}

const MINUTE = 60_000;
const WEEK_MINUTES = 7 * 24 * 60;
// A Monday 00:00 UTC; the week it starts is walked to find a schedule's gaps.
const WEEK_START = Date.UTC(2026, 10, 9);
const gaps = new Map<string, number>();

// The smallest number of seconds between two consecutive firings, measured over one week (wrapping around).
export function shortestGap(cron: Cron): number {
  const cached = gaps.get(cron.expr);
  if (cached !== undefined) return cached;
  let first = -1;
  let prev = -1;
  let best = Number.POSITIVE_INFINITY;
  for (let m = 0; m < WEEK_MINUTES; m++) {
    if (!matches(cron, new Date(WEEK_START + m * MINUTE))) continue;
    if (prev >= 0) best = Math.min(best, m - prev);
    else first = m;
    prev = m;
  }
  // No firing in the walked week does not mean never (e.g. the 1st of a month). Anything sparser than weekly reports
  // as a week, which the lock clamp makes equivalent; `nextFiring` is what detects a schedule that never fires.
  best = prev < 0 ? WEEK_MINUTES * 60 : Math.min(best, first + WEEK_MINUTES - prev) * 60;
  gaps.set(cron.expr, best);
  return best;
}

// The first matching minute strictly after `after`, looking at most a year ahead.
export function nextFiring(cron: Cron, after: Date): Date {
  const start = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  for (let m = 0; m < 366 * 24 * 60; m++) {
    const t = new Date(start + m * MINUTE);
    if (matches(cron, t)) return t;
  }
  throw new CronError(`cron "${cron.expr}" does not fire within a year`);
}
