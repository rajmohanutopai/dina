/**
 * Interactive-run domain model + pure state machine.
 *
 * Implements docs/INTERACTIVE_SERVICES_ARCHITECTURE.md §5 (the run) and §5.1
 * (state machine, termination, and drain strength). This module is PURE — no
 * I/O, no clock, no persistence. Core owns the run and is the sole authority
 * over every lifecycle transition; the repository/service layers apply these
 * pure decisions inside a single per-run transaction.
 *
 * V1 scope (see implementation-notes.html "Scope read"): pull transport only.
 * The push transports are a deferred, still-being-contracted factoring (§7.1),
 * so `createRun` rejects push transports until their joint contracts are frozen.
 */

// ---------------------------------------------------------------------------
// Enums (const + type, following the workflow/domain.ts idiom)
// ---------------------------------------------------------------------------

/** Run lifecycle state (§5). `draining` is the transient terminal-approach
 *  state every termination passes through; the other terminals are absorbing. */
export type RunState = 'active' | 'paused' | 'draining' | 'completed' | 'stopped' | 'expired';

export const RunState = Object.freeze({
  Active: 'active',
  Paused: 'paused',
  Draining: 'draining',
  Completed: 'completed',
  Stopped: 'stopped',
  Expired: 'expired',
} as const satisfies Record<string, RunState>);

/** Terminal states — absorbing (§5.1 "Terminal states are absorbing."). */
export const RUN_TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
  'completed',
  'stopped',
  'expired',
]);

export function isRunTerminal(state: RunState): boolean {
  return RUN_TERMINAL_STATES.has(state);
}

/** Transport mode (§3.2). V1 ships `pull`; push modes are deferred (§7.1). */
export type RunTransport = 'pull' | 'push_reserved' | 'push_open';

export const RunTransport = Object.freeze({
  Pull: 'pull',
  PushReserved: 'push_reserved',
  PushOpen: 'push_open',
} as const satisfies Record<string, RunTransport>);

/** The cause that opened the termination barrier (§5.1). */
export type DrainCause = 'cancel_pending' | 'finish_pending' | 'count' | 'exhaustion' | 'expiry';

export const DrainCause = Object.freeze({
  CancelPending: 'cancel_pending',
  FinishPending: 'finish_pending',
  Count: 'count',
  Exhaustion: 'exhaustion',
  Expiry: 'expiry',
} as const satisfies Record<string, DrainCause>);

/**
 * Drain strength (§5.1). A `permissive` barrier stops only *admission* — a
 * cause-retained approved action may still risk-gate and dispatch until the
 * deadline. A `fencing` barrier additionally fences all undecided / in-flight
 * work now. `fencing` is strictly stronger than `permissive`.
 */
export type DrainStrength = 'permissive' | 'fencing';

export const DrainStrength = Object.freeze({
  Permissive: 'permissive',
  Fencing: 'fencing',
} as const satisfies Record<string, DrainStrength>);

/** `max_count` basis (§5). `decided` (default): the barrier fires when
 *  `outstanding + decided_count` reaches the cap. `produced`: it fires at the
 *  enqueue-commit that takes `produced_count` to the cap. */
export type MaxCountBasis = 'produced' | 'decided';

export const MaxCountBasis = Object.freeze({
  Produced: 'produced',
  Decided: 'decided',
} as const satisfies Record<string, MaxCountBasis>);

/** Owner-facing priority ceiling (§9.1). V1 rejects `fiduciary` (Tier-1 is
 *  Phase 2); `solicited` (default) and `engagement` are the allowed ceilings. */
export type PriorityCeiling = 'fiduciary' | 'solicited' | 'engagement';

export const PriorityCeiling = Object.freeze({
  Fiduciary: 'fiduciary',
  Solicited: 'solicited',
  Engagement: 'engagement',
} as const satisfies Record<string, PriorityCeiling>);

/** On an EXPLICIT stop, how UNDECIDED messages are handled (§5). */
export type OnStop = 'cancel_pending' | 'finish_pending';

export const OnStop = Object.freeze({
  CancelPending: 'cancel_pending',
  FinishPending: 'finish_pending',
} as const satisfies Record<string, OnStop>);

/** Frozen crypto-shred guarantee, probed at creation (§13). */
export type ErasureMode = 'backup_resistant' | 'logical_deletion';

export const ErasureMode = Object.freeze({
  BackupResistant: 'backup_resistant',
  LogicalDeletion: 'logical_deletion',
} as const satisfies Record<string, ErasureMode>);

