/**
 * Deduplication with LRU cache — prevent duplicate item ingestion.
 *
 * Hot path (fast): In-memory LRU set, 10K entries per source.
 *   Check → hit = duplicate, miss = new.
 *
 * Cold path (thorough): Vault search by source_id (upsert semantics).
 *   Only used when hot cache misses and item is about to be ingested.
 *
 * The LRU eviction ensures bounded memory (~10K × source count).
 * Each source (gmail, calendar, etc.) gets its own independent cache.
 *
 * Source: ARCHITECTURE.md Task 7.4
 */

/**
 * Generic LRU set — bounded set with least-recently-used eviction.
 *
 * Uses a Map for O(1) insertion/lookup/deletion.
 * Map iteration order is insertion order — last entry is most recent.
 * On access, we delete and re-insert to move to the "most recent" position.
 */
export class LRUSet {
  private readonly map: Map<string, number>; // key → timestamp
  private readonly maxSize: number;

  constructor(maxSize: number) {
    if (maxSize < 1) throw new Error('LRU: maxSize must be >= 1');
    this.map = new Map();
    this.maxSize = maxSize;
  }

  /** Add a key to the set. Returns true if the key was new (not a duplicate). */
  add(key: string): boolean {
    if (this.map.has(key)) {
      // Move to most recent position
      this.map.delete(key);
      this.map.set(key, Date.now());
      return false; // duplicate
    }

    // Evict oldest if at capacity
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
    }

    this.map.set(key, Date.now());
    return true; // new entry
  }

  /** Check if a key exists in the set (without updating access order). */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Remove a key from the set. Returns true if it existed. */
  delete(key: string): boolean {
    return this.map.delete(key);
  }

  /** Current number of entries. */
  get size(): number {
    return this.map.size;
  }

  /** Maximum capacity. */
  get capacity(): number {
    return this.maxSize;
  }

  /** Clear all entries. */
  clear(): void {
    this.map.clear();
  }
}

// ---------------------------------------------------------------
// Per-source dedup manager
// ---------------------------------------------------------------

const DEFAULT_CACHE_SIZE = 10_000;

/**
 * Dedup manager — maintains separate LRU caches per source.
 */
export class DedupManager {
  private readonly caches: Map<string, LRUSet>;
  private readonly cacheSize: number;

  /** Injectable cold-path checker (vault search by source_id). */
  private coldPathChecker: ((source: string, sourceId: string) => Promise<boolean>) | null = null;

  constructor(cacheSize?: number) {
    this.caches = new Map();
    this.cacheSize = cacheSize ?? DEFAULT_CACHE_SIZE;
  }

  /**
   * Register a cold-path duplicate checker.
   *
   * In production, this searches the vault for an existing item with
   * the same source_id. Returns true if the item already exists.
   */
  setColdPathChecker(checker: (source: string, sourceId: string) => Promise<boolean>): void {
    this.coldPathChecker = checker;
  }

  /**
   * Check if an item is a duplicate.
   *
   * Hot path: check in-memory LRU cache (O(1)).
   * Cold path: if hot cache misses and cold checker is registered,
   *            check the vault (I/O). Cache the result either way.
   *
   * @returns true if duplicate, false if new
   */
  async isDuplicate(source: string, sourceId: string): Promise<boolean> {
    const key = `${source}|${sourceId}`;
    const cache = this.getOrCreateCache(source);

    // Hot path: cache hit
    if (cache.has(key)) {
      return true;
    }

    // Cold path: vault check
    if (this.coldPathChecker) {
      const existsInVault = await this.coldPathChecker(source, sourceId);
      if (existsInVault) {
        cache.add(key); // warm the cache
        return true;
      }
    }

    // Not a duplicate — add to cache
    cache.add(key);
    return false;
  }

  /**
   * Synchronous hot-path-only check. No cold path.
   * Use when you need fast dedup without I/O.
   */
  isDuplicateSync(source: string, sourceId: string): boolean {
    const key = `${source}|${sourceId}`;
    const cache = this.getOrCreateCache(source);
    return cache.has(key);
  }

  /**
   * Record an item as seen (add to cache without checking).
   * Use after successful ingestion to prevent re-processing.
   */
  recordSeen(source: string, sourceId: string): void {
    const key = `${source}|${sourceId}`;
    const cache = this.getOrCreateCache(source);
    cache.add(key);
  }

  /** Get cache stats for a source. */
  getStats(source: string): { size: number; capacity: number } | null {
    const cache = this.caches.get(source);
    if (!cache) return null;
    return { size: cache.size, capacity: cache.capacity };
  }

  /** List all tracked sources. */
  getSources(): string[] {
    return [...this.caches.keys()];
  }

  /** Clear all caches. */
  clear(): void {
    this.caches.clear();
  }

  /** Clear cache for a specific source. */
  clearSource(source: string): void {
    this.caches.delete(source);
  }

  private getOrCreateCache(source: string): LRUSet {
    let cache = this.caches.get(source);
    if (!cache) {
      cache = new LRUSet(this.cacheSize);
      this.caches.set(source, cache);
    }
    return cache;
  }
}

/** Singleton default instance. */
let defaultManager: DedupManager | null = null;

/** Get or create the default dedup manager. */
export function getDefaultDedupManager(): DedupManager {
  if (!defaultManager) {
    defaultManager = new DedupManager();
  }
  return defaultManager;
}

/** Reset default manager (for testing). */
export function resetDedupManager(): void {
  defaultManager = null;
}
