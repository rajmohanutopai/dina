/**
 * Live listings (docs/REAL_LIFE_FIXES.md §14): the shared rules for how old
 * an operator is, which tier its listings rank in, and which listings may be
 * served at all. Every reader of `services` (search, get-by-uri,
 * is-discoverable, capability coverage) and commerce search use these, so
 * the rules cannot drift between them.
 *
 * Age is measured on AppView's clock: the time since the operator's last
 * observed renewal (`service_operator_presence.last_seen_us`), minus the
 * blind time inside that span (`service_blind_intervals`). The clock pauses
 * while AppView may have missed renewals; it never moves `last_seen_us`.
 */

import { sql, type SQL } from 'drizzle-orm'

import type { DrizzleDB } from '@/db/connection.js'
import { readBoolFlag } from '@/db/queries/appview-config.js'

const HOUR_US = 3_600_000_000
/** Fresh while the age is under this: three missed daily renewals. */
export const FRESH_FOR_US = 72 * HOUR_US
/** Expired once the age is over this. */
export const EXPIRES_AFTER_US = 14 * 24 * HOUR_US
/** Inside a tier, seen within this ranks above older. */
export const RECENT_WITHIN_US = 26 * HOUR_US
/** Freshness is credited at most once per this per DID. */
export const CREDIT_EVERY_US = 10 * 60 * 1_000_000
/** A `time_us` this far ahead of receipt is replaced by the receipt time. */
export const MAX_CLOCK_SKEW_US = 5 * 60 * 1_000_000

export type Liveness = 'fresh' | 'stale' | 'expired' | 'unknown'

/**
 * The time an event counts as observed: when it happened, never later than
 * AppView received it. A `time_us` more than 5 minutes ahead of receipt is
 * not believed; a delayed or replayed event counts only as of when it
 * happened.
 */
export function observedUs(timeUs: number | undefined, receivedUs: number): number {
  if (typeof timeUs !== 'number' || !Number.isFinite(timeUs) || timeUs <= 0) return receivedUs
  if (timeUs > receivedUs + MAX_CLOCK_SKEW_US) return receivedUs
  return Math.min(timeUs, receivedUs)
}

/**
 * Repository revisions are TIDs: fixed-length, base32-sortable strings, so a
 * later revision compares greater. `null` (unknown) is older than any.
 */
export function revIsNewer(candidate: string | null | undefined, stored: string | null | undefined): boolean {
  if (typeof candidate !== 'string' || candidate === '') return false
  if (typeof stored !== 'string' || stored === '') return true
  return candidate > stored
}

/** The AT-URI's record key (`at://did/collection/rkey`). */
export function rkeyOfUri(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1)
}

export interface LivenessSettings {
  nowUs: number
  hideExpired: boolean
  /** µs since epoch, or null when no legacy sunset is set. */
  legacySunsetUs: number | null
}

/** Read the settings once per request. */
export async function readLivenessSettings(db: DrizzleDB, nowUs = Date.now() * 1000): Promise<LivenessSettings> {
  const hideExpired = await readBoolFlag(db, 'service_presence_hide_expired').catch(() => false)
  let legacySunsetUs: number | null = null
  try {
    const rows = (await db.execute(
      sql`SELECT text_value FROM appview_config WHERE key = 'service_legacy_sunset' LIMIT 1`,
    )) as unknown as { rows?: { text_value: string | null }[] }
    const raw = rows.rows?.[0]?.text_value
    if (typeof raw === 'string' && raw !== '') {
      const ms = Date.parse(raw)
      if (Number.isFinite(ms)) legacySunsetUs = ms * 1000
    }
  } catch {
    /* no sunset */
  }
  return { nowUs, hideExpired, legacySunsetUs }
}

/**
 * SQL for one operator's age (µs) at `nowUs`: time since `last_seen_us`
 * (0 when never seen) minus blind time inside that span. `presence` is the
 * alias of the joined `service_operator_presence` row.
 */
