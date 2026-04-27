/**
 * Vault CRUD — persona-scoped vault operations routed through a
 * `VaultRepository` (SQLite in production, in-memory in tests). The
 * old module-level `Map<persona, Map<id, VaultItem>>` has been
 * retired: Metro's bundler duplicated this source file across
 * resolution paths (relative ../ vs @dina/core/…) which gave each copy
 * its OWN Map instance, so `/remember`'s write landed in Map A while
 * `/ask`'s read scanned Map B. One authoritative repo per persona
 * (SQLite when wired, auto-provisioned InMemoryVaultRepository
 * otherwise) keeps state singular no matter how Metro slices the code.
 *
 * Provides store, query (keyword + semantic + hybrid), get, delete
 * (soft), and batch operations. Per-persona isolation: items in
 * "health" vault are invisible to "general" queries — enforced by
 * separate repos per persona.
 *
 * Source: core/test/vault_test.go (CRUD section); ARCHITECTURE.md
 * "op-sqlite persistence layer".
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
import {
  getVaultRepository,
  setVaultRepository,
  resetVaultRepositories,
  InMemoryVaultRepository,
  type VaultRepository,
} from './repository';

const MAX_BATCH_SIZE = 100;

/**
 * Resolve the vault repository for a persona — strict.
 *
 * NO auto-provision, NO in-memory fallback. If no repo has been wired
 * (via `setVaultRepository`), this throws. The fallback used to be a
 * convenience for tests but was masking a real-world bug class:
 * mobile boot only opens personas that exist at install time
 * (`general` only), and the staging drain's LLM classifier could pick
 * a persona that was never opened. The old fallback silently routed
 * the write into a `Map` in RAM — vault row gone on app restart,
 * `/ask` never sees it, dev simulator looks broken with no log line.
 *
 * Production callers (mobile's `storage/init.ts::openPersonaDB`) wire
 * a `SQLiteVaultRepository` before any CRUD call. Tests must wire
 * either a SQLite repo (via the `withSQLiteVault` harness) or
 * explicit in-memory repos via the default set installed by
 * `clearVaults()`.
 */
function requireRepo(persona: string): VaultRepository {
  const repo = getVaultRepository(persona);
  if (!repo) {
    throw new Error(
      `vault: no repository registered for persona "${persona}". ` +
        'Production: call openPersonaDB(persona) before any vault CRUD. ' +
        'Tests: call clearVaults([...]) with the persona in the list, ' +
        'or wire it explicitly via setVaultRepository(persona, new InMemoryVaultRepository()) ' +
        'or via the openSQLiteVault test harness.',
    );
  }
  return repo;
}

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

/**
 * Default in-memory test personas installed by `clearVaults()`.
 *
 * Production never calls `clearVaults()` — only test code does — so
 * pre-seeding these is safe for production while keeping ~300 legacy
 * test callsites working without explicit `setVaultRepository()`
 * calls. SQLite-backed harness tests (`openSQLiteVault`) override
 * specific personas after `clearVaults()` runs, which is fine — the
 * latest `setVaultRepository(p, …)` wins.
 *
 * This list mirrors the personas the keyword + LLM classifiers can
 * pick. If a future test needs a persona outside this set, it must
 * pass it to `clearVaults([...])` explicitly or wire it directly.
 */
export const DEFAULT_TEST_PERSONAS = [
  'general',
  'personal',
  'health',
  'family',
  'financial',
  'legal',
  'professional',
  'social',
  'consumer',
];

/**
 * Drop every wired vault repository and re-seed the default test
 * persona set with fresh `InMemoryVaultRepository` instances.
 *
 * The strict `requireRepo()` resolver no longer auto-provisions on
 * miss — production needs that strictness so a forgotten
 * `openPersonaDB()` surfaces immediately instead of silently routing
 * writes into volatile RAM. The previous `clearVaults()` left the
 * registry empty and relied on auto-provision; that's gone, so this
 * seeds the same in-memory repos eagerly to keep test ergonomics.
 *
 * Pass an explicit list to override the default seed:
 *   `clearVaults(['general'])` for a faithful mobile-install scenario,
 *   `clearVaults([])` for a strict-mode test that wires its own repos.
 */
