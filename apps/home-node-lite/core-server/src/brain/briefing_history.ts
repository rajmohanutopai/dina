/**
 * Briefing history store — persists past briefing dispatches so the
 * admin UI + audit log can show "what did Dina surface today, and
 * yesterday, and last week".
 *
 * Silence-First batches engagement notifications into briefings (see
 * `NotifyDispatcher.flush()` task 5.47). Today every flush is
 * fire-and-forget — once the items go out the wire they're gone from
 * Brain memory. The Python Brain keeps a rolling log of briefing
 * dispatches (which items, which persona, how big, when) so the
 * operator can answer "what was in this morning's briefing?" without
 * consulting the user's notification client. ADMIN_GAP.md flagged
 * this primitive as missing on the TS side.
 *
 * **Surface**:
 *
 *   - `record(input)` — store one briefing event. Assigns a fresh id
 *     when the caller doesn't supply one. Returns the stored entry.
 *   - `get(id)` — fetch a single entry by id. Returns null when
 *     unknown.
 *   - `list(opts?)` — paginated, sorted DESC by sentAtMs. Caller
 *     filters by persona / kind via optional opts.
 *   - `count(opts?)` — total matching entries (for paginated UIs).
 *   - `purgeOlderThan(cutoffMs)` — operator + retention loop calls
 *     this on a schedule. Returns count purged.
 *
 * **Adapter pattern** matches `AskRegistry` / `WorkflowPersistence`:
 * an in-memory adapter ships today; a SQLCipher-backed one will land
 * with `@dina/storage-node` for durable retention. The `BriefingHistoryStore`
 * itself is stateless above the adapter — every read/write is an
 * adapter call.
 *
 * **Bounded retention via cap**: the in-memory adapter accepts an
 * optional `maxEntries` cap. Once full, every `insert` evicts the
 * oldest entry (by sentAtMs) before storing the new one. Production
 * sets `maxEntries` to bound RSS in long-running deployments without
 * a cron sweeping `purgeOlderThan`. This is convenience layered on
 * top of the explicit purge — the cap is a memory ceiling, the purge
 * is a retention policy.
 *
 * **What this primitive does NOT do**:
 *
 *   - It does NOT subscribe to `NotifyDispatcher` events directly.
 *     The caller (the briefing orchestrator OR a small adapter) is
 *     expected to call `record()` after a successful `flush()`. This
 *     keeps the store decoupled from any specific dispatcher
 *     instance — useful when multiple briefings (per persona)
 *     coexist.
 *   - It does NOT enforce schema beyond shape validation. The
 *     `items` field is opaque — store whatever the briefing
 *     pipeline produced.
 *
 * **Event hook**: optional `onEvent` fires `recorded` / `purged`. The
 * admin UI's live-feed component subscribes to this without polling.
 *
 * Source: `apps/home-node-lite/brain-server/ADMIN_GAP.md` §"Briefing
 * history — ❌". Closes the missing-primitive flag.
 */

export interface BriefingHistoryItem {
  /** The same `id` the briefing item carried (vault id, reminder id, etc.). */
  id: string;
  /** Short headline. */
  title: string;
  /** Bucket the item landed in. */
  priority: 'fiduciary' | 'solicited' | 'engagement';
  /** Optional kind hint — `vault | nudge | event | reminder | other`. */
  kind?: string;
}

export interface BriefingHistoryEntry {
  /** Fresh, store-assigned id. Format: `bh-<counter>` by default. */
  readonly id: string;
  /** Persona the briefing targeted, e.g. `general`, `health`. */
  readonly persona: string;
  /** ms since epoch — when the briefing was dispatched. */
  readonly sentAtMs: number;
  /** All items the briefing surfaced. Ordered as the briefing emitted them. */
  readonly items: ReadonlyArray<BriefingHistoryItem>;
  /** Total items considered before bucket caps + overflow trimming. */
  readonly totalConsidered: number;
  /** Convenience: `items.length`. Stored explicitly so the list view
   *  doesn't need to scan items to compute counts. */
  readonly itemCount: number;
  /** Optional headline the briefing led with. */
  readonly headline?: string;
  /** Free-form metadata — render mode, user agent, etc. */
  readonly meta?: Record<string, unknown>;
}

export interface BriefingHistoryRecordInput {
  persona: string;
  sentAtMs?: number;
  items: ReadonlyArray<BriefingHistoryItem>;
  totalConsidered: number;
  headline?: string;
  meta?: Record<string, unknown>;
  /** Caller-supplied id override — useful for idempotent recording. */
  id?: string;
}

export interface BriefingHistoryListOptions {
  /** Filter to one persona. Omit for all personas. */
  persona?: string;
  /** Pagination — entries to skip from the front. Default 0. */
  offset?: number;
  /** Max entries returned. Default 50, max 1000 (enforced). */
  limit?: number;
  /** Filter to entries sent on or after this timestamp (ms). */
  sinceMs?: number;
  /** Filter to entries sent strictly before this timestamp (ms). */
  beforeMs?: number;
}

