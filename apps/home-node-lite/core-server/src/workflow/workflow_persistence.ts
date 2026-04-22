/**
 * Task 4.82 — long-running workflow persistence.
 *
 * In-flight workflow tasks (service queries, long reason calls, delegated
 * agent operations) must survive a process restart. Without persistence,
 * a crash or SIGTERM mid-flight means the caller never gets a response
 * and the vault writes that were in progress are lost.
 *
 * **Model**:
 *   - A `WorkflowTask` carries `{id, kind, payload, status, attempts,
 *     createdAtMs, updatedAtMs, completedAtMs?, resultJson?, errorJson?}`.
 *   - Status machine: `pending → running → completed | failed`
 *     (+ restored-to-pending on process startup so any `running` task
 *     that was interrupted mid-execution gets re-queued).
 *   - Persistence is pluggable via `WorkflowPersistenceAdapter` — the
 *     in-memory adapter shipped here covers tests; the SQLCipher
 *     adapter lands with `@dina/storage-node` using the same interface.
 *
 * **Crash recovery**: on `restoreOnStartup()` we load every task the
 * adapter has, demote any `running` entries back to `pending` (they
 * didn't reach a terminal state, so replay is safe), and leave
 * terminal entries alone. The caller (boot.ts) then re-queues the
 * pendings into whatever executor pool it has.
 *
 * **Why "demote running → pending" on startup**: the alternative
 * would be marking them `failed`, but that surfaces as a user-visible
 * error when the system can safely retry. Idempotent handlers (the
 * only kind Dina accepts for workflow tasks — see workflow_runner.ts
 * design) are replay-safe by contract.
 *
 * **No in-process queue**: this module owns the *store*, not the
 * executor. The executor (future task) takes pending tasks off the
 * store, calls the handler, writes back the terminal state. Separating
 * store from executor keeps the persistence surface thin + testable.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4l task 4.82.
 */

export type WorkflowTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

export interface WorkflowTask {
  readonly id: string;
  /** Handler namespace key — e.g. `service_query_execution`. */
  readonly kind: string;
  /** JSON-stringified arbitrary payload for the handler. */
  readonly payload: string;
  status: WorkflowTaskStatus;
  attempts: number;
  readonly createdAtMs: number;
  updatedAtMs: number;
  /** Set when status is `completed` or `failed`. */
  completedAtMs?: number;
  /** JSON-stringified result when `completed`. */
  resultJson?: string;
  /** JSON-stringified error when `failed`. */
  errorJson?: string;
}

export interface WorkflowTaskInput {
  id: string;
  kind: string;
  payload: string;
}

/**
 * Storage adapter — the contract between the registry and a concrete
 * backend. In-memory adapter is exported below; SQLCipher adapter
 * lands with `@dina/storage-node`.
 */
export interface WorkflowPersistenceAdapter {
  /** Persist a new task (INSERT-equivalent). */
  insert(task: WorkflowTask): Promise<void>;
  /** Persist an existing task's state changes (UPDATE-equivalent). */
  update(task: WorkflowTask): Promise<void>;
  /** Load all tasks. Used on startup for restore + on demand for admin UI. */
  loadAll(): Promise<WorkflowTask[]>;
  /** Fetch a single task by id. */
  get(id: string): Promise<WorkflowTask | null>;
  /** Delete by id — used for terminal-state cleanup after TTL. */
  delete(id: string): Promise<boolean>;
}

/**
 * In-memory adapter. Matches the interface byte-for-byte; swap in
 * `SqliteWorkflowAdapter` from `@dina/storage-node` when it lands.
 *
 * Defensive-copies on write so the registry can't mutate a caller's
 * object via back-reference, and vice versa.
 */
export class InMemoryWorkflowAdapter implements WorkflowPersistenceAdapter {
  private readonly rows = new Map<string, WorkflowTask>();

  async insert(task: WorkflowTask): Promise<void> {
    if (this.rows.has(task.id)) {
      throw new Error(
        `InMemoryWorkflowAdapter.insert: duplicate id ${JSON.stringify(task.id)}`,
      );
    }
    this.rows.set(task.id, cloneTask(task));
  }