export function ageUsSql(presence: string, nowUs: number): SQL {
  const seen = sql.raw(`COALESCE(${presence}.last_seen_us, 0)`)
  return sql`(
    ${nowUs}::bigint - ${seen}
    - COALESCE((
        SELECT SUM(GREATEST(0, LEAST(COALESCE(b.end_us, ${nowUs}::bigint), ${nowUs}::bigint) - GREATEST(b.start_us, ${seen})))
        FROM service_blind_intervals b
        WHERE COALESCE(b.end_us, ${nowUs}::bigint) > ${seen}
      ), 0)
  )`
}

/**
 * SQL for the liveness tier: 0 fresh, 1 stale or unknown, 2 expired. A DID
 * that never wrote presence (an older release) is `unknown`: ranked with
 * stale ones, never expired by age until the legacy sunset has passed.
 */
export function tierSql(presence: string, s: LivenessSettings): SQL {
  const capable = sql.raw(`COALESCE(${presence}.presence_capable, false)`)
  const age = ageUsSql(presence, s.nowUs)
  const sunsetPassed = s.legacySunsetUs !== null && s.nowUs >= s.legacySunsetUs
  return sql`(CASE
    WHEN NOT ${capable} THEN (CASE WHEN ${sunsetPassed} AND ${age} > ${EXPIRES_AFTER_US}::bigint THEN 2 ELSE 1 END)
    WHEN ${age} < ${FRESH_FOR_US}::bigint THEN 0
    WHEN ${age} < ${EXPIRES_AFTER_US}::bigint THEN 1
    ELSE 2
  END)`
}

/** SQL for the liveness label, matching `tierSql`. */
export function livenessSql(presence: string, s: LivenessSettings): SQL {
  const capable = sql.raw(`COALESCE(${presence}.presence_capable, false)`)
  const age = ageUsSql(presence, s.nowUs)
  const sunsetPassed = s.legacySunsetUs !== null && s.nowUs >= s.legacySunsetUs
  return sql`(CASE
    WHEN NOT ${capable} THEN (CASE WHEN ${sunsetPassed} AND ${age} > ${EXPIRES_AFTER_US}::bigint THEN 'expired' ELSE 'unknown' END)
    WHEN ${age} < ${FRESH_FOR_US}::bigint THEN 'fresh'
    WHEN ${age} < ${EXPIRES_AFTER_US}::bigint THEN 'stale'
    ELSE 'expired'
  END)`
}

/** SQL: 0 when seen within 26 h (raw time, not paused), else 1. */
export function recencySql(presence: string, nowUs: number): SQL {
  return sql`(CASE WHEN COALESCE(${sql.raw(`${presence}.last_seen_us`)}, 0) >= ${nowUs - RECENT_WITHIN_US}::bigint THEN 0 ELSE 1 END)`
}

/**
 * SQL gate: may this listing be served at all? Withholds a listing whose
 * operator's account is inactive, whose node withdrew its presence, or
 * (with a complete presence set) whose rkey and CID the set does not name.
 * `row` is the alias for `services`; `presence` and `account` are the joined
 * `service_operator_presence` and `service_account_status` rows.
 */
export function servableSql(row: string, presence: string, account: string): SQL {
  return sql.raw(`(
    COALESCE(${account}.active, true)
    AND (
      NOT COALESCE(${presence}.presence_capable, false)
      OR (
        ${presence}.presence_present
        AND (
          NOT ${presence}.presence_complete
          OR ${presence}.listings_json @> jsonb_build_array(jsonb_build_object(
               'rkey', split_part(${row}.uri, '/', 5), 'cid', ${row}.cid))
        )
      )
    )
  )`)
}

/** Microseconds → ISO time truncated to the hour, or null. */
export function lastSeenAtIso(lastSeenUs: number | string | null | undefined): string | null {
  const us = typeof lastSeenUs === 'string' ? Number(lastSeenUs) : lastSeenUs
  if (typeof us !== 'number' || !Number.isFinite(us) || us <= 0) return null
  const ms = Math.floor(us / 1000)
  const d = new Date(ms - (ms % 3_600_000))
  return d.toISOString()
}
