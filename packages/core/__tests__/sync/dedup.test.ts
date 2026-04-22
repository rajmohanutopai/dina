/**
 * T7.4 — LRU deduplication set for data connectors.
 *
 * Source: ARCHITECTURE.md Task 7.4
 */

import {
  LRUDedupSet,
  isDuplicate,
  markSeen,
  getSourceSet,
  sourceCount,
  resetDedupState,
} from '../../src/sync/dedup';

describe('LRU Dedup Set', () => {
  describe('LRUDedupSet class', () => {
    it('reports unseen items as not present', () => {
      const set = new LRUDedupSet(100);
      expect(set.has('item-1')).toBe(false);
    });

    it('reports added items as present', () => {
      const set = new LRUDedupSet(100);
      set.add('item-1');
      expect(set.has('item-1')).toBe(true);
    });

    it('add returns true for new items', () => {
      const set = new LRUDedupSet(100);
      expect(set.add('item-1')).toBe(true);
    });

    it('add returns false for existing items', () => {
      const set = new LRUDedupSet(100);
      set.add('item-1');
      expect(set.add('item-1')).toBe(false);
    });

    it('evicts oldest when at capacity', () => {
      const set = new LRUDedupSet(3);
      set.add('a');
      set.add('b');
      set.add('c');
      expect(set.size).toBe(3);

      set.add('d'); // evicts 'a' (oldest)
      expect(set.has('a')).toBe(false);
      expect(set.has('b')).toBe(true);
      expect(set.has('d')).toBe(true);
      expect(set.size).toBe(3);
    });

    it('has() promotes item to most-recent (prevents eviction)', () => {
      const set = new LRUDedupSet(3);
      set.add('a');
      set.add('b');
      set.add('c');

      set.has('a'); // promote 'a' to most-recent

      set.add('d'); // should evict 'b' (now oldest), not 'a'
      expect(set.has('a')).toBe(true);
      expect(set.has('b')).toBe(false);
    });

    it('tracks size correctly', () => {
      const set = new LRUDedupSet(100);
      expect(set.size).toBe(0);
      set.add('a');
      set.add('b');
      expect(set.size).toBe(2);
    });

    it('clear removes all items', () => {
      const set = new LRUDedupSet(100);
      set.add('a');
      set.add('b');
      set.clear();
      expect(set.size).toBe(0);
      expect(set.has('a')).toBe(false);
    });

    it('handles 10K items at default capacity', () => {
      const set = new LRUDedupSet();
      for (let i = 0; i < 10_000; i++) {
        set.add(`item-${i}`);
      }
      expect(set.size).toBe(10_000);
      // Adding one more evicts the first
      set.add('overflow');
      expect(set.size).toBe(10_000);
      expect(set.has('item-0')).toBe(false);
      expect(set.has('overflow')).toBe(true);
    });
  });

  describe('per-source registry', () => {
    beforeEach(() => resetDedupState());

    it('creates source set on first access', () => {
      expect(sourceCount()).toBe(0);
      markSeen('gmail', 'msg-001');
      expect(sourceCount()).toBe(1);
    });

    it('isDuplicate returns false for new items', () => {
      expect(isDuplicate('gmail', 'msg-001')).toBe(false);
    });

    it('isDuplicate returns true after markSeen', () => {
      markSeen('gmail', 'msg-001');
      expect(isDuplicate('gmail', 'msg-001')).toBe(true);
    });

    it('markSeen returns true for new, false for existing', () => {
      expect(markSeen('gmail', 'msg-001')).toBe(true);
      expect(markSeen('gmail', 'msg-001')).toBe(false);
    });

    it('sources are independent', () => {
      markSeen('gmail', 'msg-001');
      markSeen('calendar', 'evt-001');
      expect(isDuplicate('gmail', 'msg-001')).toBe(true);
      expect(isDuplicate('gmail', 'evt-001')).toBe(false);
      expect(isDuplicate('calendar', 'evt-001')).toBe(true);
      expect(isDuplicate('calendar', 'msg-001')).toBe(false);
    });

    it('same item ID ingested twice → second rejected', () => {
      markSeen('gmail', 'msg-dup');
      // Second ingest attempt: isDuplicate catches it
      expect(isDuplicate('gmail', 'msg-dup')).toBe(true);
    });

    it('getSourceSet returns the set for a source', () => {
      const set = getSourceSet('gmail');
      set.add('msg-001');
      expect(isDuplicate('gmail', 'msg-001')).toBe(true);
    });

    it('resetDedupState clears all sources', () => {
      markSeen('gmail', 'a');
      markSeen('calendar', 'b');
      resetDedupState();
      expect(sourceCount()).toBe(0);
      expect(isDuplicate('gmail', 'a')).toBe(false);
    });
  });
});
