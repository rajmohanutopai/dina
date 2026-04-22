/**
 * Task 4.72 — Brain + agent approval flows.
 *
 * When Brain or an agent wants to access a `sensitive`-tier persona
 * (see CLAUDE.md §Persona Access Tiers), the request is NOT served
 * automatically. Instead an `ApprovalRequest` is enqueued, and the
 * operator — via admin UI, Telegram bot, or `dina-admin` CLI — must
 * approve or deny it explicitly.
 *
 * **State machine**:
 *
 * ```
 *          ┌───────────┐
 *          │  pending  │────approve()──▶ approved  (terminal)
 *          └─────┬─────┘
 *                ├──────deny()──────▶  denied    (terminal)
 *                └──────expire()────▶  expired   (terminal)
 * ```
 *
 * All transitions are one-shot: once an `ApprovalRequest` is terminal
 * it cannot be resurrected. Re-requesting requires a new `request()`
 * call which mints a new id.
 *
 * **TTL**: pending requests expire after `defaultTtlMs` (5 minutes
 * matches the Go Core's implicit convention). `sweep(nowMs?)` walks
 * the pending queue and transitions expired entries to `expired`.
 * Callers are expected to invoke `sweep` on a cadence, or lazily
 * before any `listPending()` / `get()`. We don't start our own timer
 * here — that keeps the module deterministic under test.
 *
 * **Events** — `onEvent` hook fires `requested` / `approved` /
 * `denied` / `expired` so UI + audit-log can observe transitions
 * without pulling state.
 *
 * **Scope**: a request may be `'single'` (consumed on first use) or
 * `'session'` (lives until the enclosing session ends — see 4.70).
 * The scope is data we track; enforcement lives at the gatekeeper
 * call-site that combines approvals with session grants.
 *
 * **Storage**: in-memory today. SQLCipher-backed variant later —
 * same surface. Pattern matches 4.70 / 4.71 / 4.73.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4i task 4.72.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export type ApprovalScope = 'single' | 'session';

export interface ApprovalRequest {
  readonly id: string;
  /** Action requested, e.g. `"vault_query"`, `"vault_store"`. */
  readonly action: string;
  /** DID of the requesting caller (Brain DID or agent DID). */
  readonly requesterDid: string;
  /** Persona the caller wants to access, e.g. `/health`. */
  readonly persona: string;
  /** Human-readable reason shown to the operator. */
  readonly reason: string;
  /** Short preview of the data / action (e.g. excerpt of the question). */
  readonly preview: string;
  readonly scope: ApprovalScope;
  /** ms since epoch. Assigned at `request()` time. */
  readonly createdAtMs: number;
  /** ms since epoch. `createdAtMs + ttlMs`. */
  readonly expiresAtMs: number;
  /** Current state. Mutated only through the registry's transition methods. */
  status: ApprovalStatus;
  /** ms since epoch. Set on approve/deny/expire, unset while pending. */
  resolvedAtMs?: number;
}

export interface ApprovalRequestInput {
  action: string;
  requesterDid: string;
  persona: string;
  reason: string;
  preview: string;
  /** Defaults to `'single'`. */
  scope?: ApprovalScope;
  /** Per-request TTL override (ms). Defaults to the registry-level default. */
  ttlMs?: number;
}

export interface ApprovalRegistryOptions {
  /** Default TTL in ms. Default 5 minutes. */
  defaultTtlMs?: number;
  /** Injectable clock. Default `Date.now`. */
  nowMsFn?: () => number;
  /** Id generator. Default `approval-<counter>`; production passes UUIDv4. */
  idFn?: () => string;
  /** Diagnostic hook. Fires after every state transition. */
  onEvent?: (event: ApprovalEvent) => void;
}

export type ApprovalEvent =
  | { kind: 'requested'; request: ApprovalRequest }
  | { kind: 'approved'; request: ApprovalRequest }
  | { kind: 'denied'; request: ApprovalRequest }
  | { kind: 'expired'; request: ApprovalRequest };

export const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;

export class ApprovalRegistry {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly defaultTtlMs: number;
  private readonly nowMsFn: () => number;
  private readonly idFn: () => string;
  private readonly onEvent?: (event: ApprovalEvent) => void;
  private idCounter = 0;

