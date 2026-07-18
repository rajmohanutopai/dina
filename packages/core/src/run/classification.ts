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
    return (
      this.db.run(
        `UPDATE run_classification_jobs
           SET state = 'classified', tier_candidate = ?, updated_at = ?
         WHERE message_id = ? AND state = 'pending' AND message_revision = ? AND lease_token = ?`,
        [tierCandidate, nowMs, messageId, messageRevision, leaseToken],
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
    if (!this.jobs.report(messageId, messageRevision, leaseToken, tierCandidate, nowMs)) {
      return 'rejected';
    }
    const run = this.runs.getById(msg.run_id);
    const ceiling: PriorityCeiling = run?.priority_ceiling ?? 'solicited';
    const result = computeFinalTier({
      kind: 'informational',
      brainCandidate: tierCandidate,
      priorityCeiling: ceiling,
      timedOut: false,
    });
    this.messages.transition(messageId, 'classification_pending', 'classified', nowMs);
    this.messages.setTier(
      messageId,
      {
        tier_candidate: tierCandidate,
        ...(result !== null ? { final_tier: result.tier, tier_source: result.tier_source } : {}),
      },
      nowMs,
    );
    return 'ok';
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
    this.jobs.timeout(messageId, nowMs);
    const result = computeFinalTier({
      kind: 'informational',
      brainCandidate: null,
      priorityCeiling: ceiling,
      timedOut: true,
    });
    this.messages.transition(messageId, 'classification_pending', 'classified', nowMs);
    if (result !== null) {
      this.messages.setTier(messageId, { final_tier: result.tier, tier_source: result.tier_source }, nowMs);
    }
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
    if (run.state === 'draining' && run.drain_strength === 'permissive') return true;
    return false;
  }
}
