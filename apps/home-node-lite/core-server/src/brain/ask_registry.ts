/**
 * Tasks 5.19 + 5.20 — Ask registry state machine + persistence.
 *
 * Brain's `POST /api/v1/ask` is async: the handler fast-paths for 3
 * seconds and, if the answer isn't ready, returns `202 + request_id`.
 * Clients poll `GET /api/v1/ask/:id/status`. The ask registry tracks
 * every in-flight ask across that async window and past crashes.
 *
 * **State machine** (pinned by tests):
 *
 *   in_flight ─────┬─────► complete         (answer ready)
 *                  ├─────► failed           (LLM / network error)
 *                  ├─────► expired          (TTL elapsed without resolution)
 *                  └─────► pending_approval (vault access needs operator sign-off)
 *
 *   pending_approval ──► in_flight          (operator approved, retry)
 *                    ──► failed             (operator denied)
 *
 * Every other transition throws.
 *
 * **TTL reaper**: asks that sit `in_flight` or `pending_approval`
 * past their deadline transition to `expired`. Caller drives the
 * reaper on a cadence (production wires `SupervisedLoop` from 4.90;
 * tests call `sweepExpired()` directly). Reaping is idempotent.
 *
 * **Persistence layer** (task 5.20): pluggable
 * `AskPersistenceAdapter` with the same 5-method contract as
 * `WorkflowPersistenceAdapter` (task 4.82). In-memory adapter ships;
 * SQLCipher variant lands with `@dina/storage-node`. Identical
 * crash-recovery semantics: on `restoreOnStartup()`, in_flight tasks
 * past their deadline flip to `expired`; pending_approval tasks
 * outlive restart (the operator decision wasn't crash-dependent).
 *
 * **Why a separate module from `workflow_persistence.ts`**: asks have
 * a richer state machine (4 terminal + 1 intermediate approval
 * state vs workflow's 2 terminal) AND Brain's HTTP handler owns
 * the TTL contract directly (unlike workflow's executor-driven
 * model). Sharing the adapter pattern but not the state machine
 * matches what each subsystem actually needs.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5b tasks 5.19 + 5.20.
 */

export type AskStatus =
  | 'in_flight'
  | 'complete'
  | 'failed'
  | 'expired'
  | 'pending_approval';

export interface AskRecord {
  readonly id: string;
  /** Opaque input preserved verbatim so the handler can log / replay. */
  readonly question: string;
  /** DID that submitted the ask — used for audit + rate-limit bucketing. */
  readonly requesterDid: string;
  status: AskStatus;
  readonly createdAtMs: number;
  updatedAtMs: number;
  /** ms since epoch; set at enqueue time; NOT mutated across transitions. */
  readonly deadlineMs: number;
  /** JSON-stringified answer when `complete`. */
  answerJson?: string;
  /** JSON-stringified error when `failed`. */
  errorJson?: string;
  /** Approval request id when `pending_approval`. Links to ApprovalRegistry (4.72). */
  approvalId?: string;
}

export interface AskEnqueueInput {
  id: string;
  question: string;
  requesterDid: string;
  /** TTL override (ms). Defaults to the registry-level default. */
  ttlMs?: number;
}

export interface AskPersistenceAdapter {
  insert(record: AskRecord): Promise<void>;
  update(record: AskRecord): Promise<void>;
  loadAll(): Promise<AskRecord[]>;
  get(id: string): Promise<AskRecord | null>;
  delete(id: string): Promise<boolean>;
}

export class InMemoryAskAdapter implements AskPersistenceAdapter {
  private readonly rows = new Map<string, AskRecord>();

  async insert(record: AskRecord): Promise<void> {
    if (this.rows.has(record.id)) {
      throw new Error(
        `InMemoryAskAdapter.insert: duplicate id ${JSON.stringify(record.id)}`,
      );
    }
    this.rows.set(record.id, cloneAsk(record));
  }

  async update(record: AskRecord): Promise<void> {
    if (!this.rows.has(record.id)) {
      throw new Error(
        `InMemoryAskAdapter.update: unknown id ${JSON.stringify(record.id)}`,
      );
    }
    this.rows.set(record.id, cloneAsk(record));
  }

  async loadAll(): Promise<AskRecord[]> {
    return Array.from(this.rows.values()).map(cloneAsk);
  }

