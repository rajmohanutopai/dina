/**
 * HNSW (Hierarchical Navigable Small World) vector index.
 *
 * In-memory approximate nearest-neighbor search for 768-dim embeddings.
 * Built on persona unlock (load embeddings from vault), destroyed on lock.
 *
 * Algorithm:
 *   - Multi-layer graph where each layer has fewer nodes
 *   - Search starts at top layer, greedily descends to find entry point
 *   - Then searches the base layer (layer 0) more thoroughly
 *   - Insert selects random layer based on exponential distribution
 *
 * Parameters (tuned for ~10K items, 768 dimensions):
 *   M = 16            — max connections per node per layer
 *   efConstruction = 200 — search width during build
 *   efSearch = 50      — search width during query (adjustable)
 *
 * Memory: ~50MB for 10K items with 768-dim float32 vectors.
 *
 * Source: ARCHITECTURE.md Task 8.6
 */

export interface HNSWConfig {
  /** Max connections per node per layer (default: 16). */
  M?: number;
  /** Search width during construction (default: 200). */
  efConstruction?: number;
  /** Dimensions of vectors. */
  dimensions: number;
}

export interface SearchResult {
  id: string;
  distance: number; // cosine distance (1 - similarity)
}

interface HNSWNode {
  id: string;
  vector: Float32Array;
  layer: number;
  neighbors: Map<number, Set<string>>; // layer → set of neighbor IDs
}

import { HNSW_DEFAULT_M, HNSW_DEFAULT_EF_CONSTRUCTION } from '../constants';

const DEFAULT_M = HNSW_DEFAULT_M;
const DEFAULT_EF_CONSTRUCTION = HNSW_DEFAULT_EF_CONSTRUCTION;

export class HNSWIndex {
  private readonly M: number;
  private readonly efConstruction: number;
  private readonly dimensions: number;
  private readonly mL: number; // normalization factor for layer selection

  private readonly nodes: Map<string, HNSWNode> = new Map();
  private entryPointId: string | null = null;
  private maxLayer = -1;

  constructor(config: HNSWConfig) {
    this.M = config.M ?? DEFAULT_M;
    this.efConstruction = config.efConstruction ?? DEFAULT_EF_CONSTRUCTION;
    this.dimensions = config.dimensions;
    // Fixed: Go hardcodes mL = 0.25 (not 1/ln(M) ≈ 0.36 for M=16).
    // Using 0.25 produces the same graph topology as Go — flatter graphs
    // with fewer layers. The 1/ln(M) formula is the theoretical HNSW paper
    // value, but Go's 0.25 is the tuned production value.
    this.mL = 0.25;
  }

  /**
   * Insert a vector into the index.
   */
  insert(id: string, vector: Float32Array): void {
    if (vector.length !== this.dimensions) {
      throw new Error(`hnsw: expected ${this.dimensions} dimensions, got ${vector.length}`);
    }
    // Reject NaN/Inf values — they corrupt cosine distance calculations.
    // Matches Go's EncodeEmbedding validation.
    for (let i = 0; i < vector.length; i++) {
      if (!isFinite(vector[i])) {
        throw new Error(`hnsw: vector contains NaN or Infinity at index ${i}`);
      }
    }
    if (this.nodes.has(id)) {
      // Update: delete then re-insert to rebuild graph edges for the new
      // vector position. Just swapping the vector in-place would leave the
      // node's neighbors pointing to stale positions — a correctness bug.
      this.remove(id);
    }

    const nodeLayer = this.randomLayer();
    const node: HNSWNode = {
      id,
      vector,
      layer: nodeLayer,
      neighbors: new Map(),
    };

    // Initialize neighbor sets for each layer
    for (let l = 0; l <= nodeLayer; l++) {
      node.neighbors.set(l, new Set());
    }

    this.nodes.set(id, node);

    // First node — just set as entry point
    if (this.entryPointId === null) {
      this.entryPointId = id;
      this.maxLayer = nodeLayer;
      return;
    }

    // Search from top to find entry point for insertion
    let currentId = this.entryPointId;

    // Traverse from maxLayer down to nodeLayer+1 (greedy search)
    for (let l = this.maxLayer; l > nodeLayer; l--) {
      currentId = this.greedySearch(vector, currentId, l);
    }

    // Insert at each layer from min(nodeLayer, maxLayer) down to 0
    for (let l = Math.min(nodeLayer, this.maxLayer); l >= 0; l--) {
      const neighbors = this.searchLayer(vector, currentId, this.efConstruction, l);

      // Select M best neighbors
      const selected = this.selectNeighbors(vector, neighbors, this.M);

      // Connect bidirectionally
      for (const neighborId of selected) {
        node.neighbors.get(l)!.add(neighborId);
        const neighborNode = this.nodes.get(neighborId)!;
        if (!neighborNode.neighbors.has(l)) {
          neighborNode.neighbors.set(l, new Set());
        }
        neighborNode.neighbors.get(l)!.add(id);

        // Prune if neighbor has too many connections
        if (neighborNode.neighbors.get(l)!.size > this.M * 2) {
          this.pruneConnections(neighborNode, l);
        }
      }

      if (selected.length > 0) {
        currentId = selected[0];
      }
    }

    // Update entry point if new node has higher layer
    if (nodeLayer > this.maxLayer) {
      this.entryPointId = id;
      this.maxLayer = nodeLayer;
    }
  }

