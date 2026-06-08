/**
 * PeerLens publish-job repository — durable CRUD + the state-machine
 * transitions, as compare-and-set operations (docs/PEERLENS_PUBLISH_JOBS_DESIGN.md).
 *
 * SYNC by design (like `WorkflowRepository`): the CAS claim, lease reclaim, and
 * the receipt+prune coupling need `db.run(... WHERE ... AND status=?)`
 * affected-rows + `db.transaction()` to complete before COMMIT — wrapping those
 * in promises buys nothing but microtask overhead. Pinned exempt from the
 * async-only port rule alongside `WorkflowRepository`.
 *
 * Two parity-tested implementations: `InMemoryReviewPublishRepository`
 * (Map-backed, the full logic — what unit tests drive) and
 * `SQLiteReviewPublishRepository` (real SQL against the identity DB). A single
 * contract suite runs against BOTH (incl. a real `NodeSQLiteAdapter`) so they
 * can't diverge.
 */

import {
  ACTIVE_STATUSES,
  OUTBOX_STATUSES,
  type ClassifiedError,
  type NewPublishJob,
  type PublishErrorCode,
  type PublishJob,
} from './publish_job';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';


export interface ReviewPublishRepository {
  /** Insert a fresh `queued` job. */
  create(job: NewPublishJob): void;
  /** CAS `queued → publishing`, stamping the worker lease. True iff this caller won. */
  claim(jobId: string, nowMs: number, leaseMs: number): boolean;
  /** Reclaim `publishing` rows whose lease lapsed (owner crashed) → `queued`,
   *  `attempts++`. Returns how many were reclaimed. */
  reclaimExpiredLeases(ownerDid: string, nowMs: number): number;
  /** CAS `publishing → published` (the service prunes in the same txn). */
  complete(jobId: string, uri: string, cid: string, nowMs: number): boolean;
  /** CAS `publishing → queued` on a retryable failure (backoff). */
  requeue(
    jobId: string,
    attempts: number,
    nextAttemptAt: number,
    err: ClassifiedError,
    nowMs: number,
  ): boolean;
  /** CAS `publishing → failed` on a permanent failure / exhausted retries. */
  fail(jobId: string, err: ClassifiedError, nowMs: number): boolean;
  /** CAS `failed → queued` (user "Try again"): resets attempts + backoff. */
  retry(jobId: string, nowMs: number): boolean;
  /** Delete a `queued` or `failed` job (user cancel). True iff a row was deleted. */
  discard(jobId: string): boolean;
  /** Unconditional delete — used after a `published` row's receipt is written. */
  prune(jobId: string): void;
  getById(jobId: string): PublishJob | null;
  /** The most-recent job for an originating chat draft — INCLUDING `published`
   *  (the card projects every post-submit state off this row). `null` once the
   *  draft was never submitted or its job was retention-pruned. */
  findLatestForDraft(ownerDid: string, threadId: string, draftId: string): PublishJob | null;
  /** Count of cap-occupying jobs (`queued` + `publishing`) for an identity. */
  countActive(ownerDid: string): number;
  /** Outbox rows (`queued` + `publishing` + `failed`) for an identity, FIFO. */
  listForOwner(ownerDid: string): PublishJob[];
  /** `queued` jobs due to attempt now (past their backoff gate), FIFO. */
  listDue(ownerDid: string, nowMs: number): PublishJob[];
  /** Retention escape hatch: delete `published` jobs whose receipt is older than
   *  `olderThanMs` (by `updated_at`). V1 keeps published rows (the receipt lives
   *  on the row), so this is unscheduled — exposed for a future policy. Returns
   *  the number pruned. */
  prunePublished(ownerDid: string, olderThanMs: number): number;
  /** Drop every row NOT owned by `ownerDid` (re-onboard housekeeping). */
  purgeForeign(ownerDid: string): void;
  /** Run `fn` atomically — lets the service couple a job write + a chat write. */
  transaction(fn: () => void): void;
  /** Subscribe to any mutation (fires once per committed change). */
  subscribe(cb: () => void): () => void;
}

let repo: ReviewPublishRepository | null = null;

export function setReviewPublishRepository(r: ReviewPublishRepository | null): void {
  repo = r;
}

export function getReviewPublishRepository(): ReviewPublishRepository | null {
  return repo;
}

