/**
 * Live listings: the scheduled side (docs/REAL_LIFE_FIXES.md §14.4 C).
 *
 *   - `servicePresenceHealth` (hourly): the Eureka-style guard. When far
 *     fewer providers renew than should, and the upstream event rate has
 *     dropped too, AppView itself is probably missing renewals: it opens a
 *     blind interval, so nobody ages for AppView's fault. The rule runs only
 *     with at least 50 tracked providers and after 7 days of tracking (a small
 *     index, or one still filling its baseline, would misfire), counts each
 *     provider once however often it writes, leaves clean withdrawals out,
 *     and is capped at 72 h: reaching the cap raises an alarm and lets
 *     ageing run again until the drop clears.
 *   - `serviceLivenessGc` (daily): deletion markers after 30 days, account
 *     statuses of DIDs AppView holds nothing for after 48 h, hourly event
 *     counts after 8 days, finished reconciliation markers after a day.
 */

import { sql } from 'drizzle-orm'

import type { DrizzleDB } from '@/db/connection.js'
import { FRESH_FOR_US } from '@/shared/service-liveness.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

const HOUR_US = 3_600_000_000
const DAY_US = 24 * HOUR_US
export const HEALTH_WINDOW_US = 26 * HOUR_US
export const HEALTH_MIN_POPULATION = 50
export const HEALTH_WARMUP_US = 7 * DAY_US
export const HEALTH_MAX_BLIND_US = 72 * HOUR_US

function rowsOf<T>(r: unknown): T[] {
  return ((r as { rows?: T[] }).rows ?? []) as T[]
}

/** The facts the health rule judges by, at `nowUs`. */
export async function readHealth(db: DrizzleDB, nowUs: number) {
  const since = nowUs - HEALTH_WINDOW_US
  const [pop] = rowsOf<{ eligible: string; renewed: string }>(
    await db.execute(sql`
      SELECT COUNT(*) AS eligible,
             COUNT(*) FILTER (WHERE last_seen_us >= ${since}) AS renewed
      FROM service_operator_presence
      WHERE presence_capable AND presence_present
        AND last_seen_us >= ${since - FRESH_FOR_US}`),
  )
  const [ev] = rowsOf<{ recent: string | null; prior: string | null }>(
    await db.execute(sql`
      SELECT SUM(events) FILTER (WHERE hour_start_us >= ${since}) AS recent,
             SUM(events) FILTER (WHERE hour_start_us < ${since} AND hour_start_us >= ${since - 7 * DAY_US}) AS prior
      FROM ingest_hourly_events`),
  )
  const [track] = rowsOf<{ started: string | null }>(
    await db.execute(sql`SELECT MAX(end_us) AS started FROM service_blind_intervals WHERE reason = 'pre_tracking'`),
  )
  const prior = Number(ev?.prior ?? 0)
  // The prior week scaled to one 26 h window.
  const baseline = (prior * HEALTH_WINDOW_US) / (7 * DAY_US)
  return {
    eligible: Number(pop?.eligible ?? 0),
    renewed: Number(pop?.renewed ?? 0),
    upstreamLow: baseline > 0 && Number(ev?.recent ?? 0) < baseline / 2,
    trackingStartUs: track?.started === null || track?.started === undefined ? null : Number(track.started),
  }
}

/** One hourly run of the health guard. */
export async function servicePresenceHealth(db: DrizzleDB, nowUs = Date.now() * 1000): Promise<'opened' | 'closed' | 'capped' | 'none'> {
  const h = await readHealth(db, nowUs)
  const warmedUp = h.trackingStartUs !== null && nowUs - h.trackingStartUs >= HEALTH_WARMUP_US
  const drop = warmedUp && h.eligible >= HEALTH_MIN_POPULATION && h.renewed < h.eligible / 2 && h.upstreamLow
  metrics.gauge('service.presence.eligible', h.eligible)
  metrics.gauge('service.presence.renewed', h.renewed)

  const [latest] = rowsOf<{ id: number; start_us: string; end_us: string | null; reason: string }>(
    await db.execute(sql`
      SELECT id, start_us, end_us, reason FROM service_blind_intervals
      WHERE reason IN ('health_drop', 'health_drop_capped') ORDER BY id DESC LIMIT 1`),
  )
  const open = latest !== undefined && latest.end_us === null ? latest : undefined

  if (open !== undefined) {
    if (!drop) {
      await db.execute(sql`UPDATE service_blind_intervals SET end_us = ${nowUs} WHERE id = ${open.id}`)
      return 'closed'
    }
    if (nowUs - Number(open.start_us) >= HEALTH_MAX_BLIND_US) {
      await db.execute(sql`
        UPDATE service_blind_intervals SET end_us = ${nowUs}, reason = 'health_drop_capped' WHERE id = ${open.id}`)
      metrics.incr('service.presence.health_cap_reached')
      logger.error({ eligible: h.eligible, renewed: h.renewed }, 'service presence: health drop lasted 72 h; ageing resumes')
      return 'capped'
    }
    return 'none'
  }
  if (!drop) {
    // The drop cleared: a capped interval may open again next time.
    if (latest?.reason === 'health_drop_capped') {
      await db.execute(sql`UPDATE service_blind_intervals SET reason = 'health_drop_cleared' WHERE id = ${latest.id}`)
    }
    return 'none'
  }
  if (latest?.reason === 'health_drop_capped') return 'none'
  // Renewals have been missing since the window began.
  await db.execute(sql`
    INSERT INTO service_blind_intervals (start_us, end_us, reason) VALUES (${nowUs - HEALTH_WINDOW_US}, NULL, 'health_drop')`)
  logger.warn({ eligible: h.eligible, renewed: h.renewed }, 'service presence: health drop; ageing paused')
  return 'opened'
}

/** Daily clean-up of the liveness tables. */
export async function serviceLivenessGc(db: DrizzleDB, nowUs = Date.now() * 1000): Promise<void> {
  await db.execute(sql`DELETE FROM service_deletions WHERE at < now() - interval '30 days'`)
  await db.execute(sql`
    DELETE FROM service_account_status s
    WHERE s.updated_at < now() - interval '48 hours'
      AND NOT EXISTS (SELECT 1 FROM services v WHERE v.operator_did = s.did)
      AND NOT EXISTS (SELECT 1 FROM commerce_catalog_products c WHERE c.supplier_did = s.did)
      AND NOT EXISTS (SELECT 1 FROM service_operator_presence p WHERE p.did = s.did)
      AND NOT EXISTS (SELECT 1 FROM service_reconcile_jobs j WHERE j.did = s.did)`)
  await db.execute(sql`DELETE FROM ingest_hourly_events WHERE hour_start_us < ${nowUs - 8 * DAY_US}`)
  await db.execute(sql`
    DELETE FROM service_reconcile_jobs WHERE reason = 'done' AND next_attempt_at < now() - interval '23 hours'`)
}