export interface BriefingHistoryAdapter {
  insert(entry: BriefingHistoryEntry): Promise<void>;
  get(id: string): Promise<BriefingHistoryEntry | null>;
  /** All matching entries; caller handles sort + pagination. */
  query(opts: BriefingHistoryListOptions): Promise<BriefingHistoryEntry[]>;
  count(opts: BriefingHistoryListOptions): Promise<number>;
  purgeOlderThan(cutoffMs: number): Promise<number>;
}

export type BriefingHistoryEvent =
  | { kind: 'recorded'; entry: BriefingHistoryEntry }
  | { kind: 'purged'; count: number; cutoffMs: number }
  | { kind: 'evicted'; id: string };

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 1000;
export const DEFAULT_MAX_ENTRIES = 1000;

export class InMemoryBriefingHistoryAdapter implements BriefingHistoryAdapter {
  private readonly rows = new Map<string, BriefingHistoryEntry>();
  private readonly maxEntries: number;
  private readonly onEvict?: (id: string) => void;

  constructor(opts?: { maxEntries?: number; onEvict?: (id: string) => void }) {
    const cap = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(cap) || cap < 1) {
      throw new RangeError(
        `InMemoryBriefingHistoryAdapter: maxEntries must be a positive integer (got ${cap})`,
      );
    }
    this.maxEntries = cap;
    if (opts?.onEvict) this.onEvict = opts.onEvict;
  }

  async insert(entry: BriefingHistoryEntry): Promise<void> {
    if (this.rows.has(entry.id)) {
      throw new Error(
        `InMemoryBriefingHistoryAdapter.insert: duplicate id ${JSON.stringify(entry.id)}`,
      );
    }
    if (this.rows.size >= this.maxEntries) {
      // Evict the oldest by sentAtMs. Linear scan is fine for caps
      // measured in thousands — admin UI shows last N entries, not
      // unbounded retention.
      let oldestId: string | null = null;
      let oldestMs = Number.POSITIVE_INFINITY;
      for (const row of this.rows.values()) {
        if (row.sentAtMs < oldestMs) {
          oldestMs = row.sentAtMs;
          oldestId = row.id;
        }
      }
      if (oldestId !== null) {
        this.rows.delete(oldestId);
        this.onEvict?.(oldestId);
      }
    }
    this.rows.set(entry.id, cloneEntry(entry));
  }

  async get(id: string): Promise<BriefingHistoryEntry | null> {
    const row = this.rows.get(id);
    return row === undefined ? null : cloneEntry(row);
  }

  async query(opts: BriefingHistoryListOptions): Promise<BriefingHistoryEntry[]> {
    const rows = Array.from(this.rows.values()).filter((r) => matches(r, opts));
    rows.sort((a, b) => b.sentAtMs - a.sentAtMs);
    const offset = opts.offset ?? 0;
    const limit = clampLimit(opts.limit);
    return rows.slice(offset, offset + limit).map(cloneEntry);
  }

  async count(opts: BriefingHistoryListOptions): Promise<number> {
    let n = 0;
    for (const row of this.rows.values()) {
      if (matches(row, opts)) n += 1;
    }
    return n;
  }

  async purgeOlderThan(cutoffMs: number): Promise<number> {
    let purged = 0;
    for (const [id, row] of this.rows) {
      if (row.sentAtMs < cutoffMs) {
        this.rows.delete(id);
        purged += 1;
      }
    }
    return purged;
  }
}

export interface BriefingHistoryStoreOptions {
  adapter: BriefingHistoryAdapter;
  /** Injectable clock (ms). Default `Date.now`. */
  nowMsFn?: () => number;
  /** Id generator. Default `bh-<counter>`. */
  idFn?: () => string;
  /** Diagnostic hook. */
  onEvent?: (event: BriefingHistoryEvent) => void;
}

export class BriefingHistoryStore {
  private readonly adapter: BriefingHistoryAdapter;
  private readonly nowMsFn: () => number;
  private readonly idFn: () => string;
  private readonly onEvent?: (event: BriefingHistoryEvent) => void;
  private idCounter = 0;

  constructor(opts: BriefingHistoryStoreOptions) {
    if (!opts || typeof opts !== 'object') {
      throw new TypeError('BriefingHistoryStore: options required');
    }
    if (!opts.adapter) {
      throw new Error('BriefingHistoryStore: adapter is required');
    }
    this.adapter = opts.adapter;
    this.nowMsFn = opts.nowMsFn ?? Date.now;
    this.idFn =
      opts.idFn ??
      (() => {
        this.idCounter += 1;
        return `bh-${this.idCounter}`;
      });
    if (opts.onEvent) this.onEvent = opts.onEvent;
  }

