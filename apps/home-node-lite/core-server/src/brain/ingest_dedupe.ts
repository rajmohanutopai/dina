/**
 * Ingest dedupe — content-hash LRU for the staging pipeline.
 *
 * Ingest sources (email, calendar, web fetches, D2D messages) often
 * deliver the same content twice — a retry, a provider that re-serves
 * the inbox on every poll, a forwarded message that arrives via two
 * routes. Staging should process each content BODY once.
 *
 * This primitive is the **decision half**: a content-addressed LRU.
 * Callers pass an `{id?, contentHash}` pair per item; the dedupe
 * returns `seen | unique`. If `id` is supplied it ALSO dedupes by id
 * (defends against same-hash-different-id and vice versa).
 *
 * **What's in scope**:
 *   - In-memory LRU window by (id, hash). Size-capped.
 *   - Optional TTL (seconds) — entries auto-expire even if the LRU
 *     isn't full. Injected clock for determinism.
 *   - Observers on every ingest via `onEvent` for audit.
 *
 * **What's NOT here**:
 *   - Cross-process / cross-restart persistence. If callers need a
 *     durable dedupe, they wrap this primitive around a SQLite-backed
 *     kv-store — that's a separate IO concern.
 *   - Hash computation — callers supply the digest. Source-specific
 *     canonicalisation (stripping email headers, normalising URLs) is
 *     out of scope for this primitive.
 *
 * **Pure** except for the in-memory map. Every behaviour observable
 * via the injected clock + `onEvent` stream.
 */

export interface IngestDedupeOptions {
  /** Max retained entries. Default 10_000. */
  maxEntries?: number;
  /** TTL in seconds. `null` = no TTL (LRU-only). Default null. */
  ttlSec?: number | null;
  /** Injectable clock — ms since epoch. Default `Date.now`. */
  nowMsFn?: () => number;
  /** Diagnostic hook. */
  onEvent?: (event: DedupeEvent) => void;
}

export interface IngestDedupeInput {
  /** Optional application id (e.g. vault id or staging task id). */
  id?: string;
  /** Content hash — hex / base64 / anything stable per content. */
  contentHash: string;
}

export type IngestDedupeResult =
  | { kind: 'unique' }
  | {
      kind: 'seen';
      /**
       * Which match triggered. `hash` = content appeared before with
       * a different id. `id` = same id seen previously (possibly with
       * new hash). `both` = same id + same hash.
       */
      matchedOn: 'hash' | 'id' | 'both';
      firstSeenMs: number;
    };

export type DedupeEvent =
  | { kind: 'seen'; id: string | null; contentHash: string; matchedOn: 'hash' | 'id' | 'both' }
  | { kind: 'unique'; id: string | null; contentHash: string }
  | { kind: 'evicted'; reason: 'lru' | 'ttl'; id: string | null; contentHash: string };

export const DEFAULT_MAX_ENTRIES = 10_000;

interface Entry {
  id: string | null;
  contentHash: string;
  firstSeenMs: number;
}

/**
 * LRU-ordered dedupe store. `check(input)` returns unique/seen AND
 * records the entry in LRU-front — size-bounded by `maxEntries`.
 */
export class IngestDedupe {
  private readonly maxEntries: number;
  private readonly ttlMs: number | null;
  private readonly nowMsFn: () => number;
  private readonly onEvent?: (event: DedupeEvent) => void;
  /** Map kept in insertion order; oldest at front, newest at back. */
  private readonly entries = new Map<string, Entry>();

