/**
 * Vault CRUD — in-memory per-persona vault item store.
 *
 * Provides store, query (keyword search), get, delete (soft), and batch
 * operations. Per-persona isolation: items in "health" vault are invisible
 * to "general" queries.
 *
 * In production, this layer sits atop SQLCipher + FTS5. The in-memory
 * implementation provides the same interface for testing and early
 * integration before the storage layer is wired up.
 *
 * Source: core/test/vault_test.go (CRUD section)
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { VaultItem, SearchQuery } from '@dina/test-harness';
import { searchIndex, hasIndex } from '../embedding/persona_index';
import {
  VAULT_QUERY_DEFAULT_LIMIT,
  VAULT_QUERY_MAX_LIMIT,
  HYBRID_FTS_WEIGHT,
  HYBRID_SEMANTIC_WEIGHT,
  TRUST_RERANK_CAVEATED,
  TRUST_RERANK_TRUSTED,
  TRUST_RERANK_LOW_CONFIDENCE,
} from '../constants';
import { validateVaultItem, SEARCHABLE_RETRIEVAL_POLICIES } from './validation';
import { getVaultRepository } from './repository';

const MAX_BATCH_SIZE = 100;

/**
 * Check if an item should appear in default search results.
 *
 * Filters: not deleted, and retrieval_policy is searchable
 * (normal, caveated, or empty). Quarantined and briefing_only items
 * are excluded by default — matching Go's VaultService.Query behavior.
 */
function isSearchable(item: VaultItem): boolean {
  if (item.deleted) return false;
  return SEARCHABLE_RETRIEVAL_POLICIES.has(item.retrieval_policy);
}

/**
 * Check if an item passes the query's type and time range filters.
 *
 * Matches Go's vault search parameters:
 *   - types[]: only items with matching type
 *   - after: only items with timestamp > after (Unix ms)
 *   - before: only items with timestamp < before (Unix ms)
 */
function passesFilters(item: VaultItem, query: SearchQuery): boolean {
  if (query.types && query.types.length > 0) {
    if (!query.types.includes(item.type)) return false;
  }
  if (query.after != null) {
    if (item.timestamp < query.after) return false;
  }
  if (query.before != null) {
    if (item.timestamp > query.before) return false;
  }
  return true;
}

/**
 * Apply offset pagination to a results array.
 * Skips the first `offset` items. Applied after scoring/sorting.
 */
function applyOffset<T>(results: T[], offset?: number): T[] {
  if (offset && offset > 0) return results.slice(offset);
  return results;
}

/** Per-persona vault stores. Map<persona, Map<itemId, VaultItem>>. */
const vaults = new Map<string, Map<string, VaultItem>>();

/** Get or create a persona vault. */
function getVault(persona: string): Map<string, VaultItem> {
  let vault = vaults.get(persona);
  if (!vault) {
    vault = new Map();
    vaults.set(persona, vault);
  }
  return vault;
}

/** Clear all vaults (for testing). */
export function clearVaults(): void {
  vaults.clear();
}

/**
 * Store an item in a persona vault. Returns the item ID.
 *
 * Auto-generates an ID if the item's id field is empty or missing.
 */
export function storeItem(persona: string, item: Partial<VaultItem>): string {
  // Validate enum fields before storage (defense-in-depth)
  const validationError = validateVaultItem(item);
  if (validationError) {
    throw new Error(`vault: ${validationError}`);
  }

  const vault = getVault(persona);
  const id = item.id && item.id.length > 0 ? item.id : `vi-${bytesToHex(randomBytes(8))}`;
  const now = Date.now();

  const stored: VaultItem = {
    id,
    type: item.type ?? 'note',
    source: item.source ?? '',
    source_id: item.source_id ?? '',
    contact_did: item.contact_did ?? '',
    summary: item.summary ?? '',
    body: item.body ?? '',
    metadata: item.metadata ?? '{}',
    tags: item.tags ?? '[]',
    content_l0: item.content_l0 ?? '',
    content_l1: item.content_l1 ?? '',
    deleted: 0,
    timestamp: item.timestamp ?? now,
    created_at: item.created_at ?? now,
    updated_at: now,
    sender: item.sender ?? '',
    sender_trust: item.sender_trust ?? 'unknown',
    source_type: item.source_type ?? '',
    confidence: item.confidence ?? 'medium',
    retrieval_policy: item.retrieval_policy ?? 'normal',
    contradicts: item.contradicts ?? '',
    enrichment_status: item.enrichment_status ?? 'pending',
    enrichment_version: item.enrichment_version ?? '',
    ...(item.embedding ? { embedding: item.embedding } : {}),
  };

  // SQL persistence path (when repository is wired) — fire-and-forget
  // since Phase 2.3 (task 2.3). In-memory `vault` Map is authoritative
  // for reads within the process; SQL persists across restart but a
  // transient write failure doesn't affect correctness. Double-guarded
  // for sync-throw mocks + async rejection.
  const sqlRepo = getVaultRepository(persona);
  if (sqlRepo) {
    try {
      void sqlRepo.storeItem(stored).catch(() => {
        /* fail-safe — transient SQL write loss is acceptable */
      });
    } catch {
      /* fail-safe — sync-throw variant */
    }
  }

  vault.set(id, stored);
  return id;
}

