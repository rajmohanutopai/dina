import type { DrizzleDB } from '@/db/connection.js'
import { trustV1Params } from '@/db/schema/trust-v1-params.js'
import { TRUST_V1_PARAM_SEEDS } from '@/db/seeds/trust-v1-params.js'

/**
 * Hot-reload reader for `trust_v1_params` (TN-SCORE-009 / Plan §4.1 + §13.6).
 *
 * The scorer reads this on each cron tick (~minute granularity). When an
 * operator runs `dina-admin trust set-param WEIGHT_VOLUME 0.30` (TN-FLAG-002
 * sibling — separate task), the UPDATE propagates within the next tick
 * via the cache TTL.
 *
 * **Snapshot semantics**: one read returns a frozen `TrustV1Params` with
 * every documented param resolved. Missing rows fall back to
 * `TRUST_V1_PARAM_SEEDS` defaults — a partially-seeded DB doesn't break
 * the scorer; the seed defaults are correct values, not zeros.
 *
 * **Cache TTL = 60 seconds**: the scorer's most aggressive cron is
 * every 5 minutes (`refresh-profiles`, `refresh-subject-scores`), so
 * a 60s TTL means at most 1 cache miss per tick and at-worst-60s
 * propagation latency. Short enough that operator-initiated
 * tuning lands on the next job; long enough to avoid hitting the
 * params table on every algorithm function call within a tick.
 *
 * **Why a typed snapshot** rather than a `Map<string, number>`:
 *   - Compile-time safety — calling `params.WEIGHT_VOLUME` is a tsc
 *     error if the field is renamed; `params.get('WIEGHT_VOLUME')`
 *     would silently return undefined.
 *   - Refactor-safe — IDE rename works.
 *   - The 10-key typed shape mirrors the seed list one-to-one.
 *
 * **Pure read function**: the cache wrapper is a thin TTL gate; no
 * subscriptions, no event listeners. Future enhancement: LISTEN/NOTIFY
 * for sub-second propagation (Plan §13.6 sketches this).
 */

/**
 * Typed snapshot of all V1 scoring parameters. The shape mirrors
 * `TRUST_V1_PARAM_SEEDS` exactly so adding a key requires updating
 * the seed list, this type, and the reader's row-merge logic in
 * lockstep — surfaces any drift at compile time.
 */
export interface TrustV1Params {
  readonly WEIGHT_VOLUME: number
  readonly WEIGHT_AGE: number
  readonly WEIGHT_COSIG: number
  readonly WEIGHT_CONSISTENCY: number
  readonly N_VOLUME_TARGET: number
  readonly N_COSIG_TARGET: number
  readonly N_CONSISTENCY_MIN: number
  readonly VAR_MAX: number
  readonly HOT_SUBJECT_THRESHOLD: number
  readonly FRIEND_BOOST: number
}

const PARAMS_CACHE_TTL_MS = 60_000

interface CachedSnapshot {
  readonly value: TrustV1Params
  readonly loadedAt: number
}

let cached: CachedSnapshot | null = null

/**
 * Build the seed-only fallback snapshot (used when the DB has no rows
 * or a partial set). Frozen, returned as-is when caller doesn't need
 * to merge with DB rows.
 */
function buildSeedSnapshot(): TrustV1Params {
  const seedMap = new Map(TRUST_V1_PARAM_SEEDS.map((s) => [s.key, s.value]))
  return Object.freeze({
    WEIGHT_VOLUME: seedMap.get('WEIGHT_VOLUME') ?? 0,
    WEIGHT_AGE: seedMap.get('WEIGHT_AGE') ?? 0,
    WEIGHT_COSIG: seedMap.get('WEIGHT_COSIG') ?? 0,
    WEIGHT_CONSISTENCY: seedMap.get('WEIGHT_CONSISTENCY') ?? 0,
    N_VOLUME_TARGET: seedMap.get('N_VOLUME_TARGET') ?? 0,
    N_COSIG_TARGET: seedMap.get('N_COSIG_TARGET') ?? 0,
    N_CONSISTENCY_MIN: seedMap.get('N_CONSISTENCY_MIN') ?? 0,
    VAR_MAX: seedMap.get('VAR_MAX') ?? 0,
    HOT_SUBJECT_THRESHOLD: seedMap.get('HOT_SUBJECT_THRESHOLD') ?? 0,
    FRIEND_BOOST: seedMap.get('FRIEND_BOOST') ?? 0,
  })
}

