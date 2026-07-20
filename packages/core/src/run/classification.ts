/**
 * Classification job + the Brain-classify boundary
 * (INTERACTIVE_SERVICES_ARCHITECTURE.md §6.2/§9.1/§12.6).
 *
 * Brain is a NON-load-bearing, pull-based classifier of open-persona
 * INFORMATIONAL messages. Its only two calls are `workerAcquire` (Core
 * CAS-checks the message is still classification_pending in an eligible run/drain
 * state, persona open, and leases the job) and `workerReport` (an idempotent,
 * lease-checked, downward-only candidate). Action messages skip Brain entirely —
 * Core assigns the Tier-2 base directly. A fence cancels the job so no fenced
 * card view is ever handed to Brain.
 */

import { computeFinalTier } from './delivery';
import { isRunTerminal, type PriorityCeiling, type RunRecord } from './domain';
import { getMessageRepository, type MessageRecord, type MessageRepository } from './message';
import { getRunRepository, type RunRepository } from './repository';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type ClassificationJobState = 'pending' | 'classified' | 'timed_out' | 'cancelled' | 'expired';

export interface ClassificationJobRecord {
  message_id: string;
  message_revision: number;
  state: ClassificationJobState;
  lease_token: string | null;
  lease_expires_at: number | null;
  tier_candidate: number | null;
  created_at: number;
  updated_at: number;
}

export interface ClassificationJobRepository {
  create(job: ClassificationJobRecord): void;
  getByMessage(messageId: string): ClassificationJobRecord | null;
  /** Pending jobs whose lease is free or expired (candidates for acquire). */
  listAcquirable(nowMs: number, limit?: number): ClassificationJobRecord[];
  /** ALL still-`pending` jobs (leased or not), oldest first — the classify-timeout
   *  sweep scans these to finalize any past its run's `classify_timeout_ms` (§9.1,
   *  F12), so Brain being slow/absent is never load-bearing. */
  listPending(limit?: number): ClassificationJobRecord[];
  /** A keyset PAGE of still-`pending` jobs strictly after the `(created_at,
   *  message_id)` cursor, oldest first. The sweep pages the ENTIRE pending set
   *  through this so a due job is never starved behind >`limit` earlier
   *  not-yet-due jobs (F12) — a single `listPending(limit)` window could hide
   *  due jobs beyond the first page behind long-timeout jobs that are not yet
   *  due. Pass `(-1, '')` for the first page. */
  listPendingAfter(
    afterCreatedAt: number,
    afterMessageId: string,
    limit?: number,
  ): ClassificationJobRecord[];
  /** CAS a lease onto a `pending` job (lease free or expired). */
  acquire(messageId: string, leaseToken: string, leaseExpiresAt: number, nowMs: number): boolean;
  /** CAS a candidate onto a leased `pending` job → `classified`. */
  report(
    messageId: string,
    messageRevision: number,
    leaseToken: string,
    tierCandidate: number,
    nowMs: number,
  ): boolean;
  /** CAS `pending → timed_out`. */
  timeout(messageId: string, nowMs: number): boolean;
  /** Fence: `pending → cancelled|expired`, invalidating any lease. */
  cancel(messageId: string, terminal: 'cancelled' | 'expired', nowMs: number): boolean;
  size(): number;
}

