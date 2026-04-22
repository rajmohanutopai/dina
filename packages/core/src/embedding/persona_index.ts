/**
 * Per-persona HNSW index manager.
 *
 * Each open persona gets its own HNSW index, built from vault embeddings
 * on unlock and destroyed on lock.
 *
 * The manager provides the bridge between the vault (stores embeddings
 * as Uint8Array BLOBs) and the HNSW index (uses Float32Array vectors).
 *
 * Source: ARCHITECTURE.md Tasks 8.6, 8.7
 */

import { HNSWIndex, type SearchResult } from './hnsw';
import { DEFAULT_EMBEDDING_DIMENSIONS } from '../constants';

const DEFAULT_DIMENSIONS = DEFAULT_EMBEDDING_DIMENSIONS;

/** Per-persona indexes. */
const indexes = new Map<string, HNSWIndex>();

/**
 * Build the HNSW index for a persona from its vault items.
 *
 * Called on persona unlock. Loads all items with embeddings and inserts them.
 */
export function buildIndex(
  persona: string,
  items: Array<{ id: string; embedding: Uint8Array | Float32Array }>,
  dimensions?: number,
): number {
  const dims = dimensions ?? DEFAULT_DIMENSIONS;
  const index = new HNSWIndex({ dimensions: dims });

  let count = 0;
  for (const item of items) {
    const vector = toFloat32(item.embedding, dims);
    if (vector) {
      index.insert(item.id, vector);
      count++;
    }
  }

  indexes.set(persona, index);
  return count;
}

/**
 * Search the persona's HNSW index for nearest neighbors.
 *
 * Returns item IDs with cosine distance (0 = identical, 2 = opposite).
 */
export function searchIndex(
  persona: string,
  query: Float32Array,
  k: number,
  ef?: number,
): SearchResult[] {
  const index = indexes.get(persona);
  if (!index) return [];
  return index.search(query, k, ef);
}

/**
 * Add a single item to the persona's index (after vault store).
 */
export function addToIndex(
  persona: string,
  id: string,
  embedding: Uint8Array | Float32Array,
  dimensions?: number,
): boolean {
  const index = indexes.get(persona);
  if (!index) return false;

  const vector = toFloat32(embedding, dimensions ?? DEFAULT_DIMENSIONS);
  if (!vector) return false;

  index.insert(id, vector);
  return true;
}

/**
 * Remove a single item from the persona's index (after vault delete).
 */
export function removeFromIndex(persona: string, id: string): boolean {
  const index = indexes.get(persona);
  if (!index) return false;
  return index.remove(id);
}

/**
 * Destroy the persona's index (on persona lock).
 */
export function destroyIndex(persona: string): void {
  const index = indexes.get(persona);
  if (index) {
    index.destroy();
    indexes.delete(persona);
  }
}

/**
 * Check if a persona has an active index.
 */
export function hasIndex(persona: string): boolean {
  return indexes.has(persona);
}

/**
 * Get the size of a persona's index.
 */
export function indexSize(persona: string): number {
  return indexes.get(persona)?.size ?? 0;
}

/**
 * Destroy all indexes (for testing).
 */
export function destroyAllIndexes(): void {
  for (const index of indexes.values()) {
    index.destroy();
  }
  indexes.clear();
}

/** Convert Uint8Array (raw Float32 bytes) to Float32Array. Returns null if invalid. */
function toFloat32(data: Uint8Array | Float32Array, expectedDims: number): Float32Array | null {
  if (data instanceof Float32Array) {
    return data.length === expectedDims ? data : null;
  }
  // Uint8Array: must be exactly expectedDims * 4 bytes
  if (data.byteLength !== expectedDims * 4) return null;
  return new Float32Array(data.buffer, data.byteOffset, expectedDims);
}
