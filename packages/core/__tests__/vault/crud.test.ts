/**
 * T1G.4 — Vault CRUD: store, query (FTS5), delete, batch.
 *
 * Category A: fixture-based. Verifies vault item lifecycle, FTS5 search
 * behavior, batch atomicity, and soft delete.
 *
 * Source: core/test/vault_test.go (CRUD section)
 */

import {
  storeItem,
  storeBatch,
  queryVault,
  getItem,
  getItemIncludeDeleted,
  deleteItem,
  clearVaults,
} from '../../src/vault/crud';
import { makeVaultItem, makeSearchQuery, resetFactoryCounters } from '@dina/test-harness';

describe('Vault CRUD Operations', () => {
  beforeEach(() => {
    resetFactoryCounters();
    clearVaults();
  });

  describe('storeItem', () => {
    it('stores an item and returns its ID', () => {
      const item = makeVaultItem();
      const id = storeItem('general', item);
      expect(id).toBe(item.id);
    });

    it('stores an item with all required fields', () => {
      const item = makeVaultItem({ type: 'email', source: 'gmail' });
      const id = storeItem('general', item);
      const stored = getItem('general', id);
      expect(stored).not.toBeNull();
      expect(stored!.type).toBe('email');
      expect(stored!.source).toBe('gmail');
    });

    it('auto-generates ID if not provided', () => {
      const { id: _, ...itemWithoutId } = makeVaultItem();
      const id = storeItem('general', { ...itemWithoutId, id: '' });
      expect(id).toMatch(/^vi-[0-9a-f]{16}$/);
      expect(getItem('general', id)).not.toBeNull();
    });

    it('respects persona (stores in correct vault)', () => {
      const item = makeVaultItem();
      storeItem('health', item);
      expect(getItem('health', item.id)).not.toBeNull();
      expect(getItem('general', item.id)).toBeNull();
    });
  });

  describe('storeBatch', () => {
    it('stores multiple items atomically', () => {
      const items = Array.from({ length: 5 }, () => makeVaultItem());
      const ids = storeBatch('general', items);
      expect(ids).toHaveLength(5);
      for (const id of ids) {
        expect(getItem('general', id)).not.toBeNull();
      }
    });

    it('returns array of IDs matching input length', () => {
      const items = Array.from({ length: 3 }, () => makeVaultItem());
      const ids = storeBatch('general', items);
      expect(ids).toHaveLength(3);
    });

    it('rejects batch larger than 100 items', () => {
      const items = Array.from({ length: 101 }, () => makeVaultItem());
      expect(() => storeBatch('general', items)).toThrow('exceeds maximum');
    });

    it('accepts exactly 100 items', () => {
      const items = Array.from({ length: 100 }, () => makeVaultItem());
      const ids = storeBatch('general', items);
      expect(ids).toHaveLength(100);
    });

    it('stores empty batch (no-op, returns empty array)', () => {
      const ids = storeBatch('general', []);
      expect(ids).toEqual([]);
    });

    it('transactional: invalid item rollbacks all (none stored)', () => {
      const items = [
        makeVaultItem({ summary: 'Good item 1' }),
        makeVaultItem({ summary: 'Good item 2' }),
        makeVaultItem({ summary: 'Bad item', type: 'INVALID_TYPE' as any }),
      ];

      expect(() => storeBatch('general', items)).toThrow('batch item 2');

      // None of the items should have been stored
      const results = queryVault('general', { mode: 'fts5', text: 'good', limit: 10 });
      expect(results).toHaveLength(0);
    });

    it('transactional: all valid items stored on success', () => {
      const items = [makeVaultItem({ summary: 'Batch A' }), makeVaultItem({ summary: 'Batch B' })];
      const ids = storeBatch('general', items);
      expect(ids).toHaveLength(2);
      expect(getItem('general', ids[0])).not.toBeNull();
      expect(getItem('general', ids[1])).not.toBeNull();
    });
  });

  describe('queryVault', () => {
    it('searches by keyword (FTS-like)', () => {
      storeItem(
        'general',
        makeVaultItem({ summary: 'Meeting with Alice', body: 'Discuss project' }),
      );
      storeItem('general', makeVaultItem({ summary: 'Grocery list', body: 'Buy milk' }));
      const query = makeSearchQuery({ text: 'grocery' });
      const results = queryVault('general', query);
      expect(results).toHaveLength(1);
      expect(results[0].summary).toContain('Grocery');
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        storeItem('general', makeVaultItem({ summary: `Meeting ${i}` }));
      }
      const query = makeSearchQuery({ text: 'meeting', limit: 5 });
      const results = queryVault('general', query);
      expect(results).toHaveLength(5);
    });

    it('clamps limit to [1, 100]', () => {
      for (let i = 0; i < 5; i++) {
        storeItem('general', makeVaultItem({ summary: `Test item ${i}` }));
      }
      const query = makeSearchQuery({ text: 'test', limit: 200 });
      const results = queryVault('general', query);
      expect(results.length).toBeLessThanOrEqual(100);
    });

    it('returns empty array when no matches', () => {
      storeItem('general', makeVaultItem({ summary: 'Hello' }));
      const query = makeSearchQuery({ text: 'nonexistent' });
      expect(queryVault('general', query)).toEqual([]);
    });

    it('searches within specified persona only', () => {
      storeItem('general', makeVaultItem({ summary: 'General meeting' }));
      storeItem('health', makeVaultItem({ summary: 'Health meeting' }));
      const query = makeSearchQuery({ text: 'meeting' });
      const generalResults = queryVault('general', query);
      const healthResults = queryVault('health', query);
      expect(generalResults).toHaveLength(1);
      expect(healthResults).toHaveLength(1);
      expect(generalResults[0].summary).toContain('General');
      expect(healthResults[0].summary).toContain('Health');
    });

    it('searches body and content fields too', () => {
      storeItem('general', makeVaultItem({ summary: 'Note', body: 'Important budget meeting' }));
      const query = makeSearchQuery({ text: 'budget' });
      expect(queryVault('general', query)).toHaveLength(1);
    });
  });

  describe('getItem', () => {
    it('retrieves an item by ID', () => {
      const item = makeVaultItem();
      storeItem('general', item);
      const found = getItem('general', item.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(item.id);
      expect(found!.summary).toBe(item.summary);
    });

    it('returns null for non-existent ID', () => {
      expect(getItem('general', 'does-not-exist')).toBeNull();
    });
  });

  describe('deleteItem', () => {
    it('soft-deletes an item (sets deleted=1)', () => {
      const item = makeVaultItem();
      storeItem('general', item);
      const result = deleteItem('general', item.id);
      expect(result).toBe(true);
      // getItem returns null for deleted items (matching Go WHERE deleted=0)
      expect(getItem('general', item.id)).toBeNull();
      // But getItemIncludeDeleted still sees it
      const deleted = getItemIncludeDeleted('general', item.id);
      expect(deleted!.deleted).toBe(1);
    });

    it('returns false for non-existent ID', () => {
      expect(deleteItem('general', 'does-not-exist')).toBe(false);
    });

    it('deleted item not returned by query', () => {
      const item = makeVaultItem({ summary: 'Searchable meeting' });
      storeItem('general', item);
      deleteItem('general', item.id);
      const query = makeSearchQuery({ text: 'searchable' });
      expect(queryVault('general', query)).toHaveLength(0);
    });

    it('getItem returns null for deleted items (matching Go)', () => {
      const item = makeVaultItem();
      storeItem('general', item);
      deleteItem('general', item.id);
      expect(getItem('general', item.id)).toBeNull();
    });

    it('getItemIncludeDeleted returns deleted items (for audit)', () => {
      const item = makeVaultItem();
      storeItem('general', item);
      deleteItem('general', item.id);
      const found = getItemIncludeDeleted('general', item.id);
      expect(found).not.toBeNull();
      expect(found!.deleted).toBe(1);
    });
  });
});