/**
 * Direct read from the DB — bypasses cache. Used by tests and by the
 * cached reader on miss. Merges DB rows with seed defaults so a
 * partially-seeded DB behaves correctly.
 *
 * **NUMERIC → number coercion**: pg's default deserializer returns
 * `NUMERIC` columns as strings to preserve precision. `parseFloat`
 * truncates to JS double (~15 significant digits); the trust formula
 * doesn't need more, and the scorer is currently number-typed.
 */
export async function readTrustV1Params(db: DrizzleDB): Promise<TrustV1Params> {
  const seedSnapshot = buildSeedSnapshot()
  const rows = await db
    .select({ key: trustV1Params.key, value: trustV1Params.value })
    .from(trustV1Params)
  // Build the merged snapshot: seed defaults + DB overrides. Unknown
  // keys in the DB are silently ignored — a future param added to the
  // table without updating the TS shape doesn't crash the scorer; the
  // scorer just doesn't see it until the next deploy.
  const dbValues: Record<string, number> = {}
  for (const row of rows) {
    const value = typeof row.value === 'string' ? parseFloat(row.value) : Number(row.value)
    if (Number.isFinite(value)) {
      dbValues[row.key] = value
    }
  }
  return Object.freeze({
    WEIGHT_VOLUME: dbValues.WEIGHT_VOLUME ?? seedSnapshot.WEIGHT_VOLUME,
    WEIGHT_AGE: dbValues.WEIGHT_AGE ?? seedSnapshot.WEIGHT_AGE,
    WEIGHT_COSIG: dbValues.WEIGHT_COSIG ?? seedSnapshot.WEIGHT_COSIG,
    WEIGHT_CONSISTENCY: dbValues.WEIGHT_CONSISTENCY ?? seedSnapshot.WEIGHT_CONSISTENCY,
    N_VOLUME_TARGET: dbValues.N_VOLUME_TARGET ?? seedSnapshot.N_VOLUME_TARGET,
    N_COSIG_TARGET: dbValues.N_COSIG_TARGET ?? seedSnapshot.N_COSIG_TARGET,
    N_CONSISTENCY_MIN: dbValues.N_CONSISTENCY_MIN ?? seedSnapshot.N_CONSISTENCY_MIN,
    VAR_MAX: dbValues.VAR_MAX ?? seedSnapshot.VAR_MAX,
    HOT_SUBJECT_THRESHOLD: dbValues.HOT_SUBJECT_THRESHOLD ?? seedSnapshot.HOT_SUBJECT_THRESHOLD,
    FRIEND_BOOST: dbValues.FRIEND_BOOST ?? seedSnapshot.FRIEND_BOOST,
  })
}

/**
 * Cached snapshot read with 60s TTL. Scorer call sites use this on
 * every algorithm invocation; hot-reload propagation is bounded by
 * the TTL.
 *
 * **DB error policy**: if the read throws (transient pg error), the
 * cached snapshot (if any) is reused. Falling back to "no params" or
 * "all zeros" would silently produce nonsense scores; preferring the
 * last-known-good snapshot keeps the scorer correct during a brief
 * DB blip. If there's no prior snapshot (first call after process
 * start), fall back to seeds — same correctness guarantee.
 */
export async function readCachedTrustV1Params(db: DrizzleDB): Promise<TrustV1Params> {
  const now = Date.now()
  if (cached !== null && now - cached.loadedAt < PARAMS_CACHE_TTL_MS) {
    return cached.value
  }
  try {
    const fresh = await readTrustV1Params(db)
    cached = { value: fresh, loadedAt: now }
    return fresh
  } catch (err) {
    if (cached !== null) {
      // Reuse last-known-good rather than crash.
      return cached.value
    }
    // First-call DB failure: fall back to compiled-in seeds. The
    // scorer continues to produce correct V1 scores; an operator
    // tuning the params won't see their changes until the DB recovers.
    const seedSnapshot = buildSeedSnapshot()
    cached = { value: seedSnapshot, loadedAt: now }
    return seedSnapshot
  }
}

/**
 * Clear the cached snapshot. Tests use this between suites; production
 * relies on the TTL.
 */
export function clearParamsCache(): void {
  cached = null
}