  /**
   * Persist a briefing dispatch. Validates input, assigns an id when
   * absent, stamps `sentAtMs` from the clock when absent, computes
   * `itemCount` from `items.length`. Returns the stored entry (a
   * defensive copy).
   */
  async record(input: BriefingHistoryRecordInput): Promise<BriefingHistoryEntry> {
    if (!input || typeof input !== 'object') {
      throw new TypeError('BriefingHistoryStore.record: input required');
    }
    if (!input.persona || typeof input.persona !== 'string') {
      throw new Error('BriefingHistoryStore.record: persona is required');
    }
    if (!Array.isArray(input.items)) {
      throw new TypeError('BriefingHistoryStore.record: items must be an array');
    }
    if (
      typeof input.totalConsidered !== 'number' ||
      !Number.isFinite(input.totalConsidered) ||
      input.totalConsidered < 0
    ) {
      throw new Error(
        'BriefingHistoryStore.record: totalConsidered must be a non-negative finite number',
      );
    }
    const sentAtMs = input.sentAtMs ?? this.nowMsFn();
    if (!Number.isFinite(sentAtMs)) {
      throw new Error(
        `BriefingHistoryStore.record: sentAtMs must be finite (got ${sentAtMs})`,
      );
    }

    const id = input.id ?? this.idFn();
    if (!id || id.length === 0) {
      throw new Error('BriefingHistoryStore.record: id must be non-empty');
    }

    // Validate items shape — title + id + priority required.
    for (let i = 0; i < input.items.length; i += 1) {
      const it = input.items[i]!;
      if (!it || typeof it !== 'object') {
        throw new TypeError(
          `BriefingHistoryStore.record: items[${i}] must be an object`,
        );
      }
      if (typeof it.id !== 'string' || it.id.length === 0) {
        throw new Error(
          `BriefingHistoryStore.record: items[${i}].id must be a non-empty string`,
        );
      }
      if (typeof it.title !== 'string') {
        throw new TypeError(
          `BriefingHistoryStore.record: items[${i}].title must be a string`,
        );
      }
      if (
        it.priority !== 'fiduciary' &&
        it.priority !== 'solicited' &&
        it.priority !== 'engagement'
      ) {
        throw new Error(
          `BriefingHistoryStore.record: items[${i}].priority must be one of fiduciary | solicited | engagement (got ${JSON.stringify(it.priority)})`,
        );
      }
    }

    const entry: BriefingHistoryEntry = {
      id,
      persona: input.persona,
      sentAtMs,
      items: input.items.map(cloneItem),
      totalConsidered: input.totalConsidered,
      itemCount: input.items.length,
      ...(input.headline !== undefined ? { headline: input.headline } : {}),
      // Deep clone — `meta` is `Record<string, unknown>` which admits
      // nested objects. A shallow spread would let caller mutation of
      // a nested object poison the stored entry. structuredClone is
      // the same primitive notify_dispatcher uses for symmetric reasons.
      ...(input.meta !== undefined ? { meta: structuredClone(input.meta) } : {}),
    };

    await this.adapter.insert(entry);
    this.onEvent?.({ kind: 'recorded', entry: cloneEntry(entry) });
    return cloneEntry(entry);
  }

  async get(id: string): Promise<BriefingHistoryEntry | null> {
    if (!id || id.length === 0) return null;
    return this.adapter.get(id);
  }

  async list(
    opts: BriefingHistoryListOptions = {},
  ): Promise<BriefingHistoryEntry[]> {
    return this.adapter.query(opts);
  }

  async count(opts: BriefingHistoryListOptions = {}): Promise<number> {
    return this.adapter.count(opts);
  }

  /**
   * Purge entries older than `cutoffMs`. Caller computes the cutoff
   * (e.g. `now - 30 days`). Returns count purged.
   */
  async purgeOlderThan(cutoffMs: number): Promise<number> {
    if (!Number.isFinite(cutoffMs)) {
      throw new Error(
        `BriefingHistoryStore.purgeOlderThan: cutoffMs must be finite (got ${cutoffMs})`,
      );
    }
    const purged = await this.adapter.purgeOlderThan(cutoffMs);
    if (purged > 0) {
      this.onEvent?.({ kind: 'purged', count: purged, cutoffMs });
    }
    return purged;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_LIST_LIMIT;
  return Math.min(limit, MAX_LIST_LIMIT);
}

function matches(
  entry: BriefingHistoryEntry,
  opts: BriefingHistoryListOptions,
): boolean {
  if (opts.persona !== undefined && entry.persona !== opts.persona) return false;
  if (opts.sinceMs !== undefined && entry.sentAtMs < opts.sinceMs) return false;
  if (opts.beforeMs !== undefined && entry.sentAtMs >= opts.beforeMs) return false;
  return true;
}

function cloneItem(item: BriefingHistoryItem): BriefingHistoryItem {
  const out: BriefingHistoryItem = {
    id: item.id,
    title: item.title,
    priority: item.priority,
  };
  if (item.kind !== undefined) out.kind = item.kind;
  return out;
}

function cloneEntry(entry: BriefingHistoryEntry): BriefingHistoryEntry {
  return {
    id: entry.id,
    persona: entry.persona,
    sentAtMs: entry.sentAtMs,
    items: entry.items.map(cloneItem),
    totalConsidered: entry.totalConsidered,
    itemCount: entry.itemCount,
    ...(entry.headline !== undefined ? { headline: entry.headline } : {}),
    // Deep clone for the same reason as `record()`.
    ...(entry.meta !== undefined ? { meta: structuredClone(entry.meta) } : {}),
  };
}
