/**
 * Review queue — stateful FIFO for agent-gateway `review` outcomes.
 *
 * When `agent_gateway.decide()` returns `{action: 'review', ...}`, the
 * intent isn't allowed yet — a human operator must approve/reject.
 * This primitive holds the pending queue:
 *
 *   - `enqueue(item) → entryId` — records an item in the queue.
 *   - `list({status?, limit?})` — admin UI fetch.
 *   - `approve(entryId)` / `reject(entryId, reason)` — terminal outcomes.
 *   - `get(entryId)` — inspect a single entry.
 *   - `cleanupExpired()` — drop entries past their TTL as `expired`.
 *
 * **Terminal statuses**: `pending` → `approved` | `rejected` |
 * `expired`. Once terminal, an entry stays in the queue for audit
 * until a `purge()` or TTL-based second-stage cleanup.
 *
 * **Injectable clock** — the test clock drives TTL expiry.
 * Production passes `Date.now`.
 *
 * **Event stream** — `onEvent` fires for every state transition.
 * The dispatcher / admin UI subscribes to render badges live.
 *
 * **Bounded** — max entries cap with FIFO pending-eviction. When the
 * queue exceeds capacity and must evict a pending entry to accept a
 * new one, the evicted entry is marked `expired` with reason
 * `capacity_exceeded` — never silently dropped.
 *
 * **Pure-ish** — state lives in the class instance; all inputs/outputs
 * are plain objects. No IO.
 */

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ReviewItem<T = unknown> {
  id: string;
  status: ReviewStatus;
  /** Original intent payload — agent_gateway output or domain equivalent. */
  payload: T;
  /** Short human summary shown in the admin UI list. */
  summary: string;
  /** Risk label for quick scanning. */
  risk?: string;
  /** Unix ms when enqueued. */
  enqueuedAtMs: number;
  /** Unix ms when transitioned to terminal (or null). */
  resolvedAtMs: number | null;
  /** Unix ms when the entry should auto-expire. */
  expiresAtMs: number;
  /** For approved/rejected, echo of the decision. */
  decisionNote: string | null;
}

export interface EnqueueInput<T = unknown> {
  /** Optional caller-supplied id — defaults to a generated one. */
  id?: string;
  payload: T;
  summary: string;
  risk?: string;
  /** TTL override for this entry in ms. Defaults to queue default. */
  ttlMs?: number;
}

export type ReviewEvent<T = unknown> =
  | { kind: 'enqueued'; entry: ReviewItem<T> }
  | { kind: 'approved'; entry: ReviewItem<T> }
  | { kind: 'rejected'; entry: ReviewItem<T>; reason: string }
  | { kind: 'expired'; entry: ReviewItem<T>; reason: 'ttl' | 'capacity_exceeded' };

export interface ReviewQueueOptions {
  /** Max concurrent PENDING entries. Default 100. */
  maxPending?: number;
  /** Default TTL in ms for each entry. Default 24h. */
  defaultTtlMs?: number;
  nowMsFn?: () => number;
  onEvent?: (event: ReviewEvent) => void;
  /** Id generator — default `rv-<counter>`. */
  makeIdFn?: () => string;
}

