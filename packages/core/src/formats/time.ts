// Time zones at the edges. The database stores instants as unix seconds (UTC); a zone (an IANA name such as
// "Asia/Seoul" or "Europe/Madrid": the user's, else the workspace's) only turns them into wall time for people and back.
// Intl handles daylight saving, so 18:00 entered in summer and 18:00 entered in winter are both 18:00 local time.

const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(ms: number, tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

/** Whether `tz` is a time zone Intl knows. */
export function isTimeZone(tz: string): boolean {
  try {
    parts(0, tz);
    return true;
  } catch {
    return false;
  }
}

/** The zone's offset from UTC at that instant, in seconds (e.g. 32400 for Asia/Seoul). */
export function zoneOffset(ms: number, tz: string): number {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 1000);
}

/** The date in the zone, YYYY-MM-DD. */
export function zoneDate(now: Date, tz: string): string {
  const p = parts(now.getTime(), tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The wall time in the zone, HH:MM. */
export function zoneClock(now: Date, tz: string): string {
  const p = parts(now.getTime(), tz);
  return `${p.hour}:${p.minute}`;
}

/** The hour (0–23) in the zone. */
export const zoneHour = (now: Date, tz: string) => Number(parts(now.getTime(), tz).hour);

/** Unix seconds of a date (YYYY-MM-DD) and time (HH:MM) in the zone; null if either is malformed. A time skipped by
 *  a daylight-saving change resolves to the first valid instant after it. */
export function zoneToUnix(date: string, time: string, tz: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t || Number(t[1]) > 23 || Number(t[2]) > 59) return null;
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  if (new Date(wall).toISOString().slice(0, 10) !== date) return null; // e.g. 2026-02-30
  // The offset at the guess may differ from the offset at the answer near a change: refine once.
  let s = wall / 1000 - zoneOffset(wall, tz);
  s = wall / 1000 - zoneOffset(s * 1000, tz);
  return s;
}

/** "YYYY-MM-DD HH:MM" in the zone for unix seconds. */
export function zoneStamp(unix: number, tz: string): string {
  const p = parts(unix * 1000, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** ISO 8601 with the zone's offset, e.g. "2026-10-20T18:00:00+09:00". */
export function zoneIso(unix: number, tz: string): string {
  const p = parts(unix * 1000, tz);
  const off = zoneOffset(unix * 1000, tz);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  const hh = String(Math.floor(a / 3600)).padStart(2, "0");
  const mm = String(Math.floor((a % 3600) / 60)).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

/** The date `days` days after (or before) a YYYY-MM-DD date. */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** ISO 8601 in UTC, e.g. "2026-10-20T09:00:00Z". */
export const utcIso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Unix seconds of an ISO 8601 instant that carries its zone: "2026-10-20T09:00:00Z" or "2026-10-20T18:00+09:00".
 *  null otherwise; a time without Z or an offset is refused, since it could be any zone's. */
export function parseInstant(s: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) return null;
  const ms = Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** The start of the hour holding `unix` on the zone's clock (zones with half-hour offsets have their own hours). */
export function zoneHourStart(unix: number, tz: string): number {
  const local = unix + zoneOffset(unix * 1000, tz);
  return unix - (((local % 3600) + 3600) % 3600);
}
