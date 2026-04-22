/**
 * T2.49 — KV service: GET/PUT key-value store.
 *
 * All assertions are async-aware since Phase 2.3 (task 2.3 pilot) —
 * the KV wrapper functions return Promises now.
 *
 * Source: ARCHITECTURE.md Task 2.49
 */

import { kvGet, kvSet, kvDelete, kvHas, kvList, kvCount, resetKVStore } from '../../src/kv/store';

describe('KV Store', () => {
  beforeEach(() => resetKVStore());

  describe('kvSet + kvGet', () => {
    it('stores and retrieves a value', async () => {
      await kvSet('theme', 'dark');
      expect(await kvGet('theme')).toBe('dark');
    });

    it('overwrites existing value', async () => {
      await kvSet('theme', 'dark');
      await kvSet('theme', 'light');
      expect(await kvGet('theme')).toBe('light');
    });

    it('returns null for missing key', async () => {
      expect(await kvGet('nonexistent')).toBeNull();
    });
  });

  describe('kvDelete', () => {
    it('deletes an existing key', async () => {
      await kvSet('key', 'value');
      expect(await kvDelete('key')).toBe(true);
      expect(await kvGet('key')).toBeNull();
    });

    it('returns false for missing key', async () => {
      expect(await kvDelete('missing')).toBe(false);
    });
  });

  describe('kvHas', () => {
    it('returns true for existing key', async () => {
      await kvSet('exists', 'yes');
      expect(await kvHas('exists')).toBe(true);
    });

    it('returns false for missing key', async () => {
      expect(await kvHas('nope')).toBe(false);
    });
  });

  describe('namespace support', () => {
    it('isolates keys by namespace', async () => {
      await kvSet('theme', 'dark', 'general');
      await kvSet('theme', 'light', 'health');
      expect(await kvGet('theme', 'general')).toBe('dark');
      expect(await kvGet('theme', 'health')).toBe('light');
    });

    it('namespaced key is not found without namespace', async () => {
      await kvSet('key', 'value', 'ns');
      expect(await kvGet('key')).toBeNull();
    });

    it('delete is namespace-scoped', async () => {
      await kvSet('key', 'a', 'ns1');
      await kvSet('key', 'b', 'ns2');
      await kvDelete('key', 'ns1');
      expect(await kvGet('key', 'ns1')).toBeNull();
      expect(await kvGet('key', 'ns2')).toBe('b');
    });

    it('kvHas respects namespace', async () => {
      await kvSet('x', 'y', 'ns');
      expect(await kvHas('x', 'ns')).toBe(true);
      expect(await kvHas('x')).toBe(false);
    });
  });

  describe('kvList', () => {
    it('lists all entries', async () => {
      await kvSet('a', '1');
      await kvSet('b', '2');
      await kvSet('c', '3');
      expect(await kvList()).toHaveLength(3);
    });

    it('filters by namespace', async () => {
      await kvSet('x', '1', 'ns1');
      await kvSet('y', '2', 'ns1');
      await kvSet('z', '3', 'ns2');
      expect(await kvList('ns1')).toHaveLength(2);
      expect(await kvList('ns2')).toHaveLength(1);
    });

    it('sorted by key', async () => {
      await kvSet('c', '3');
      await kvSet('a', '1');
      await kvSet('b', '2');
      const keys = (await kvList()).map((e) => e.key);
      expect(keys).toEqual(['a', 'b', 'c']);
    });

    it('returns empty when nothing stored', async () => {
      expect(await kvList()).toEqual([]);
    });
  });

  describe('kvCount', () => {
    it('counts total entries', async () => {
      await kvSet('a', '1');
      await kvSet('b', '2');
      expect(await kvCount()).toBe(2);
    });

    it('counts entries in namespace', async () => {
      await kvSet('a', '1', 'ns1');
      await kvSet('b', '2', 'ns1');
      await kvSet('c', '3', 'ns2');
      expect(await kvCount('ns1')).toBe(2);
      expect(await kvCount('ns2')).toBe(1);
    });

    it('returns 0 when empty', async () => {
      expect(await kvCount()).toBe(0);
    });
  });

  describe('updatedAt tracking', () => {
    it('tracks update timestamp', async () => {
      const before = Date.now();
      await kvSet('key', 'value');
      const entries = await kvList();
      expect(entries[0].updatedAt).toBeGreaterThanOrEqual(before);
    });
  });
});
