/**
 * Live listings, ingest side (docs/REAL_LIFE_FIXES.md §14.4 C).
 *
 * Every write to the liveness tables goes through here:
 *   - a presence record renews its operator and replaces the listing set;
 *   - a profile write renews an operator that has never written presence
 *     (an older release); for one that has, only presence counts;
 *   - `#account` events, kept in time order, gate every read;
 *   - a DID whose listings AppView may hold wrongly is queued for
 *     reconciliation against its repository.
 *
 * All times are AppView observation times (`observedUs`), never times a
 * record claims.
 */

import { and, eq, sql } from 'drizzle-orm'

import type { DrizzleDB } from '@/db/connection.js'
import {
  serviceAccountStatus,
  serviceOperatorPresence,
  serviceReconcileJobs,
  services,
} from '@/db/schema/index.js'
import { CREDIT_EVERY_US, revIsNewer, rkeyOfUri } from '@/shared/service-liveness.js'

export interface PresenceListing {
  rkey: string
  cid: string
}

/** Delay before a queued reconciliation runs, so in-flight events land first. */
const RECONCILE_SETTLE_MS = 60_000

/**
 * Queue `did` for reconciliation. Idempotent: a pending job keeps its time;
 * a job done within the last hour reopens, but not before that hour is up
 * (one run per DID per hour).
 */
export async function queueReconcile(db: DrizzleDB, did: string, reason: string): Promise<void> {
  const presence = await db
    .select({ rev: serviceOperatorPresence.presenceRev })
    .from(serviceOperatorPresence)
    .where(eq(serviceOperatorPresence.did, did))
    .limit(1)
  await db
    .insert(serviceReconcileJobs)
    .values({
      did,
      reason,
      presenceRevAtQueue: presence[0]?.rev ?? null,
      nextAttemptAt: new Date(Date.now() + RECONCILE_SETTLE_MS),
    })
    .onConflictDoUpdate({
      target: serviceReconcileJobs.did,
      set: {
        reason,
        presenceRevAtQueue: presence[0]?.rev ?? null,
        nextAttemptAt: sql`GREATEST(${serviceReconcileJobs.nextAttemptAt}, now() + interval '60 seconds')`,
        queuedAt: new Date(),
      },
      setWhere: sql`${serviceReconcileJobs.reason} = 'done'`,
    })
}

/** A presence create or update (`rkey` already checked to be `self`). */
export async function notePresence(
  db: DrizzleDB,
  did: string,
  record: { listings: PresenceListing[]; complete: boolean },
  repoRev: string | undefined,
  observedUs: number,
  /** False for a reconciled read: it updates the set but renews nothing. */
  creditFreshness = true,
): Promise<'applied' | 'stale'> {
  const prior = await db
    .select()
    .from(serviceOperatorPresence)
    .where(eq(serviceOperatorPresence.did, did))
    .limit(1)
  const row = prior[0]
  // Membership: every newer revision applies, whatever the credit limit.
  if (row !== undefined && repoRev !== undefined && !revIsNewer(repoRev, row.presenceRev)) return 'stale'
  // Freshness: credited at most once per 10 minutes, never moved backwards.
  const credit =
    creditFreshness &&
    (row === undefined || row.creditedUs === null || observedUs - Number(row.creditedUs) >= CREDIT_EVERY_US)
  const lastSeen = credit ? Math.max(Number(row?.lastSeenUs ?? 0), observedUs) : (row?.lastSeenUs ?? null)
  const values = {
    did,
    lastSeenUs: lastSeen === null ? null : Number(lastSeen),
    creditedUs: credit ? observedUs : (row?.creditedUs ?? null),
    presenceCapable: true,
    presencePresent: true,
    presenceComplete: record.complete,
    listingsJson: record.listings,
    presenceRev: repoRev ?? row?.presenceRev ?? null,
    updatedAt: new Date(),
  }
  await db
    .insert(serviceOperatorPresence)
    .values(values)
    .onConflictDoUpdate({ target: serviceOperatorPresence.did, set: values })
  await clearInactiveIfOlder(db, did, observedUs)
  if (record.complete && (await setDiffersFromIndex(db, did, record.listings))) {
    await queueReconcile(db, did, 'presence_set_mismatch')
  }
  return 'applied'
}

/** A presence delete: the node withdrew; all its listings are withheld. */
export async function notePresenceDelete(db: DrizzleDB, did: string, repoRev: string | undefined): Promise<void> {
  const prior = await db
    .select({ rev: serviceOperatorPresence.presenceRev })
    .from(serviceOperatorPresence)
    .where(eq(serviceOperatorPresence.did, did))
    .limit(1)
  if (prior[0] !== undefined && repoRev !== undefined && !revIsNewer(repoRev, prior[0].rev)) return
  await db
    .insert(serviceOperatorPresence)
    .values({ did, presenceCapable: true, presencePresent: false, presenceComplete: false, listingsJson: [], presenceRev: repoRev ?? null })
    .onConflictDoUpdate({
      target: serviceOperatorPresence.did,
      set: { presencePresent: false, presenceComplete: false, listingsJson: [], presenceRev: repoRev ?? null, updatedAt: new Date() },
    })
}

