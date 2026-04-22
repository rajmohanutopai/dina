/**
 * T7.4 — Deduplication with LRU cache.
 *
 * Source: ARCHITECTURE.md Task 7.4
 */

import {
  LRUSet,
  DedupManager,
  getDefaultDedupManager,
  resetDedupManager,
} from '../../src/sync/dedup';

describe('LRUSet', () => {
  it('adds new keys and returns true', () => {
    const set = new LRUSet(100);
    expect(set.add('a')).toBe(true);
    expect(set.add('b')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('returns false for duplicate keys', () => {
    const set = new LRUSet(100);
    set.add('a');
    expect(set.add('a')).toBe(false);
    expect(set.size).toBe(1);
  });

  it('has() returns true for existing keys', () => {
    const set = new LRUSet(100);
    set.add('x');
    expect(set.has('x')).toBe(true);
    expect(set.has('y')).toBe(false);
  });

  it('evicts oldest entry when at capacity', () => {
    const set = new LRUSet(3);
    set.add('a');
    set.add('b');
    set.add('c');
    expect(set.size).toBe(3);

    // Adding 'd' should evict 'a' (oldest)
    set.add('d');
    expect(set.size).toBe(3);
    expect(set.has('a')).toBe(false);
    expect(set.has('b')).toBe(true);
    expect(set.has('c')).toBe(true);
    expect(set.has('d')).toBe(true);
  });

  it('accessing a key moves it to most recent (no eviction)', () => {
    const set = new LRUSet(3);
    set.add('a');
    set.add('b');
    set.add('c');

    // Re-add 'a' — moves to most recent
    set.add('a');

    // Now add 'd' — should evict 'b' (oldest after 'a' was refreshed)
    set.add('d');
    expect(set.has('a')).toBe(true); // refreshed, not evicted
    expect(set.has('b')).toBe(false); // oldest, evicted
    expect(set.has('c')).toBe(true);
    expect(set.has('d')).toBe(true);
  });

  it('delete removes a key', () => {
    const set = new LRUSet(100);
    set.add('x');
    expect(set.delete('x')).toBe(true);
    expect(set.has('x')).toBe(false);
    expect(set.size).toBe(0);
  });

  it('delete returns false for missing key', () => {
    const set = new LRUSet(100);
    expect(set.delete('nonexistent')).toBe(false);
  });

  it('clear empties the set', () => {
    const set = new LRUSet(100);
    set.add('a');
    set.add('b');
    set.clear();
    expect(set.size).toBe(0);
    expect(set.has('a')).toBe(false);
  });

  it('capacity returns max size', () => {
    const set = new LRUSet(500);
    expect(set.capacity).toBe(500);
  });

  it('rejects maxSize < 1', () => {
    expect(() => new LRUSet(0)).toThrow('maxSize must be >= 1');
  });

  it('handles 10K entries without issues', () => {
    const set = new LRUSet(10_000);
    for (let i = 0; i < 10_000; i++) {
      set.add(`key-${i}`);
    }
    expect(set.size).toBe(10_000);

    // Adding one more evicts the oldest
    set.add('overflow');
    expect(set.size).toBe(10_000);
    expect(set.has('key-0')).toBe(false);
    expect(set.has('overflow')).toBe(true);
  });
});

describe('DedupManager', () => {
  describe('isDuplicate (hot path)', () => {
    it('returns false for new items', async () => {
      const mgr = new DedupManager();
      expect(await mgr.isDuplicate('gmail', 'msg-1')).toBe(false);
    });

    it('returns true for seen items', async () => {
      const mgr = new DedupManager();
      await mgr.isDuplicate('gmail', 'msg-1');
      expect(await mgr.isDuplicate('gmail', 'msg-1')).toBe(true);
    });

    it('tracks sources independently', async () => {
      const mgr = new DedupManager();
      await mgr.isDuplicate('gmail', 'id-1');

      // Same ID from different source → not a duplicate
      expect(await mgr.isDuplicate('calendar', 'id-1')).toBe(false);
    });
  });

  describe('isDuplicate (cold path)', () => {
    it('checks vault when hot cache misses', async () => {
      const mgr = new DedupManager();
      const vaultCheck = jest.fn().mockResolvedValue(true);
      mgr.setColdPathChecker(vaultCheck);

      const result = await mgr.isDuplicate('gmail', 'msg-old');

      expect(result).toBe(true);
      expect(vaultCheck).toHaveBeenCalledWith('gmail', 'msg-old');
    });

    it('warms cache on cold-path hit', async () => {
      const mgr = new DedupManager();
      mgr.setColdPathChecker(jest.fn().mockResolvedValue(true));

      await mgr.isDuplicate('gmail', 'msg-old');

      // Second check should hit hot cache (no vault call)
      expect(mgr.isDuplicateSync('gmail', 'msg-old')).toBe(true);
    });

    it('returns false when vault says no', async () => {
      const mgr = new DedupManager();
      mgr.setColdPathChecker(jest.fn().mockResolvedValue(false));

      const result = await mgr.isDuplicate('gmail', 'msg-new');
      expect(result).toBe(false);
    });
  });

  describe('isDuplicateSync', () => {
    it('checks hot cache only', () => {
      const mgr = new DedupManager();
      mgr.recordSeen('gmail', 'msg-1');
      expect(mgr.isDuplicateSync('gmail', 'msg-1')).toBe(true);
      expect(mgr.isDuplicateSync('gmail', 'msg-2')).toBe(false);
    });
  });

  describe('recordSeen', () => {
    it('marks an item as seen without duplicate check', () => {
      const mgr = new DedupManager();
      mgr.recordSeen('gmail', 'msg-1');
      expect(mgr.isDuplicateSync('gmail', 'msg-1')).toBe(true);
    });
  });

  describe('stats and management', () => {
    it('returns stats per source', async () => {
      const mgr = new DedupManager(5000);
      await mgr.isDuplicate('gmail', 'msg-1');
      await mgr.isDuplicate('gmail', 'msg-2');

      const stats = mgr.getStats('gmail');
      expect(stats).toEqual({ size: 2, capacity: 5000 });
    });

    it('returns null for unknown source', () => {
      const mgr = new DedupManager();
      expect(mgr.getStats('unknown')).toBeNull();
    });

    it('lists tracked sources', async () => {
      const mgr = new DedupManager();
      await mgr.isDuplicate('gmail', 'a');
      await mgr.isDuplicate('calendar', 'b');

      expect(mgr.getSources()).toContain('gmail');
      expect(mgr.getSources()).toContain('calendar');
    });

    it('clear removes all caches', async () => {
      const mgr = new DedupManager();
      await mgr.isDuplicate('gmail', 'a');
      mgr.clear();
      expect(mgr.getSources()).toHaveLength(0);
    });

    it('clearSource removes one source', async () => {
      const mgr = new DedupManager();
      await mgr.isDuplicate('gmail', 'a');
      await mgr.isDuplicate('calendar', 'b');
      mgr.clearSource('gmail');

      expect(mgr.getStats('gmail')).toBeNull();
      expect(mgr.getStats('calendar')).not.toBeNull();
    });
  });

  describe('LRU eviction per source', () => {
    it('evicts oldest entries per source at capacity', async () => {
      const mgr = new DedupManager(3); // small capacity for testing
      await mgr.isDuplicate('gmail', 'msg-1');
      await mgr.isDuplicate('gmail', 'msg-2');
      await mgr.isDuplicate('gmail', 'msg-3');

      // At capacity — next add evicts oldest
      await mgr.isDuplicate('gmail', 'msg-4');

      expect(mgr.isDuplicateSync('gmail', 'msg-1')).toBe(false); // evicted
      expect(mgr.isDuplicateSync('gmail', 'msg-4')).toBe(true); // newest
    });
  });
});

describe('default singleton', () => {
  afterEach(() => resetDedupManager());

  it('returns same instance', () => {
    const a = getDefaultDedupManager();
    const b = getDefaultDedupManager();
    expect(a).toBe(b);
  });

  it('reset creates new instance', () => {
    const a = getDefaultDedupManager();
    resetDedupManager();
    const b = getDefaultDedupManager();
    expect(a).not.toBe(b);
  });
});
