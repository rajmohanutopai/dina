/**
 * T8.6 — HNSW vector index: approximate nearest-neighbor search.
 *
 * Source: ARCHITECTURE.md Task 8.6
 */

import { HNSWIndex, type SearchResult } from '../../src/embedding/hnsw';

/** Create a random unit vector of given dimensions. */
function randomVector(dims: number): Float32Array {
  const v = new Float32Array(dims);
  let mag = 0;
  for (let i = 0; i < dims; i++) {
    v[i] = Math.random() * 2 - 1;
    mag += v[i] * v[i];
  }
  mag = Math.sqrt(mag);
  for (let i = 0; i < dims; i++) v[i] /= mag;
  return v;
}

/** Create a vector pointing strongly in a given direction. */
function directedVector(dims: number, mainDim: number, strength: number = 0.9): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) v[i] = 0.01;
  v[mainDim] = strength;
  return v;
}

describe('HNSW Vector Index (8.6)', () => {
  describe('basic operations', () => {
    it('inserts and searches a single vector', () => {
      const index = new HNSWIndex({ dimensions: 4 });
      index.insert('a', new Float32Array([1, 0, 0, 0]));

      const results = index.search(new Float32Array([1, 0, 0, 0]), 1);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('a');
      expect(results[0].distance).toBeCloseTo(0, 5); // cosine distance ≈ 0
    });

    it('returns empty for empty index', () => {
      const index = new HNSWIndex({ dimensions: 4 });
      const results = index.search(new Float32Array([1, 0, 0, 0]), 5);
      expect(results).toHaveLength(0);
    });

    it('finds nearest neighbor among multiple vectors', () => {
      const index = new HNSWIndex({ dimensions: 4 });
      index.insert('north', new Float32Array([0, 1, 0, 0]));
      index.insert('east', new Float32Array([1, 0, 0, 0]));
      index.insert('south', new Float32Array([0, -1, 0, 0]));

      const results = index.search(new Float32Array([0.1, 0.9, 0, 0]), 1);
      expect(results[0].id).toBe('north');
    });

    it('returns k results sorted by distance', () => {
      const index = new HNSWIndex({ dimensions: 4 });
      index.insert('close', new Float32Array([0.9, 0.1, 0, 0]));
      index.insert('medium', new Float32Array([0.5, 0.5, 0, 0]));
      index.insert('far', new Float32Array([0, 0, 0, 1]));

      const results = index.search(new Float32Array([1, 0, 0, 0]), 3);
      expect(results).toHaveLength(3);
      expect(results[0].id).toBe('close');
      // Distances should be ascending
      expect(results[0].distance).toBeLessThanOrEqual(results[1].distance);
      expect(results[1].distance).toBeLessThanOrEqual(results[2].distance);
    });

    it('handles k larger than index size', () => {
      const index = new HNSWIndex({ dimensions: 4 });
      index.insert('a', new Float32Array([1, 0, 0, 0]));
      index.insert('b', new Float32Array([0, 1, 0, 0]));

      const results = index.search(new Float32Array([1, 0, 0, 0]), 10);
      expect(results).toHaveLength(2);
    });
  });

  describe('update + remove', () => {
    it('updates an existing vector', () => {
      const index = new HNSWIndex({ dimensions: 4 });
      index.insert('a', new Float32Array([1, 0, 0, 0]));
      index.insert('a', new Float32Array([0, 1, 0, 0])); // update

      const results = index.search(new Float32Array([0, 1, 0, 0]), 1);
      expect(results[0].id).toBe('a');
      expect(results[0].distance).toBeCloseTo(0, 5);
      expect(index.size).toBe(1);
    });

    it('removes a vector', () => {
      const index = new HNSWIndex({ dimensions: 4 });
      index.insert('a', new Float32Array([1, 0, 0, 0]));
      index.insert('b', new Float32Array([0, 1, 0, 0]));

      expect(index.remove('a')).toBe(true);
      expect(index.size).toBe(1);
      expect(index.has('a')).toBe(false);
      expect(index.has('b')).toBe(true);
    });

    it('remove returns false for missing ID', () => {
      const index = new HNSWIndex({ dimensions: 4 });
      expect(index.remove('nonexistent')).toBe(false);
    });
  });

  describe('destroy', () => {
    it('clears all data', () => {
      const index = new HNSWIndex({ dimensions: 4 });
      index.insert('a', new Float32Array([1, 0, 0, 0]));
      index.insert('b', new Float32Array([0, 1, 0, 0]));

      index.destroy();
      expect(index.size).toBe(0);
      expect(index.search(new Float32Array([1, 0, 0, 0]), 5)).toHaveLength(0);
    });
  });

  describe('validation', () => {
    it('rejects wrong dimensions on insert', () => {
      const index = new HNSWIndex({ dimensions: 4 });
      expect(() => index.insert('a', new Float32Array([1, 0]))).toThrow('4 dimensions');
    });

    it('rejects NaN values in vectors', () => {
      const index = new HNSWIndex({ dimensions: 4 });
      expect(() => index.insert('a', new Float32Array([1, NaN, 0, 0]))).toThrow('NaN or Infinity');
    });

    it('rejects Infinity values in vectors', () => {
      const index = new HNSWIndex({ dimensions: 4 });
      expect(() => index.insert('a', new Float32Array([1, Infinity, 0, 0]))).toThrow(
        'NaN or Infinity',
      );
    });

    it('rejects negative Infinity', () => {
      const index = new HNSWIndex({ dimensions: 4 });
      expect(() => index.insert('a', new Float32Array([1, -Infinity, 0, 0]))).toThrow(
        'NaN or Infinity',
      );
    });

    it('reports the index of the invalid value', () => {
      const index = new HNSWIndex({ dimensions: 4 });
      expect(() => index.insert('a', new Float32Array([0, 0, NaN, 0]))).toThrow('index 2');
    });

    it('accepts valid float values including zero and negative', () => {
      const index = new HNSWIndex({ dimensions: 4 });
      expect(() => index.insert('a', new Float32Array([0, -0.5, 0.999, -1]))).not.toThrow();
    });

    it('rejects wrong dimensions on search', () => {
      const index = new HNSWIndex({ dimensions: 4 });
      index.insert('a', new Float32Array([1, 0, 0, 0]));
      expect(() => index.search(new Float32Array([1, 0]), 1)).toThrow('4 dimensions');
    });
  });

  describe('scale test — 768 dimensions', () => {
    it('correctly finds nearest neighbor in 768-dim space', () => {
      const index = new HNSWIndex({ dimensions: 768, M: 16, efConstruction: 50 });

      // Insert 100 random vectors
      const vectors: Array<{ id: string; v: Float32Array }> = [];
      for (let i = 0; i < 100; i++) {
        const v = randomVector(768);
        vectors.push({ id: `item-${i}`, v });
        index.insert(`item-${i}`, v);
      }

      expect(index.size).toBe(100);

      // Query with one of the inserted vectors — should find itself
      const query = vectors[42].v;
      const results = index.search(query, 1, 100);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('item-42');
      expect(results[0].distance).toBeCloseTo(0, 3);
    });

    it('finds nearest neighbor accurately (recall > 0.8)', () => {
      const index = new HNSWIndex({ dimensions: 768, M: 16, efConstruction: 100 });

      // Insert 200 random vectors
      const vectors: Float32Array[] = [];
      for (let i = 0; i < 200; i++) {
        const v = randomVector(768);
        vectors.push(v);
        index.insert(`item-${i}`, v);
      }

      // Test recall: for 20 random queries, check if true NN is in top-5
      let hits = 0;
      const trials = 20;

      for (let t = 0; t < trials; t++) {
        const queryIdx = Math.floor(Math.random() * 200);
        const query = vectors[queryIdx];

        // Brute-force true nearest neighbor
        let bestDist = Infinity;
        let bestId = '';
        for (let i = 0; i < 200; i++) {
          if (i === queryIdx) continue;
          const dist = cosineDistance(query, vectors[i]);
          if (dist < bestDist) {
            bestDist = dist;
            bestId = `item-${i}`;
          }
        }

        // HNSW approximate result
        const results = index.search(query, 5, 100);
        if (results.some((r) => r.id === bestId)) hits++;
      }

      const recall = hits / trials;
      expect(recall).toBeGreaterThanOrEqual(0.8);
    });
  });

  describe('clustering — directed vectors', () => {
    it('separates clusters correctly', () => {
      const index = new HNSWIndex({ dimensions: 8 });

      // Cluster A: dim 0
      for (let i = 0; i < 10; i++) index.insert(`a-${i}`, directedVector(8, 0));
      // Cluster B: dim 4
      for (let i = 0; i < 10; i++) index.insert(`b-${i}`, directedVector(8, 4));

      // Query near cluster A
      const results = index.search(directedVector(8, 0), 5);
      const ids = results.map((r) => r.id);
      expect(ids.every((id) => id.startsWith('a-'))).toBe(true);
    });
  });

  describe('update (delete + re-insert)', () => {
    it('moves a node to a new position and finds it there', () => {
      const index = new HNSWIndex({ dimensions: 8 });

      // Insert 3 nodes: A near dim 0, B near dim 4, target near dim 0
      index.insert('a', directedVector(8, 0));
      index.insert('b', directedVector(8, 4));
      index.insert('target', directedVector(8, 0, 0.95));

      // Verify target is found when searching near dim 0
      let results = index.search(directedVector(8, 0), 2);
      expect(results.map((r) => r.id)).toContain('target');

      // Now update target to point near dim 4 instead
      index.insert('target', directedVector(8, 4, 0.95));

      // Target should now be found near dim 4, NOT near dim 0
      results = index.search(directedVector(8, 4), 2);
      expect(results.map((r) => r.id)).toContain('target');

      // And should NOT be the closest to dim 0 anymore
      results = index.search(directedVector(8, 0), 1);
      expect(results[0].id).toBe('a'); // 'a' should be closest to dim 0
    });

    it('preserves node count after update', () => {
      const index = new HNSWIndex({ dimensions: 4 });
      index.insert('x', new Float32Array([1, 0, 0, 0]));
      index.insert('y', new Float32Array([0, 1, 0, 0]));

      expect(index.size).toBe(2);

      // Update x — should still have 2 nodes, not 3
      index.insert('x', new Float32Array([0, 0, 1, 0]));
      expect(index.size).toBe(2);
    });

    it('rebuilds edges correctly after multiple updates', () => {
      const index = new HNSWIndex({ dimensions: 4 });

      // Build a small cluster
      index.insert('a', new Float32Array([1, 0, 0, 0]));
      index.insert('b', new Float32Array([0, 1, 0, 0]));
      index.insert('c', new Float32Array([0, 0, 1, 0]));

      // Update 'a' to be near 'c'
      index.insert('a', new Float32Array([0, 0, 0.99, 0]));

      // Search near dim 2 — should find both 'c' and 'a' (now close together)
      const results = index.search(new Float32Array([0, 0, 1, 0]), 2);
      const ids = results.map((r) => r.id);
      expect(ids).toContain('a');
      expect(ids).toContain('c');
    });
  });
});

/** Helper: cosine distance for brute-force verification. */
function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 1 : 1 - dot / denom;
}