  async get(id: string): Promise<AskRecord | null> {
    const row = this.rows.get(id);
    return row === undefined ? null : cloneAsk(row);
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

export const DEFAULT_ASK_TTL_MS = 60_000; // 60s — covers the 3s fast path + 57s poll window.

export interface AskRegistryOptions {
  adapter: AskPersistenceAdapter;
  /** Default TTL for `enqueue` when caller doesn't supply `ttlMs`. */
  defaultTtlMs?: number;
  /** Injectable clock (ms). Default `Date.now`. */
  nowMsFn?: () => number;
  /** Diagnostic hook — fires on every state transition. */
  onEvent?: (event: AskEvent) => void;
}

export type AskEvent =
  | { kind: 'enqueued'; id: string; requesterDid: string; deadlineMs: number }
  | { kind: 'completed'; id: string; durationMs: number }
  | { kind: 'failed'; id: string; error: string }
  | { kind: 'expired'; id: string; atMs: number; fromStatus: AskStatus }
  | { kind: 'pending_approval'; id: string; approvalId: string }
  | { kind: 'approval_resumed'; id: string }
  | { kind: 'purged'; id: string }
  | { kind: 'restored_expired'; id: string };

export interface AskRestoreSummary {
  loaded: number;
  expiredOnRestore: number;
  stillInFlight: number;
  stillPendingApproval: number;
  terminal: number;
}

export class AskRegistry {
  private readonly adapter: AskPersistenceAdapter;
  private readonly defaultTtlMs: number;
  private readonly nowMsFn: () => number;
  private readonly onEvent?: (event: AskEvent) => void;

  constructor(opts: AskRegistryOptions) {
    if (!opts.adapter) throw new Error('AskRegistry: adapter is required');
    const ttl = opts.defaultTtlMs ?? DEFAULT_ASK_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error(
        `AskRegistry: defaultTtlMs must be > 0 (got ${ttl})`,
      );
    }
    this.adapter = opts.adapter;
    this.defaultTtlMs = ttl;
    this.nowMsFn = opts.nowMsFn ?? Date.now;
    this.onEvent = opts.onEvent;
  }

  /** Create a new ask in `in_flight` state. */
  async enqueue(input: AskEnqueueInput): Promise<AskRecord> {
    if (!input.id || input.id.length === 0) {
      throw new Error('AskRegistry.enqueue: id is required');
    }
    if (typeof input.question !== 'string') {
      throw new Error('AskRegistry.enqueue: question must be a string');
    }
    if (!input.requesterDid || input.requesterDid.length === 0) {
      throw new Error('AskRegistry.enqueue: requesterDid is required');
    }
    const ttl = input.ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error(`AskRegistry.enqueue: ttlMs must be > 0 (got ${ttl})`);
    }
    const now = this.nowMsFn();
    const record: AskRecord = {
      id: input.id,
      question: input.question,
      requesterDid: input.requesterDid,
      status: 'in_flight',
      createdAtMs: now,
      updatedAtMs: now,
      deadlineMs: now + ttl,
    };
    await this.adapter.insert(record);
    this.onEvent?.({
      kind: 'enqueued',
      id: record.id,
      requesterDid: record.requesterDid,
      deadlineMs: record.deadlineMs,
    });
    return cloneAsk(record);
  }

  /** Transition `in_flight → complete` with the answer JSON. */
  async markComplete(id: string, answerJson: string): Promise<AskRecord> {
    const record = await this.requireRecord(id);
    if (record.status !== 'in_flight') {
      throw new Error(
        `AskRegistry.markComplete: id ${JSON.stringify(id)} is ${record.status} (need in_flight)`,
      );
    }
    const now = this.nowMsFn();
    record.status = 'complete';
    record.updatedAtMs = now;
    record.answerJson = answerJson;
    await this.adapter.update(record);
    this.onEvent?.({
      kind: 'completed',
      id,
      durationMs: now - record.createdAtMs,
    });
    return cloneAsk(record);
  }

  /** Transition `in_flight → failed` with the error JSON. */
  async markFailed(id: string, errorJson: string): Promise<AskRecord> {
    const record = await this.requireRecord(id);
    if (record.status !== 'in_flight' && record.status !== 'pending_approval') {
      throw new Error(
        `AskRegistry.markFailed: id ${JSON.stringify(id)} is ${record.status} (need in_flight or pending_approval)`,
      );
    }
    const now = this.nowMsFn();
    record.status = 'failed';
    record.updatedAtMs = now;
    record.errorJson = errorJson;
    await this.adapter.update(record);
    this.onEvent?.({ kind: 'failed', id, error: errorJson });
    return cloneAsk(record);
  }

  /** Transition `in_flight → pending_approval` with an approval id. */
  async markPendingApproval(id: string, approvalId: string): Promise<AskRecord> {
    if (!approvalId || approvalId.length === 0) {
      throw new Error('AskRegistry.markPendingApproval: approvalId is required');
    }
    const record = await this.requireRecord(id);
    if (record.status !== 'in_flight') {
      throw new Error(
        `AskRegistry.markPendingApproval: id ${JSON.stringify(id)} is ${record.status} (need in_flight)`,
      );
    }
    record.status = 'pending_approval';
    record.updatedAtMs = this.nowMsFn();
    record.approvalId = approvalId;
    await this.adapter.update(record);
    this.onEvent?.({ kind: 'pending_approval', id, approvalId });
    return cloneAsk(record);
  }

