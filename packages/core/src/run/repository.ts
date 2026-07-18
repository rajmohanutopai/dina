/**
 * Interactive-run store (Tier-0, `identity.sqlite`).
 *
 * Persists run *control state* (metadata, cursor, counts, lifecycle) per
 * docs/INTERACTIVE_SERVICES_ARCHITECTURE.md §5/§13. Message payloads are NOT
 * here — they live envelope-encrypted in the payload store (ISVC-2). Every
 * authoritative change runs in one per-run Core transaction (§8), so all
 * mutating methods here are CAS-guarded and synchronous-by-design (the whole
 * subsystem composes statements inside `db.transaction`, like the workflow
 * repository).
 *
 * Two implementations: `SQLiteRunRepository` (production, over a Tier-0
 * `DatabaseAdapter`) and `InMemoryRunRepository` (tests). A module-global
 * singleton is wired at bootstrap (`setRunRepository`) and reset in tests.
 */

import type {
  DrainCause,
  DrainStrength,
  PausedReason,
  RunRecord,
  RunState,
} from './domain';
import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

/** Raised when a create violates a uniqueness constraint. */
export class RunConflictError extends Error {
  constructor(public readonly code: 'duplicate_id' | 'duplicate_idempotency') {
    super(`run conflict: ${code}`);
    this.name = 'RunConflictError';
  }
}

/** A config-mutation patch (§12.5 `/update`). All fields optional; only the
 *  present ones are applied. Version-gated by the caller. */
export interface RunConfigPatch {
  interval_ms?: number;
  queue_cap?: number;
  priority_ceiling?: RunRecord['priority_ceiling'];
  muted?: boolean;
  provider_grant_id?: string | null;
  provider_grant_expires_at_sec?: number | null;
  next_fetch_at?: number | null;
}

export interface RunRepository {
  /** Insert a new run. Throws `RunConflictError` on duplicate id or a
   *  duplicate *live* idempotency key. */
  create(run: RunRecord): void;

  getById(runId: string): RunRecord | null;
  /** Look up by the owner-supplied idempotency key (returns the most recent). */
  getByIdempotencyKey(idempotencyKey: string): RunRecord | null;

  /** Atomic CAS state transition. Returns true iff the row was in `from`. */
  transitionState(runId: string, from: RunState, to: RunState, nowMs: number): boolean;

  /** Persist a termination barrier (§5.1): sets state=`draining` + drain
   *  fields, guarded on the run being non-terminal. Returns true iff applied. */
  applyBarrier(
    runId: string,
    cause: DrainCause,
    strength: DrainStrength,
    deadlineAt: number,
    nowMs: number,
  ): boolean;

  /** Force-terminate a draining run into an absorbing terminal state (§5.1).
   *  Guarded on the run being `draining`. Returns true iff applied. */
  finalize(runId: string, terminal: RunState, nowMs: number): boolean;

  /** CAS `active → paused`. */
  pause(runId: string, nowMs: number): boolean;
  /** CAS `paused → active`. Clears any `paused_reason`. */
  resume(runId: string, nowMs: number): boolean;

  /** PULL enqueue-commit advance (§7/§8): guarded on the run being `active` AND
   *  `now < expires_at`, atomically bump produced_count + fetch_cursor +
   *  next_fetch_at (= now + interval) + last_commit_at. Returns true iff the
   *  guard held (a false means a barrier/TTL raced in and the enqueue-commit
   *  must roll back — no slot committed, no cursor advance). */
  incrementProducedAndAdvance(runId: string, nowMs: number, intervalMs: number): boolean;

  /** Bump decided_count on an owner decision (§5.1 decided-basis count).
   *  Returns the new decided_count (0 if the run is missing). */
  incrementDecided(runId: string, nowMs: number): number;

