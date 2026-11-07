/**
 * Day keys for the daily plan: `YYYY-MM-DD` in the device's own time zone,
 * since a plan follows the owner's day, not UTC's.
 */

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function planDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight at the start of the day holding `ms`. */
export function planDayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Local midnight at the start of the next day. */
export function planDayEnd(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** The day key `days` after the one holding `ms` (negative for before). */
export function planDayKeyAfter(ms: number, days: number): string {
  const d = new Date(ms);
  return planDayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 12).getTime());
}

/** The same local clock time `days` calendar days away, across clock changes. */
export function shiftCalendarDays(ms: number, days: number): number {
  const d = new Date(ms);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + days,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  ).getTime();
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A date or time from chat, a model or an agent, in ms; null when unreadable.
 * A bare `YYYY-MM-DD` means the end of that day on the owner's clock, as on
 * the goal's page. `Date.parse` would read it as UTC midnight, which falls on
 * the day before anywhere west of UTC.
 */
export function parsePlanDate(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  const m = DATE_ONLY.exec(t);
  if (m !== null) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59);
    return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d.getTime() : null;
  }
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}