/** Derived `fetch-paused` reasons surfaced via /status (§5, §10). */
export type PausedReason =
  | 'provider_grant_unavailable'
  | 'push_grant_unavailable'
  | 'response_lost';

// ---------------------------------------------------------------------------
// Bounds (§19 pins the exact values; these are the V1 frozen choices)
// ---------------------------------------------------------------------------

/** Admission ceiling upper bound (§5 `queue_cap ∈ 1..MAX_QUEUE_CAP`). */
export const MAX_QUEUE_CAP = 32;
/** Default `queue_cap` when the owner does not specify one. */
export const DEFAULT_QUEUE_CAP = 4;
/** Default classify timeout window (ms) — bounded, < the pre-deadline window. */
export const DEFAULT_CLASSIFY_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// The run record (§5). Times are ms unless the field name ends in `_at_sec`.
// ---------------------------------------------------------------------------

export interface RunRecord {
  run_id: string;
  idempotency_key: string;
  service_uri: string;
  provider_did: string;
  persona: string;

  transport: RunTransport;
  /** push modes only; null in V1 (pull). */
  push_grant_ref: string | null;
  /** optional provider-issued grant for a protected/known_only service. */
  provider_grant_id: string | null;
  /** locally-known provider-grant expiry (unix sec), if known. */
  provider_grant_expires_at_sec: number | null;

  /** pull mode: fetch interval (ms). null for push. */
  interval_ms: number | null;
  /** pull mode: a fetch requires now >= next_fetch_at. null for push. */
  next_fetch_at: number | null;

  queue_cap: number;
  /** never BLOCKED (§5); one of SAFE|MODERATE|HIGH. */
  action_risk_ceiling: string;
  priority_ceiling: PriorityCeiling;
  classify_timeout_ms: number;
  muted: boolean;
  on_stop: OnStop;
  erasure_mode: ErasureMode;
  paused_reason: PausedReason | null;

  // termination policy
  stop_on_command: boolean;
  max_count: number | null;
  max_count_basis: MaxCountBasis;
  stop_on_exhaustion: boolean;
  /** hard TTL (ms); required. */
  expires_at: number;
  /** configured forced-terminate window (ms) applied when draining begins. */
  drain_deadline_ms: number;
  /** forced-terminate instant (ms) — set when a barrier opens. */
  drain_deadline_at: number | null;
  drain_cause: DrainCause | null;
  drain_strength: DrainStrength | null;

  config_version: number;
  /** pull read-idempotency identity; null for push. */
  fetch_cursor: number | null;
  last_commit_at: number | null;
  produced_count: number;
  decided_count: number;