// ── shared change-notification (suppressed inside a transaction) ───────────

class Notifier {
  private readonly listeners = new Set<() => void>();
  private depth = 0;
  private dirty = false;

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Mark a change; fires immediately unless inside a transaction (then on commit). */
  mark(): void {
    if (this.depth > 0) {
      this.dirty = true;
      return;
    }
    this.fire();
  }

  /** Run `fn`, deferring a single change notification to commit. On throw,
   *  the pending notification is DISCARDED (the txn rolled back) and the error
   *  re-propagates so the caller can restore/rollback its own state. */
  runInTxn(fn: () => void): void {
    this.depth++;
    let ok = false;
    try {
      fn();
      ok = true;
    } finally {
      this.depth--;
      if (this.depth === 0) {
        const shouldFire = ok && this.dirty;
        this.dirty = false;
        if (shouldFire) this.fire();
      }
    }
  }

  private fire(): void {
    for (const l of [...this.listeners]) l();
  }
}

// ── In-memory implementation (the full logic; what unit tests drive) ───────

/** Mutable internal shape (the interface exposes a readonly `PublishJob`). */
type MutableJob = { -readonly [K in keyof PublishJob]: PublishJob[K] };

export class InMemoryReviewPublishRepository implements ReviewPublishRepository {
  private readonly jobs = new Map<string, MutableJob>();
  private readonly notifier = new Notifier();

  create(job: NewPublishJob): void {
    if (this.jobs.has(job.jobId)) return; // idempotent
    this.jobs.set(job.jobId, {
      jobId: job.jobId,
      ownerDid: job.ownerDid,
      rkey: job.rkey,
      recordJSON: job.recordJSON,
      draftJSON: job.draftJSON,
      status: 'queued',
      attempts: 0,
      lastErrorCode: null,
      lastErrorMessage: null,
      nextAttemptAt: null,
      claimedAt: null,
      claimExpiresAt: null,
      threadId: job.threadId ?? null,
      draftId: job.draftId ?? null,
      publishedUri: null,
      publishedCid: null,
      dataScope: 'user',
      createdAt: job.createdAt,
      updatedAt: job.createdAt,
    });
    this.notifier.mark();
  }