function rowToJob(row: DBRow): ClassificationJobRecord {
  return {
    message_id: String(row.message_id),
    message_revision: Number(row.message_revision),
    state: String(row.state) as ClassificationJobState,
    lease_token: row.lease_token === null || row.lease_token === undefined ? null : String(row.lease_token),
    lease_expires_at:
      row.lease_expires_at === null || row.lease_expires_at === undefined
        ? null
        : Number(row.lease_expires_at),
    tier_candidate:
      row.tier_candidate === null || row.tier_candidate === undefined ? null : Number(row.tier_candidate),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export class SQLiteClassificationJobRepository implements ClassificationJobRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  create(job: ClassificationJobRecord): void {
    this.db.execute(
      `INSERT INTO run_classification_jobs
         (message_id, message_revision, state, lease_token, lease_expires_at, tier_candidate, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        job.message_id,
        job.message_revision,
        job.state,
        job.lease_token,
        job.lease_expires_at,
        job.tier_candidate,
        job.created_at,
        job.updated_at,
      ],
    );
  }

  getByMessage(messageId: string): ClassificationJobRecord | null {
    const rows = this.db.query('SELECT * FROM run_classification_jobs WHERE message_id = ? LIMIT 1', [
      messageId,
    ]);
    return rows.length > 0 ? rowToJob(rows[0]) : null;
  }

  listPending(limit = 200): ClassificationJobRecord[] {
    return this.db
      .query(
        "SELECT * FROM run_classification_jobs WHERE state = 'pending' ORDER BY created_at ASC LIMIT ?",
        [limit],
      )
      .map(rowToJob);
  }

  listPendingAfter(afterCreatedAt: number, afterMessageId: string, limit = 200): ClassificationJobRecord[] {
    return this.db
      .query(
        `SELECT * FROM run_classification_jobs
          WHERE state = 'pending'
            AND (created_at > ? OR (created_at = ? AND message_id > ?))
          ORDER BY created_at ASC, message_id ASC
          LIMIT ?`,
        [afterCreatedAt, afterCreatedAt, afterMessageId, limit],
      )
      .map(rowToJob);
  }

  listAcquirable(nowMs: number, limit = 32): ClassificationJobRecord[] {
    return this.db
      .query(
        `SELECT * FROM run_classification_jobs
           WHERE state = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at < ?)
           ORDER BY created_at ASC LIMIT ?`,
        [nowMs, limit],
      )
      .map(rowToJob);
  }

  acquire(messageId: string, leaseToken: string, leaseExpiresAt: number, nowMs: number): boolean {
    return (
      this.db.run(
        `UPDATE run_classification_jobs
           SET lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE message_id = ? AND state = 'pending'
           AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
        [leaseToken, leaseExpiresAt, nowMs, messageId, nowMs],
      ) > 0
    );
  }

  report(
    messageId: string,
    messageRevision: number,
    leaseToken: string,
    tierCandidate: number,
    nowMs: number,
  ): boolean {
    // The lease must still be UNEXPIRED (§12.6): a report on a lapsed lease is
    // rejected even if the token still matches (the job was not re-acquired), so
    // stale Brain work can never finalize a tier after the lease window closed.
    return (
      this.db.run(
        `UPDATE run_classification_jobs
           SET state = 'classified', tier_candidate = ?, updated_at = ?
         WHERE message_id = ? AND state = 'pending' AND message_revision = ? AND lease_token = ?
           AND lease_expires_at IS NOT NULL AND lease_expires_at >= ?`,
        [tierCandidate, nowMs, messageId, messageRevision, leaseToken, nowMs],
      ) > 0
    );
  }

  timeout(messageId: string, nowMs: number): boolean {
    return (
      this.db.run(
        "UPDATE run_classification_jobs SET state = 'timed_out', updated_at = ? WHERE message_id = ? AND state = 'pending'",
        [nowMs, messageId],
      ) > 0
    );
  }

  cancel(messageId: string, terminal: 'cancelled' | 'expired', nowMs: number): boolean {
    return (
      this.db.run(
        "UPDATE run_classification_jobs SET state = ?, lease_token = NULL, updated_at = ? WHERE message_id = ? AND state = 'pending'",
        [terminal, nowMs, messageId],
      ) > 0
    );
  }

  size(): number {
    const rows = this.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM run_classification_jobs');
    return rows[0]?.n ?? 0;
  }
}