  /**
   * Resume `pending_approval → in_flight` after the operator
   * approved. Clears the `approvalId` since it's no longer relevant.
   */
  async resumeAfterApproval(id: string): Promise<AskRecord> {
    const record = await this.requireRecord(id);
    if (record.status !== 'pending_approval') {
      throw new Error(
        `AskRegistry.resumeAfterApproval: id ${JSON.stringify(id)} is ${record.status} (need pending_approval)`,
      );
    }
    record.status = 'in_flight';
    record.updatedAtMs = this.nowMsFn();
    delete record.approvalId;
    await this.adapter.update(record);
    this.onEvent?.({ kind: 'approval_resumed', id });
    return cloneAsk(record);
  }

  /**
   * Sweep `in_flight` + `pending_approval` asks past their deadline
   * to `expired`. Returns count swept. Idempotent.
   */
  async sweepExpired(): Promise<number> {
    const now = this.nowMsFn();
    const rows = await this.adapter.loadAll();
    let swept = 0;
    for (const row of rows) {
      if (
        (row.status === 'in_flight' || row.status === 'pending_approval') &&
        row.deadlineMs <= now
      ) {
        const fromStatus = row.status;
        row.status = 'expired';
        row.updatedAtMs = now;
        await this.adapter.update(row);
        this.onEvent?.({ kind: 'expired', id: row.id, atMs: now, fromStatus });
        swept++;
      }
    }
    return swept;
  }

  /**
   * Crash-recovery entry. Loads every persisted ask; any `in_flight`
   * past its deadline transitions to `expired` (TTL elapsed during
   * downtime). `in_flight` still within budget stays as-is —
   * production should wire a fresh-arrival resume path. `pending_approval`
   * is preserved: the operator's decision wasn't invalidated by the
   * crash.
   */
  async restoreOnStartup(): Promise<AskRestoreSummary> {
    const rows = await this.adapter.loadAll();
    const now = this.nowMsFn();
    const summary: AskRestoreSummary = {
      loaded: rows.length,
      expiredOnRestore: 0,
      stillInFlight: 0,
      stillPendingApproval: 0,
      terminal: 0,
    };
    for (const row of rows) {
      if (row.status === 'in_flight') {
        if (row.deadlineMs <= now) {
          row.status = 'expired';
          row.updatedAtMs = now;
          await this.adapter.update(row);
          this.onEvent?.({ kind: 'restored_expired', id: row.id });
          summary.expiredOnRestore += 1;
        } else {
          summary.stillInFlight += 1;
        }
      } else if (row.status === 'pending_approval') {
        summary.stillPendingApproval += 1;
      } else {
        summary.terminal += 1;
      }
    }
    return summary;
  }

  async get(id: string): Promise<AskRecord | null> {
    return this.adapter.get(id);
  }

  async listAll(): Promise<AskRecord[]> {
    const rows = await this.adapter.loadAll();
    rows.sort((a, b) => a.createdAtMs - b.createdAtMs);
    return rows;
  }

  /**
   * Purge a terminal record (complete / failed / expired). Throws on
   * unknown; returns false on non-terminal (caller must not lose
   * in-flight state).
   */
  async purge(id: string): Promise<boolean> {
    const record = await this.requireRecord(id);
    if (
      record.status !== 'complete' &&
      record.status !== 'failed' &&
      record.status !== 'expired'
    ) {
      return false;
    }
    const removed = await this.adapter.delete(id);
    if (removed) this.onEvent?.({ kind: 'purged', id });
    return removed;
  }

  private async requireRecord(id: string): Promise<AskRecord> {
    const record = await this.adapter.get(id);
    if (record === null) {
      throw new Error(`AskRegistry: id ${JSON.stringify(id)} not found`);
    }
    return record;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloneAsk(r: AskRecord): AskRecord {
  const clone: AskRecord = {
    id: r.id,
    question: r.question,
    requesterDid: r.requesterDid,
    status: r.status,
    createdAtMs: r.createdAtMs,
    updatedAtMs: r.updatedAtMs,
    deadlineMs: r.deadlineMs,
  };
  if (r.answerJson !== undefined) clone.answerJson = r.answerJson;
  if (r.errorJson !== undefined) clone.errorJson = r.errorJson;
  if (r.approvalId !== undefined) clone.approvalId = r.approvalId;
  return clone;
}