  /** Apply an owner config change gated on `config_version` (§12.5). Returns
   *  the new config_version, or null on a version mismatch / missing run. */
  updateConfig(
    runId: string,
    patch: RunConfigPatch,
    expectedConfigVersion: number,
    nowMs: number,
  ): number | null;

  /** Set the derived fetch-paused reason (surfaced via /status). */
  setPausedReason(runId: string, reason: PausedReason | null, nowMs: number): void;

  /** List runs by state (diagnostics + sweepers). */
  listByState(state: RunState, limit?: number): RunRecord[];
  /** List every non-terminal run (sweeper scan). */
  listActive(limit?: number): RunRecord[];

  size(): number;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

const COLUMNS = [
  'run_id',
  'idempotency_key',
  'service_uri',
  'provider_did',
  'persona',
  'transport',
  'push_grant_ref',
  'provider_grant_id',
  'provider_grant_expires_at_sec',
  'interval_ms',
  'next_fetch_at',
  'queue_cap',
  'action_risk_ceiling',
  'priority_ceiling',
  'classify_timeout_ms',
  'muted',
  'on_stop',
  'erasure_mode',
  'paused_reason',
  'stop_on_command',
  'max_count',
  'max_count_basis',
  'stop_on_exhaustion',
  'expires_at',
  'drain_deadline_ms',
  'drain_deadline_at',
  'drain_cause',
  'drain_strength',
  'config_version',
  'fetch_cursor',
  'last_commit_at',
  'produced_count',
  'decided_count',
  'state',
  'created_at',
  'updated_at',
] as const;

const TERMINAL_SQL = "('completed','stopped','expired')";

function rowToRun(row: DBRow): RunRecord {
  const num = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  return {
    run_id: String(row.run_id),
    idempotency_key: String(row.idempotency_key),
    service_uri: String(row.service_uri),
    provider_did: String(row.provider_did),
    persona: String(row.persona),
    transport: String(row.transport) as RunRecord['transport'],
    push_grant_ref: row.push_grant_ref === null ? null : String(row.push_grant_ref),
    provider_grant_id: row.provider_grant_id === null ? null : String(row.provider_grant_id),
    provider_grant_expires_at_sec: num(row.provider_grant_expires_at_sec),
    interval_ms: num(row.interval_ms),
    next_fetch_at: num(row.next_fetch_at),
    queue_cap: Number(row.queue_cap),
    action_risk_ceiling: String(row.action_risk_ceiling),
    priority_ceiling: String(row.priority_ceiling) as RunRecord['priority_ceiling'],
    classify_timeout_ms: Number(row.classify_timeout_ms),
    muted: Number(row.muted) === 1,
    on_stop: String(row.on_stop) as RunRecord['on_stop'],
    erasure_mode: String(row.erasure_mode) as RunRecord['erasure_mode'],
    paused_reason: row.paused_reason === null ? null : (String(row.paused_reason) as PausedReason),
    stop_on_command: Number(row.stop_on_command) === 1,
    max_count: num(row.max_count),
    max_count_basis: String(row.max_count_basis) as RunRecord['max_count_basis'],
    stop_on_exhaustion: Number(row.stop_on_exhaustion) === 1,
    expires_at: Number(row.expires_at),
    drain_deadline_ms: Number(row.drain_deadline_ms),
    drain_deadline_at: num(row.drain_deadline_at),
    drain_cause: row.drain_cause === null ? null : (String(row.drain_cause) as DrainCause),
    drain_strength:
      row.drain_strength === null ? null : (String(row.drain_strength) as DrainStrength),
    config_version: Number(row.config_version),
    fetch_cursor: num(row.fetch_cursor),
    last_commit_at: num(row.last_commit_at),
    produced_count: Number(row.produced_count),
    decided_count: Number(row.decided_count),
    state: String(row.state) as RunState,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export class SQLiteRunRepository implements RunRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  create(run: RunRecord): void {
    // A live idempotency key may back at most one non-terminal run.
    const dup = this.db.query(
      `SELECT run_id FROM interactive_runs
         WHERE idempotency_key = ? AND state NOT IN ${TERMINAL_SQL} LIMIT 1`,
      [run.idempotency_key],
    );
    if (dup.length > 0) throw new RunConflictError('duplicate_idempotency');

    const exists = this.db.query('SELECT run_id FROM interactive_runs WHERE run_id = ? LIMIT 1', [
      run.run_id,
    ]);
    if (exists.length > 0) throw new RunConflictError('duplicate_id');

    const placeholders = COLUMNS.map(() => '?').join(', ');
    this.db.execute(
      `INSERT INTO interactive_runs (${COLUMNS.join(', ')}) VALUES (${placeholders})`,
      COLUMNS.map((c) => this.encode(run, c)),
    );
  }

  private encode(run: RunRecord, col: (typeof COLUMNS)[number]): unknown {
    const v = run[col as keyof RunRecord];
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v ?? null;
  }

  getById(runId: string): RunRecord | null {
    const rows = this.db.query('SELECT * FROM interactive_runs WHERE run_id = ? LIMIT 1', [runId]);
    return rows.length > 0 ? rowToRun(rows[0]) : null;
  }

  getByIdempotencyKey(idempotencyKey: string): RunRecord | null {
    const rows = this.db.query(
      'SELECT * FROM interactive_runs WHERE idempotency_key = ? ORDER BY created_at DESC LIMIT 1',
      [idempotencyKey],
    );
    return rows.length > 0 ? rowToRun(rows[0]) : null;
  }

  transitionState(runId: string, from: RunState, to: RunState, nowMs: number): boolean {
    const affected = this.db.run(
      'UPDATE interactive_runs SET state = ?, updated_at = ? WHERE run_id = ? AND state = ?',
      [to, nowMs, runId, from],
    );
    return affected > 0;
  }

  applyBarrier(
    runId: string,
    cause: DrainCause,
    strength: DrainStrength,
    deadlineAt: number,
    nowMs: number,
  ): boolean {
    const affected = this.db.run(
      `UPDATE interactive_runs
         SET state = 'draining', drain_cause = ?, drain_strength = ?, drain_deadline_at = ?, updated_at = ?
       WHERE run_id = ? AND state NOT IN ${TERMINAL_SQL}`,
      [cause, strength, deadlineAt, nowMs, runId],
    );
    return affected > 0;
  }

  finalize(runId: string, terminal: RunState, nowMs: number): boolean {
    const affected = this.db.run(
      "UPDATE interactive_runs SET state = ?, updated_at = ? WHERE run_id = ? AND state = 'draining'",
      [terminal, nowMs, runId],
    );
    return affected > 0;
  }

  pause(runId: string, nowMs: number): boolean {
    return (
      this.db.run(
        "UPDATE interactive_runs SET state = 'paused', updated_at = ? WHERE run_id = ? AND state = 'active'",
        [nowMs, runId],
      ) > 0
    );
  }

  resume(runId: string, nowMs: number): boolean {
    return (
      this.db.run(
        "UPDATE interactive_runs SET state = 'active', paused_reason = NULL, updated_at = ? WHERE run_id = ? AND state = 'paused'",
        [nowMs, runId],
      ) > 0
    );
  }

  incrementProducedAndAdvance(runId: string, nowMs: number, intervalMs: number): boolean {
    return (
      this.db.run(
        `UPDATE interactive_runs
           SET produced_count = produced_count + 1,
               fetch_cursor = COALESCE(fetch_cursor, 0) + 1,
               next_fetch_at = ?,
               last_commit_at = ?,
               updated_at = ?
         WHERE run_id = ? AND state = 'active' AND ? < expires_at`,
        [nowMs + intervalMs, nowMs, nowMs, runId, nowMs],
      ) > 0
    );
  }

  incrementDecided(runId: string, nowMs: number): number {
    this.db.run(
      'UPDATE interactive_runs SET decided_count = decided_count + 1, updated_at = ? WHERE run_id = ?',
      [nowMs, runId],
    );
    return this.getById(runId)?.decided_count ?? 0;
  }

  updateConfig(
    runId: string,
    patch: RunConfigPatch,
    expectedConfigVersion: number,
    nowMs: number,
  ): number | null {
    const sets: string[] = ['config_version = config_version + 1', 'updated_at = ?'];
    const params: unknown[] = [nowMs];
    const push = (col: string, val: unknown): void => {
      sets.push(`${col} = ?`);
      params.push(val);
    };
    if (patch.interval_ms !== undefined) push('interval_ms', patch.interval_ms);
    if (patch.queue_cap !== undefined) push('queue_cap', patch.queue_cap);
    if (patch.priority_ceiling !== undefined) push('priority_ceiling', patch.priority_ceiling);
    if (patch.muted !== undefined) push('muted', patch.muted ? 1 : 0);
    if (patch.provider_grant_id !== undefined) push('provider_grant_id', patch.provider_grant_id);
    if (patch.provider_grant_expires_at_sec !== undefined)
      push('provider_grant_expires_at_sec', patch.provider_grant_expires_at_sec);
    if (patch.next_fetch_at !== undefined) push('next_fetch_at', patch.next_fetch_at);

    params.push(runId, expectedConfigVersion);
    const affected = this.db.run(
      `UPDATE interactive_runs SET ${sets.join(', ')} WHERE run_id = ? AND config_version = ?`,
      params,
    );
    if (affected === 0) return null;
    const row = this.getById(runId);
    return row === null ? null : row.config_version;
  }

  setPausedReason(runId: string, reason: PausedReason | null, nowMs: number): void {
    this.db.run('UPDATE interactive_runs SET paused_reason = ?, updated_at = ? WHERE run_id = ?', [
      reason,
      nowMs,
      runId,
    ]);
  }

  listByState(state: RunState, limit = 100): RunRecord[] {
    return this.db
      .query('SELECT * FROM interactive_runs WHERE state = ? ORDER BY created_at ASC LIMIT ?', [
        state,
        limit,
      ])
      .map(rowToRun);
  }

  listActive(limit = 100): RunRecord[] {
    return this.db
      .query(
        `SELECT * FROM interactive_runs WHERE state NOT IN ${TERMINAL_SQL} ORDER BY created_at ASC LIMIT ?`,
        [limit],
      )
      .map(rowToRun);
  }

  size(): number {
    const rows = this.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM interactive_runs');
    return rows[0]?.n ?? 0;
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests)
// ---------------------------------------------------------------------------

export class InMemoryRunRepository implements RunRepository {
  private readonly runs = new Map<string, RunRecord>();

  create(run: RunRecord): void {
    for (const r of this.runs.values()) {
      if (
        r.idempotency_key === run.idempotency_key &&
        !['completed', 'stopped', 'expired'].includes(r.state)
      ) {
        throw new RunConflictError('duplicate_idempotency');
      }
    }
    if (this.runs.has(run.run_id)) throw new RunConflictError('duplicate_id');
    this.runs.set(run.run_id, { ...run });
  }

  getById(runId: string): RunRecord | null {
    const r = this.runs.get(runId);
    return r ? { ...r } : null;
  }

  getByIdempotencyKey(idempotencyKey: string): RunRecord | null {
    let best: RunRecord | null = null;
    for (const r of this.runs.values()) {
      if (r.idempotency_key === idempotencyKey) {
        if (best === null || r.created_at >= best.created_at) best = r;
      }
    }
    return best ? { ...best } : null;
  }

  transitionState(runId: string, from: RunState, to: RunState, nowMs: number): boolean {
    const r = this.runs.get(runId);
    if (!r || r.state !== from) return false;
    r.state = to;
    r.updated_at = nowMs;
    return true;
  }

  applyBarrier(
    runId: string,
    cause: DrainCause,
    strength: DrainStrength,
    deadlineAt: number,
    nowMs: number,
  ): boolean {
    const r = this.runs.get(runId);
    if (!r || ['completed', 'stopped', 'expired'].includes(r.state)) return false;
    r.state = 'draining';
    r.drain_cause = cause;
    r.drain_strength = strength;
    r.drain_deadline_at = deadlineAt;
    r.updated_at = nowMs;
    return true;
  }

  finalize(runId: string, terminal: RunState, nowMs: number): boolean {
    const r = this.runs.get(runId);
    if (!r || r.state !== 'draining') return false;
    r.state = terminal;
    r.updated_at = nowMs;
    return true;
  }

  pause(runId: string, nowMs: number): boolean {
    const r = this.runs.get(runId);
    if (!r || r.state !== 'active') return false;
    r.state = 'paused';
    r.updated_at = nowMs;
    return true;
  }

  resume(runId: string, nowMs: number): boolean {
    const r = this.runs.get(runId);
    if (!r || r.state !== 'paused') return false;
    r.state = 'active';
    r.paused_reason = null;
    r.updated_at = nowMs;
    return true;
  }

  incrementProducedAndAdvance(runId: string, nowMs: number, intervalMs: number): boolean {
    const r = this.runs.get(runId);
    if (!r || r.state !== 'active' || nowMs >= r.expires_at) return false;
    r.produced_count += 1;
    r.fetch_cursor = (r.fetch_cursor ?? 0) + 1;
    r.next_fetch_at = nowMs + intervalMs;
    r.last_commit_at = nowMs;
    r.updated_at = nowMs;
    return true;
  }

  incrementDecided(runId: string, nowMs: number): number {
    const r = this.runs.get(runId);
    if (!r) return 0;
    r.decided_count += 1;
    r.updated_at = nowMs;
    return r.decided_count;
  }

  updateConfig(
    runId: string,
    patch: RunConfigPatch,
    expectedConfigVersion: number,
    nowMs: number,
  ): number | null {
    const r = this.runs.get(runId);
    if (!r || r.config_version !== expectedConfigVersion) return null;
    if (patch.interval_ms !== undefined) r.interval_ms = patch.interval_ms;
    if (patch.queue_cap !== undefined) r.queue_cap = patch.queue_cap;
    if (patch.priority_ceiling !== undefined) r.priority_ceiling = patch.priority_ceiling;
    if (patch.muted !== undefined) r.muted = patch.muted;
    if (patch.provider_grant_id !== undefined) r.provider_grant_id = patch.provider_grant_id;
    if (patch.provider_grant_expires_at_sec !== undefined)
      r.provider_grant_expires_at_sec = patch.provider_grant_expires_at_sec;
    if (patch.next_fetch_at !== undefined) r.next_fetch_at = patch.next_fetch_at;
    r.config_version += 1;
    r.updated_at = nowMs;
    return r.config_version;
  }

  setPausedReason(runId: string, reason: PausedReason | null, nowMs: number): void {
    const r = this.runs.get(runId);
    if (r) {
      r.paused_reason = reason;
      r.updated_at = nowMs;
    }
  }

  listByState(state: RunState, limit = 100): RunRecord[] {
    return [...this.runs.values()]
      .filter((r) => r.state === state)
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  listActive(limit = 100): RunRecord[] {
    return [...this.runs.values()]
      .filter((r) => !['completed', 'stopped', 'expired'].includes(r.state))
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  size(): number {
    return this.runs.size;
  }
}

// ---------------------------------------------------------------------------
// Singleton (bootstrap wires SQLite; tests inject in-memory)
// ---------------------------------------------------------------------------

let repo: RunRepository | null = null;

export function setRunRepository(r: RunRepository | null): void {
  repo = r;
}

export function getRunRepository(): RunRepository | null {
  return repo;
}