/**
 * A profile write. It renews only an operator that has never written
 * presence (an older release, judged on its profile writes); a presence
 * writer is judged on presence alone, so a boot that could not receive
 * queries cannot mark it alive.
 */
export async function noteProfileWrite(db: DrizzleDB, did: string, observedUs: number): Promise<void> {
  await db
    .insert(serviceOperatorPresence)
    .values({ did, lastSeenUs: observedUs, creditedUs: observedUs })
    .onConflictDoUpdate({
      target: serviceOperatorPresence.did,
      set: {
        lastSeenUs: sql`GREATEST(COALESCE(${serviceOperatorPresence.lastSeenUs}, 0), ${observedUs})`,
        creditedUs: observedUs,
        updatedAt: new Date(),
      },
      setWhere: sql`NOT ${serviceOperatorPresence.presenceCapable}`,
    })
  await clearInactiveIfOlder(db, did, observedUs)
}

/**
 * An `#account` event. Applied only when newer than the stored status. An
 * inactive status withholds the DID's listings; `deleted` also removes them,
 * and the status stays as a marker so a delayed older create is refused.
 */
export async function noteServiceAccount(
  db: DrizzleDB,
  did: string,
  active: boolean,
  status: string | undefined,
  timeUs: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'svc:' + did}))`)
    const prior = await tx
      .select({ timeUs: serviceAccountStatus.timeUs })
      .from(serviceAccountStatus)
      .where(eq(serviceAccountStatus.did, did))
      .limit(1)
    if (prior[0] !== undefined && Number(prior[0].timeUs) >= timeUs) return
    const values = { did, active, status: status ?? null, timeUs, updatedAt: new Date() }
    await tx.insert(serviceAccountStatus).values(values).onConflictDoUpdate({ target: serviceAccountStatus.did, set: values })
    if (!active && status === 'deleted') {
      await tx.delete(services).where(eq(services.operatorDid, did))
    }
  })
}

/**
 * May a commit observed at `observedUs` for `did` be admitted? A `deleted`
 * account refuses any commit observed before its deletion.
 */
export async function accountAdmits(db: DrizzleDB, did: string, observedUs: number): Promise<boolean> {
  const rows = await db
    .select()
    .from(serviceAccountStatus)
    .where(eq(serviceAccountStatus.did, did))
    .limit(1)
  const s = rows[0]
  if (s === undefined || s.active) return true
  return !(s.status === 'deleted' && Number(s.timeUs) >= observedUs)
}

/** A commit observed after an inactive status proves the account active again. */
async function clearInactiveIfOlder(db: DrizzleDB, did: string, observedUs: number): Promise<void> {
  await db
    .update(serviceAccountStatus)
    .set({ active: true, status: 'active', timeUs: observedUs, updatedAt: new Date() })
    .where(and(eq(serviceAccountStatus.did, did), eq(serviceAccountStatus.active, false), sql`${serviceAccountStatus.timeUs} < ${observedUs}`))
}

/** Does the presence set differ from what AppView holds for `did`? */
async function setDiffersFromIndex(db: DrizzleDB, did: string, listings: PresenceListing[]): Promise<boolean> {
  const held = await db
    .select({ uri: services.uri, cid: services.cid })
    .from(services)
    .where(eq(services.operatorDid, did))
  const heldByRkey = new Map(held.map((h) => [rkeyOfUri(h.uri), h.cid]))
  const named = new Set(listings.map((l) => l.rkey))
  for (const l of listings) if (heldByRkey.get(l.rkey) !== l.cid) return true
  for (const rkey of heldByRkey.keys()) if (!named.has(rkey)) return true
  return false
}

/**
 * Before ingestion resumes from `cursorUs`: when renewals may have been lost
 * (no cursor over an index that holds presence rows, or a resume point older
 * than Jetstream keeps events), record the lost span as blind time. Ageing
 * pauses over it; nobody looks dead for AppView's own outage (§14.4 C).
 */
export async function noteIngestGap(
  db: DrizzleDB,
  cursorUs: number,
  retentionUs: number,
  nowUs: number = Date.now() * 1000,
): Promise<boolean> {
  const MARGIN_US = 10 * 60 * 1_000_000
  let fromUs: number | null = null
  if (cursorUs === 0) {
    const rows = (await db.execute(
      sql`SELECT MAX(last_seen_us) AS m FROM service_operator_presence`,
    )) as unknown as { rows?: { m: string | number | null }[] }
    const m = rows.rows?.[0]?.m
    if (m !== null && m !== undefined) fromUs = Number(m)
  } else if (nowUs - cursorUs > retentionUs - MARGIN_US) {
    fromUs = cursorUs
  }
  if (fromUs === null || fromUs >= nowUs) return false
  await db.execute(
    sql`INSERT INTO service_blind_intervals (start_us, end_us, reason) VALUES (${fromUs}, ${nowUs}, 'ingest_gap')`,
  )
  return true
}
