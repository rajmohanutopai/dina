/**
 * Live listings: reconciliation (docs/REAL_LIFE_FIXES.md §14.4 C).
 *
 * A DID is queued here when AppView may hold its listings wrongly: its
 * presence set names a listing or CID AppView does not hold, or holds one the
 * set omits, or one of its events was dropped (the services kill switch, the
 * per-DID limit). The job re-reads the records from the DID's own
 * repository, each with a signed proof, and applies only what verifies:
 *
 *   1. resolve the DID document (PLC) for the repository signing key and the
 *      PDS (`https` only);
 *   2. learn which listings to check: the presence set and every held
 *      listing, or, for a DID without a complete set, the repository's own
 *      list (`com.atproto.repo.listRecords`);
 *   3. fetch each record with `com.atproto.sync.getRecord` (a CAR: the
 *      signed commit, the MST path and the record) through the vetted socket
 *      (one resolution, special-use addresses refused, pinned, no redirects,
 *      1 MB and 10 s caps);
 *   4. verify with `@atproto/repo`: the commit is this DID's and its
 *      signature checks against the DID's key; the record is reachable from
 *      the signed root, or provably absent;
 *   5. apply through the normal handlers at the commit's revision, which
 *      apply only what is newer than what AppView holds. A reconciled read
 *      proves a record exists, never that the node is alive: it credits no
 *      freshness.
 *
 * If the DID's presence revision changed while the job ran, the job is redone
 * rather than applied over newer state. A failure changes nothing and retries
 * with backoff (1 h doubling to 24 h). One run per DID per hour, at most 8 at
 * once.
 */

import { sql } from 'drizzle-orm'

import type { DrizzleDB } from '@/db/connection.js'
import { validateRecord } from '@/ingester/record-validator.js'
import { serviceProfileHandler } from '@/ingester/handlers/service-profile.js'
import { servicePresenceHandler } from '@/ingester/handlers/service-presence.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

const PROFILE = 'com.dinakernel.service.profile'
const PRESENCE = 'com.dinakernel.service.presence'
export const RECONCILE_CONCURRENCY = 8
/** A node publishes at most 100 listings; a little room for ones being deleted. */
const MAX_RKEYS = 120
/** One job's whole budget; past it the job stops and retries later. */
export const RECONCILE_JOB_BUDGET_MS = 60_000
const HOUR_MS = 3_600_000

/** One verified read of one record. */
export type VerifiedRead =
  | { kind: 'present'; rev: string; cid: string; record: unknown }
  | { kind: 'absent'; rev: string }
  | { kind: 'failed'; reason: string }

/** Everything the job reaches outside the database (injectable for tests). */
export interface ReconcileDeps {
  /** The DID's repository signing key (`did:key:…`) and https PDS, or null. */
  resolve(did: string): Promise<{ signingKey: string; pds: string } | null>
  /** The repository's own list of profile rkeys and CIDs (unverified hints). */
  listRkeys(pds: string, did: string): Promise<{ rkey: string; cid: string }[] | null>
  /** A verified read of `collection/rkey` from the DID's repository. */
  readVerified(pds: string, did: string, signingKey: string, collection: string, rkey: string): Promise<VerifiedRead>
}

interface Job {
  did: string
  reason: string
  presence_rev_at_queue: string | null
  attempts: number
}

function rowsOf<T>(r: unknown): T[] {
  return ((r as { rows?: T[] }).rows ?? []) as T[]
}

class BudgetExceeded extends Error {}

/** Run due jobs. */
export async function serviceReconcile(db: DrizzleDB, deps: ReconcileDeps | null = defaultDeps()): Promise<void> {
  if (deps === null) return
  const due = rowsOf<Job>(
    await db.execute(sql`
      SELECT did, reason, presence_rev_at_queue, attempts FROM service_reconcile_jobs
      WHERE reason <> 'done' AND next_attempt_at <= now()
      ORDER BY next_attempt_at LIMIT ${RECONCILE_CONCURRENCY}`),
  )
  await Promise.all(due.map((job) => reconcileOne(db, deps, job)))
}