  state: RunState;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Barrier logic (§5.1) — monotonic strengthen-only.
// ---------------------------------------------------------------------------

/** The strength a cause opens with (§5.1). */
export function strengthOfCause(cause: DrainCause): DrainStrength {
  switch (cause) {
    case 'cancel_pending':
    case 'expiry':
      return 'fencing';
    case 'finish_pending':
    case 'count':
    case 'exhaustion':
      return 'permissive';
  }
}

/** The terminal state a cause resolves to (§5.1). */
export function terminalStateForCause(cause: DrainCause): RunState {
  switch (cause) {
    case 'cancel_pending':
    case 'finish_pending':
      return 'stopped';
    case 'count':
    case 'exhaustion':
      return 'completed';
    case 'expiry':
      return 'expired';
  }
}

export interface BarrierState {
  cause: DrainCause;
  strength: DrainStrength;
  deadline_at: number;
}

/**
 * The result of applying a termination cause to a run (§5.1). One of:
 *  - `open`: the run was not draining; open a fresh barrier.
 *  - `strengthen`: the run was draining permissively; strengthen to fencing
 *    and move the deadline earlier-or-equal.
 *  - `noop`: idempotent — a weaker/duplicate cause never weakens a barrier.
 */
export type BarrierDecision =
  | { kind: 'open'; barrier: BarrierState }
  | { kind: 'strengthen'; barrier: BarrierState }
  | { kind: 'noop' };

/**
 * Pure barrier-transition decision (§5.1 "Barriers are monotonic — strengthen
 * only, never weaken").
 *
 * @param current  the run's current barrier (null if not yet draining).
 * @param incoming the cause being applied, with its proposed deadline.
 */
export function decideBarrier(
  current: BarrierState | null,
  incomingCause: DrainCause,
  incomingDeadlineAt: number,
): BarrierDecision {
  const incomingStrength = strengthOfCause(incomingCause);

  if (current === null) {
    return {
      kind: 'open',
      barrier: { cause: incomingCause, strength: incomingStrength, deadline_at: incomingDeadlineAt },
    };
  }

  // Already draining. Only a permissive→fencing transition is a real change;
  // everything else (duplicate/weaker cause, fencing-on-fencing) is a no-op
  // that never weakens the barrier, un-fences work, or extends the deadline.
  if (current.strength === 'permissive' && incomingStrength === 'fencing') {
    // Deadline only moves earlier-or-equal, never later.
    const deadline_at = Math.min(current.deadline_at, incomingDeadlineAt);
    return {
      kind: 'strengthen',
      barrier: { cause: incomingCause, strength: 'fencing', deadline_at },
    };
  }

  return { kind: 'noop' };
}

// ---------------------------------------------------------------------------
// Command / state matrix (§5.1, §12.5). Version-unconditional but state-gated.
// ---------------------------------------------------------------------------

export type RunControlCommand = 'pause' | 'resume' | 'stop';

/** `pause` only `active → paused` (retains everything; cancels nothing). */
export function canPause(state: RunState): boolean {
  return state === 'active';
}

/** `resume` only `paused → active`. On any other state it is an idempotent
 *  no-op that never restores authorization or weakens a barrier (§12). */
export function canResume(state: RunState): boolean {
  return state === 'paused';
}

/** `stop` from `active`/`paused` → `draining`; while `draining` a
 *  `cancel_pending` stop may *strengthen* a permissive drain (handled by
 *  `decideBarrier`). A terminal run rejects stop. */
export function canStop(state: RunState): boolean {
  return state === 'active' || state === 'paused' || state === 'draining';
}

// ---------------------------------------------------------------------------
// Creation validation (§5, §9.1, §18)
// ---------------------------------------------------------------------------

export interface CreateRunParams {
  service_uri: string;
  provider_did: string;
  persona: string;
  idempotency_key: string;
  transport?: RunTransport;
  push_grant_ref?: string | null;
  provider_grant_id?: string | null;
  provider_grant_expires_at_sec?: number | null;
  interval_ms?: number | null;
  queue_cap?: number;
  action_risk_ceiling?: string;
  priority_ceiling?: PriorityCeiling;
  classify_timeout_ms?: number;
  muted?: boolean;
  on_stop?: OnStop;
  erasure_mode?: ErasureMode;
  stop_on_command?: boolean;
  max_count?: number | null;
  max_count_basis?: MaxCountBasis;
  stop_on_exhaustion?: boolean;
  /** absolute hard-TTL instant (ms); required. */
  expires_at: number;
  /** forced-terminate window (ms) after draining begins. */
  drain_deadline_ms?: number;
}

export class RunValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'RunValidationError';
  }
}

/** Default forced-terminate window after `draining` begins (ms). */
export const DEFAULT_DRAIN_DEADLINE_MS = 60_000;

const VALID_RISK_CEILINGS: ReadonlySet<string> = new Set(['SAFE', 'MODERATE', 'HIGH']);

/**
 * Validate + normalize creation params into a seed for a new run (§5, §18).
 * Pure — the caller stamps `run_id`, `created_at`, `state='active'`, and the
 * pull cursor/next_fetch bootstrap. Throws `RunValidationError` on any invalid
 * field so creation fails closed.
 */
