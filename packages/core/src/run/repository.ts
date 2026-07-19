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
  incrementProducedAndAdvance(
    runId: string,
    nowMs: number,
    intervalMs: number,
    expectedCursor?: number,
  ): boolean;

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
  /** Keyset page of runs in `state`, strictly after the `(created_at, run_id)`
   *  cursor, ordered by `(created_at ASC, run_id ASC)`. Lets boot recovery page
   *  the FULL terminal set to exhaustion (E76-09) instead of revisiting a fixed
   *  oldest-N window that would strand later crash-gap runs. */
  listByStateAfter(
    state: RunState,
    afterCreatedAt: number,
    afterRunId: string,
    limit: number,
  ): RunRecord[];
  /** List every non-terminal run (sweeper scan). */
  listActive(limit?: number): RunRecord[];
  /** List non-terminal runs that are DUE for a sweep at `nowMs`: past their hard
   *  TTL, or draining past their `drain_deadline_at`. Targets the due set directly
   *  so an unbounded backlog of live-but-not-due runs can never starve a newer
   *  expired run (the sweeper pages this until it drains). */
  listDueForSweep(nowMs: number, limit?: number): RunRecord[];
  /** List ACTIVE pull runs DUE to fetch at `nowMs` (`next_fetch_at <= nowMs`),
   *  ordered by `next_fetch_at` ASC (most-overdue first). Fair by construction: a
   *  run that just committed has its `next_fetch_at` pushed into the future and
   *  drops out of the due set, so a backlog of old-but-not-due runs can never
   *  starve a newer eligible run (the oldest-N `created_at` scan did). */
  listPullDueForFetch(nowMs: number, limit?: number): RunRecord[];

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

  incrementProducedAndAdvance(
    runId: string,
    nowMs: number,
    intervalMs: number,
    expectedCursor?: number,
  ): boolean {
    // Optional in-order commit CAS (§7/§8): a reservation may only commit at the
    // run's CURRENT fetch_cursor, so two fetch-ahead reservations advance the
    // cursor exactly once each, in order — never a skipped or double-advanced
    // position. Absent (push / legacy), only the state+TTL barrier guard applies.
    const cursorClause = expectedCursor === undefined ? '' : ' AND COALESCE(fetch_cursor, 0) = ?';
    const params =
      expectedCursor === undefined
        ? [nowMs + intervalMs, nowMs, nowMs, runId, nowMs]
        : [nowMs + intervalMs, nowMs, nowMs, runId, nowMs, expectedCursor];
    return (
      this.db.run(
        `UPDATE interactive_runs
           SET produced_count = produced_count + 1,
               fetch_cursor = COALESCE(fetch_cursor, 0) + 1,
               next_fetch_at = ?,
               last_commit_at = ?,
               updated_at = ?
         WHERE run_id = ? AND state = 'active' AND ? < expires_at${cursorClause}`,
        params,
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

  listByStateAfter(
    state: RunState,
    afterCreatedAt: number,
    afterRunId: string,
    limit: number,
  ): RunRecord[] {
    return this.db
      .query(
        `SELECT * FROM interactive_runs
          WHERE state = ?
            AND (created_at > ? OR (created_at = ? AND run_id > ?))
          ORDER BY created_at ASC, run_id ASC
          LIMIT ?`,
        [state, afterCreatedAt, afterCreatedAt, afterRunId, limit],
      )
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

  listPullDueForFetch(nowMs: number, limit = 500): RunRecord[] {
    return this.db
      .query(
        `SELECT * FROM interactive_runs
           WHERE state = 'active' AND transport = 'pull'
             AND (next_fetch_at IS NULL OR next_fetch_at <= ?)
           ORDER BY next_fetch_at ASC LIMIT ?`,
        [nowMs, limit],
      )
      .map(rowToRun);
  }

  listDueForSweep(nowMs: number, limit = 500): RunRecord[] {
    // ACTIONABLE-only so paging makes monotonic progress: each returned run is
    // one the sweep will transition OUT of this set — an active/paused run past
    // its TTL (→ expiry barrier), a permissive drain past its TTL (→ strengthen
    // to fencing, once), or any drain past its deadline (→ force-terminate). A
    // draining-fencing run past its TTL but before its deadline is NOT due (there
    // is nothing to do until the deadline), so it can never fill a page and
    // starve a newer, genuinely-due run.
    return this.db
      .query(
        `SELECT * FROM interactive_runs
           WHERE state NOT IN ${TERMINAL_SQL}
             AND (
               (state IN ('active', 'paused') AND ? >= expires_at)
               OR (state = 'draining' AND drain_strength = 'permissive' AND ? >= expires_at)
               OR (state = 'draining' AND drain_deadline_at IS NOT NULL AND ? >= drain_deadline_at)
             )
         ORDER BY created_at ASC LIMIT ?`,
        [nowMs, nowMs, nowMs, limit],
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

  incrementProducedAndAdvance(
    runId: string,
    nowMs: number,
    intervalMs: number,
    expectedCursor?: number,
  ): boolean {
    const r = this.runs.get(runId);
    if (!r || r.state !== 'active' || nowMs >= r.expires_at) return false;
    // In-order commit CAS (§7/§8): only the reservation at the current cursor may commit.
    if (expectedCursor !== undefined && (r.fetch_cursor ?? 0) !== expectedCursor) return false;
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

  listByStateAfter(
    state: RunState,
    afterCreatedAt: number,
    afterRunId: string,
    limit: number,
  ): RunRecord[] {
    return [...this.runs.values()]
      .filter((r) => r.state === state)
      .filter(
        (r) =>
          r.created_at > afterCreatedAt ||
          (r.created_at === afterCreatedAt && r.run_id > afterRunId),
      )
      .sort((a, b) => a.created_at - b.created_at || a.run_id.localeCompare(b.run_id))
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

  listPullDueForFetch(nowMs: number, limit = 500): RunRecord[] {
    return [...this.runs.values()]
      .filter(
        (r) =>
          r.state === 'active' &&
          r.transport === 'pull' &&
          (r.next_fetch_at === null || r.next_fetch_at <= nowMs),
      )
      .sort((a, b) => (a.next_fetch_at ?? 0) - (b.next_fetch_at ?? 0))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  listDueForSweep(nowMs: number, limit = 500): RunRecord[] {
    return [...this.runs.values()]
      .filter((r) => !['completed', 'stopped', 'expired'].includes(r.state))
      .filter(
        (r) =>
          ((r.state === 'active' || r.state === 'paused') && nowMs >= r.expires_at) ||
          (r.state === 'draining' && r.drain_strength === 'permissive' && nowMs >= r.expires_at) ||
          (r.state === 'draining' && r.drain_deadline_at !== null && nowMs >= r.drain_deadline_at),
      )
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
