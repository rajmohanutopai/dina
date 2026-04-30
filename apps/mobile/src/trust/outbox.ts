/**
 * Mobile attestation outbox — pure data layer (TN-MOB-004 + TN-MOB-007).
 *
 * Per Trust Network V1 plan §3.5.1:
 *
 *   > Mobile-side polling: `apps/mobile/src/trust/outbox.ts` keeps a
 *   > small in-memory + persisted set of `{at_uri, draft_body,
 *   > submitted_at}` rows. A 5 s timer polls
 *   > `com.dina.trust.attestationStatus` for each pending AT-URI
 *   > until the response transitions from `pending` → `indexed`
 *   > (success) or `rejected` (surface inbox failure row), or the
 *   > 60 s budget elapses (surface "stuck — retry?" inbox row).
 *
 * Plus plan §1 row 69:
 *
 *   > Offline publish queue? Stash unsent attestations in keystore
 *   > (`trust.outbox`); retry on `NetInfo` reconnect; surface in inbox
 *   > if stuck > 24 h. Simple FIFO; max 50 queued items, hard-fail
 *   > beyond.
 *
 * This module owns the **data layer** — pure state machine + read-side
 * selectors. The screen-level **runner** (5 s timer, NetInfo
 * subscription, PDS `createRecord` call, xRPC `attestationStatus`
 * poll, keystore persistence) wires into the data layer via the
 * exported events; the runner itself is a separate concern not
 * testable under plain Jest and lands when the screen layer is wired.
 *
 * State machine:
 *
 *           ┌──────── 24h elapse ────────► stuck-offline (terminal)
 *           │
 *   queued-offline ─[event:submitted]─► submitted-pending
 *                                              │
 *                  ┌── 60s budget elapse ──────┴───► stuck-pending (terminal)
 *                  │
 *           [response:indexed]   ─────────────────► indexed (terminal)
 *           [response:rejected]  ─────────────────► rejected (terminal)
 *           [response:pending]   ─────────────────► (no-op; keep polling)
 *
 * Terminal states ignore all events. Replays are safe.
 *
 * The runner reads `selectFlushable(rows)` when NetInfo flips to
 * online (plan §1 row 69 — "retry on NetInfo reconnect") and
 * `selectActivePolling(rows)` to drive the 5 s `attestationStatus`
 * timer. Time-based transitions (24h offline, 60s pending) are
 * driven by `tick` events the runner fires on every poll.
 *
 * Pure functions. No state, no I/O. Zero RN deps.
 *
 * Why a separate module rather than folding into the runner:
 *   - The runner is RN-coupled (NetInfo, react-native-keychain,
 *     timers); pure-data testability would suffer.
 *   - The state machine + selectors are read by screen renderers,
 *     the inbox surface (stuck/rejected → inbox row), AND the
 *     runner — one function feeds all three; without it the rules
 *     drift.
 *   - The cap-enforcement + age-budget rules need exhaustive test
 *     coverage that a Jest run gives cheaply.
 */

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Closed enum of outbox row states.
 *
 *   - `queued-offline`: created locally; not yet submitted to the
 *     PDS. The runner submits when the network is reachable.
 *   - `submitted-pending`: submitted to PDS (AT-URI assigned); the
 *     runner is polling `com.dina.trust.attestationStatus` to learn
 *     whether AppView has indexed or rejected it.
 *   - `indexed`: terminal — record successfully ingested.
 *   - `rejected`: terminal — AppView rejected (rate limit, sig
 *     invalid, etc.); inbox surfaces a failure row.
 *   - `stuck-pending`: terminal — 60 s budget elapsed without a
 *     terminal status response; inbox surfaces a "stuck — retry?" row.
 *   - `stuck-offline`: terminal — row sat in `queued-offline` for
 *     longer than 24 h; inbox surfaces a "queued >24h" row.
 */
export type OutboxStatus =
  | 'queued-offline'
  | 'submitted-pending'
  | 'indexed'
  | 'rejected'
  | 'stuck-pending'
  | 'stuck-offline';

/**
 * Reasons AppView's ingester can reject a record. Mirrors
 * `com.dina.trust.attestationStatus`'s response shape (plan §6.5).
 */