  async update(task: WorkflowTask): Promise<void> {
    if (!this.rows.has(task.id)) {
      throw new Error(
        `InMemoryWorkflowAdapter.update: unknown id ${JSON.stringify(task.id)}`,
      );
    }
    this.rows.set(task.id, cloneTask(task));
  }

  async loadAll(): Promise<WorkflowTask[]> {
    return Array.from(this.rows.values()).map(cloneTask);
  }

  async get(id: string): Promise<WorkflowTask | null> {
    const row = this.rows.get(id);
    return row === undefined ? null : cloneTask(row);
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  /** Test-only helper: clears everything. Not part of the adapter contract. */
  _reset(): void {
    this.rows.clear();
  }
}

export interface WorkflowRegistryOptions {
  adapter: WorkflowPersistenceAdapter;
  /** Injectable clock (ms). Default `Date.now`. */
  nowMsFn?: () => number;
  /** Diagnostic hook — fires on every state transition. */
  onEvent?: (event: WorkflowEvent) => void;
}

export type WorkflowEvent =
  | { kind: 'enqueued'; id: string; taskKind: string }
  | { kind: 'started'; id: string; attempt: number }
  | { kind: 'completed'; id: string; durationMs: number }
  | { kind: 'failed'; id: string; attempt: number; error: string }
  | { kind: 'restored'; id: string; fromStatus: WorkflowTaskStatus }
  | { kind: 'purged'; id: string };

export interface RestoreSummary {
  loaded: number;
  demotedRunningToPending: number;
  terminal: number;
}

export class WorkflowTaskRegistry {
  private readonly adapter: WorkflowPersistenceAdapter;
  private readonly nowMsFn: () => number;
  private readonly onEvent?: (event: WorkflowEvent) => void;

  constructor(opts: WorkflowRegistryOptions) {
    if (!opts.adapter) {
      throw new Error('WorkflowTaskRegistry: adapter is required');
    }
    this.adapter = opts.adapter;
    this.nowMsFn = opts.nowMsFn ?? Date.now;
    this.onEvent = opts.onEvent;
  }