  constructor(opts: ApprovalRegistryOptions = {}) {
    const ttl = opts.defaultTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error(`ApprovalRegistry: defaultTtlMs must be > 0 (got ${ttl})`);
    }
    this.defaultTtlMs = ttl;
    this.nowMsFn = opts.nowMsFn ?? Date.now;
    this.idFn =
      opts.idFn ??
      (() => {
        this.idCounter += 1;
        return `approval-${this.idCounter}`;
      });
    this.onEvent = opts.onEvent;
  }

  /**
   * Enqueue a new approval request. Returns the stored object so
   * callers can show the id to the operator immediately.
   */
  request(input: ApprovalRequestInput): ApprovalRequest {
    if (!input.action) throw new Error('ApprovalRegistry.request: action is required');
    if (!input.requesterDid)
      throw new Error('ApprovalRegistry.request: requesterDid is required');
    if (!input.persona) throw new Error('ApprovalRegistry.request: persona is required');

    const ttl = input.ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error(`ApprovalRegistry.request: ttlMs must be > 0 (got ${ttl})`);
    }

    const now = this.nowMsFn();
    const req: ApprovalRequest = {
      id: this.idFn(),
      action: input.action,
      requesterDid: input.requesterDid,
      persona: input.persona,
      reason: input.reason,
      preview: input.preview,
      scope: input.scope ?? 'single',
      createdAtMs: now,
      expiresAtMs: now + ttl,
      status: 'pending',
    };
    this.requests.set(req.id, req);
    this.onEvent?.({ kind: 'requested', request: { ...req } });
    return req;
  }

  /**
   * Approve a pending request. Returns the updated request, or
   * `undefined` if the id is unknown. Throws if the request already
   * reached a terminal state (approve-after-deny is a bug, not a
   * no-op — failing loud surfaces the race so the caller can fix it).
   */
  approve(id: string): ApprovalRequest | undefined {
    return this.transition(id, 'approved');
  }

  /** Deny a pending request. Same semantics as `approve` but terminal status = denied. */
  deny(id: string): ApprovalRequest | undefined {
    return this.transition(id, 'denied');
  }

  /** Fetch a request by id. Returns undefined when unknown. Does NOT auto-sweep. */
  get(id: string): ApprovalRequest | undefined {
    return this.requests.get(id);
  }

  /**
   * List every pending request, oldest first. Does NOT auto-sweep — if
   * the caller wants freshness they call `sweep()` first. Returning
   * stale-pending entries is intentional: the operator UI should be
   * the one deciding when to expire (audit trail needs the "expired
   * without action" records).
   */
  listPending(): ApprovalRequest[] {
    const out: ApprovalRequest[] = [];
    for (const req of this.requests.values()) {
      if (req.status === 'pending') out.push(req);
    }
    out.sort((a, b) => a.createdAtMs - b.createdAtMs);
    return out;
  }

  /**
   * Sweep expired pending requests. Returns the count transitioned to
   * `expired`. Callers typically run this on an interval (e.g. once a
   * minute) OR lazily before displaying the pending queue.
   */
  sweep(): number {
    const now = this.nowMsFn();
    let swept = 0;
    for (const req of this.requests.values()) {
      if (req.status === 'pending' && req.expiresAtMs <= now) {
        req.status = 'expired';
        req.resolvedAtMs = now;
        this.onEvent?.({ kind: 'expired', request: { ...req } });
        swept++;
      }
    }
    return swept;
  }

  /**
   * Drop a terminal request from memory. No-op on pending (can't GC
   * something still in flight). Returns true when the record was removed.
   */
  forget(id: string): boolean {
    const req = this.requests.get(id);
    if (req === undefined || req.status === 'pending') return false;
    return this.requests.delete(id);
  }

  /** All requests (pending + terminal). Ordered by createdAtMs. */
  all(): ApprovalRequest[] {
    return Array.from(this.requests.values()).sort(
      (a, b) => a.createdAtMs - b.createdAtMs,
    );
  }

  /** Count of requests currently in memory (pending + terminal). */
  size(): number {
    return this.requests.size;
  }

  /**
   * Shared approve/deny implementation. Mutates the in-place record
   * (we ship a read-only interface to callers — mutation happens only
   * here) and emits the appropriate event.
   */
  private transition(
    id: string,
    terminal: Exclude<ApprovalStatus, 'pending'>,
  ): ApprovalRequest | undefined {
    const req = this.requests.get(id);
    if (req === undefined) return undefined;
    if (req.status !== 'pending') {
      throw new Error(
        `ApprovalRegistry.${terminal === 'approved' ? 'approve' : terminal === 'denied' ? 'deny' : 'expire'}: request ${JSON.stringify(id)} already terminal (${req.status})`,
      );
    }
    // Auto-expire if already past deadline — caller should not see a
    // request resolved after its TTL, even if they got here first.
    const now = this.nowMsFn();
    if (req.expiresAtMs <= now) {
      req.status = 'expired';
      req.resolvedAtMs = now;
      this.onEvent?.({ kind: 'expired', request: { ...req } });
      return req;
    }
    req.status = terminal;
    req.resolvedAtMs = now;
    this.onEvent?.({ kind: terminal, request: { ...req } });
    return req;
  }
}