export class InMemoryClassificationJobRepository implements ClassificationJobRepository {
  private readonly jobs = new Map<string, ClassificationJobRecord>();
  create(job: ClassificationJobRecord): void {
    this.jobs.set(job.message_id, { ...job });
  }
  getByMessage(messageId: string): ClassificationJobRecord | null {
    const j = this.jobs.get(messageId);
    return j ? { ...j } : null;
  }
  listPending(limit = 200): ClassificationJobRecord[] {
    return [...this.jobs.values()]
      .filter((j) => j.state === 'pending')
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, limit)
      .map((j) => ({ ...j }));
  }
  listPendingAfter(afterCreatedAt: number, afterMessageId: string, limit = 200): ClassificationJobRecord[] {
    return [...this.jobs.values()]
      .filter(
        (j) =>
          j.state === 'pending' &&
          (j.created_at > afterCreatedAt ||
            (j.created_at === afterCreatedAt && j.message_id > afterMessageId)),
      )
      .sort((a, b) => a.created_at - b.created_at || (a.message_id < b.message_id ? -1 : 1))
      .slice(0, limit)
      .map((j) => ({ ...j }));
  }
  listAcquirable(nowMs: number, limit = 32): ClassificationJobRecord[] {
    return [...this.jobs.values()]
      .filter((j) => j.state === 'pending' && (j.lease_expires_at === null || j.lease_expires_at < nowMs))
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, limit)
      .map((j) => ({ ...j }));
  }
  acquire(messageId: string, leaseToken: string, leaseExpiresAt: number, nowMs: number): boolean {
    const j = this.jobs.get(messageId);
    if (!j || j.state !== 'pending') return false;
    if (j.lease_expires_at !== null && j.lease_expires_at >= nowMs) return false;
    j.lease_token = leaseToken;
    j.lease_expires_at = leaseExpiresAt;
    j.updated_at = nowMs;
    return true;
  }
  report(
    messageId: string,
    messageRevision: number,
    leaseToken: string,
    tierCandidate: number,
    nowMs: number,
  ): boolean {
    const j = this.jobs.get(messageId);
    if (!j || j.state !== 'pending' || j.message_revision !== messageRevision || j.lease_token !== leaseToken) {
      return false;
    }
    // Reject a report on a lapsed lease (§12.6) — mirrors the SQLite CAS.
    if (j.lease_expires_at === null || j.lease_expires_at < nowMs) return false;
    j.state = 'classified';
    j.tier_candidate = tierCandidate;
    j.updated_at = nowMs;
    return true;
  }
  timeout(messageId: string, nowMs: number): boolean {
    const j = this.jobs.get(messageId);
    if (!j || j.state !== 'pending') return false;
    j.state = 'timed_out';
    j.updated_at = nowMs;
    return true;
  }
  cancel(messageId: string, terminal: 'cancelled' | 'expired', nowMs: number): boolean {
    const j = this.jobs.get(messageId);
    if (!j || j.state !== 'pending') return false;
    j.state = terminal;
    j.lease_token = null;
    j.updated_at = nowMs;
    return true;
  }
  size(): number {
    return this.jobs.size;
  }
}

let jobRepoSingleton: ClassificationJobRepository | null = null;
export function setClassificationJobRepository(r: ClassificationJobRepository | null): void {
  jobRepoSingleton = r;
}
export function getClassificationJobRepository(): ClassificationJobRepository | null {
  return jobRepoSingleton;
}

// ---------------------------------------------------------------------------
// The classify service (Core-owned mechanics + the Brain boundary)
// ---------------------------------------------------------------------------

/** The bounded, size-limited view Core hands Brain (§6.2). NO vault context, NO
 *  `params` — only the card's permitted display text + the content digest. */
export interface ClassificationView {
  message_id: string;
  message_revision: number;
  kind: 'informational';
  title: string;
  body: string;
  content_digest: string;
}

export interface WorkerAcquireResult {
  message_id: string;
  message_revision: number;
  classification_view: ClassificationView;
  lease_token: string;
}

export interface RunClassifyServiceOptions {
  messageRepo?: MessageRepository;
  jobRepo?: ClassificationJobRepository;
  runRepo?: RunRepository;
  nowMsFn?: () => number;
  idFn?: () => string;
  /** Whether the run's persona is currently open (§12.6). Default: open. */
  isPersonaOpen?: (persona: string) => boolean;
  /** Build the bounded classification view for a message (title/body from its
   *  card). Default returns empty display text (payload wiring is composed in). */
  buildClassificationView?: (message: MessageRecord) => { title: string; body: string; content_digest: string };
  leaseMs?: number;
  /** Runs a classify mutation atomically (rollback on throw). Default is a
   *  passthrough; boot passes the SQLite `db.transaction` so the paired
   *  `classification_pending → classified` + `setTier` writes commit as ONE step
   *  (§6.3 "atomically transitions ... at the fallback tier") and a crash can
   *  never strand a message `classified` with a null `final_tier`. */
  tx?: (fn: () => void) => void;
  /**
   * R5-02 — fired AFTER a message durably reaches `classified` (action base,
   * worker report, or classify-timeout fallback). The boots wire this to the
   * notification inbox so every classified message lands a retained Activity
   * entry (§9.1 — the entry is never removed; banner loudness is the inbox's
   * downstream concern). Best-effort: a sink throw never fails classification.
   */
  onClassified?: (message: MessageRecord, run: RunRecord) => void;
}

