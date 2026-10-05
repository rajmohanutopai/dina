/**
 * Rotating a signing key that others verify from a published, cached key
 * list (UCP plan §4.8, U7): the UCP request key (`m/9999'/6'/{g}'`, listed in
 * the buyer profile) and the A2A card key (`m/9999'/5'/{g}'`, listed in the
 * card's JWK Set) both go through it. Pure: the caller publishes, confirms,
 * persists and signs.
 *
 *  1. `stage`: the next generation is listed beside the active one (phase
 *     `staged`); nothing is signed with it.
 *  2. Once the list naming it is published (`staged.publishedAt`) and the
 *     caller has confirmed it is served (`staged.confirmedAt`), wait the list's
 *     cache lifetime plus a margin: every verifier that honours the header has
 *     then fetched a list naming the new key.
 *  3. `promote`: the new generation signs; the old one stays listed as
 *     `retiring` for the overlap (7 days), so a signature made just before the
 *     switch still verifies against a list cached just before it.
 *  4. `dropExpired`: past its overlap a retiring key leaves the list.
 *
 * Compromise is not a rotation: the caller removes every listed key at once
 * and starts again at the next generation (`fresh`).
 */

export interface KeyRing {
  /** The generation that signs now. */
  active: number;
  /** The next generation, listed but not yet signing. */
  staged?: {
    generation: number;
    /** When the list naming it was first published; its earliest switch is this plus the wait. */
    publishedAt?: number;
    /** When the caller saw the published list served; the switch also waits the wait from here. */
    confirmedAt?: number;
  };
  /** Earlier generations still listed, each until its time. */
  retiring: { generation: number; retireAfter: number }[];
}

/** A ring at `generation`, nothing staged or retiring. */
export function freshRing(generation: number): KeyRing {
  return { active: generation, retiring: [] };
}

/** Every generation the ring lists: active, staged, then retiring. */
export function listedGenerations(ring: KeyRing): number[] {
  return [
    ring.active,
    ...(ring.staged !== undefined ? [ring.staged.generation] : []),
    ...ring.retiring.map((r) => r.generation),
  ];
}

/** The highest generation the ring has used or staged. */
export function highestGeneration(ring: KeyRing): number {
  return Math.max(...listedGenerations(ring));
}

/** Begin a rotation: the next generation above `floor` (and above any listed) is staged. */
export function stage(ring: KeyRing, floor: number): KeyRing {
  if (ring.staged !== undefined) return ring;
  return { ...ring, staged: { generation: Math.max(floor, highestGeneration(ring)) + 1 } };
}

/** The list naming the staged key was published at `at` (the first time only counts). */
export function stagedPublished(ring: KeyRing, at: number): KeyRing {
  if (ring.staged === undefined || ring.staged.publishedAt !== undefined) return ring;
  return { ...ring, staged: { ...ring.staged, publishedAt: at } };
}

/** The caller saw the list naming the staged key served at `at` (the first time only counts). */
export function stagedConfirmed(ring: KeyRing, at: number): KeyRing {
  if (
    ring.staged === undefined ||
    ring.staged.publishedAt === undefined ||
    ring.staged.confirmedAt !== undefined
  )
    return ring;
  return {
    ...ring,
    staged: { ...ring.staged, confirmedAt: Math.max(at, ring.staged.publishedAt) },
  };
}

/** When the staged key may start signing: null until it is published and confirmed served. */
export function promoteAt(ring: KeyRing, waitMs: number): number | null {
  const s = ring.staged;
  if (s?.publishedAt === undefined || s.confirmedAt === undefined) return null;
  return Math.max(s.publishedAt, s.confirmedAt) + waitMs;
}

/** The staged key signs from now; the old one retires after the overlap. Unchanged before its time. */
export function promote(ring: KeyRing, now: number, waitMs: number, overlapMs: number): KeyRing {
  const at = promoteAt(ring, waitMs);
  if (ring.staged === undefined || at === null || now < at) return ring;
  return {
    active: ring.staged.generation,
    retiring: [...ring.retiring, { generation: ring.active, retireAfter: now + overlapMs }],
  };
}

/** Retiring keys past their time leave the list. */
export function dropExpired(ring: KeyRing, now: number): KeyRing {
  const retiring = ring.retiring.filter((r) => r.retireAfter > now);
  return retiring.length === ring.retiring.length ? ring : { ...ring, retiring };
}

/** The next time the ring changes on its own (a promotion or a retirement); null when nothing waits. */
export function nextStepAt(ring: KeyRing, waitMs: number): number | null {
  const times = [
    ...(promoteAt(ring, waitMs) !== null ? [promoteAt(ring, waitMs) as number] : []),
    ...ring.retiring.map((r) => r.retireAfter),
  ];
  return times.length === 0 ? null : Math.min(...times);
}

/** Advance the ring to `now`: promote when due, drop what expired. */
export function advance(ring: KeyRing, now: number, waitMs: number, overlapMs: number): KeyRing {
  return dropExpired(promote(ring, now, waitMs, overlapMs), now);
}

const isGen = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isTime = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** A stored ring, checked field by field; null when any field is wrong. */
export function readKeyRing(value: unknown): KeyRing | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isGen(v.active) || !Array.isArray(v.retiring)) return null;
  const retiring: KeyRing['retiring'] = [];
  for (const r of v.retiring as unknown[]) {
    if (r === null || typeof r !== 'object') return null;
    const rr = r as Record<string, unknown>;
    if (!isGen(rr.generation) || !isTime(rr.retireAfter)) return null;
    retiring.push({ generation: rr.generation, retireAfter: rr.retireAfter });
  }
  let staged: KeyRing['staged'];
  if (v.staged !== undefined) {
    if (v.staged === null || typeof v.staged !== 'object') return null;
    const s = v.staged as Record<string, unknown>;
    if (!isGen(s.generation)) return null;
    if (s.publishedAt !== undefined && !isTime(s.publishedAt)) return null;
    if (s.confirmedAt !== undefined && !isTime(s.confirmedAt)) return null;
    staged = {
      generation: s.generation,
      ...(s.publishedAt !== undefined ? { publishedAt: s.publishedAt as number } : {}),
      ...(s.confirmedAt !== undefined ? { confirmedAt: s.confirmedAt as number } : {}),
    };
  }
  const ring: KeyRing = { active: v.active, retiring, ...(staged !== undefined ? { staged } : {}) };
  // Each generation listed once.
  const gens = listedGenerations(ring);
  return new Set(gens).size === gens.length ? ring : null;
}