  constructor(opts: IngestDedupeOptions = {}) {
    const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    this.maxEntries = max;
    const ttlSec = opts.ttlSec ?? null;
    if (ttlSec !== null) {
      if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
        throw new RangeError('ttlSec must be > 0 or null');
      }
      this.ttlMs = Math.floor(ttlSec * 1000);
    } else {
      this.ttlMs = null;
    }
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    this.onEvent = opts.onEvent;
  }

  /** Current retained entry count (after sweeping expired). */
  size(): number {
    this.sweepExpired();
    return this.entries.size;
  }

  /**
   * Decide whether to process this item. Records it on `unique`
   * outcomes so the next call with the same (id, hash) returns `seen`.
   */
  check(input: IngestDedupeInput): IngestDedupeResult {
    if (!input || typeof input !== 'object') {
      throw new TypeError('check: input required');
    }
    if (typeof input.contentHash !== 'string' || input.contentHash === '') {
      throw new TypeError('check: contentHash required');
    }
    if (input.id !== undefined && (typeof input.id !== 'string' || input.id === '')) {
      throw new TypeError('check: id must be a non-empty string when supplied');
    }

    this.sweepExpired();
    const id = input.id ?? null;
    const hashKey = hashLookup(input.contentHash);
    const idKey = id !== null ? idLookup(id) : null;

    const hashHit = this.entries.get(hashKey);
    const idHit = idKey !== null ? this.entries.get(idKey) : undefined;

    if (hashHit || idHit) {
      const hit = idHit ?? hashHit!;
      let matchedOn: 'hash' | 'id' | 'both';
      if (hashHit && idHit) matchedOn = 'both';
      else if (idHit) matchedOn = 'id';
      else matchedOn = 'hash';
      this.touch(hashHit ?? null);
      this.touch(idHit ?? null);
      this.onEvent?.({ kind: 'seen', id, contentHash: input.contentHash, matchedOn });
      return { kind: 'seen', matchedOn, firstSeenMs: hit.firstSeenMs };
    }

    const nowMs = this.nowMsFn();
    const entry: Entry = { id, contentHash: input.contentHash, firstSeenMs: nowMs };
    this.entries.set(hashKey, entry);
    if (idKey !== null) this.entries.set(idKey, entry);
    this.evictLruIfOver();
    this.onEvent?.({ kind: 'unique', id, contentHash: input.contentHash });
    return { kind: 'unique' };
  }

  /** Drop every entry. */
  clear(): void {
    this.entries.clear();
  }

  /** Drop entries for `id` and/or `contentHash`. Returns the number removed. */
  forget(input: { id?: string; contentHash?: string }): number {
    let removed = 0;
    if (input.id !== undefined) {
      if (this.entries.delete(idLookup(input.id))) removed += 1;
    }
    if (input.contentHash !== undefined) {
      if (this.entries.delete(hashLookup(input.contentHash))) removed += 1;
    }
    return removed;
  }

  // ── Internals ────────────────────────────────────────────────────────

  private touch(entry: Entry | null): void {
    if (!entry) return;
    const hashKey = hashLookup(entry.contentHash);
    const idKey = entry.id !== null ? idLookup(entry.id) : null;
    // Re-insert to move to the back of the insertion order (LRU refresh).
    const h = this.entries.get(hashKey);
    if (h) {
      this.entries.delete(hashKey);
      this.entries.set(hashKey, h);
    }
    if (idKey !== null) {
      const i = this.entries.get(idKey);
      if (i) {
        this.entries.delete(idKey);
        this.entries.set(idKey, i);
      }
    }
  }

  private evictLruIfOver(): void {
    while (this.entries.size > this.maxEntries) {
      const firstKey = this.entries.keys().next();
      if (firstKey.done) break;
      const entry = this.entries.get(firstKey.value)!;
      this.entries.delete(firstKey.value);
      // Delete the twin key too (if any).
      const twin =
        firstKey.value.startsWith(HASH_PREFIX)
          ? entry.id !== null ? idLookup(entry.id) : null
          : hashLookup(entry.contentHash);
      if (twin !== null) this.entries.delete(twin);
      this.onEvent?.({
        kind: 'evicted',
        reason: 'lru',
        id: entry.id,
        contentHash: entry.contentHash,
      });
    }
  }

  private sweepExpired(): void {
    if (this.ttlMs === null) return;
    const cutoff = this.nowMsFn() - this.ttlMs;
    const toRemove: string[] = [];
    const evicted = new Set<Entry>();
    for (const [key, entry] of this.entries) {
      if (entry.firstSeenMs < cutoff) {
        toRemove.push(key);
        evicted.add(entry);
      }
    }
    for (const key of toRemove) this.entries.delete(key);
    if (this.onEvent) {
      for (const entry of evicted) {
        this.onEvent({
          kind: 'evicted',
          reason: 'ttl',
          id: entry.id,
          contentHash: entry.contentHash,
        });
      }
    }
  }
}

const HASH_PREFIX = 'h:';
const ID_PREFIX = 'i:';

function hashLookup(hash: string): string {
  return `${HASH_PREFIX}${hash}`;
}

function idLookup(id: string): string {
  return `${ID_PREFIX}${id}`;
}