export type OutboxRejectReason =
  | 'rate_limit'
  | 'signature_invalid'
  | 'schema_invalid'
  | 'namespace_disabled'
  | 'feature_off';

export interface OutboxRejection {
  readonly reason: OutboxRejectReason;
  readonly detail?: Readonly<Record<string, unknown>>;
  /** ISO-8601 — when AppView marked the record rejected. */
  readonly rejectedAt: string;
}

/**
 * Single outbox row. Identity key is `clientId` (a local UUID
 * generated at enqueue time, stable across restarts) — not `atUri`,
 * because `atUri` only exists post-submission. The runner uses
 * `clientId` to correlate events (e.g. submission completion) back
 * to a row that was queued before any AT-URI existed.
 *
 * `draftBody` is opaque to this module — the renderer / runner
 * understand its shape; we only persist it, never inspect.
 */
export interface OutboxRow<DraftBody = unknown> {
  readonly clientId: string;
  readonly draftBody: DraftBody;
  readonly status: OutboxStatus;
  /** ISO-8601 — when the row was first added to the outbox. */
  readonly enqueuedAt: string;
  /** ISO-8601 — when the row was first successfully submitted to PDS. */
  readonly submittedAt?: string;
  /** AT-URI assigned by the PDS at submission. */
  readonly atUri?: string;
  /** AppView's `indexedAt` timestamp when status reaches `indexed`. */
  readonly indexedAt?: string;
  /** Populated when status is `rejected` or `stuck-pending`. */
  readonly rejection?: OutboxRejection;
  /** ISO-8601 — when the row entered `stuck-offline` / `stuck-pending`. */
  readonly stuckAt?: string;
}

/**
 * The success/rejection/pending shape returned by
 * `com.dina.trust.attestationStatus` (plan §6.5).
 */
export interface AttestationStatusResponse {
  readonly state: 'indexed' | 'rejected' | 'pending';
  readonly indexedAt?: string;
  readonly rejection?: OutboxRejection;
}

/**
 * Events the runner feeds to `outboxStepRow`. Wraps:
 *   - `submitted`: PDS createRecord returned successfully.
 *   - `status_response`: poll cycle returned an attestationStatus body.
 *   - `tick`: time has advanced; check budgets.
 *
 * The runner does NOT feed `connectivity` events to the data layer;
 * connectivity is a runner-side signal that drives WHEN to call
 * `selectFlushable` / `selectActivePolling`. The state machine itself
 * is connectivity-free.
 */
export type OutboxEvent =
  | { kind: 'submitted'; clientId: string; atUri: string; submittedAt: string }
  | {
      kind: 'status_response';
      clientId: string;
      response: AttestationStatusResponse;
    }
  | { kind: 'tick'; nowMs: number };

export interface EnqueueDraftInput<DraftBody = unknown> {
  readonly clientId: string;
  readonly draftBody: DraftBody;
  /** ISO-8601 — when the user tapped publish. */
  readonly enqueuedAt: string;
}

/**
 * Result of `enqueueDraft` — discriminated so caller can branch on
 * the cap-rejection case without try/catch noise.
 */
export type EnqueueResult<DraftBody = unknown> =
  | { ok: true; rows: readonly OutboxRow<DraftBody>[] }
  | { ok: false; reason: 'cap_exceeded' | 'duplicate_client_id' };

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * Plan §1 row 69 — "Simple FIFO; max 50 queued items, hard-fail
 * beyond". Cap counts ALL non-terminal rows (queued-offline +
 * submitted-pending) — terminal rows would still occupy memory if
 * kept indefinitely, but the runner's responsibility is to evict
 * them once the user dismisses (out of scope for this module).
 */
export const MAX_QUEUE_SIZE = 50;

/**
 * Plan §3.5.1 — 60 s budget for the watcher polling phase. After
 * this, a row in `submitted-pending` transitions to `stuck-pending`
 * and surfaces a retry row in the inbox.
 */
export const STUCK_PENDING_BUDGET_MS = 60_000;

/**
 * Plan §1 row 69 — "surface in inbox if stuck > 24 h". After this,
 * a row in `queued-offline` transitions to `stuck-offline`.
 */
export const STUCK_OFFLINE_AGE_MS = 24 * 60 * 60 * 1000;