  claim(jobId: string, nowMs: number, leaseMs: number): boolean {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== 'queued') return false;
    j.status = 'publishing';
    j.claimedAt = nowMs;
    j.claimExpiresAt = nowMs + leaseMs;
    j.updatedAt = nowMs;
    this.notifier.mark();
    return true;
  }

  reclaimExpiredLeases(ownerDid: string, nowMs: number): number {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (
        j.ownerDid === ownerDid &&
        j.status === 'publishing' &&
        j.claimExpiresAt !== null &&
        j.claimExpiresAt < nowMs
      ) {
        j.status = 'queued';
        j.attempts += 1;
        j.nextAttemptAt = nowMs;
        j.claimedAt = null;
        j.claimExpiresAt = null;
        j.lastErrorCode = 'lease_expired';
        j.lastErrorMessage = 'worker lease expired (owner crashed mid-publish)';
        j.updatedAt = nowMs;
        n++;
      }
    }
    if (n > 0) this.notifier.mark();
    return n;
  }

  complete(jobId: string, uri: string, cid: string, nowMs: number): boolean {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== 'publishing') return false;
    j.status = 'published';
    j.publishedUri = uri;
    j.publishedCid = cid;
    j.claimedAt = null;
    j.claimExpiresAt = null;
    j.lastErrorCode = null;
    j.lastErrorMessage = null;
    j.updatedAt = nowMs;
    this.notifier.mark();
    return true;
  }

  requeue(
    jobId: string,
    attempts: number,
    nextAttemptAt: number,
    err: ClassifiedError,
    nowMs: number,
  ): boolean {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== 'publishing') return false;
    j.status = 'queued';
    j.attempts = attempts;
    j.nextAttemptAt = nextAttemptAt;
    j.claimedAt = null;
    j.claimExpiresAt = null;
    j.lastErrorCode = err.code;
    j.lastErrorMessage = err.message;
    j.updatedAt = nowMs;
    this.notifier.mark();
    return true;
  }

  fail(jobId: string, err: ClassifiedError, nowMs: number): boolean {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== 'publishing') return false;
    j.status = 'failed';
    j.claimedAt = null;
    j.claimExpiresAt = null;
    j.lastErrorCode = err.code;
    j.lastErrorMessage = err.message;
    j.updatedAt = nowMs;
    this.notifier.mark();
    return true;
  }

  retry(jobId: string, nowMs: number): boolean {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== 'failed') return false;
    j.status = 'queued';
    j.attempts = 0;
    j.nextAttemptAt = null;
    j.lastErrorCode = null;
    j.lastErrorMessage = null;
    j.updatedAt = nowMs;
    this.notifier.mark();
    return true;
  }

  discard(jobId: string): boolean {
    const j = this.jobs.get(jobId);
    if (!j || (j.status !== 'queued' && j.status !== 'failed')) return false;
    this.jobs.delete(jobId);
    this.notifier.mark();
    return true;
  }

  prune(jobId: string): void {
    if (this.jobs.delete(jobId)) this.notifier.mark();
  }

  getById(jobId: string): PublishJob | null {
    const j = this.jobs.get(jobId);
    return j ? { ...j } : null;
  }

  findLatestForDraft(ownerDid: string, threadId: string, draftId: string): PublishJob | null {
    const matches = [...this.jobs.values()].filter(
      (j) => j.ownerDid === ownerDid && j.threadId === threadId && j.draftId === draftId,
    );
    if (matches.length === 0) return null;
    matches.sort(byCreatedThenId);
    return { ...matches[matches.length - 1] }; // most-recent job for the draft (any status)
  }

  countActive(ownerDid: string): number {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.ownerDid === ownerDid && ACTIVE_STATUSES.includes(j.status)) n++;
    }
    return n;
  }

  listForOwner(ownerDid: string): PublishJob[] {
    return [...this.jobs.values()]
      .filter((j) => j.ownerDid === ownerDid && OUTBOX_STATUSES.includes(j.status))
      .sort(byCreatedThenId)
      .map((j) => ({ ...j }));
  }

  listDue(ownerDid: string, nowMs: number): PublishJob[] {
    return [...this.jobs.values()]
      .filter(
        (j) =>
          j.ownerDid === ownerDid &&
          j.status === 'queued' &&
          (j.nextAttemptAt === null || j.nextAttemptAt <= nowMs),
      )
      .sort(byCreatedThenId)
      .map((j) => ({ ...j }));
  }

  prunePublished(ownerDid: string, olderThanMs: number): number {
    let n = 0;
    for (const [id, j] of this.jobs) {
      if (j.ownerDid === ownerDid && j.status === 'published' && j.updatedAt < olderThanMs) {
        this.jobs.delete(id);
        n++;
      }
    }
    if (n > 0) this.notifier.mark();
    return n;
  }

  purgeForeign(ownerDid: string): void {
    let changed = false;
    for (const [id, j] of this.jobs) {
      if (j.ownerDid !== ownerDid) {
        this.jobs.delete(id);
        changed = true;
      }
    }
    if (changed) this.notifier.mark();
  }

  transaction(fn: () => void): void {
    // Atomic like the SQLite impl: snapshot the rows, and on any throw restore
    // them so a coupled write (job + chat) is all-or-nothing in tests too.
    const snapshot = new Map([...this.jobs].map(([k, v]) => [k, { ...v }]));
    try {
      this.notifier.runInTxn(fn);
    } catch (err) {
      this.jobs.clear();
      for (const [k, v] of snapshot) this.jobs.set(k, v);
      throw err;
    }
  }

  subscribe(cb: () => void): () => void {
    return this.notifier.subscribe(cb);
  }
}

function byCreatedThenId(a: PublishJob, b: PublishJob): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
}

// ── SQLite implementation (real SQL; parity-tested against the InMemory one) ─

interface JobRow extends DBRow {
  job_id: string;
  owner_did: string;
  rkey: string;
  record_json: string;
  draft_json: string;
  status: string;
  attempts: number;
  last_error_code: string | null;
  last_error_message: string | null;
  next_attempt_at: number | null;
  claimed_at: number | null;
  claim_expires_at: number | null;
  thread_id: string | null;
  draft_id: string | null;
  published_uri: string | null;
  published_cid: string | null;
  data_scope: string;
  created_at: number;
  updated_at: number;
}