export function validateCreateParams(
  params: CreateRunParams,
  nowMs: number,
): Omit<RunRecord, 'run_id' | 'created_at' | 'updated_at' | 'state' | 'config_version' | 'produced_count' | 'decided_count' | 'last_commit_at' | 'next_fetch_at' | 'fetch_cursor' | 'drain_deadline_at' | 'drain_cause' | 'drain_strength' | 'paused_reason'> & {
  drain_deadline_ms: number;
} {
  const transport = params.transport ?? 'pull';

  // V1 ships pull only. Push transports are a deferred, not-yet-contracted
  // factoring (§7.1/§19) — reject them honestly rather than half-admit.
  if (transport !== 'pull') {
    throw new RunValidationError(
      'transport',
      `transport "${transport}" is deferred in V1 (pull only); push transports await the §19 joint freeze`,
    );
  }

  if (typeof params.service_uri !== 'string' || params.service_uri === '') {
    throw new RunValidationError('service_uri', 'service_uri is required');
  }
  if (typeof params.provider_did !== 'string' || params.provider_did === '') {
    throw new RunValidationError('provider_did', 'provider_did is required');
  }
  if (typeof params.persona !== 'string' || params.persona === '') {
    throw new RunValidationError('persona', 'persona is required');
  }
  if (typeof params.idempotency_key !== 'string' || params.idempotency_key === '') {
    throw new RunValidationError('idempotency_key', 'idempotency_key is required');
  }

  // queue_cap ∈ 1..MAX_QUEUE_CAP.
  const queue_cap = params.queue_cap ?? DEFAULT_QUEUE_CAP;
  if (!Number.isInteger(queue_cap) || queue_cap < 1 || queue_cap > MAX_QUEUE_CAP) {
    throw new RunValidationError('queue_cap', `queue_cap must be an integer in 1..${MAX_QUEUE_CAP}`);
  }

  // priority_ceiling: V1 rejects fiduciary (Tier-1 is Phase 2, §9.1).
  const priority_ceiling = params.priority_ceiling ?? 'solicited';
  if (priority_ceiling === 'fiduciary') {
    throw new RunValidationError(
      'priority_ceiling',
      'priority_ceiling=fiduciary (Tier-1) is Phase 2; use solicited or engagement',
    );
  }
  if (priority_ceiling !== 'solicited' && priority_ceiling !== 'engagement') {
    throw new RunValidationError('priority_ceiling', `invalid priority_ceiling "${priority_ceiling}"`);
  }

  // action_risk_ceiling never BLOCKED.
  const action_risk_ceiling = params.action_risk_ceiling ?? 'MODERATE';
  if (!VALID_RISK_CEILINGS.has(action_risk_ceiling)) {
    throw new RunValidationError(
      'action_risk_ceiling',
      `action_risk_ceiling must be one of SAFE|MODERATE|HIGH (never BLOCKED)`,
    );
  }

  // A run MUST have a termination policy: stop_on_command, a max_count, OR a
  // finite TTL. expires_at is always required (hard TTL, §5).
  if (typeof params.expires_at !== 'number' || !Number.isFinite(params.expires_at)) {
    throw new RunValidationError('expires_at', 'expires_at (hard TTL) is required');
  }
  if (params.expires_at <= nowMs) {
    throw new RunValidationError('expires_at', 'expires_at must be in the future');
  }

  const max_count = params.max_count ?? null;
  if (max_count !== null && (!Number.isInteger(max_count) || max_count < 1)) {
    throw new RunValidationError('max_count', 'max_count must be a positive integer when set');
  }
  const max_count_basis = params.max_count_basis ?? 'decided';
  if (max_count_basis !== 'produced' && max_count_basis !== 'decided') {
    throw new RunValidationError('max_count_basis', `invalid max_count_basis "${max_count_basis}"`);
  }

  const stop_on_command = params.stop_on_command ?? true;
  const stop_on_exhaustion = params.stop_on_exhaustion ?? true;

  // At least one non-TTL termination lever, or the TTL alone (always present).
  // (The TTL guarantees termination; the others are additive owner controls.)

  const interval_ms = params.interval_ms ?? 60_000;
  if (!Number.isInteger(interval_ms) || interval_ms < 0) {
    throw new RunValidationError('interval_ms', 'interval_ms must be a non-negative integer (pull mode)');
  }

  const classify_timeout_ms = params.classify_timeout_ms ?? DEFAULT_CLASSIFY_TIMEOUT_MS;
  if (!Number.isInteger(classify_timeout_ms) || classify_timeout_ms < 0) {
    throw new RunValidationError('classify_timeout_ms', 'classify_timeout_ms must be a non-negative integer');
  }

  const drain_deadline_ms = params.drain_deadline_ms ?? DEFAULT_DRAIN_DEADLINE_MS;
  if (!Number.isInteger(drain_deadline_ms) || drain_deadline_ms < 0) {
    throw new RunValidationError('drain_deadline_ms', 'drain_deadline_ms must be a non-negative integer');
  }

  const on_stop = params.on_stop ?? 'cancel_pending';
  if (on_stop !== 'cancel_pending' && on_stop !== 'finish_pending') {
    throw new RunValidationError('on_stop', `invalid on_stop "${on_stop}"`);
  }

  const erasure_mode = params.erasure_mode ?? 'logical_deletion';

  return {
    idempotency_key: params.idempotency_key,
    service_uri: params.service_uri,
    provider_did: params.provider_did,
    persona: params.persona,
    transport,
    push_grant_ref: params.push_grant_ref ?? null,
    provider_grant_id: params.provider_grant_id ?? null,
    provider_grant_expires_at_sec: params.provider_grant_expires_at_sec ?? null,
    interval_ms,
    queue_cap,
    action_risk_ceiling,
    priority_ceiling,
    classify_timeout_ms,
    muted: params.muted ?? false,
    on_stop,
    erasure_mode,
    stop_on_command,
    max_count,
    max_count_basis,
    stop_on_exhaustion,
    expires_at: params.expires_at,
    drain_deadline_ms,
  };
}
