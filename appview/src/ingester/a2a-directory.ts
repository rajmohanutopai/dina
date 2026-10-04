/**
 * The A2A directory's ingest (Lane 3, docs/A2A_GATEWAY_ARCHITECTURE.md §8.3).
 *
 * Recording and processing are separate:
 *   - `receive` records a card event in `a2a_event_spool` and returns only
 *     once the row is committed: the consumer's acknowledgement (its cursor
 *     moving past the event) follows the write, never precedes it. A write
 *     that fails is retried until it lands; the event stays in flight and
 *     holds the shared cursor back meanwhile. Card events never reach the
 *     consumer's dead-letter or its capped file spool: backpressure over
 *     loss. Recording ignores every flag.
 *   - The processor drains the spool, each repository in revision order,
 *     through `decideTransition`, every write conditioned on the row's
 *     revision. It runs only while `a2a_directory_enabled` is on; while it is
 *     off (or cannot be read) the directory is `disabled` and events wait.
 *     Turned on, the directory drains up to the spool's high-water mark
 *     (`draining`), then opens (`ready`). Serving reads only `ready`.
 *
 * Card and spool times (`received_at`, `indexed_at`, `verified_at`,
 * `processed_at`) are AppView's clock, the one staleness and pruning are
 * measured against. A card's `indexed_at` is when AppView received the event
 * that gave it its card, so time an event spent waiting never freshens it;
 * leases and retry delays are the database's. `verified_at` is when the
 * record was last checked against the DID document, whatever the check
 * found: the daily check goes by it.
 *
 * Signatures are checked against the publisher's DID document as it is now.
 * An identity event for a card holder, or a day without a check, marks the
 * card for another; a card whose signatures no longer verify is withheld
 * until they verify again (its publisher republishes, or its document names
 * the key once more). A newer record withheld as invalid is checked again the
 * same way, from the event its evidence cites, and served once it verifies.
 *
 * Gaps: an outage longer than Jetstream keeps events, or a first start over
 * an index that already has cards, moves the gap generation before ingestion
 * resumes. Every card must then be proved again by a newer valid event
 * received under the new generation (`decideTransition`).
 */

import { sql, type SQL } from 'drizzle-orm'

import { A2A_CARD_COLLECTION, A2A_SELF_RKEY } from '@dina/a2a'

import type { DrizzleDB } from '@/db/connection.js'
import type { DrizzleTransaction } from '@/shared/types/db-types.js'
import type { JetstreamCommitCreate, JetstreamCommitDelete } from '@/shared/types/jetstream-types.js'
import { publisherKeysFromDidDocument, verifyA2ACardRecord, type A2ACardVerdict } from '@/shared/a2a/card-verify.js'
import type { DidResolver } from '@/shared/a2a/did-resolver.js'
import {
  a2aEventHash,
  decideReinstatement,
  decideTransition,
  isRepoRev,
  orderEvent,
  type CardEvent,
  type CardOperation,
  type CardRowState,
  type CardTransition,
} from '@/shared/a2a/directory-decide.js'
import { readBoolFlag } from '@/db/queries/appview-config.js'
import { recordRejection, type RejectionContext } from './rejection-writer.js'

export type A2ACommitEvent = JetstreamCommitCreate | JetstreamCommitDelete

export function isA2ACommit(event: { kind: string; commit?: { collection?: string } }): boolean {
  return event.kind === 'commit' && event.commit?.collection === A2A_CARD_COLLECTION
}