export function clearVaults(personas: string[] = DEFAULT_TEST_PERSONAS): void {
  resetVaultRepositories();
  for (const persona of personas) {
    setVaultRepository(persona, new InMemoryVaultRepository());
  }
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

  const repo = requireRepo(persona);
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

  repo.storeItemSync(stored);
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

/** FTS5-style keyword search. Excludes quarantined/briefing_only items.
 *  Delegates to the wired repository (SQLite in production, in-memory
 *  in tests — both behind the same `VaultRepository.queryFTSSync`
 *  interface). */
function queryFTS(persona: string, query: SearchQuery): VaultItem[] {
  const limit = clampLimit(query.limit);
  const repo = requireRepo(persona);
  // In-memory repo accepts free text; SQLite repo needs FTS5 MATCH
  // syntax (quoted tokens). Sanitise once — safe for both.
  const match = sanitizeFTSMatch(query.text);
  if (match === '') return [];
  const raw = repo.queryFTSSync(match, limit + (query.offset ?? 0));
  const filtered = raw.filter((item) => isSearchable(item) && passesFilters(item, query));
  return applyOffset(filtered, query.offset).slice(0, limit);
}

/** Escape a free-text query for SQLite FTS5 MATCH.
 *
 *  Strips FTS5 operators/punctuation the user didn't intend (`"`,
 *  `(`, `)`, `*`, `NEAR`, boolean keywords) and quotes each term.
 *
 *  **Joins with OR, not space (AND).** SQLite FTS5's default operator
 *  between tokens is AND — `"emma" "birthday" "is" "when"` would
 *  require EVERY token to be present. Natural-language queries like
 *  "When is Emma's birthday?" contain stop-words ("when", "is") that
 *  aren't in the stored memory — AND-matching returns 0 rows and
 *  `/ask` sees an empty vault even though the item is there. Using OR
 *  lets the FTS5 `rank` score the match by how many tokens hit +
 *  their column weights, which is the semantically-correct behaviour
 *  for a user-facing search. Dropping explicit stop-words would also
 *  work but is language-specific and fragile; OR is engine-native.
 *
 *  Empty input → "". */
function sanitizeFTSMatch(text: string): string {
  const tokens = text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !/^(AND|OR|NOT|NEAR)$/i.test(t));
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

/**
 * Semantic search via cosine similarity on embeddings.
 *
 * Uses HNSW index when available (O(log n) approximate nearest-neighbor).
 * Falls back to brute-force O(n) scan when HNSW is not built.
 */
function querySemantic(persona: string, query: SearchQuery): VaultItem[] {
  const repo = requireRepo(persona);
  const limit = clampLimit(query.limit);

  if (!query.embedding || query.embedding.length === 0) return [];

  // Try HNSW first (O(log n))
  if (hasIndex(persona)) {
    const hnswResults = searchIndex(persona, query.embedding, limit + (query.offset ?? 0));
    const filtered = hnswResults
      .map((r) => repo.getItemIncludeDeletedSync(r.id))
      .filter(
        (item): item is VaultItem =>
          item !== null && isSearchable(item) && passesFilters(item, query),
      );
    return applyOffset(filtered, query.offset).slice(0, limit);
  }

  // Fallback: brute-force scan (O(n))
  const results: Array<{ item: VaultItem; score: number }> = [];

  for (const item of repo.valuesSync()) {
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
  const repo = requireRepo(persona);
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

  for (const item of repo.valuesSync()) {
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
    const item = repo.getItemIncludeDeletedSync(id);
    if (item) {
      score *= trustMultiplier(item);
    }

    combined.set(id, score);
  }

  // Sort, apply offset, and return
  const sorted = [...combined.entries()].sort((a, b) => b[1] - a[1]);

  return applyOffset(sorted, query.offset)
    .slice(0, limit)
    .map(([id]) => repo.getItemIncludeDeletedSync(id))
    .filter((item): item is VaultItem => item !== null);
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
  return requireRepo(persona).getItemSync(itemId);
}

/**
 * Get a single item by ID INCLUDING soft-deleted items.
 *
 * Used internally for operations that need to see deleted items
 * (e.g., undelete, audit, export).
 */
export function getItemIncludeDeleted(persona: string, itemId: string): VaultItem | null {
  return requireRepo(persona).getItemIncludeDeletedSync(itemId);
}

/**
 * Soft-delete an item (sets deleted=1). Returns true if found.
 *
 * Item remains in storage for audit/recovery. Excluded from query results.
 */
export function deleteItem(persona: string, itemId: string): boolean {
  return requireRepo(persona).deleteItemSync(itemId);
}

/** Count non-deleted items in a persona vault. */
export function vaultItemCount(persona: string): number {
  let count = 0;
  for (const item of requireRepo(persona).valuesSync()) {
    if (!item.deleted) count++;
  }
  return count;
}

/**
 * Return the most-recent non-deleted items in a persona, bounded by
 * `limit`. Backs the agentic `browse_vault` + `list_personas` preview
 * tools — the empty-query "what's in here?" path.
 *
 * `queryVault({mode:'fts5', text:''})` short-circuits to `[]` because
 * FTS5 can't match an empty query; this helper takes the same no-term
 * intent and returns items ordered by timestamp DESC instead. Matches
 * Python's `core.search_vault(persona, query="")` behaviour.
 */
export function listRecentItems(persona: string, limit: number): VaultItem[] {
  if (limit <= 0) return [];
  const repo = requireRepo(persona);
  const all = repo.valuesSync().filter((item) => isSearchable(item));
  // `valuesSync` on SQLite returns repository-insertion order; make the
  // sort explicit so both backends agree on "most recent first".
  all.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  return all.slice(0, limit);
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
  const results: VaultItem[] = [];
  for (const item of requireRepo(persona).valuesSync()) {
    if (item.deleted) continue;
    if (item.enrichment_status === status) results.push(item);
  }
  results.sort((a, b) => a.created_at - b.created_at);
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
  const repo = requireRepo(persona);
  // Read-merge-write via the repo — `storeItemSync` is INSERT OR REPLACE
  // on SQLite, so overwriting the whole row after merging is safe and
  // atomic per row. In-memory repo mutates in place inside storeItemSync
  // by replacing the map entry.
  const existing = repo.getItemIncludeDeletedSync(itemId);
  if (!existing || existing.deleted) return false;
  const merged: VaultItem = { ...existing };
  if (updates.content_l0 !== undefined) merged.content_l0 = updates.content_l0;
  if (updates.content_l1 !== undefined) merged.content_l1 = updates.content_l1;
  if (updates.enrichment_status !== undefined) merged.enrichment_status = updates.enrichment_status;
  if (updates.enrichment_version !== undefined)
    merged.enrichment_version = updates.enrichment_version;
  if (updates.embedding !== undefined) merged.embedding = updates.embedding;
  if (updates.confidence !== undefined) merged.confidence = updates.confidence;
  merged.updated_at = Date.now();
  repo.storeItemSync(merged);
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
  if (after > before) return [];
  const results: VaultItem[] = [];
  for (const item of requireRepo(persona).valuesSync()) {
    if (item.deleted) continue;
    if (item.created_at < after || item.created_at > before) continue;
    results.push(item);
  }
  results.sort((a, b) => b.created_at - a.created_at);
  return results.slice(0, limit);
}