const TERMINAL_STATUSES: ReadonlySet<OutboxStatus> = new Set([
  'indexed',
  'rejected',
  'stuck-pending',
  'stuck-offline',
]);

// ─── Public API — enqueue ────────────────────────────────────────────────

/**
 * Add a new draft to the outbox.
 *
 * Cap-counting policy: the cap (`MAX_QUEUE_SIZE`) applies to the
 * total of queued-offline + submitted-pending rows. Terminal rows
 * (indexed / rejected / stuck-*) DO NOT count — they're awaiting
 * dismissal but don't consume queue capacity. This matches the
 * intuition "the queue is full of in-flight work", not "the queue
 * has 50 records of any kind".
 *
 * Caller is responsible for generating `clientId` (e.g. crypto.randomUUID).
 * Duplicate `clientId` is a caller bug and rejected synchronously
 * — silently no-oping would leave the second user-tap producing no
 * row, which the screen has no way to detect.
 */
export function enqueueDraft<DraftBody>(
  rows: readonly OutboxRow<DraftBody>[],
  input: EnqueueDraftInput<DraftBody>,
): EnqueueResult<DraftBody> {
  if (typeof input.clientId !== 'string' || input.clientId.length === 0) {
    throw new Error('enqueueDraft: clientId must be a non-empty string');
  }
  if (typeof input.enqueuedAt !== 'string' || !ISO_REGEX.test(input.enqueuedAt)) {
    throw new Error('enqueueDraft: enqueuedAt must be an ISO-8601 string');
  }
  if (rows.some((r) => r.clientId === input.clientId)) {
    return { ok: false, reason: 'duplicate_client_id' };
  }
  const inFlight = rows.filter((r) => !TERMINAL_STATUSES.has(r.status)).length;
  if (inFlight >= MAX_QUEUE_SIZE) {
    return { ok: false, reason: 'cap_exceeded' };
  }
  const next: OutboxRow<DraftBody> = {
    clientId: input.clientId,
    draftBody: input.draftBody,
    status: 'queued-offline',
    enqueuedAt: input.enqueuedAt,
  };
  return { ok: true, rows: [...rows, next] };
}

// ─── Public API — state machine ──────────────────────────────────────────

/**
 * Drive the state machine for one row.
 *
 *   - Terminal-status rows ignore every event (replay-safe).
 *   - Mismatched `clientId` on `submitted` / `status_response` returns
 *     the row unchanged.
 *   - Garbage clock input on `tick` is a no-op.
 *
 * Returns the SAME row object reference when the event is a no-op,
 * so callers can compare by reference to skip unnecessary re-renders.
 */
export function outboxStepRow<DraftBody>(
  row: OutboxRow<DraftBody>,
  event: OutboxEvent,
): OutboxRow<DraftBody> {
  if (TERMINAL_STATUSES.has(row.status)) return row;

  switch (event.kind) {
    case 'submitted': {
      if (row.status !== 'queued-offline') return row;
      if (event.clientId !== row.clientId) return row;
      if (typeof event.atUri !== 'string' || event.atUri.length === 0) return row;
      if (typeof event.submittedAt !== 'string' || !ISO_REGEX.test(event.submittedAt)) return row;
      return {
        ...row,
        status: 'submitted-pending',
        atUri: event.atUri,
        submittedAt: event.submittedAt,
      };
    }
    case 'status_response': {
      if (row.status !== 'submitted-pending') return row;
      if (event.clientId !== row.clientId) return row;
      const r = event.response;
      switch (r.state) {
        case 'indexed':
          return {
            ...row,
            status: 'indexed',
            ...(r.indexedAt !== undefined ? { indexedAt: r.indexedAt } : {}),
          };
        case 'rejected':
          return r.rejection !== undefined
            ? { ...row, status: 'rejected', rejection: r.rejection }
            : row;
        case 'pending':
          return row;
        default:
          // Unknown state — defensive against malformed wire data.
          return row;
      }
    }
    case 'tick': {
      if (typeof event.nowMs !== 'number' || !Number.isFinite(event.nowMs)) return row;
      if (row.status === 'queued-offline') {
        const enqMs = Date.parse(row.enqueuedAt);
        if (Number.isNaN(enqMs)) return row;
        if (event.nowMs - enqMs >= STUCK_OFFLINE_AGE_MS) {
          return {
            ...row,
            status: 'stuck-offline',
            stuckAt: new Date(event.nowMs).toISOString(),
          };
        }
        return row;
      }
      if (row.status === 'submitted-pending') {
        const submittedAt = row.submittedAt;
        if (submittedAt === undefined) return row;
        const subMs = Date.parse(submittedAt);
        if (Number.isNaN(subMs)) return row;
        if (event.nowMs - subMs >= STUCK_PENDING_BUDGET_MS) {
          return {
            ...row,
            status: 'stuck-pending',
            stuckAt: new Date(event.nowMs).toISOString(),
          };
        }
        return row;
      }
      return row;
    }
  }
}