async function presenceState(db: DrizzleDB, did: string) {
  const rows = rowsOf<{ presence_rev: string | null; presence_complete: boolean | null; listings_json: unknown }>(
    await db.execute(sql`
      SELECT presence_rev, presence_complete, listings_json FROM service_operator_presence WHERE did = ${did}`),
  )
  return rows[0] ?? null
}

export async function reconcileOne(db: DrizzleDB, deps: ReconcileDeps, job: Job): Promise<'done' | 'redo' | 'failed'> {
  const did = job.did
  // One deadline for the whole job. A single read is capped at 10 s by the
  // socket, so a job ends within its budget plus at most one read.
  const deadline = Date.now() + RECONCILE_JOB_BUDGET_MS
  const late = () => Date.now() >= deadline
  try {
    const before = await presenceState(db, did)
    const resolved = await deps.resolve(did)
    if (resolved === null) return await fail(db, job, 'did_unresolved')
    if (late()) return await fail(db, job, 'budget_exceeded')

    // The current presence first: its listing set says what to read.
    const presenceRead = await deps.readVerified(resolved.pds, did, resolved.signingKey, PRESENCE, 'self')
    if (presenceRead.kind === 'failed') return await fail(db, job, 'read_unverified')
    const verifiedSet =
      presenceRead.kind === 'present'
        ? (presenceRead.record as { listings?: { rkey?: unknown }[]; complete?: unknown })
        : null

    // Which listings to check.
    const rkeys = new Set<string>()
    const held = rowsOf<{ uri: string }>(await db.execute(sql`SELECT uri FROM services WHERE operator_did = ${did}`))
    for (const h of held) rkeys.add(h.uri.slice(h.uri.lastIndexOf('/') + 1))
    if (verifiedSet?.complete === true && Array.isArray(verifiedSet.listings)) {
      for (const l of verifiedSet.listings) if (typeof l.rkey === 'string') rkeys.add(l.rkey)
    } else {
      if (late()) return await fail(db, job, 'budget_exceeded')
      const listed = await deps.listRkeys(resolved.pds, did)
      if (listed === null) return await fail(db, job, 'list_failed')
      for (const l of listed) rkeys.add(l.rkey)
    }
    if (rkeys.size > MAX_RKEYS) return await fail(db, job, 'too_many_listings')

    // Read everything first; apply only if nothing moved meanwhile. A slow or
    // hostile PDS cannot hold a worker: past the deadline the job stops,
    // having applied nothing, and retries with backoff.
    const reads: { rkey: string; read: VerifiedRead }[] = []
    for (const rkey of rkeys) {
      if (late()) return await fail(db, job, 'budget_exceeded')
      reads.push({ rkey, read: await deps.readVerified(resolved.pds, did, resolved.signingKey, PROFILE, rkey) })
    }
    if (reads.some((r) => r.read.kind === 'failed')) return await fail(db, job, 'read_unverified')
    if (late()) return await fail(db, job, 'budget_exceeded')
    const after = await presenceState(db, did)
    if ((after?.presence_rev ?? null) !== (before?.presence_rev ?? null)) {
      // Redo once soon; a DID whose presence keeps moving waits the hour out,
      // so it cannot hold a worker by rewriting presence (one run per hour).
      const again = job.reason === 'redo' ? sql`now() + interval '1 hour'` : sql`now() + interval '60 seconds'`
      await db.execute(sql`UPDATE service_reconcile_jobs SET reason = 'redo', next_attempt_at = ${again} WHERE did = ${did}`)
      return 'redo'
    }

    // The writes run in ONE transaction, bounded by the time left: Postgres
    // statement and lock timeouts are set to it, and an expired job rolls
    // everything back and reports failure. Nothing commits after the
    // deadline, and a lock wait cannot hold the worker past it.
    if (late()) return await fail(db, job, 'budget_exceeded')
    const applied = await db
      .transaction(async (tx) => {
        // Before every write: stop if the deadline has passed, and bound the
        // next statements by the time actually left (the timeouts shrink as
        // the job goes on, so their sum cannot pass the deadline).
        const bound = async (): Promise<void> => {
          if (late()) throw new BudgetExceeded()
          const remaining = Math.max(1, deadline - Date.now())
          await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${remaining}`))
          await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${remaining}`))
        }
        await bound()
        const ctx = { db: tx as unknown as DrizzleDB, logger, metrics }
        if (presenceRead.kind === 'present') {
          const v = validateRecord(PRESENCE, presenceRead.record)
          if (v.success) {
            await servicePresenceHandler.handleCreate(ctx, {
              uri: `at://${did}/${PRESENCE}/self`, did, collection: PRESENCE, rkey: 'self', cid: presenceRead.cid,
              record: v.data as Record<string, unknown>, repoRev: presenceRead.rev, observedUs: 0, reconciled: true,
            })
          }
        } else {
          await servicePresenceHandler.handleDelete(ctx, {
            uri: `at://${did}/${PRESENCE}/self`, did, collection: PRESENCE, rkey: 'self', repoRev: presenceRead.rev,
            reconciled: true,
          })
        }
        for (const { rkey, read } of reads) {
          await bound()
          const uri = `at://${did}/${PROFILE}/${rkey}`
          if (read.kind === 'present') {
            const v = validateRecord(PROFILE, read.record)
            if (!v.success) continue
            await serviceProfileHandler.handleCreate(ctx, {
              uri, did, collection: PROFILE, rkey, cid: read.cid,
              record: v.data as Record<string, unknown>, repoRev: read.rev, observedUs: 0, reconciled: true,
            })
          } else if (read.kind === 'absent') {
            await serviceProfileHandler.handleDelete(ctx, { uri, did, collection: PROFILE, rkey, repoRev: read.rev })
          }
        }
        if (late()) throw new BudgetExceeded()
        return true
      })
      .catch((err: unknown) => {
        if (err instanceof BudgetExceeded) return false
        // A Postgres statement or lock timeout is the deadline too.
        const e = err as { code?: unknown; cause?: { code?: unknown } }
        const code = e?.code ?? e?.cause?.code
        if (code === '57014' || code === '55P03') return false
        throw err
      })
    if (!applied) return await fail(db, job, 'budget_exceeded')
    // Done: kept as a marker, so the DID is not reconciled again within the hour.
    await db.execute(sql`
      UPDATE service_reconcile_jobs SET reason = 'done', attempts = 0,
        next_attempt_at = now() + interval '1 hour' WHERE did = ${did}`)
    metrics.incr('service.reconcile', { outcome: 'done' })
    return 'done'
  } catch (err) {
    logger.warn({ err, did }, 'service reconcile failed')
    return fail(db, job, 'error')
  }
}

async function fail(db: DrizzleDB, job: Job, reason: string): Promise<'failed'> {
  const attempts = job.attempts + 1
  const delayMs = Math.min(HOUR_MS * 2 ** (attempts - 1), 24 * HOUR_MS)
  await db.execute(sql`
    UPDATE service_reconcile_jobs SET attempts = ${attempts},
      next_attempt_at = now() + (${delayMs} || ' milliseconds')::interval WHERE did = ${job.did}`)
  metrics.incr('service.reconcile', { outcome: 'failed', reason })
  return 'failed'
}

/** The production dependencies, or null when reconciliation is not configured. */
function defaultDeps(): ReconcileDeps | null {
  return productionDeps ?? null
}

let productionDeps: ReconcileDeps | null = null

/** Installed by the scorer at boot (see `service-reconcile-deps.ts`). */
export function installReconcileDeps(deps: ReconcileDeps | null): void {
  productionDeps = deps
}