export class RunClassifyService {
  private readonly messages: MessageRepository;
  private readonly jobs: ClassificationJobRepository;
  private readonly runs: RunRepository;
  private readonly now: () => number;
  private readonly nextId: () => string;
  private readonly personaOpen: (persona: string) => boolean;
  private readonly viewOf: (m: MessageRecord) => { title: string; body: string; content_digest: string };
  private readonly leaseMs: number;
  private readonly tx: (fn: () => void) => void;
  private readonly onClassified: ((message: MessageRecord, run: RunRecord) => void) | undefined;
  private seq = 0;

  constructor(opts: RunClassifyServiceOptions = {}) {
    const messages = opts.messageRepo ?? getMessageRepository();
    const jobs = opts.jobRepo ?? getClassificationJobRepository();
    const runs = opts.runRepo ?? getRunRepository();
    if (messages === null || jobs === null || runs === null) {
      throw new Error('RunClassifyService: message + job + run repositories must be wired');
    }
    this.messages = messages;
    this.jobs = jobs;
    this.runs = runs;
    this.now = opts.nowMsFn ?? (() => Date.now());
    this.nextId = opts.idFn ?? (() => `lease-${(++this.seq).toString(36)}-${this.now().toString(36)}`);
    this.personaOpen = opts.isPersonaOpen ?? (() => true);
    this.viewOf = opts.buildClassificationView ?? (() => ({ title: '', body: '', content_digest: '' }));
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.tx = opts.tx ?? ((fn) => fn());
    this.onClassified = opts.onClassified;
  }

  /** Fire the post-commit classified sink, isolated (never fails the caller). */
  private fireClassified(messageId: string): void {
    if (this.onClassified === undefined) return;
    const msg = this.messages.getById(messageId);
    if (msg === null || msg.state !== 'classified') return;
    const run = this.runs.getById(msg.run_id);
    if (run === null) return;
    try {
      this.onClassified(msg, run);
    } catch {
      /* the notification sink is best-effort — classification already committed */
    }
  }

  /**
   * Begin classification for a freshly-enqueued message (§6.3). An ACTION takes
   * the Tier-2 base directly (no Brain job); an INFORMATIONAL message enters
   * classification_pending and gets a durable pull job.
   */
  beginClassification(messageId: string): void {
    const msg = this.messages.getById(messageId);
    if (msg === null || msg.state !== 'enqueued') return;
    const run = this.runs.getById(msg.run_id);
    if (run === null) return;
    const nowMs = this.now();

    // One atomic step: the entry transition + (action: classified + tier | info:
    // job create). A crash can never leave the message classification_pending
    // with neither a tier nor a job, or classified with a null tier (§6.3).
    this.tx(() => {
      if (!this.messages.transition(messageId, 'enqueued', 'classification_pending', nowMs)) return;

      if (msg.kind === 'action') {
        // Core assigns the action Tier-2 base + owner ceiling clamp, then marks
        // classified without ever consulting Brain (§9.1).
        const result = computeFinalTier({
          kind: 'action',
          brainCandidate: null,
          priorityCeiling: run.priority_ceiling,
          timedOut: false,
        });
        this.messages.transition(messageId, 'classification_pending', 'classified', nowMs);
        if (result !== null) {
          this.messages.setTier(
            messageId,
            { final_tier: result.tier, tier_source: result.tier_source },
            nowMs,
          );
        }
        return;
      }

      // Informational → a durable classification job Brain will pull.
      this.jobs.create({
        message_id: messageId,
        message_revision: 1,
        state: 'pending',
        lease_token: null,
        lease_expires_at: null,
        tier_candidate: null,
        created_at: nowMs,
        updated_at: nowMs,
      });
    });
    // R5-02 — an ACTION classifies inside the tx above; surface it post-commit.
    // (An informational message fires later, from workerReport/finalizeTimeout.)
    if (msg.kind === 'action') this.fireClassified(messageId);
  }