interface Log {
  info(obj: Record<string, unknown>, msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

export interface A2ADirectoryOptions {
  db: DrizzleDB
  resolveDid: DidResolver
  rejection: Omit<RejectionContext, 'db'>
  log: Log
  /** How long Jetstream keeps events, in microseconds: a cursor older than this has lost some. */
  retentionUs: number
  /** Look again this often with nothing nudging. Default 2 s. */
  tickMs?: number
  /** A verified card is checked again after this long without a check. Default 24 h. */
  recheckAfterMs?: number
  /** The sweep that marks such cards runs at most this often. Default 1 h. */
  sweepEveryMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Retries for a spool row whose processing could not finish: 5 s, 30 s, 2 min, 10 min, then every 30 min. */
export const A2A_PROCESS_RETRY_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000] as const
/**
 * Processed spool rows are kept this long, then pruned. Safe: Jetstream
 * replays only within its retention, far shorter, and a replay of a pruned
 * event is judged by the card row's revision anyway (stale, or a replay).
 */
const SPOOL_KEEP_DONE_MS = 30 * 24 * 60 * 60 * 1000
/** The stamp for an event whose receipt generation is unknown: it never proves a card. */
export const A2A_UNSTAMPED = -1
/** Gaps are judged this much early, against the skew between Jetstream's clock and ours. */
const A2A_GAP_CLOCK_MARGIN_US = 10 * 60 * 1_000_000
/** After the PLC directory did not answer, the next revalidation waits this long. */
const REVALIDATION_RETRY_MS = 300_000
/**
 * Spool events one pass processes at most. A pass then ends, and the next
 * one starts at once if more are due: the flag, the checks after a key
 * change and the drain watermark are each looked at between passes, so a
 * stream that never pauses neither keeps the directory closed nor delays
 * turning it off or checking a changed key.
 */
export const A2A_DRAIN_PASS_MAX = 200
/** Cards one pass checks again after a key change; more wait for the next pass, which starts at once. */
const REVALIDATE_PASS_MAX = 10
/**
 * How long a card's check after a key change is the pass's that took it.
 * The card stays marked until its own verdict lands, so a pass that dies
 * holding it loses nothing: the card is taken again once the lease ends.
 */
const REVALIDATION_LEASE_SECONDS = 60

/** A card taken for a check after a key change, and the lease that makes it this pass's (`revalidate_after` as text). */
interface RevalidationRow {
  did: string
  repo_rev: string
  record_json: string | null
  card_hash: string | null
  presence: string
  unavailable_reason: string | null
  last_spool_id: number | null
  lease: string
}
/**
 * The most conflicting events one standing conflict cites. Past it a further
 * event at that revision adds nothing: the card is withheld either way, and a
 * broken or hostile stream cannot grow the evidence (or the spool rows it
 * spares) without bound.
 */
export const A2A_CONFLICT_EVIDENCE_MAX = 16

interface SpoolRow {
  id: number
  time_us: number
  did: string
  collection: string
  rkey: string
  repo_rev: string
  operation: CardOperation
  event_hash: string
  payload: string
  observed_gap_generation: number
  attempts: number
  /** When AppView received the event (its clock): a card's `indexed_at`, however long the event then waited. */
  received_at: Date | string
}

interface DirectoryStateRow {
  phase: 'disabled' | 'draining' | 'ready'
  generation: number
  gap_generation: number
  drain_watermark: number | null
  last_live_us: number | null
  reconciliation_required: boolean
}

/** The advisory-lock key a DID's card writes and account events share. */
function didLockKey(did: string): string {
  return `a2a:${did}`
}

/** A `text[]` value. (The `sql` template expands a JS array into a list of parameters, not an array.) */
function textArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`
}

/** The row moved between reading and writing: decide again. */
class RowMoved extends Error {}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows
}

export class A2ADirectory {
  private readonly db: DrizzleDB
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly tickMs: number
  private readonly recheckAfterMs: number
  private readonly sweepEveryMs: number
  private lastSweep = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private again = false
  private stopped = true
  /** DIDs whose card is being checked against their DID document now; true once an identity event arrived meanwhile. */
  private readonly checking = new Map<string, boolean>()
  /** Card events being recorded, by DID, so an account event can wait for its card's record. */
  private readonly receiving = new Map<string, Promise<void>>()

  constructor(private readonly options: A2ADirectoryOptions) {
    this.db = options.db
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.tickMs = options.tickMs ?? 2_000
    this.recheckAfterMs = options.recheckAfterMs ?? 24 * 60 * 60 * 1000
    this.sweepEveryMs = options.sweepEveryMs ?? 60 * 60 * 1000
  }

  // ---------------------------------------------------------------- recording

  /**
   * Record a card event; resolves only once it is committed. An event the
   * directory refuses outright (an rkey other than `self`, a revision that
   * is not a TID) is recorded as a rejection instead and touches nothing.
   *
   * `observedGapGeneration` is the gap generation the consumer held when the
   * event came off the socket (§8.3: stamped at receipt). An event that waited
   * in the queue while a gap was declared keeps its older stamp, so it can
   * apply its transition but never prove a card. An event whose receipt
   * generation is unknown is stamped `A2A_UNSTAMPED`: it proves nothing.
   */
  async receive(event: A2ACommitEvent, observedGapGeneration: number): Promise<void> {
    const done = this.receiveOne(event, observedGapGeneration)
    // An account event for this DID waits for its card event's record (`noteAccount`).
    this.receiving.set(event.did, done)
    try {
      await done
    } finally {
      if (this.receiving.get(event.did) === done) this.receiving.delete(event.did)
    }
  }

  private async receiveOne(event: A2ACommitEvent, observedGapGeneration: number): Promise<void> {
    const { did, commit } = event
    const atUri = `at://${did}/${commit.collection}/${commit.rkey}`
    if (commit.rkey !== A2A_SELF_RKEY) {
      await recordRejection({ ...this.options.rejection, db: this.db }, {
        atUri,
        did,
        reason: 'schema_invalid',
        detail: { phase: 'a2a_rkey_not_self' },
      })
      return
    }
    if (!isRepoRev(commit.rev)) {
      await recordRejection({ ...this.options.rejection, db: this.db }, {
        atUri,
        did,
        reason: 'schema_invalid',
        detail: { phase: 'a2a_rev_invalid' },
      })
      return
    }
    const record = commit.operation === 'delete' ? null : commit.record
    const cid = commit.operation === 'delete' ? null : (commit.cid ?? null)
    const eventHash = a2aEventHash(commit.operation, cid, record)
    const payload = JSON.stringify(commit)
    await this.persist('a2a.spool_insert', () =>
      this.db.execute(sql`
        INSERT INTO a2a_event_spool
          (did, collection, rkey, repo_rev, operation, event_hash, payload, time_us, observed_gap_generation, received_at)
        VALUES (${did}, ${commit.collection}, ${commit.rkey}, ${commit.rev}, ${commit.operation}, ${eventHash},
                ${payload}, ${event.time_us}, ${observedGapGeneration}, ${new Date(this.now())})
        ON CONFLICT (did, collection, rkey, repo_rev, operation, event_hash) DO NOTHING`),
    )
    this.nudge()
  }

  /**
   * An identity event: if the DID holds a card, check its signatures again.
   * Identity events come for every repository on the network; only a card
   * holder's wakes the processor. A check of this DID's card already under
   * way is told too: it must not land a verdict made against the document
   * as it was (`process`).
   */
  async noteIdentity(did: string): Promise<void> {
    if (this.checking.has(did)) this.checking.set(did, true)
    let marked = 0
    await this.persist('a2a.identity_mark', async () => {
      const result = (await this.db.execute(sql`
        UPDATE a2a_cards SET needs_revalidation = true, identity_check_pending = true, revalidate_after = NULL
         WHERE did = ${did}`)) as unknown as {
        rowCount: number | null
      }
      marked = result.rowCount ?? 0
    })
    if (marked > 0) this.nudge()
  }