/**
 * Store multiple items atomically. Returns array of IDs.
 *
 * Max 100 items per batch. Throws on oversized batch.
 * Empty batch is a no-op returning empty array.
 *
 * Transactional: validates ALL items before storing ANY.
 * If any item fails validation, none are stored (matching Go's
 * single TX with rollback behavior).
 */
export function storeBatch(persona: string, items: Partial<VaultItem>[]): string[] {
  if (items.length > MAX_BATCH_SIZE) {
    throw new Error(`vault: batch size ${items.length} exceeds maximum ${MAX_BATCH_SIZE}`);
  }

  // Phase 1: Validate all items BEFORE storing any (rollback semantics)
  for (let i = 0; i < items.length; i++) {
    const validationError = validateVaultItem(items[i]);
    if (validationError) {
      throw new Error(`vault: batch item ${i}: ${validationError}`);
    }
  }

  // Phase 2: All valid — store atomically
  return items.map((item) => storeItem(persona, item));
}

/**
 * Query vault items by keyword search (FTS-like).
 *
 * Supports three search modes:
 *   - fts5:     keyword matching on summary/body/content_l0/content_l1
 *   - semantic: cosine similarity on embeddings (requires query.embedding)
 *   - hybrid:   0.4 × FTS5 + 0.6 × cosine similarity (combined reranking)
 *
 * Excludes soft-deleted items. Clamps limit to [1, 100].
 */
export function queryVault(persona: string, query: SearchQuery): VaultItem[] {
  const mode = query.mode || 'fts5';

  switch (mode) {
    case 'fts5':
      return queryFTS(persona, query);
    case 'semantic':
      return querySemantic(persona, query);
    case 'hybrid':
      return queryHybrid(persona, query);
    default:
      return queryFTS(persona, query);
  }
}