  /** Brain pull #1 (§12.6): acquire the next eligible informational job. */
  workerAcquire(): WorkerAcquireResult | null {
    const nowMs = this.now();
    for (const job of this.jobs.listAcquirable(nowMs)) {
      const msg = this.messages.getById(job.message_id);
      if (msg === null || msg.state !== 'classification_pending' || msg.kind !== 'informational') continue;
      const run = this.runs.getById(msg.run_id);
      if (run === null || !this.runEligible(run, nowMs) || !this.personaOpen(run.persona)) continue;

      const leaseToken = this.nextId();
      if (!this.jobs.acquire(job.message_id, leaseToken, nowMs + this.leaseMs, nowMs)) continue;

      const view = this.viewOf(msg);
      return {
        message_id: msg.message_id,
        message_revision: job.message_revision,
        classification_view: {
          message_id: msg.message_id,
          message_revision: job.message_revision,
          kind: 'informational',
          title: view.title,
          body: view.body,
          content_digest: view.content_digest,
        },
        lease_token: leaseToken,
      };
    }
    return null;
  }

  /**
   * Brain pull #2 (§12.6): report a downward tier candidate. Idempotent by
   * (message_id, message_revision); a stale lease or a fenced/terminal message
   * is rejected. Records the candidate + finalizes the message tier.
   */
  workerReport(
    messageId: string,
    messageRevision: number,
    leaseToken: string,
    tierCandidate: number,
  ): 'ok' | 'rejected' {
    const nowMs = this.now();
    const msg = this.messages.getById(messageId);
    if (msg === null || msg.state !== 'classification_pending' || msg.kind !== 'informational') {
      return 'rejected';
    }
    const run = this.runs.getById(msg.run_id);
    // Recheck run eligibility + persona-open at REPORT time (§12.6 fence-aware,
    // non-load-bearing): a fenced / past-deadline run, or a persona that locked
    // after the job was acquired, must not let stale Brain work finalize a tier —
    // the classify_timeout fallback / fence path owns the message from here.
    if (run === null || !this.runEligible(run, nowMs) || !this.personaOpen(run.persona)) {
      return 'rejected';
    }
    const ceiling: PriorityCeiling = run.priority_ceiling;
    const result = computeFinalTier({
      kind: 'informational',
      brainCandidate: tierCandidate,
      priorityCeiling: ceiling,
      timedOut: false,
    });

    // The job-report CAS + the classified transition + the tier write commit as
    // ONE step (§6.3): a crash can never record the candidate but leave the
    // message classification_pending, or mark it classified with a null tier.
    let outcome: 'ok' | 'rejected' = 'rejected';
    this.tx(() => {
      if (!this.jobs.report(messageId, messageRevision, leaseToken, tierCandidate, nowMs)) return;
      this.messages.transition(messageId, 'classification_pending', 'classified', nowMs);
      this.messages.setTier(
        messageId,
        {
          tier_candidate: tierCandidate,
          ...(result !== null ? { final_tier: result.tier, tier_source: result.tier_source } : {}),
        },
        nowMs,
      );
      outcome = 'ok';
    });
    // R5-02 — surface the freshly-classified informational message post-commit.
    // Unconditional: fireClassified re-reads state and fires only when the
    // message is actually `classified` (a rejected report on an already-
    // classified message just re-upserts the idempotent entry).
    this.fireClassified(messageId);
    return outcome;
  }

