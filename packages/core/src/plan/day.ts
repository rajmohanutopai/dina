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