  /** Enqueue a fresh task in `pending` state. */
  async enqueue(input: WorkflowTaskInput): Promise<WorkflowTask> {
    if (!input.id || input.id.length === 0) {
      throw new Error('WorkflowTaskRegistry.enqueue: id is required');
    }
    if (!input.kind || input.kind.length === 0) {
      throw new Error('WorkflowTaskRegistry.enqueue: kind is required');
    }
    if (typeof input.payload !== 'string') {
      throw new Error(
        'WorkflowTaskRegistry.enqueue: payload must be a string (JSON-encoded)',
      );
    }
    const now = this.nowMsFn();
    const task: WorkflowTask = {
      id: input.id,
      kind: input.kind,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await this.adapter.insert(task);
    this.onEvent?.({ kind: 'enqueued', id: task.id, taskKind: task.kind });
    return cloneTask(task);
  }

  /**
   * Transition `pending → running`. Increments attempts. Returns the
   * updated task. Throws on unknown id or non-pending source status.
   */
  async markRunning(id: string): Promise<WorkflowTask> {
    const task = await this.requireTask(id);
    if (task.status !== 'pending') {
      throw new Error(
        `WorkflowTaskRegistry.markRunning: id ${JSON.stringify(id)} is ${task.status} (need pending)`,
      );
    }
    task.status = 'running';
    task.attempts += 1;
    task.updatedAtMs = this.nowMsFn();
    await this.adapter.update(task);
    this.onEvent?.({ kind: 'started', id, attempt: task.attempts });
    return cloneTask(task);
  }

  /** Transition `running → completed` with a JSON result. */
  async markCompleted(id: string, resultJson: string): Promise<WorkflowTask> {
    const task = await this.requireTask(id);
    if (task.status !== 'running') {
      throw new Error(
        `WorkflowTaskRegistry.markCompleted: id ${JSON.stringify(id)} is ${task.status} (need running)`,
      );
    }
    const now = this.nowMsFn();
    task.status = 'completed';
    task.updatedAtMs = now;
    task.completedAtMs = now;
    task.resultJson = resultJson;
    await this.adapter.update(task);
    this.onEvent?.({
      kind: 'completed',
      id,
      durationMs: now - task.createdAtMs,
    });
    return cloneTask(task);
  }

  /**
   * Transition `running → failed` with a JSON error. Does NOT
   * auto-retry — the executor decides whether to re-enqueue.
   */
  async markFailed(id: string, errorJson: string): Promise<WorkflowTask> {
    const task = await this.requireTask(id);
    if (task.status !== 'running') {
      throw new Error(
        `WorkflowTaskRegistry.markFailed: id ${JSON.stringify(id)} is ${task.status} (need running)`,
      );
    }
    const now = this.nowMsFn();
    task.status = 'failed';
    task.updatedAtMs = now;
    task.completedAtMs = now;
    task.errorJson = errorJson;
    await this.adapter.update(task);
    this.onEvent?.({
      kind: 'failed',
      id,
      attempt: task.attempts,
      error: errorJson,
    });
    return cloneTask(task);
  }

  /**
   * Crash-recovery entry point — call once at process startup before
   * the executor starts draining. Loads every persisted task and
   * demotes any `running` entries back to `pending` so they can be
   * retried. Terminal entries (`completed`, `failed`) are left
   * untouched — those outcomes survived the crash.
   */
  async restoreOnStartup(): Promise<RestoreSummary> {
    const rows = await this.adapter.loadAll();
    let demoted = 0;
    let terminal = 0;
    for (const row of rows) {
      if (row.status === 'running') {
        row.status = 'pending';
        row.updatedAtMs = this.nowMsFn();
        await this.adapter.update(row);
        this.onEvent?.({ kind: 'restored', id: row.id, fromStatus: 'running' });
        demoted++;
      } else if (row.status === 'completed' || row.status === 'failed') {
        terminal++;
      }
    }
    return {
      loaded: rows.length,
      demotedRunningToPending: demoted,
      terminal,
    };
  }

  /** Drain all pending tasks — used by the executor to dispatch work. */
  async listPending(): Promise<WorkflowTask[]> {
    const rows = await this.adapter.loadAll();
    const pending = rows.filter((r) => r.status === 'pending');
    // Oldest first so the queue is FIFO.
    pending.sort((a, b) => a.createdAtMs - b.createdAtMs);
    return pending;
  }

  /** Raw view for admin UI + ops tooling. */
  async listAll(): Promise<WorkflowTask[]> {
    const rows = await this.adapter.loadAll();
    rows.sort((a, b) => a.createdAtMs - b.createdAtMs);
    return rows;
  }

  /** Fetch a single task — returns null on unknown. */
  async get(id: string): Promise<WorkflowTask | null> {
    return this.adapter.get(id);
  }

  /**
   * Purge a terminal task from storage. Throws on unknown id;
   * returns false when the task is not yet terminal (pending/running
   * must NOT be purged — that loses in-flight state).
   */
  async purge(id: string): Promise<boolean> {
    const task = await this.requireTask(id);
    if (task.status !== 'completed' && task.status !== 'failed') {
      return false;
    }
    const removed = await this.adapter.delete(id);
    if (removed) this.onEvent?.({ kind: 'purged', id });
    return removed;
  }

  private async requireTask(id: string): Promise<WorkflowTask> {
    const task = await this.adapter.get(id);
    if (task === null) {
      throw new Error(
        `WorkflowTaskRegistry: task ${JSON.stringify(id)} not found`,
      );
    }
    return task;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shallow clone — copies everything except the prototype chain. */
function cloneTask(task: WorkflowTask): WorkflowTask {
  const clone: WorkflowTask = {
    id: task.id,
    kind: task.kind,
    payload: task.payload,
    status: task.status,
    attempts: task.attempts,
    createdAtMs: task.createdAtMs,
    updatedAtMs: task.updatedAtMs,
  };
  if (task.completedAtMs !== undefined) clone.completedAtMs = task.completedAtMs;
  if (task.resultJson !== undefined) clone.resultJson = task.resultJson;
  if (task.errorJson !== undefined) clone.errorJson = task.errorJson;
  return clone;
}