  /**
   * classify_timeout fallback (§9.1): finalize an informational message at the
   * owner ceiling if it is still classification_pending. Job → timed_out.
   */
  finalizeTimeout(messageId: string): void {
    const nowMs = this.now();
    const msg = this.messages.getById(messageId);
    if (msg === null || msg.state !== 'classification_pending') return;
    const run = this.runs.getById(msg.run_id);
    const ceiling: PriorityCeiling = run?.priority_ceiling ?? 'solicited';
    const result = computeFinalTier({
      kind: 'informational',
      brainCandidate: null,
      priorityCeiling: ceiling,
      timedOut: true,
    });
    // The job timeout + the classified transition + the tier write commit as ONE
    // step (§6.3 "classify_timeout atomically transitions ... at the fallback
    // tier"): a crash can never leave the message classified with a null tier.
    this.tx(() => {
      this.jobs.timeout(messageId, nowMs);
      this.messages.transition(messageId, 'classification_pending', 'classified', nowMs);
      if (result !== null) {
        this.messages.setTier(messageId, { final_tier: result.tier, tier_source: result.tier_source }, nowMs);
      }
    });
    // R5-02 — surface the timeout-finalized message post-commit (fireClassified
    // re-reads state, so a fenced/failed transition fires nothing).
    this.fireClassified(messageId);
  }

  /**
   * Drive the classify-timeout fallback (§9.1/§12.6, F12) — the piece that makes
   * Brain NON-load-bearing. Scans still-`pending` jobs and finalizes every message
   * whose classification window (`run.classify_timeout_ms` from the job's
   * `created_at`) has elapsed, at the fallback (ceiling) tier. Deterministic; the
   * boot loop / sweeper calls this on a cadence. Without it an absent or failing
   * Brain would strand informational messages `classification_pending` forever.
   * Returns the number finalized.
   */
  sweepTimeouts(pageLimit = 200): number {
    const nowMs = this.now();
    let finalized = 0;
    // Page the ENTIRE pending set by the (created_at, message_id) keyset (F12).
    // A single `listPending(limit)` window could hide a DUE job behind >limit
    // earlier jobs whose longer `classify_timeout_ms` has not elapsed (7 max-cap
    // runs can hold >200 pending jobs); the keyset advances past every scanned
    // row — due or not — so one call finalizes every currently-due job. Finalizing
    // removes a job from `pending`, so the cursor never revisits it.
    let cursorCreatedAt = -1;
    let cursorMessageId = '';
    for (;;) {
      const page = this.jobs.listPendingAfter(cursorCreatedAt, cursorMessageId, pageLimit);
      if (page.length === 0) break;
      for (const job of page) {
        cursorCreatedAt = job.created_at;
        cursorMessageId = job.message_id;
        const msg = this.messages.getById(job.message_id);
        if (msg === null || msg.state !== 'classification_pending') continue;
        const run = this.runs.getById(msg.run_id);
        if (run === null) continue;
        // The window opened when the job was created (enqueue-commit → begin classify).
        if (nowMs > job.created_at + run.classify_timeout_ms) {
          // §18 hard bounds: NEVER classify content past the run's eligibility
          // (terminal / past hard-TTL / fencing-draining) or past the message's
          // own signed `expires_at`. Such work is fenced → `expired` by the
          // run-TTL barrier (RunSweeper) + termination, which cancels this job;
          // the timeout fallback must not surface stale content as a fresh
          // `classified` decision (§6.3/§18, INTERACTIVE:223,473).
          if (!this.runEligible(run, nowMs) || nowMs >= msg.expires_at) continue;
          this.finalizeTimeout(job.message_id);
          finalized++;
        }
      }
      if (page.length < pageLimit) break;
    }
    return finalized;
  }

  /** Fence a message's classification job (barrier, §5.1/§12.6) so no fenced
   *  view is handed to Brain. Called alongside message fencing. */
  fenceJob(messageId: string, terminal: 'cancelled' | 'expired'): void {
    this.jobs.cancel(messageId, terminal, this.now());
  }

  private runEligible(run: RunRecord, nowMs: number): boolean {
    if (isRunTerminal(run.state)) return false;
    if (nowMs >= run.expires_at) return false;
    // active, or a permissive drain (a fencing drain cancels the job, §12.6).
    if (run.state === 'active') return true;
    if (run.state === 'draining' && run.drain_strength === 'permissive') {
      // A permissive drain past its `drain_deadline_at` is shedding — no new
      // classification is offered (§18 "hard bounds in guards").
      return run.drain_deadline_at === null || nowMs < run.drain_deadline_at;
    }
    return false;
  }
}