  /**
   * An account event (Jetstream time `timeUs`): an inactive account's card is
   * withheld until it is active again. Recorded for every DID the directory
   * knows (a card or a spool row; a card event in flight for the DID is
   * waited for), latest by time, and applied to the card unless the card's
   * own commit is newer: a repository that committed after the event was
   * active then. So a status taken while the directory was off still holds
   * when the card is processed, and a reactivation lost in a gap is
   * answered by the next commit.
   */
  async noteAccount(did: string, active: boolean, timeUs: number): Promise<void> {
    await this.receiving.get(did)
    // Account events come for every repository on the network: a DID the
    // directory does not know (checked after its in-flight card event, if
    // any, is recorded) costs one read and no transaction.
    let known = false
    await this.persist('a2a.account_known', async () => {
      known =
        rowsOf<{ one: number }>(
          await this.db.execute(sql`
            SELECT 1 AS one WHERE EXISTS (SELECT 1 FROM a2a_cards WHERE did = ${did})
                              OR EXISTS (SELECT 1 FROM a2a_event_spool WHERE did = ${did})`),
        ).length > 0
    })
    if (!known) return
    await this.persist('a2a.account_mark', () =>
      this.db.transaction(async (tx) => {
        // Serialized with a card write for the same DID (`process`): each sees the other's commit.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${didLockKey(did)}))`)
        await tx.execute(sql`
        WITH s AS (
          INSERT INTO a2a_account_status (did, active, time_us)
          SELECT ${did}, ${active}, ${timeUs}
           WHERE EXISTS (SELECT 1 FROM a2a_cards WHERE did = ${did})
              OR EXISTS (SELECT 1 FROM a2a_event_spool WHERE did = ${did})
          ON CONFLICT (did) DO UPDATE SET active = EXCLUDED.active, time_us = EXCLUDED.time_us, updated_at = now()
           WHERE a2a_account_status.time_us < EXCLUDED.time_us
          RETURNING did, active, time_us)
        UPDATE a2a_cards c SET account_active = s.active, updated_at = now()
          FROM s
         WHERE c.did = s.did AND (c.last_event_time_us IS NULL OR c.last_event_time_us < s.time_us)`)
      }),
    )
  }

  /** The current gap generation: what events received from now on are stamped with. */
  async currentGapGeneration(): Promise<number> {
    return (await this.readState()).gap_generation
  }

  /**
   * The consumer is connected with nothing waiting (no event queued, in
   * flight or failed): every event up to now has been received and recorded.
   * Gaps are measured from the later of this and the cursor (a quiet stream
   * moves no cursor, yet loses nothing while live).
   */
  async noteLive(nowUs: number): Promise<void> {
    await this.db.execute(sql`
      UPDATE a2a_directory_state SET last_live_us = GREATEST(COALESCE(last_live_us, 0), ${nowUs}) WHERE id = 1`)
  }

  /**
   * Before ingestion resumes from `cursorUs`: when events may have been lost,
   * move the gap generation. Lost means: no cursor at all over a directory
   * that holds anything (a card or a spool row; Jetstream then starts at the
   * live tail), or a resume point older than Jetstream's retention, the
   * resume point being the later of the cursor and the last time the
   * consumer was live (`noteLive`), less a margin for the two clocks.
   * Returns whether it moved and the generation to stamp new events with.
   */
  async markGapIfUnreplayable(cursorUs: number): Promise<{ gapped: boolean; generation: number }> {
    const state = await this.readState()
    let lost: boolean
    if (cursorUs === 0) {
      const any = rowsOf<{ one: number }>(
        await this.db.execute(sql`
          SELECT 1 AS one WHERE EXISTS (SELECT 1 FROM a2a_cards) OR EXISTS (SELECT 1 FROM a2a_event_spool)`),
      )
      lost = any.length > 0
    } else {
      const resumeUs = Math.max(cursorUs, state.last_live_us ?? 0)
      lost = this.now() * 1000 - resumeUs > this.options.retentionUs - A2A_GAP_CLOCK_MARGIN_US
    }
    if (!lost) return { gapped: false, generation: state.gap_generation }
    const moved = rowsOf<{ gap_generation: number }>(
      await this.db.execute(sql`
        UPDATE a2a_directory_state SET gap_generation = gap_generation + 1, updated_at = now() WHERE id = 1
        RETURNING gap_generation`),
    )
    this.options.log.warn({ cursorUs }, 'a2a directory: events may have been lost; every card must be proved again')
    return { gapped: true, generation: moved[0]?.gap_generation ?? state.gap_generation + 1 }
  }

