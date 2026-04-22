/**
 * LRU deduplication set — hot-path dedup for staging ingest.
 *
 * Each data source (gmail, calendar, etc.) has its own LRU set with
 * a 10K capacity. When an item is checked, it's promoted to most-recent.
 * When capacity is exceeded, the least-recently-used entry is evicted.
 *
 * This prevents re-ingesting the same email/event on every sync cycle
 * without requiring a database lookup (cold-path: vault search by
 * source_id is the fallback for cache misses after eviction).
 *
 * Source: ARCHITECTURE.md Task 7.4
 */

const DEFAULT_CAPACITY = 10_000;

/**
 * LRU set — ordered by access time, evicts oldest on overflow.
 *
 * Uses Map's insertion-order guarantee: delete + re-set promotes
 * an entry to the end (most recent). Oldest entries are at the front.
 */
export class LRUDedupSet {
  private readonly items: Map<string, number>;
  private readonly capacity: number;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.items = new Map();
    this.capacity = capacity;
  }

  /**
   * Check if an item has been seen (dedup hit).
   *
   * If seen → promotes to most-recent and returns true.
   * If not seen → returns false (caller should add after processing).
   */
  has(key: string): boolean {
    if (!this.items.has(key)) return false;

    // Promote to most-recent (delete + re-set)
    const ts = this.items.get(key)!;
    this.items.delete(key);
    this.items.set(key, ts);
    return true;
  }

  /**
   * Add an item to the set. Evicts oldest if at capacity.
   *
   * Returns true if the item was newly added, false if it was already present.
   */
  add(key: string): boolean {
    if (this.items.has(key)) {
      // Already exists — promote
      this.items.delete(key);
      this.items.set(key, Date.now());
      return false;
    }

    // Evict oldest if at capacity
    if (this.items.size >= this.capacity) {
      const oldest = this.items.keys().next().value;
      if (oldest !== undefined) {
        this.items.delete(oldest);
      }
    }

    this.items.set(key, Date.now());
    return true;
  }

  /** Current set size. */
  get size(): number {
    return this.items.size;
  }

  /** Clear all entries. */
  clear(): void {
    this.items.clear();
  }
}

// ---------------------------------------------------------------
// Per-source dedup registry
// ---------------------------------------------------------------

/** Per-source LRU sets. */
const sources = new Map<string, LRUDedupSet>();

/**
 * Check if an item ID has been seen for a given source.
 * Creates the source's LRU set on first access.
 */
export function isDuplicate(source: string, itemId: string): boolean {
  return getSourceSet(source).has(itemId);
}

/**
 * Mark an item as seen for a given source.
 * Returns true if newly added, false if already seen.
 */
export function markSeen(source: string, itemId: string): boolean {
  return getSourceSet(source).add(itemId);
}

/** Get the dedup set for a source (creates if needed). */
export function getSourceSet(source: string, capacity?: number): LRUDedupSet {
  let set = sources.get(source);
  if (!set) {
    set = new LRUDedupSet(capacity ?? DEFAULT_CAPACITY);
    sources.set(source, set);
  }
  return set;
}

/** Get the number of tracked sources. */
export function sourceCount(): number {
  return sources.size;
}

/** Reset all dedup state (for testing). */
export function resetDedupState(): void {
  sources.clear();
}