/** FTS5-style keyword search. Excludes quarantined/briefing_only items. */
function queryFTS(persona: string, query: SearchQuery): VaultItem[] {
  const vault = getVault(persona);
  const limit = clampLimit(query.limit);
  const terms = query.text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return [];

  const results: Array<{ item: VaultItem; score: number }> = [];

  for (const item of vault.values()) {
    if (!isSearchable(item)) continue;
    if (!passesFilters(item, query)) continue;

    const searchable = [item.summary, item.body, item.content_l0, item.content_l1]
      .join(' ')
      .toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (searchable.includes(term)) score++;
    }

    if (score > 0) {
      results.push({ item, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return applyOffset(results, query.offset)
    .slice(0, limit)
    .map((r) => r.item);
}

/**
 * Semantic search via cosine similarity on embeddings.
 *
 * Uses HNSW index when available (O(log n) approximate nearest-neighbor).
 * Falls back to brute-force O(n) scan when HNSW is not built.
 */
function querySemantic(persona: string, query: SearchQuery): VaultItem[] {
  const vault = getVault(persona);
  const limit = clampLimit(query.limit);

  if (!query.embedding || query.embedding.length === 0) return [];

  // Try HNSW first (O(log n))
  if (hasIndex(persona)) {
    const hnswResults = searchIndex(persona, query.embedding, limit + (query.offset ?? 0));
    const filtered = hnswResults
      .map((r) => vault.get(r.id))
      .filter(
        (item): item is VaultItem =>
          item !== undefined && isSearchable(item) && passesFilters(item, query),
      );
    return applyOffset(filtered, query.offset).slice(0, limit);
  }

  // Fallback: brute-force scan (O(n))
  const results: Array<{ item: VaultItem; score: number }> = [];

  for (const item of vault.values()) {
    if (!isSearchable(item)) continue;
    if (!passesFilters(item, query)) continue;
    if (!item.embedding || item.embedding.length === 0) continue;

    const score = cosineSimilarity(query.embedding, item.embedding);
    if (score > 0) {
      results.push({ item, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return applyOffset(results, query.offset)
    .slice(0, limit)
    .map((r) => r.item);
}

/**
 * Hybrid search: 0.4 × FTS5 + 0.6 × cosine similarity.
 *
 * Both FTS and semantic scores are normalized to [0, 1] before combining.
 * Items that match on FTS only, semantic only, or both are all included.
 * The combined score determines final ranking.
 */
function queryHybrid(persona: string, query: SearchQuery): VaultItem[] {
  const vault = getVault(persona);
  const limit = clampLimit(query.limit);
  const terms = query.text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const hasEmbedding = query.embedding && query.embedding.length > 0;

  // If no text AND no embedding, nothing to search
  if (terms.length === 0 && !hasEmbedding) return [];

  // Use HNSW for semantic component when available
  const useHNSW = hasEmbedding && hasIndex(persona);

  // Collect raw scores
  const ftsScores = new Map<string, number>();
  const semanticScores = new Map<string, number>();
  let maxFts = 0;
  let maxSemantic = 0;

  // HNSW path: get semantic scores from index (O(log n))
  if (useHNSW) {
    const hnswResults = searchIndex(persona, query.embedding!, limit * 3);
    for (const r of hnswResults) {
      const similarity = 1 - r.distance; // convert distance to similarity
      if (similarity > 0) {
        semanticScores.set(r.id, similarity);
        if (similarity > maxSemantic) maxSemantic = similarity;
      }
    }
  }

  for (const item of vault.values()) {
    if (!isSearchable(item)) continue;
    if (!passesFilters(item, query)) continue;

    // FTS score
    if (terms.length > 0) {
      const searchable = [item.summary, item.body, item.content_l0, item.content_l1]
        .join(' ')
        .toLowerCase();

      let ftsScore = 0;
      for (const term of terms) {
        if (searchable.includes(term)) ftsScore++;
      }
      if (ftsScore > 0) {
        ftsScores.set(item.id, ftsScore);
        if (ftsScore > maxFts) maxFts = ftsScore;
      }
    }

    // Semantic score (brute-force per-item, used when HNSW is not available)
    if (!useHNSW && hasEmbedding && item.embedding && item.embedding.length > 0) {
      const semScore = cosineSimilarity(query.embedding!, item.embedding);
      if (semScore > 0) {
        semanticScores.set(item.id, semScore);
        if (semScore > maxSemantic) maxSemantic = semScore;
      }
    }
  }

  // Combine with weights: 0.4 × FTS + 0.6 × cosine
  const FTS_WEIGHT = HYBRID_FTS_WEIGHT;
  const SEMANTIC_WEIGHT = HYBRID_SEMANTIC_WEIGHT;
  const combined = new Map<string, number>();

  // All items that matched on either axis
  const allIds = new Set([...ftsScores.keys(), ...semanticScores.keys()]);

  for (const id of allIds) {
    const normalizedFts = maxFts > 0 ? (ftsScores.get(id) ?? 0) / maxFts : 0;
    const normalizedSem = maxSemantic > 0 ? (semanticScores.get(id) ?? 0) / maxSemantic : 0;
    let score = FTS_WEIGHT * normalizedFts + SEMANTIC_WEIGHT * normalizedSem;

    // Trust-weighted reranking (matching Go vault.go)
    // Compounding multipliers adjust score based on item trust metadata.
    const item = vault.get(id);
    if (item) {
      score *= trustMultiplier(item);
    }

    combined.set(id, score);
  }

  // Sort, apply offset, and return
  const sorted = [...combined.entries()].sort((a, b) => b[1] - a[1]);

  return applyOffset(sorted, query.offset)
    .slice(0, limit)
    .map(([id]) => getVault(persona).get(id))
    .filter((item): item is VaultItem => item !== undefined);
}

/** Clamp limit to [1, VAULT_QUERY_MAX_LIMIT]. */
function clampLimit(limit?: number): number {
  return Math.max(1, Math.min(limit || VAULT_QUERY_DEFAULT_LIMIT, VAULT_QUERY_MAX_LIMIT));
}

/**
 * Compute trust-based reranking multiplier for a vault item.
 *
 * Matches Go's vault.go post-RRF trust modifiers. Multipliers compound:
 *   - caveated retrieval_policy → 0.7x (less certain provenance)
 *   - self/contact_ring1 sender_trust → 1.2x (trusted sources boosted)
 *   - low confidence → 0.6x (low-quality data deprioritized)
 *
 * Example: a caveated + low-confidence item gets 0.7 × 0.6 = 0.42x.
 */
function trustMultiplier(item: VaultItem): number {
  let multiplier = 1.0;

  // Caveated items are demoted (uncertain provenance)
  if (item.retrieval_policy === 'caveated') {
    multiplier *= TRUST_RERANK_CAVEATED;
  }

  // Trusted sources are boosted (self-authored or known contacts)
  if (item.sender_trust === 'self' || item.sender_trust === 'contact_ring1') {
    multiplier *= TRUST_RERANK_TRUSTED;
  }

  // Low-confidence items are demoted
  if (item.confidence === 'low') {
    multiplier *= TRUST_RERANK_LOW_CONFIDENCE;
  }

  return multiplier;
}

/**
 * Cosine similarity between two vectors.
 *
 * Accepts Float32Array or Uint8Array (raw bytes of Float32Array from SQLite BLOB).
 * Returns value in [-1, 1]. Higher = more similar.
 * Returns 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(
  a: Float32Array | Uint8Array,
  b: Float32Array | Uint8Array,
): number {
  const va = toFloat32(a);
  const vb = toFloat32(b);
  const len = Math.min(va.length, vb.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < len; i++) {
    dot += va[i] * vb[i];
    magA += va[i] * va[i];
    magB += vb[i] * vb[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

/** Convert Uint8Array (raw Float32 bytes) to Float32Array. */
function toFloat32(v: Float32Array | Uint8Array): Float32Array {
  if (v instanceof Float32Array) return v;
  // Uint8Array containing raw Float32 bytes
  return new Float32Array(v.buffer, v.byteOffset, v.byteLength / 4);
}

/**
 * Get a single item by ID. Returns null if not found or soft-deleted.
 *
 * Matches Go's GetItem: `WHERE deleted=0`. Soft-deleted items are
 * invisible to callers — only query/search results are filtered by
 * retrieval_policy, but getItem filters only by deleted flag.
 */
export function getItem(persona: string, itemId: string): VaultItem | null {
  const vault = getVault(persona);
  const item = vault.get(itemId);
  if (!item || item.deleted) return null;
  return item;
}

/**
 * Get a single item by ID INCLUDING soft-deleted items.
 *
 * Used internally for operations that need to see deleted items
 * (e.g., undelete, audit, export).
 */
export function getItemIncludeDeleted(persona: string, itemId: string): VaultItem | null {
  const vault = getVault(persona);
  return vault.get(itemId) ?? null;
}

/**
 * Soft-delete an item (sets deleted=1). Returns true if found.
 *
 * Item remains in storage for audit/recovery. Excluded from query results.
 */
export function deleteItem(persona: string, itemId: string): boolean {
  const vault = getVault(persona);
  const item = vault.get(itemId);
  if (!item) return false;

  item.deleted = 1;
  item.updated_at = Date.now();
  return true;
}

/** Count non-deleted items in a persona vault. */
export function vaultItemCount(persona: string): number {
  const vault = getVault(persona);
  let count = 0;
  for (const item of vault.values()) {
    if (!item.deleted) count++;
  }
  return count;
}

/**
 * Query vault items by enrichment status.
 *
 * Returns non-deleted items matching the given enrichment_status,
 * sorted by created_at ascending (oldest first — process in order).
 * Used by the enrichment batch sweep to find pending/failed items.
 */
export function queryByEnrichmentStatus(
  persona: string,
  status: string,
  limit: number = 50,
): VaultItem[] {
  const vault = getVault(persona);
  const results: VaultItem[] = [];

  for (const item of vault.values()) {
    if (item.deleted) continue;
    if (item.enrichment_status === status) {
      results.push(item);
    }
  }

  results.sort((a, b) => a.created_at - b.created_at); // oldest first
  return results.slice(0, limit);
}

/**
 * Update enrichment fields on a vault item.
 *
 * Used by the enrichment sweep to write L1, embedding, and status
 * back to the vault after enrichment completes.
 */
export function updateEnrichment(
  persona: string,
  itemId: string,
  updates: {
    content_l0?: string;
    content_l1?: string;
    enrichment_status?: string;
    enrichment_version?: string;
    embedding?: Uint8Array;
    confidence?: string;
  },
): boolean {
  const vault = getVault(persona);
  const item = vault.get(itemId);
  if (!item || item.deleted) return false;

  if (updates.content_l0 !== undefined) item.content_l0 = updates.content_l0;
  if (updates.content_l1 !== undefined) item.content_l1 = updates.content_l1;
  if (updates.enrichment_status !== undefined) item.enrichment_status = updates.enrichment_status;
  if (updates.enrichment_version !== undefined)
    item.enrichment_version = updates.enrichment_version;
  if (updates.embedding !== undefined) item.embedding = updates.embedding;
  if (updates.confidence !== undefined) item.confidence = updates.confidence;
  item.updated_at = Date.now();

  return true;
}

/**
 * Browse recent vault items in a time range, sorted newest first.
 *
 * Unlike queryVault, this doesn't require search terms — it returns
 * ALL non-deleted items within the time range up to the limit.
 * Used by briefing assembly to collect "new memories since last briefing".
 */
export function browseRecent(
  persona: string,
  after: number,
  before: number,
  limit: number = 20,
): VaultItem[] {
  if (after > before) return []; // invalid range → empty result

  const vault = getVault(persona);
  const results: VaultItem[] = [];

  for (const item of vault.values()) {
    if (item.deleted) continue;
    if (item.created_at < after || item.created_at > before) continue;
    results.push(item);
  }

  results.sort((a, b) => b.created_at - a.created_at);
  return results.slice(0, limit);
}