  /**
   * Search for k nearest neighbors.
   *
   * @param query — query vector
   * @param k — number of results
   * @param ef — search width (higher = more accurate, slower). Default: 50.
   */
  search(query: Float32Array, k: number, ef?: number): SearchResult[] {
    if (this.entryPointId === null || this.nodes.size === 0) return [];
    if (query.length !== this.dimensions) {
      throw new Error(`hnsw: expected ${this.dimensions} dimensions, got ${query.length}`);
    }

    const searchEf = Math.max(ef ?? 50, k);
    let currentId = this.entryPointId;

    // Traverse from top layer to layer 1
    for (let l = this.maxLayer; l > 0; l--) {
      currentId = this.greedySearch(query, currentId, l);
    }

    // Search layer 0 with ef candidates
    const candidates = this.searchLayer(query, currentId, searchEf, 0);

    // Return top-k sorted by distance (ascending = closest first)
    return candidates
      .map((id) => ({ id, distance: this.cosineDistance(query, this.nodes.get(id)!.vector) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k);
  }

  /** Remove a node from the index. */
  remove(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;

    // Remove from all neighbors' neighbor lists
    for (const [layer, neighbors] of node.neighbors) {
      for (const neighborId of neighbors) {
        const neighbor = this.nodes.get(neighborId);
        if (neighbor?.neighbors.has(layer)) {
          neighbor.neighbors.get(layer)!.delete(id);
        }
      }
    }

    this.nodes.delete(id);

    // Update entry point if removed
    if (this.entryPointId === id) {
      if (this.nodes.size === 0) {
        this.entryPointId = null;
        this.maxLayer = -1;
      } else {
        // Pick the node with the highest layer
        let bestId = '';
        let bestLayer = -1;
        for (const [nid, n] of this.nodes) {
          if (n.layer > bestLayer) {
            bestLayer = n.layer;
            bestId = nid;
          }
        }
        this.entryPointId = bestId;
        this.maxLayer = bestLayer;
      }
    }

    return true;
  }

  /** Number of indexed vectors. */
  get size(): number {
    return this.nodes.size;
  }

  /** Destroy the index — free all memory. */
  destroy(): void {
    this.nodes.clear();
    this.entryPointId = null;
    this.maxLayer = -1;
  }

  /** Check if an ID exists in the index. */
  has(id: string): boolean {
    return this.nodes.has(id);
  }

  // ---------------------------------------------------------------
  // Internal search helpers
  // ---------------------------------------------------------------

  /** Greedy search at a single layer — find closest single node. */
  private greedySearch(query: Float32Array, startId: string, layer: number): string {
    let currentId = startId;
    let currentDist = this.cosineDistance(query, this.nodes.get(currentId)!.vector);

    let improved = true;
    while (improved) {
      improved = false;
      const neighbors = this.nodes.get(currentId)?.neighbors.get(layer);
      if (!neighbors) break;

      for (const neighborId of neighbors) {
        const node = this.nodes.get(neighborId);
        if (!node) continue;
        const dist = this.cosineDistance(query, node.vector);
        if (dist < currentDist) {
          currentId = neighborId;
          currentDist = dist;
          improved = true;
        }
      }
    }

    return currentId;
  }

  /** Search a layer with ef candidates — returns the ef closest IDs. */
  private searchLayer(query: Float32Array, startId: string, ef: number, layer: number): string[] {
    const visited = new Set<string>([startId]);
    const candidates: Array<{ id: string; dist: number }> = [
      {
        id: startId,
        dist: this.cosineDistance(query, this.nodes.get(startId)!.vector),
      },
    ];
    const results: Array<{ id: string; dist: number }> = [...candidates];

    while (candidates.length > 0) {
      // Get closest candidate
      candidates.sort((a, b) => a.dist - b.dist);
      const closest = candidates.shift()!;

      // Get worst result
      results.sort((a, b) => a.dist - b.dist);
      const worstDist = results.length > 0 ? results[results.length - 1].dist : Infinity;

      if (closest.dist > worstDist && results.length >= ef) break;

      const neighbors = this.nodes.get(closest.id)?.neighbors.get(layer);
      if (!neighbors) continue;

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const node = this.nodes.get(neighborId);
        if (!node) continue;

        const dist = this.cosineDistance(query, node.vector);

        if (results.length < ef || dist < worstDist) {
          candidates.push({ id: neighborId, dist });
          results.push({ id: neighborId, dist });

          if (results.length > ef) {
            results.sort((a, b) => a.dist - b.dist);
            results.pop(); // Remove worst
          }
        }
      }
    }

    return results.map((r) => r.id);
  }

  /** Select the M best neighbors from candidates. */
  private selectNeighbors(query: Float32Array, candidateIds: string[], M: number): string[] {
    const scored = candidateIds
      .map((id) => ({ id, dist: this.cosineDistance(query, this.nodes.get(id)!.vector) }))
      .sort((a, b) => a.dist - b.dist);
    return scored.slice(0, M).map((s) => s.id);
  }

  /** Prune connections of a node to at most M*2 on a given layer. */
  private pruneConnections(node: HNSWNode, layer: number): void {
    const neighbors = node.neighbors.get(layer);
    if (!neighbors || neighbors.size <= this.M * 2) return;

    const scored = [...neighbors]
      .map((id) => ({ id, dist: this.cosineDistance(node.vector, this.nodes.get(id)!.vector) }))
      .sort((a, b) => a.dist - b.dist);

    const keep = new Set(scored.slice(0, this.M).map((s) => s.id));
    for (const id of neighbors) {
      if (!keep.has(id)) {
        neighbors.delete(id);
        // Remove back-link
        this.nodes.get(id)?.neighbors.get(layer)?.delete(node.id);
      }
    }
  }

  /** Random layer based on exponential distribution. */
  private randomLayer(): number {
    return Math.floor(-Math.log(Math.random()) * this.mL);
  }

  /** Cosine distance = 1 - cosine_similarity. Lower = more similar. */
  private cosineDistance(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    const len = Math.min(a.length, b.length);

    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }

    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    if (denom === 0) return 1;
    return 1 - dot / denom;
  }
}