/**
 * Apply an event to every row in the array. Returns a fresh array;
 * unchanged rows pass through with reference identity preserved
 * (cheap React reconciliation per row).
 */
export function outboxStepRows<DraftBody>(
  rows: readonly OutboxRow<DraftBody>[],
  event: OutboxEvent,
): OutboxRow<DraftBody>[] {
  return rows.map((r) => outboxStepRow(r, event));
}

// ─── Public API — selectors ──────────────────────────────────────────────

/**
 * Rows the runner should submit when network is reachable.
 *
 * Used by the NetInfo-reconnect glue (TN-MOB-007): on connection
 * change to online, the runner reads this set, calls the PDS
 * `createRecord` for each, and feeds the resulting `submitted` events
 * back into `outboxStepRow`.
 *
 * FIFO order — older `enqueuedAt` first — so retries process in the
 * order the user originally tapped publish. Stable sort: ties on
 * `enqueuedAt` use `clientId` ascending so the order is deterministic
 * across runs.
 */
export function selectFlushable<DraftBody>(
  rows: readonly OutboxRow<DraftBody>[],
): OutboxRow<DraftBody>[] {
  return rows.filter((r) => r.status === 'queued-offline').sort(byEnqueueOrder);
}

/**
 * Rows the runner should poll `attestationStatus` for. The 5 s
 * timer iterates this set, calls the xRPC, and feeds responses back
 * via `status_response` events.
 *
 * FIFO order so the oldest pending row is polled first — bounded
 * staleness if the timer falls behind.
 */
export function selectActivePolling<DraftBody>(
  rows: readonly OutboxRow<DraftBody>[],
): OutboxRow<DraftBody>[] {
  return rows.filter((r) => r.status === 'submitted-pending').sort(byEnqueueOrder);
}

/**
 * Rows the inbox should surface as failure / "stuck" entries.
 * Combines `rejected`, `stuck-pending`, and `stuck-offline` since
 * the inbox treats them all the same way (a "Try again" row with
 * the failure reason).
 */
export function selectInboxFailureRows<DraftBody>(
  rows: readonly OutboxRow<DraftBody>[],
): OutboxRow<DraftBody>[] {
  return rows.filter(isFailureRow).sort(byEnqueueOrder);
}

/**
 * Count of currently-in-flight rows. Drives the "Reviews queued —
 * will post when back online" badge (plan §8.10) and the
 * `app/notifications.tsx` count.
 */
export function inFlightCount<DraftBody>(rows: readonly OutboxRow<DraftBody>[]): number {
  let n = 0;
  for (const r of rows) {
    if (!TERMINAL_STATUSES.has(r.status)) n += 1;
  }
  return n;
}

/**
 * Whether a status is a terminal one (indexed / rejected / stuck-*).
 * Useful for the screen layer's filter logic.
 */
export function isTerminalStatus(status: OutboxStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ─── Internal ─────────────────────────────────────────────────────────────

const ISO_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isFailureRow<DraftBody>(r: OutboxRow<DraftBody>): boolean {
  return r.status === 'rejected' || r.status === 'stuck-pending' || r.status === 'stuck-offline';
}

function byEnqueueOrder<DraftBody>(
  a: OutboxRow<DraftBody>,
  b: OutboxRow<DraftBody>,
): number {
  if (a.enqueuedAt < b.enqueuedAt) return -1;
  if (a.enqueuedAt > b.enqueuedAt) return 1;
  if (a.clientId < b.clientId) return -1;
  if (a.clientId > b.clientId) return 1;
  return 0;
}
