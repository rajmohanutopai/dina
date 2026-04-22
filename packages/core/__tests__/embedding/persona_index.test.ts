/**
 * T8.7 — Full hybrid search with HNSW + per-persona index management.
 *
 * Source: ARCHITECTURE.md Tasks 8.6, 8.7
 */

import {
  buildIndex,
  searchIndex,
  addToIndex,
  removeFromIndex,
  destroyIndex,
  hasIndex,
  indexSize,
  destroyAllIndexes,
} from '../../src/embedding/persona_index';
import { storeItem, queryVault, clearVaults } from '../../src/vault/crud';

/** Create a Float32Array embedding. */
function embed(...values: number[]): Float32Array {
  return new Float32Array(values);
}

/** Create a Uint8Array (raw Float32 bytes) for vault storage. */
function embedBytes(...values: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(values).buffer);
}

describe('Per-Persona HNSW Index (8.7)', () => {
  afterEach(() => {
    destroyAllIndexes();
    clearVaults();
  });

  describe('buildIndex', () => {
    it('builds index from vault items', () => {
      const items = [
        { id: 'v1', embedding: embed(0.9, 0.1, 0, 0) },
        { id: 'v2', embedding: embed(0.1, 0.9, 0, 0) },
        { id: 'v3', embedding: embed(0, 0, 0.9, 0.1) },
      ];

      const count = buildIndex('general', items, 4);

      expect(count).toBe(3);
      expect(hasIndex('general')).toBe(true);
      expect(indexSize('general')).toBe(3);
    });

    it('accepts Uint8Array embeddings', () => {
      const items = [{ id: 'v1', embedding: embedBytes(0.9, 0.1, 0, 0) }];

      const count = buildIndex('general', items, 4);
      expect(count).toBe(1);
    });

    it('skips items with wrong dimension embeddings', () => {
      const items = [
        { id: 'v1', embedding: embed(0.9, 0.1, 0, 0) }, // 4 dims ✓
        { id: 'v2', embedding: embed(0.9, 0.1) }, // 2 dims ✗
      ];

      const count = buildIndex('general', items, 4);
      expect(count).toBe(1);
    });
  });

  describe('searchIndex', () => {
    it('returns nearest neighbors', () => {
      const items = [
        { id: 'health', embedding: embed(0.9, 0.1, 0, 0) },
        { id: 'finance', embedding: embed(0, 0, 0.9, 0.1) },
      ];
      buildIndex('general', items, 4);

      const results = searchIndex('general', embed(0.8, 0.2, 0, 0), 1);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('health');
    });

    it('returns empty for non-existent persona', () => {
      const results = searchIndex('missing', embed(1, 0, 0, 0), 5);
      expect(results).toHaveLength(0);
    });
  });

  describe('addToIndex / removeFromIndex', () => {
    it('adds item to existing index', () => {
      buildIndex('general', [], 4);
      addToIndex('general', 'new-1', embed(1, 0, 0, 0), 4);

      expect(indexSize('general')).toBe(1);
      const results = searchIndex('general', embed(1, 0, 0, 0), 1);
      expect(results[0].id).toBe('new-1');
    });

    it('removes item from index', () => {
      buildIndex('general', [{ id: 'v1', embedding: embed(1, 0, 0, 0) }], 4);

      removeFromIndex('general', 'v1');
      expect(indexSize('general')).toBe(0);
    });

    it('returns false for non-existent persona', () => {
      expect(addToIndex('missing', 'x', embed(1, 0, 0, 0), 4)).toBe(false);
      expect(removeFromIndex('missing', 'x')).toBe(false);
    });
  });

  describe('destroyIndex', () => {
    it('destroys persona index on lock', () => {
      buildIndex('health', [{ id: 'v1', embedding: embed(1, 0, 0, 0) }], 4);

      destroyIndex('health');
      expect(hasIndex('health')).toBe(false);
      expect(indexSize('health')).toBe(0);
    });
  });

  describe('vault hybrid search with HNSW', () => {
    it('hybrid search uses HNSW when index is built', () => {
      // Store items in vault with embeddings
      const id1 = storeItem('work', {
        summary: 'Budget meeting notes',
        type: 'note',
        embedding: embedBytes(0.9, 0.1, 0.0, 0.0),
      });
      const id2 = storeItem('work', {
        summary: 'Lab results',
        type: 'note',
        embedding: embedBytes(0.0, 0.0, 0.9, 0.1),
      });

      // Build HNSW index for the persona
      buildIndex(
        'work',
        [
          { id: id1, embedding: embed(0.9, 0.1, 0, 0) },
          { id: id2, embedding: embed(0, 0, 0.9, 0.1) },
        ],
        4,
      );

      // Hybrid search — HNSW should accelerate the semantic component
      const results = queryVault('work', {
        mode: 'hybrid',
        text: 'budget',
        embedding: embed(0.8, 0.2, 0, 0),
        limit: 5,
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      // Budget notes should rank high (FTS match + similar embedding)
      expect(results[0].summary).toContain('Budget');
    });

    it('semantic search uses HNSW when index is built', () => {
      const id1 = storeItem('general', {
        summary: 'Close match',
        type: 'note',
        embedding: embedBytes(0.9, 0.1, 0, 0),
      });
      storeItem('general', {
        summary: 'Far match',
        type: 'note',
        embedding: embedBytes(0, 0, 0.9, 0.1),
      });

      buildIndex('general', [{ id: id1, embedding: embed(0.9, 0.1, 0, 0) }], 4);

      const results = queryVault('general', {
        mode: 'semantic',
        text: '',
        embedding: embed(0.8, 0.2, 0, 0),
        limit: 5,
      });

      // Only close match should appear (HNSW only has id1)
      expect(results).toHaveLength(1);
      expect(results[0].summary).toBe('Close match');
    });

    it('falls back to brute-force when no HNSW index', () => {
      storeItem('general', {
        summary: 'Item A',
        type: 'note',
        embedding: embedBytes(0.9, 0.1, 0, 0),
      });

      // No buildIndex call — should use brute-force
      const results = queryVault('general', {
        mode: 'semantic',
        text: '',
        embedding: embed(0.8, 0.2, 0, 0),
        limit: 5,
      });

      expect(results).toHaveLength(1);
      expect(results[0].summary).toBe('Item A');
    });
  });
});