  /** Retry until the write lands: a card event is never dropped. */
  private async persist(what: string, write: () => Promise<unknown>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await write()
        return
      } catch (err) {
        this.options.log.warn({ err, attempt }, `${what} failed; retrying`)
        await this.sleep(Math.min(100 * 2 ** attempt, 5_000))
      }
    }
  }

  // ---------------------------------------------------------------- the loop

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.nudge()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    while (this.running !== null) await this.running
  }

  nudge(): void {
    if (this.stopped) return
    if (this.running !== null) {
      this.again = true
      return
    }
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.running = this.step()
      .catch((err: unknown) => this.options.log.error({ err }, 'a2a directory step failed'))
      .finally(() => {
        this.running = null
        if (this.stopped) return
        if (this.again) {
          this.again = false
          this.nudge()
          return
        }
        this.timer = setTimeout(() => this.nudge(), this.tickMs)
        this.timer.unref()
      })
  }

  /** One pass: the phase, the drain, the checks, and opening when the drain is done. */
  async step(): Promise<void> {
    let flag: boolean | null
    try {
      flag = await readBoolFlag(this.db, 'a2a_directory_enabled')
    } catch {
      flag = null
    }
    let state = await this.readState()
    if (flag !== true) {
      // Off, or unreadable (treated alike, and remembered): nothing is
      // processed and nothing is served; recording goes on.
      if (state.phase !== 'disabled' || (flag === null && !state.reconciliation_required)) {
        await this.db.execute(sql`
          UPDATE a2a_directory_state
             SET phase = 'disabled',
                 generation = generation + CASE WHEN phase = 'disabled' THEN 0 ELSE 1 END,
                 reconciliation_required = reconciliation_required OR ${flag === null},
                 updated_at = now()
           WHERE id = 1 AND generation = ${state.generation}`)
      }
      return
    }
    if (state.phase === 'disabled') {
      await this.db.execute(sql`
        UPDATE a2a_directory_state
           SET phase = 'draining', generation = generation + 1, updated_at = now(),
               drain_watermark = (SELECT COALESCE(max(id), 0) FROM a2a_event_spool)
         WHERE id = 1 AND generation = ${state.generation} AND phase = 'disabled'`)
      state = await this.readState()
      if (state.phase !== 'draining') return
    }
    const moreEvents = await this.drain()
    const moreChecks = await this.revalidate()
    await this.sweep()
    // Work left over: the next pass starts as soon as this one ends, and reads the flag again first.
    if (moreEvents || moreChecks) this.again = true
    if (state.phase === 'draining') {
      const left = rowsOf<{ one: number }>(
        await this.db.execute(sql`
          SELECT 1 AS one FROM a2a_event_spool
           WHERE status = 'pending' AND id <= ${state.drain_watermark ?? 0} LIMIT 1`),
      )
      if (left.length === 0) {
        await this.db.execute(sql`
          UPDATE a2a_directory_state
             SET phase = 'ready', generation = generation + 1, reconciliation_required = false, updated_at = now()
           WHERE id = 1 AND generation = ${state.generation} AND phase = 'draining'`)
        this.options.log.info({}, 'a2a directory: drained; serving')
      }
    }
  }

  private async readState(): Promise<DirectoryStateRow> {
    const rows = rowsOf<DirectoryStateRow>(
      await this.db.execute(sql`
        SELECT phase, generation, gap_generation, drain_watermark, last_live_us, reconciliation_required
          FROM a2a_directory_state WHERE id = 1`),
    )
    const row = rows[0]
    if (row === undefined) throw new Error('a2a: the directory state row is missing (migration 0025)')
    return {
      ...row,
      drain_watermark: row.drain_watermark === null ? null : Number(row.drain_watermark),
      last_live_us: row.last_live_us === null ? null : Number(row.last_live_us),
    }
  }

  // ---------------------------------------------------------------- the drain

  /**
   * Pending events whose turn it is (the earliest pending one of its
   * repository), oldest first, up to `A2A_DRAIN_PASS_MAX`. Returns whether
   * more may be due.
   */
  private async drain(): Promise<boolean> {
    for (let taken = 0; taken < A2A_DRAIN_PASS_MAX; ) {
      const rows = rowsOf<SpoolRow>(
        await this.db.execute(sql`
          UPDATE a2a_event_spool SET lease_until = now() + interval '60 seconds'
           WHERE id IN (
             SELECT s.id FROM a2a_event_spool s
              WHERE s.status = 'pending'
                AND (s.lease_until IS NULL OR s.lease_until < now())
                AND (s.not_before IS NULL OR s.not_before <= now())
                AND NOT EXISTS (
                  SELECT 1 FROM a2a_event_spool e
                   WHERE e.did = s.did AND e.status = 'pending' AND (e.repo_rev, e.id) < (s.repo_rev, s.id))
              ORDER BY s.id
              LIMIT ${Math.min(25, A2A_DRAIN_PASS_MAX - taken)}
              FOR UPDATE SKIP LOCKED)
          RETURNING id, time_us, did, collection, rkey, repo_rev, operation, event_hash, payload, observed_gap_generation, attempts, received_at`),
      )
      if (rows.length === 0) return false
      // node-postgres returns bigint as text: numbers here, so evidence holds numbers.
      for (const row of rows) {
        await this.process({ ...row, id: Number(row.id), time_us: Number(row.time_us), attempts: Number(row.attempts) })
      }
      taken += rows.length
    }
    return true
  }

  private async process(row: SpoolRow): Promise<void> {
    const event: CardEvent = {
      operation: row.operation,
      rev: row.repo_rev,
      eventHash: row.event_hash,
      observedGapGeneration: row.observed_gap_generation,
    }
    try {
      for (let tries = 0; tries < 3; tries++) {
        this.checking.set(row.did, false)
        const order = orderEvent(await this.readCard(this.db, row.did), event)
        let verdict: A2ACardVerdict | null = null
        if (order === 'newer' && event.operation !== 'delete') {
          const commit = JSON.parse(row.payload) as { record?: unknown }
          const checked = await this.check(row.did, row.collection, row.rkey, commit.record)
          if (checked === 'unavailable') {
            await this.retryLater(row, 'did_unavailable')
            return
          }
          verdict = checked
        }
        try {
          const wrote = await this.db.transaction(async (tx) => {
            // Serialized with account events for this DID (`noteAccount`).
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${didLockKey(row.did)}))`)
            const locked = await this.readCard(tx, row.did, true)
            if (orderEvent(locked, event) !== order) throw new RowMoved()
            // The DID document changed while the record was being checked: check again against the new one.
            if (this.checking.get(row.did) === true) throw new RowMoved()
            const gap = await this.readGap(tx)
            const transition = decideTransition(locked, event, verdict, gap)
            await this.apply(tx, locked, transition, event, row)
            await tx.execute(sql`
              UPDATE a2a_event_spool
                 SET status = 'done', outcome = ${outcomeOf(transition)}, processed_at = ${new Date(this.now())}::timestamptz, lease_until = NULL
               WHERE id = ${row.id}`)
            return transition.kind !== 'none'
          })
          if (wrote) await this.settleAfterCommit(row.did)
          return
        } catch (err) {
          if (!(err instanceof RowMoved)) throw err
        }
      }
      await this.retryLater(row, 'contended')
    } catch (err) {
      this.options.log.error({ err, did: row.did, spoolId: row.id }, 'a2a directory: processing an event failed')
      await this.retryLater(row, 'error')
    } finally {
      this.checking.delete(row.did)
    }
  }

  /**
   * After a write commits: an identity or account event that ran while the
   * transaction was open could not see a row it created (a first create).
   * Settle both against what is committed now: the account gate is read
   * again from the stored status, and an identity change that arrived after
   * the in-transaction check marks the card for another check.
   */
  private async settleAfterCommit(did: string): Promise<void> {
    const identityMoved = this.checking.get(did) === true
    try {
      await this.db.execute(sql`
        UPDATE a2a_cards c
           SET account_active = NOT EXISTS (
                 SELECT 1 FROM a2a_account_status s
                  WHERE s.did = c.did AND NOT s.active AND s.time_us > COALESCE(c.last_event_time_us, 0)),
               needs_revalidation = needs_revalidation OR ${identityMoved},
               identity_check_pending = identity_check_pending OR ${identityMoved},
               revalidate_after = CASE WHEN ${identityMoved} THEN NULL ELSE revalidate_after END
         WHERE c.did = ${did}`)
    } catch (err) {
      // The event is processed; the daily check and the next account event catch up.
      this.options.log.warn({ err, did }, 'a2a directory: settling after commit failed')
      return
    }
    if (identityMoved) this.nudge()
  }

  /** The record's check against the publisher's DID document now; `unavailable` when it cannot be had. */
  private async check(did: string, collection: string, rkey: string, record: unknown): Promise<A2ACardVerdict | 'unavailable'> {
    const resolution = await this.options.resolveDid(did)
    if (resolution.kind === 'unavailable') return 'unavailable'
    if (resolution.kind !== 'document') return { ok: false, reason: `did_${resolution.kind}` }
    return verifyA2ACardRecord({
      repoDid: did,
      collection,
      rkey,
      record,
      keys: publisherKeysFromDidDocument(resolution.document, did),
    })
  }

  private async retryLater(row: SpoolRow, why: string): Promise<void> {
    const delay = A2A_PROCESS_RETRY_MS[Math.min(row.attempts, A2A_PROCESS_RETRY_MS.length - 1)] ?? 1_800_000
    await this.db.execute(sql`
      UPDATE a2a_event_spool
         SET attempts = attempts + 1, lease_until = NULL, outcome = ${`retry:${why}`},
             not_before = now() + make_interval(secs => ${delay / 1000})
       WHERE id = ${row.id}`)
  }

  private async readGap(executor: DrizzleDB | DrizzleTransaction): Promise<number> {
    const rows = rowsOf<{ gap_generation: number }>(
      await executor.execute(sql`SELECT gap_generation FROM a2a_directory_state WHERE id = 1`),
    )
    return rows[0]?.gap_generation ?? 0
  }

  private async readCard(executor: DrizzleDB | DrizzleTransaction, did: string, lock = false): Promise<CardRowState | null> {
    const rows = rowsOf<{
      presence: 'present' | 'deleted'
      repo_rev: string
      last_operation: CardOperation
      last_event_hash: string
      proved_generation: number
    }>(
      await executor.execute(sql`
        SELECT presence, repo_rev, last_operation, last_event_hash, proved_generation
          FROM a2a_cards WHERE did = ${did} ${lock ? sql`FOR UPDATE` : sql``}`),
    )
    const r = rows[0]
    if (r === undefined) return null
    return {
      presence: r.presence,
      repoRev: r.repo_rev,
      lastOperation: r.last_operation,
      lastEventHash: r.last_event_hash,
      provedGeneration: r.proved_generation,
    }
  }

  /** Apply a transition, conditioned on the revision read under the lock. */
  private async apply(
    tx: DrizzleTransaction,
    locked: CardRowState | null,
    transition: CardTransition,
    event: CardEvent,
    row: SpoolRow,
  ): Promise<void> {
    if (transition.kind === 'none') return
    if (transition.kind === 'conflict') {
      if (locked === null) throw new Error('a2a: a conflict needs a row')
      // Every event at the revision, kept as evidence: their spool rows are
      // spared pruning while it stands. A further event at a revision already
      // in conflict joins the evidence (up to A2A_CONFLICT_EVIDENCE_MAX).
      const conflicting = sql`jsonb_build_object('operation', ${event.operation}::text, 'event_hash', ${event.eventHash}::text,
                                                 'spool_id', ${row.id}::bigint)`
      const updated = rowsOf<{ did: string }>(
        await tx.execute(sql`
          UPDATE a2a_cards
             SET unavailable = true, unavailable_reason = 'equal_rev_conflict',
                 evidence_json = CASE
                   WHEN unavailable AND unavailable_reason = 'equal_rev_conflict' AND evidence_json ->> 'rev' = ${event.rev}::text
                   THEN CASE WHEN jsonb_array_length(evidence_json -> 'conflicting') >= ${A2A_CONFLICT_EVIDENCE_MAX}
                             THEN evidence_json
                             ELSE jsonb_set(jsonb_set(evidence_json, '{conflicting}', (evidence_json -> 'conflicting') || jsonb_build_array(${conflicting})),
                                            '{spool_ids}', (evidence_json -> 'spool_ids') || to_jsonb(${row.id}::bigint)) END
                   ELSE jsonb_build_object(
                     'kind', 'equal_rev_conflict', 'rev', ${event.rev}::text,
                     'applied', jsonb_build_object('operation', last_operation, 'event_hash', last_event_hash, 'spool_id', last_spool_id),
                     'conflicting', jsonb_build_array(${conflicting}),
                     'spool_ids', jsonb_build_array(last_spool_id, ${row.id}::bigint)) END,
                 updated_at = now()
           WHERE did = ${row.did} AND repo_rev = ${locked.repoRev}
          RETURNING did`),
      )
      if (updated.length === 0) throw new RowMoved()
      return
    }
    await this.writeCard(tx, locked, transition, event, row, sql`c.repo_rev < EXCLUDED.repo_rev`)
  }

  /**
   * Write the card row an event leaves: a tombstone, a served card, or a
   * withheld one. `guard` is the condition on the row it replaces (a newer
   * revision for an event; the same withheld event for a reinstatement).
   */
  private async writeCard(
    tx: DrizzleTransaction,
    locked: CardRowState | null,
    transition: CardTransition,
    event: CardEvent,
    row: SpoolRow,
    guard: SQL,
  ): Promise<void> {
    if (transition.kind === 'none' || transition.kind === 'conflict') throw new Error('a2a: not a card write')
    const commit = JSON.parse(row.payload) as { cid?: string; record?: unknown }
    const cid = event.operation === 'delete' ? null : (commit.cid ?? null)
    const proved = transition.kind === 'tombstone' ? (locked?.provedGeneration ?? event.observedGapGeneration) : transition.provedGeneration
    const card = transition.kind === 'upsert' ? transition.card : null
    const suppressed = transition.kind === 'suppress'
    const evidence = suppressed
      ? JSON.stringify({ kind: 'newer_invalid', reason: transition.reason, rev: event.rev, spool_ids: [Number(row.id)] })
      : null
    const presence = transition.kind === 'tombstone' ? 'deleted' : 'present'
    const signature = card !== null ? 'verified' : suppressed ? 'invalid' : 'none'
    const recordJson = card !== null ? JSON.stringify(commit.record) : null
    const searchText =
      card !== null ? [card.displayName, card.description, ...card.skills.map((s) => s.id), ...card.skills.map((s) => s.canonical)].join(' ') : null
    const skillIds = card !== null ? card.skills.map((s) => s.id) : []
    const skillKeys = card !== null ? [...new Set(card.skills.map((s) => s.canonical))] : []
    // Indexed when AppView received the event, not when it got to it: an event that waited in the
    // spool (the flag off, retries, a record withheld and reinstated) never makes a card look fresh.
    const at = card !== null ? new Date(row.received_at) : null
    // When the record was last checked: a served card, and a withheld one, were checked just now.
    const checkedAt = card !== null || suppressed ? new Date(this.now()) : null
    const written = rowsOf<{ did: string }>(
      await tx.execute(sql`
        INSERT INTO a2a_cards AS c (
          did, presence, repo_rev, last_operation, last_event_hash, last_spool_id, last_event_time_us, account_active,
          cid, record_json, card_json, card_hash,
          signature_state, endpoint, protocol_version, skill_ids, skill_keys, display_name, description, search_text,
          freshness_epoch, publisher_epoch, publisher_instance, indexed_at, verified_at,
          unavailable, unavailable_reason, evidence_json, proved_generation, needs_revalidation, identity_check_pending,
          revalidate_after, updated_at)
        VALUES (
          ${row.did}, ${presence}, ${event.rev}, ${event.operation}, ${event.eventHash}, ${row.id}, ${row.time_us},
          -- Inactive when the account's latest status, taken after this commit, says so.
          NOT EXISTS (SELECT 1 FROM a2a_account_status s
                       WHERE s.did = ${row.did} AND NOT s.active AND s.time_us > ${row.time_us}),
          ${cid}, ${recordJson},
          ${card?.cardText ?? null}, ${card?.cardHash ?? null}, ${signature}, ${card?.endpoint ?? null},
          ${card?.protocolVersion ?? null}, ${textArray(skillIds)}, ${textArray(skillKeys)}, ${card?.displayName ?? null},
          ${card?.description ?? null}, ${searchText}, ${card?.freshnessEpoch ?? null}, ${card?.publisherEpoch ?? null},
          ${card?.publisherInstance ?? null}, ${at}, ${checkedAt}, ${suppressed}, ${suppressed ? 'newer_invalid' : null},
          ${evidence}::jsonb, ${proved}, false, false, NULL, now())
        ON CONFLICT (did) DO UPDATE SET
          presence = EXCLUDED.presence, repo_rev = EXCLUDED.repo_rev, last_operation = EXCLUDED.last_operation,
          last_event_hash = EXCLUDED.last_event_hash, last_spool_id = EXCLUDED.last_spool_id,
          last_event_time_us = EXCLUDED.last_event_time_us, account_active = EXCLUDED.account_active,
          cid = EXCLUDED.cid, record_json = EXCLUDED.record_json,
          card_json = EXCLUDED.card_json, card_hash = EXCLUDED.card_hash, signature_state = EXCLUDED.signature_state,
          endpoint = EXCLUDED.endpoint, protocol_version = EXCLUDED.protocol_version, skill_ids = EXCLUDED.skill_ids,
          skill_keys = EXCLUDED.skill_keys, display_name = EXCLUDED.display_name, description = EXCLUDED.description,
          search_text = EXCLUDED.search_text, freshness_epoch = EXCLUDED.freshness_epoch,
          publisher_epoch = EXCLUDED.publisher_epoch, publisher_instance = EXCLUDED.publisher_instance,
          indexed_at = EXCLUDED.indexed_at, verified_at = EXCLUDED.verified_at, unavailable = EXCLUDED.unavailable,
          unavailable_reason = EXCLUDED.unavailable_reason, evidence_json = EXCLUDED.evidence_json,
          proved_generation = EXCLUDED.proved_generation, needs_revalidation = false, identity_check_pending = false,
          revalidate_after = NULL, updated_at = now()
        WHERE ${guard}
        RETURNING did`),
    )
    if (written.length === 0) throw new RowMoved()
  }

  // ---------------------------------------------------------------- checks after a key change

  /**
   * Cards marked for another check: verified again against the DID document
   * as it is now, up to `REVALIDATE_PASS_MAX`. Returns whether more may be
   * marked.
   *
   * A card stays marked while its check runs: the pass holds it under a
   * lease (`revalidate_after`), and only its own verdict clears the mark,
   * so a pass that dies, or a check that throws, loses no card; it is taken
   * again when the lease ends. Every write the check makes is conditioned
   * on that lease: an identity event during the check clears the lease and
   * marks the card afresh, so the verdict, made against a document that has
   * changed, never lands, and the next pass checks against the new one.
   * Within this process, `checking` says the same sooner (as in `process`).
   */
  private async revalidate(): Promise<boolean> {
    const rows = rowsOf<RevalidationRow>(
      await this.db.execute(sql`
        UPDATE a2a_cards SET revalidate_after = now() + make_interval(secs => ${REVALIDATION_LEASE_SECONDS})
         WHERE did IN (
           SELECT did FROM a2a_cards
            WHERE needs_revalidation AND (revalidate_after IS NULL OR revalidate_after <= now())
            LIMIT ${REVALIDATE_PASS_MAX} FOR UPDATE SKIP LOCKED)
        RETURNING did, repo_rev, record_json, card_hash, presence, unavailable_reason, last_spool_id, revalidate_after::text AS lease`),
    )
    for (const row of rows) {
      this.checking.set(row.did, false)
      try {
        await this.revalidateOne(row)
      } catch (err) {
        // Its lease runs out and a later pass takes it again; the others go on.
        this.options.log.error({ err, did: row.did }, 'a2a directory: a check after a key change failed')
      } finally {
        this.checking.delete(row.did)
      }
    }
    return rows.length === REVALIDATE_PASS_MAX
  }

  /** The mark ends: this pass's check is done. Nothing changes if the lease moved (an identity event meanwhile). */
  private async revalidated(row: RevalidationRow): Promise<void> {
    await this.db.execute(sql`
      UPDATE a2a_cards SET needs_revalidation = false, identity_check_pending = false, revalidate_after = NULL
       WHERE did = ${row.did} AND repo_rev = ${row.repo_rev} AND revalidate_after = ${row.lease}::timestamptz`)
  }

  /** The DID document could not be had: the card stays marked, and is taken again after a pause. */
  private async revalidateLater(row: Pick<RevalidationRow, 'did' | 'repo_rev' | 'lease'>): Promise<void> {
    await this.db.execute(sql`
      UPDATE a2a_cards SET revalidate_after = now() + make_interval(secs => ${REVALIDATION_RETRY_MS / 1000})
       WHERE did = ${row.did} AND repo_rev = ${row.repo_rev} AND revalidate_after = ${row.lease}::timestamptz`)
  }

  /** One card's check after a key change (`revalidate`), registered in `checking` for its length. */
  private async revalidateOne(row: RevalidationRow): Promise<void> {
    // A tombstone, or a card without a record of its own (a conflict keeps its own): nothing to check.
    if (row.presence !== 'present') return this.revalidated(row)
    // A withheld newer record is checked again from the event its evidence cites.
    if (row.unavailable_reason === 'newer_invalid' && row.last_spool_id !== null) {
      return this.recheckWithheld(row, Number(row.last_spool_id))
    }
    if (row.record_json === null) return this.revalidated(row)
    const checked = await this.check(row.did, A2A_CARD_COLLECTION, A2A_SELF_RKEY, JSON.parse(row.record_json))
    if (checked === 'unavailable') return this.revalidateLater(row)
    // The DID document changed while the record was being checked: the identity event's mark stands.
    if (this.checking.get(row.did) === true) return
    const ok = checked.ok && checked.card.cardHash === row.card_hash
    const reason = checked.ok ? (ok ? null : 'card_hash_changed') : checked.reason
    // A withheld card's evidence (a conflict) stands: a check's verdict is
    // added to it and taken off again, never put in its place, so the spool
    // rows it cites stay spared. Otherwise the verdict is the evidence.
    const written = rowsOf<{ did: string }>(
      await this.db.execute(sql`
        UPDATE a2a_cards
           SET signature_state = ${ok ? 'verified' : 'invalid'},
               verified_at = ${new Date(this.now())}::timestamptz,
               evidence_json = CASE
                 WHEN unavailable AND ${ok} THEN evidence_json - 'revalidation'
                 WHEN unavailable THEN evidence_json || jsonb_build_object('revalidation', jsonb_build_object('reason', ${reason}::text))
                 WHEN ${ok} THEN NULL
                 ELSE ${JSON.stringify({ kind: 'revalidation', reason })}::jsonb END,
               needs_revalidation = false, identity_check_pending = false, revalidate_after = NULL,
               updated_at = now()
         WHERE did = ${row.did} AND repo_rev = ${row.repo_rev} AND revalidate_after = ${row.lease}::timestamptz
        RETURNING did`),
    )
    if (written.length > 0 && !ok) this.options.log.warn({ did: row.did, reason }, 'a2a directory: a card no longer verifies; withheld')
  }

  /**
   * A record withheld as invalid when it arrived, checked again against the
   * DID document as it is now: a card checked before AppView's view of the
   * document named its key (the key goes in first, plan §4.6) is served
   * once it does. The event is the spool row the evidence cites, which
   * pruning spares while the card is withheld. On a pass it is served under
   * a compare-and-set on that same withheld event; on a failure the check's
   * reason is added to the evidence, never put in its place. Its caller has
   * registered the DID in `checking`: an identity event during the check
   * keeps the card withheld, marked for the next pass.
   */
  private async recheckWithheld(row: RevalidationRow, spoolId: number): Promise<void> {
    const { did, repo_rev: repoRev, lease } = row
    const spooled = rowsOf<SpoolRow>(
      await this.db.execute(sql`
        SELECT id, time_us, did, collection, rkey, repo_rev, operation, event_hash, payload, observed_gap_generation, attempts, received_at
          FROM a2a_event_spool WHERE id = ${spoolId} AND did = ${did} AND repo_rev = ${repoRev}`),
    )[0]
    // The event the evidence cites is gone: there is nothing to check it against.
    if (spooled === undefined) return this.revalidated(row)
    const commit = JSON.parse(spooled.payload) as { record?: unknown }
    const checked = await this.check(did, spooled.collection, spooled.rkey, commit.record)
    if (checked === 'unavailable') return this.revalidateLater(row)
    // The DID document changed while the record was being checked: the identity event's mark stands.
    if (this.checking.get(did) === true) return
    if (!checked.ok) {
      await this.db.execute(sql`
        UPDATE a2a_cards
           SET evidence_json = evidence_json || jsonb_build_object('revalidation', jsonb_build_object('reason', ${checked.reason}::text)),
               verified_at = ${new Date(this.now())}::timestamptz, needs_revalidation = false,
               identity_check_pending = false, revalidate_after = NULL, updated_at = now()
         WHERE did = ${did} AND repo_rev = ${repoRev} AND unavailable_reason = 'newer_invalid' AND last_spool_id = ${spoolId}
           AND revalidate_after = ${lease}::timestamptz`)
      return
    }
    const event: CardEvent = {
      operation: spooled.operation,
      rev: spooled.repo_rev,
      eventHash: spooled.event_hash,
      observedGapGeneration: Number(spooled.observed_gap_generation),
    }
    const wrote = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${didLockKey(did)}))`)
      const locked = await this.readCard(tx, did, true)
      if (locked === null || locked.repoRev !== repoRev) return false
      // An identity event since the check: the verdict was made against a document that is gone,
      // and serving the card would erase the event's mark. It stays withheld until checked again.
      if (this.checking.get(did) === true) return false
      const transition = decideReinstatement(locked, event, checked.card, await this.readGap(tx))
      try {
        await this.writeCard(
          tx,
          locked,
          transition,
          event,
          spooled,
          sql`c.repo_rev = EXCLUDED.repo_rev AND c.unavailable_reason = 'newer_invalid' AND c.last_spool_id = EXCLUDED.last_spool_id
              AND c.revalidate_after = ${lease}::timestamptz`,
        )
      } catch (err) {
        // The row moved on (a newer event, the withheld one no longer stands, or an identity event
        // took the lease): nothing to reinstate, and any new mark stands.
        if (err instanceof RowMoved) return false
        throw err
      }
      return true
    })
    if (wrote) {
      this.options.log.info({ did }, 'a2a directory: a withheld card verifies against the current DID document; served')
      await this.settleAfterCommit(did)
    }
  }

  /**
   * Hourly: the fallback for missed identity events (a card unchecked for a
   * day is checked again), and pruning processed spool rows.
   */
  private async sweep(): Promise<void> {
    if (this.now() - this.lastSweep < this.sweepEveryMs) return
    this.lastSweep = this.now()
    // Rows that standing evidence cites (a conflict, a withheld newer record) are kept with it.
    await this.db.execute(sql`
      DELETE FROM a2a_event_spool s
       WHERE s.status = 'done' AND s.processed_at < ${new Date(this.now() - SPOOL_KEEP_DONE_MS)}::timestamptz
         AND NOT EXISTS (SELECT 1 FROM a2a_cards c
                          WHERE c.unavailable AND c.evidence_json -> 'spool_ids' @> to_jsonb(s.id))`)
    // Every record there is to check (a stored one, or the withheld event a newer-invalid row cites) is checked once a day.
    await this.db.execute(sql`
      UPDATE a2a_cards SET needs_revalidation = true
       WHERE presence = 'present' AND NOT needs_revalidation
         AND (record_json IS NOT NULL OR unavailable_reason = 'newer_invalid')
         AND COALESCE(verified_at, '-infinity'::timestamptz) < ${new Date(this.now() - this.recheckAfterMs)}::timestamptz`)
  }
}

function outcomeOf(transition: CardTransition): string {
  switch (transition.kind) {
    case 'none':
      return transition.outcome
    case 'conflict':
      return 'conflict'
    case 'tombstone':
      return 'deleted'
    case 'upsert':
      return 'applied'
    case 'suppress':
      return `suppressed:${transition.reason}`
  }
}