export const DEFAULT_MAX_PENDING = 100;
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class ReviewQueue<T = unknown> {
  private readonly items = new Map<string, ReviewItem<T>>();
  private readonly maxPending: number;
  private readonly defaultTtlMs: number;
  private readonly nowMsFn: () => number;
  private readonly onEvent?: (event: ReviewEvent<T>) => void;
  private readonly makeId: () => string;
  private counter = 0;

  constructor(opts: ReviewQueueOptions = {}) {
    this.maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
    if (!Number.isInteger(this.maxPending) || this.maxPending < 1) {
      throw new RangeError('maxPending must be a positive integer');
    }
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(this.defaultTtlMs) || this.defaultTtlMs <= 0) {
      throw new RangeError('defaultTtlMs must be > 0');
    }
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    this.onEvent = opts.onEvent as ((e: ReviewEvent<T>) => void) | undefined;
    this.makeId = opts.makeIdFn ?? (() => `rv-${++this.counter}`);
  }

  size(pendingOnly = false): number {
    if (!pendingOnly) return this.items.size;
    let n = 0;
    for (const item of this.items.values()) {
      if (item.status === 'pending') n += 1;
    }
    return n;
  }

  enqueue(input: EnqueueInput<T>): ReviewItem<T> {
    if (!input || typeof input !== 'object') {
      throw new TypeError('enqueue: input required');
    }
    if (typeof input.summary !== 'string' || input.summary.trim() === '') {
      throw new TypeError('enqueue: summary required');
    }
    if (input.id !== undefined && (typeof input.id !== 'string' || input.id === '')) {
      throw new TypeError('enqueue: id must be a non-empty string when supplied');
    }
    this.cleanupExpired();

    // If at capacity, evict the oldest pending entry as capacity_exceeded.
    if (this.size(true) >= this.maxPending) {
      const oldest = this.findOldestPending();
      if (oldest) {
        oldest.status = 'expired';
        oldest.resolvedAtMs = this.nowMsFn();
        this.onEvent?.({ kind: 'expired', entry: { ...oldest }, reason: 'capacity_exceeded' });
      }
    }

    const nowMs = this.nowMsFn();
    const ttl = input.ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new RangeError('enqueue: ttlMs must be > 0');
    }
    const id = input.id ?? this.makeId();
    if (this.items.has(id)) {
      throw new Error(`ReviewQueue: id collision: ${id}`);
    }
    const item: ReviewItem<T> = {
      id,
      status: 'pending',
      payload: input.payload,
      summary: input.summary.trim(),
      enqueuedAtMs: nowMs,
      resolvedAtMs: null,
      expiresAtMs: nowMs + ttl,
      decisionNote: null,
    };
    if (input.risk !== undefined) item.risk = input.risk;
    this.items.set(id, item);
    this.onEvent?.({ kind: 'enqueued', entry: { ...item } });
    return { ...item };
  }

  get(id: string): ReviewItem<T> | null {
    const item = this.items.get(id);
    if (!item) return null;
    return { ...item };
  }

  /** List entries, optionally filtered. Returns defensive copies. */
  list(opts: { status?: ReviewStatus; limit?: number } = {}): ReviewItem<T>[] {
    this.cleanupExpired();
    const out: ReviewItem<T>[] = [];
    for (const item of this.items.values()) {
      if (opts.status && item.status !== opts.status) continue;
      out.push({ ...item });
    }
    // Most recent first.
    out.sort((a, b) => b.enqueuedAtMs - a.enqueuedAtMs);
    return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
  }

  approve(id: string, note?: string): ReviewItem<T> | null {
    return this.resolve(id, 'approved', note);
  }

  reject(id: string, reason: string): ReviewItem<T> | null {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new TypeError('reject: reason required');
    }
    return this.resolve(id, 'rejected', reason);
  }

  /** Force-drop expired entries. Returns count dropped. */
  cleanupExpired(): number {
    const now = this.nowMsFn();
    let n = 0;
    for (const item of this.items.values()) {
      if (item.status === 'pending' && item.expiresAtMs <= now) {
        item.status = 'expired';
        item.resolvedAtMs = now;
        this.onEvent?.({ kind: 'expired', entry: { ...item }, reason: 'ttl' });
        n += 1;
      }
    }
    return n;
  }

  /** Remove all terminal entries — call when audit store has them. */
  purgeResolved(): number {
    const before = this.items.size;
    for (const [id, item] of this.items) {
      if (item.status !== 'pending') this.items.delete(id);
    }
    return before - this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  // ── Internals ────────────────────────────────────────────────────────

  private resolve(
    id: string,
    status: Extract<ReviewStatus, 'approved' | 'rejected'>,
    note: string | undefined,
  ): ReviewItem<T> | null {
    const item = this.items.get(id);
    if (!item || item.status !== 'pending') return null;
    item.status = status;
    item.resolvedAtMs = this.nowMsFn();
    item.decisionNote = note?.trim() ?? null;
    const copy = { ...item };
    if (status === 'approved') {
      this.onEvent?.({ kind: 'approved', entry: copy });
    } else {
      this.onEvent?.({
        kind: 'rejected',
        entry: copy,
        reason: note ?? '',
      });
    }
    return copy;
  }

  private findOldestPending(): ReviewItem<T> | undefined {
    let oldest: ReviewItem<T> | undefined;
    for (const item of this.items.values()) {
      if (item.status !== 'pending') continue;
      if (!oldest || item.enqueuedAtMs < oldest.enqueuedAtMs) oldest = item;
    }
    return oldest;
  }
}
