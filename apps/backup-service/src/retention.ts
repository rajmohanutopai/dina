/**
 * Which copies to keep (USER_BACKUP.md §8.3): the newest copy of each of the
 * last 7 days that have one, and of each of the last 4 weeks that have one.
 * The newest copy is always kept, so the highest counter never goes down and
 * a restored device's next copy (highest + 1) stays above every copy held.
 * Days and weeks are UTC; a week is seven days counted from the epoch.
 */

const DAY_MS = 86_400_000;
export const KEEP_DAILY = 7;
export const KEEP_WEEKLY = 4;

export interface CopyAge {
  counter: number;
  storedAt: number;
}

function newestPerBucket(
  copies: CopyAge[],
  bucket: (c: CopyAge) => number,
  keep: number,
): number[] {
  const best = new Map<number, CopyAge>();
  for (const c of copies) {
    const b = bucket(c);
    const cur = best.get(b);
    if (cur === undefined || c.counter > cur.counter) best.set(b, c);
  }
  return [...best.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, keep)
    .map(([, c]) => c.counter);
}

/** Counters to keep; every other copy may be deleted. */
export function countersToKeep(copies: CopyAge[]): Set<number> {
  const keep = new Set<number>();
  if (copies.length === 0) return keep;
  keep.add(Math.max(...copies.map((c) => c.counter)));
  const day = (c: CopyAge): number => Math.floor(c.storedAt / DAY_MS);
  for (const n of newestPerBucket(copies, day, KEEP_DAILY)) keep.add(n);
  for (const n of newestPerBucket(copies, (c) => Math.floor(day(c) / 7), KEEP_WEEKLY)) keep.add(n);
  return keep;
}