/** Exported for tests: map a DB row to the domain object. */
export function rowToPublishJob(r: JobRow): PublishJob {
  return {
    jobId: String(r.job_id),
    ownerDid: String(r.owner_did),
    rkey: String(r.rkey),
    recordJSON: String(r.record_json),
    draftJSON: String(r.draft_json),
    status: r.status as PublishJob['status'],
    attempts: Number(r.attempts),
    lastErrorCode: (r.last_error_code as PublishErrorCode | null) ?? null,
    lastErrorMessage: r.last_error_message ?? null,
    nextAttemptAt: r.next_attempt_at === null ? null : Number(r.next_attempt_at),
    claimedAt: r.claimed_at === null ? null : Number(r.claimed_at),
    claimExpiresAt: r.claim_expires_at === null ? null : Number(r.claim_expires_at),
    threadId: r.thread_id ?? null,
    draftId: r.draft_id ?? null,
    publishedUri: r.published_uri ?? null,
    publishedCid: r.published_cid ?? null,
    dataScope: String(r.data_scope),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/**
 * Build a SQL IN-list from the domain status constants — a single source of
 * truth (the statuses are a fixed internal enum, NEVER user input, so building
 * the literal is injection-safe). Derived from `ACTIVE_STATUSES`/`OUTBOX_STATUSES`
 * so the SQL can't drift from the in-memory repo's `.includes()` checks.
 */
function sqlInList(statuses: readonly string[]): string {
  return `(${statuses.map((s) => `'${s}'`).join(',')})`;
}
const ACTIVE_SQL = sqlInList(ACTIVE_STATUSES);
const OUTBOX_SQL = sqlInList(OUTBOX_STATUSES);

export class SQLiteReviewPublishRepository implements ReviewPublishRepository {
  private readonly notifier = new Notifier();

  constructor(private readonly db: DatabaseAdapter) {}

  create(job: NewPublishJob): void {
    this.db.execute(
      `INSERT OR IGNORE INTO peerlens_publish_jobs
         (job_id, owner_did, rkey, record_json, draft_json, status, attempts,
          thread_id, draft_id, data_scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, 'user', ?, ?)`,
      [
        job.jobId,
        job.ownerDid,
        job.rkey,
        job.recordJSON,
        job.draftJSON,
        job.threadId ?? null,
        job.draftId ?? null,
        job.createdAt,
        job.createdAt,
      ],
    );
    this.notifier.mark();
  }

  claim(jobId: string, nowMs: number, leaseMs: number): boolean {
    const affected = this.db.run(
      `UPDATE peerlens_publish_jobs
          SET status='publishing', claimed_at=?, claim_expires_at=?, updated_at=?
        WHERE job_id=? AND status='queued'`,
      [nowMs, nowMs + leaseMs, nowMs, jobId],
    );
    if (affected > 0) this.notifier.mark();
    return affected > 0;
  }

  reclaimExpiredLeases(ownerDid: string, nowMs: number): number {
    const affected = this.db.run(
      `UPDATE peerlens_publish_jobs
          SET status='queued', attempts=attempts+1, next_attempt_at=?,
              claimed_at=NULL, claim_expires_at=NULL,
              last_error_code='lease_expired',
              last_error_message='worker lease expired (owner crashed mid-publish)',
              updated_at=?
        WHERE owner_did=? AND status='publishing' AND claim_expires_at < ?`,
      [nowMs, nowMs, ownerDid, nowMs],
    );
    if (affected > 0) this.notifier.mark();
    return affected;
  }

  complete(jobId: string, uri: string, cid: string, nowMs: number): boolean {
    const affected = this.db.run(
      `UPDATE peerlens_publish_jobs
          SET status='published', published_uri=?, published_cid=?,
              claimed_at=NULL, claim_expires_at=NULL,
              last_error_code=NULL, last_error_message=NULL, updated_at=?
        WHERE job_id=? AND status='publishing'`,
      [uri, cid, nowMs, jobId],
    );
    if (affected > 0) this.notifier.mark();
    return affected > 0;
  }

  requeue(
    jobId: string,
    attempts: number,
    nextAttemptAt: number,
    err: ClassifiedError,
    nowMs: number,
  ): boolean {
    const affected = this.db.run(
      `UPDATE peerlens_publish_jobs
          SET status='queued', attempts=?, next_attempt_at=?,
              claimed_at=NULL, claim_expires_at=NULL,
              last_error_code=?, last_error_message=?, updated_at=?
        WHERE job_id=? AND status='publishing'`,
      [attempts, nextAttemptAt, err.code, err.message, nowMs, jobId],
    );
    if (affected > 0) this.notifier.mark();
    return affected > 0;
  }

  fail(jobId: string, err: ClassifiedError, nowMs: number): boolean {
    const affected = this.db.run(
      `UPDATE peerlens_publish_jobs
          SET status='failed', claimed_at=NULL, claim_expires_at=NULL,
              last_error_code=?, last_error_message=?, updated_at=?
        WHERE job_id=? AND status='publishing'`,
      [err.code, err.message, nowMs, jobId],
    );
    if (affected > 0) this.notifier.mark();
    return affected > 0;
  }

  retry(jobId: string, nowMs: number): boolean {
    const affected = this.db.run(
      `UPDATE peerlens_publish_jobs
          SET status='queued', attempts=0, next_attempt_at=NULL,
              last_error_code=NULL, last_error_message=NULL, updated_at=?
        WHERE job_id=? AND status='failed'`,
      [nowMs, jobId],
    );
    if (affected > 0) this.notifier.mark();
    return affected > 0;
  }

  discard(jobId: string): boolean {
    const affected = this.db.run(
      `DELETE FROM peerlens_publish_jobs WHERE job_id=? AND status IN ('queued','failed')`,
      [jobId],
    );
    if (affected > 0) this.notifier.mark();
    return affected > 0;
  }

  prune(jobId: string): void {
    const affected = this.db.run('DELETE FROM peerlens_publish_jobs WHERE job_id=?', [jobId]);
    if (affected > 0) this.notifier.mark();
  }

  getById(jobId: string): PublishJob | null {
    const rows = this.db.query<JobRow>('SELECT * FROM peerlens_publish_jobs WHERE job_id=?', [
      jobId,
    ]);
    return rows.length > 0 ? rowToPublishJob(rows[0]) : null;
  }

  findLatestForDraft(ownerDid: string, threadId: string, draftId: string): PublishJob | null {
    const rows = this.db.query<JobRow>(
      `SELECT * FROM peerlens_publish_jobs
        WHERE owner_did=? AND thread_id=? AND draft_id=?
        ORDER BY created_at DESC, job_id DESC LIMIT 1`,
      [ownerDid, threadId, draftId],
    );
    return rows.length > 0 ? rowToPublishJob(rows[0]) : null;
  }

  countActive(ownerDid: string): number {
    const rows = this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM peerlens_publish_jobs WHERE owner_did=? AND status IN ${ACTIVE_SQL}`,
      [ownerDid],
    );
    return rows.length > 0 ? Number(rows[0].n) : 0;
  }

  listForOwner(ownerDid: string): PublishJob[] {
    return this.db
      .query<JobRow>(
        `SELECT * FROM peerlens_publish_jobs
          WHERE owner_did=? AND status IN ${OUTBOX_SQL}
          ORDER BY created_at ASC, job_id ASC`,
        [ownerDid],
      )
      .map(rowToPublishJob);
  }

  listDue(ownerDid: string, nowMs: number): PublishJob[] {
    return this.db
      .query<JobRow>(
        `SELECT * FROM peerlens_publish_jobs
          WHERE owner_did=? AND status='queued'
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY created_at ASC, job_id ASC`,
        [ownerDid, nowMs],
      )
      .map(rowToPublishJob);
  }

  prunePublished(ownerDid: string, olderThanMs: number): number {
    const affected = this.db.run(
      `DELETE FROM peerlens_publish_jobs
        WHERE owner_did=? AND status='published' AND updated_at < ?`,
      [ownerDid, olderThanMs],
    );
    if (affected > 0) this.notifier.mark();
    return affected;
  }

  purgeForeign(ownerDid: string): void {
    const affected = this.db.run('DELETE FROM peerlens_publish_jobs WHERE owner_did != ?', [
      ownerDid,
    ]);
    if (affected > 0) this.notifier.mark();
  }

  transaction(fn: () => void): void {
    this.notifier.runInTxn(() => this.db.transaction(fn));
  }

  subscribe(cb: () => void): () => void {
    return this.notifier.subscribe(cb);
  }
}
