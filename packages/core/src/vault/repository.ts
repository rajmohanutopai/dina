/**
 * Vault SQL repository — backs vault CRUD with persona-scoped SQLite.
 *
 * Each persona has its own database with vault_items + FTS5.
 * The repository handles:
 *   - 24-field VaultItem ↔ SQL column mapping
 *   - Embedding BLOB serialization (Float32Array ↔ Uint8Array)
 *   - FTS5 search (via triggers, auto-synced)
 *   - Soft delete
 *   - Retrieval policy filtering
 *
 * When the repository is wired via setVaultRepository(), all vault
 * operations go through SQL. When null, the in-memory Map is used.
 *
 * **Phase 2.3 (task 2.3).** Port methods return `Promise<T>`. SQLite
 * under go-sqlcipher is sync internally; each `async` method wraps
 * the sync result in a resolved Promise. `storeBatch` uses an
 * internal `storeItemSync()` inside the sync `db.transaction()`
 * callback (same pattern as `SQLiteTopicRepository.touch`) — awaiting
 * inside the transaction would break atomicity. Service-layer
 * `vault/crud.ts::storeItem` keeps its sync signature via fire-and-forget
 * write-through on `sqlRepo.storeItem`.
 *
 * Source: ARCHITECTURE.md — op-sqlite persistence layer
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';
import type { VaultItem } from '@dina/test-harness';

export interface VaultRepository {
  storeItem(item: VaultItem): Promise<void>;
  getItem(id: string): Promise<VaultItem | null>;
  getItemIncludeDeleted(id: string): Promise<VaultItem | null>;
  deleteItem(id: string): Promise<boolean>;
  queryFTS(text: string, limit: number): Promise<VaultItem[]>;
  queryAll(limit: number): Promise<VaultItem[]>;
  storeBatch(items: VaultItem[]): Promise<void>;

  // Sync variants — op-sqlite (mobile) + better-sqlite3 (node) are both
  // synchronous under the hood, so these match the underlying call. The
  // service layer (`vault/crud.ts`) uses them to keep its sync signatures
  // while routing everything through SQL. Async variants above are kept
  // for places that already await (e.g. HTTP handlers).
  storeItemSync(item: VaultItem): void;
  getItemSync(id: string): VaultItem | null;
  getItemIncludeDeletedSync(id: string): VaultItem | null;
  deleteItemSync(id: string): boolean;
  queryFTSSync(text: string, limit: number): VaultItem[];
  queryAllSync(limit: number): VaultItem[];
  storeBatchSync(items: VaultItem[]): void;
  /**
   * Enumerate every **non-deleted** item (matches the API's default
   * "deleted rows are invisible" rule — same as `getItemSync`, the
   * FTS + hybrid query paths, etc.). Callers that need to see deleted
   * rows reach for `getItemIncludeDeletedSync(id)` with a specific id.
   *
   * Used by vault/crud.ts's semantic/hybrid query paths for the
   * brute-force cosine scan when HNSW isn't built yet, by enrichment
   * sweeps, and by `vaultItemCount` / `browseRecent`.
   */
  valuesSync(): VaultItem[];
}

/**
 * Per-persona vault repository registry.
 *
 * **Lives on `globalThis`** (same as `staging/service.ts`'s `inbox`): in
 * production, mobile's Metro bundler may load this module twice — once
 * via a relative `../core/src/vault/...` path and once via
 * `@dina/core/...`. Two module copies means two module-local `Map`
 * instances — `/remember` would write into Map A while `/ask` scanned
 * Map B. Pinning the registry to `globalThis.__dinaVaultRepos` gives
 * both module copies the same state regardless of resolution path.
 *
 * Jest + Node-side tests are unaffected (single module instance).
 */
type VaultRepoGlobals = { repos: Map<string, VaultRepository> };
const globalWithVaultRepos = globalThis as unknown as {
  __dinaVaultRepos?: VaultRepoGlobals;
};
const _vaultRepoState: VaultRepoGlobals =
  globalWithVaultRepos.__dinaVaultRepos ??
  (globalWithVaultRepos.__dinaVaultRepos = { repos: new Map() });
const repos = _vaultRepoState.repos;

/** Set a vault repository for a persona. */
export function setVaultRepository(persona: string, r: VaultRepository | null): void {
  if (r) {
    repos.set(persona, r);
  } else {
    repos.delete(persona);
  }
}

/** Get vault repository for a persona (null = in-memory). */
export function getVaultRepository(persona: string): VaultRepository | null {
  return repos.get(persona) ?? null;
}

/** Clear all repositories (for testing). */
export function resetVaultRepositories(): void {
  repos.clear();
}

/**
 * SQLite-backed vault repository for a single persona.
 */
export class SQLiteVaultRepository implements VaultRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async storeItem(item: VaultItem): Promise<void> {
    this.storeItemSync(item);
  }

  /** Sync-only store — public because vault/crud.ts routes all writes
   *  through this method to keep its sync signatures (op-sqlite is
   *  synchronous under the hood; the async wrapper above is for callers
   *  that already await, e.g. HTTP handlers). */
  storeItemSync(item: VaultItem): void {
    let embedding: Uint8Array | null = null;
    if (item.embedding) {
      const emb = item.embedding as Float32Array | Uint8Array;
      embedding = new Uint8Array(emb.buffer, emb.byteOffset, emb.byteLength);
    }

    this.db.execute(
      `INSERT OR REPLACE INTO vault_items (
        id, type, source, source_id, contact_did, summary, body, metadata, tags,
        content_l0, content_l1, deleted, timestamp, created_at, updated_at,
        sender, sender_trust, source_type, confidence, retrieval_policy,
        contradicts, enrichment_status, enrichment_version, embedding
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        item.id,
        item.type,
        item.source,
        item.source_id,
        item.contact_did,
        item.summary,
        item.body,
        item.metadata,
        item.tags,
        item.content_l0,
        item.content_l1,
        item.deleted,
        item.timestamp,
        item.created_at,
        item.updated_at,
        item.sender,
        item.sender_trust,
        item.source_type,
        item.confidence,
        item.retrieval_policy,
        item.contradicts,
        item.enrichment_status,
        item.enrichment_version,
        embedding,
      ],
    );
  }

  async getItem(id: string): Promise<VaultItem | null> {
    return this.getItemSync(id);
  }

  getItemSync(id: string): VaultItem | null {
    const rows = this.db.query('SELECT * FROM vault_items WHERE id = ? AND deleted = 0', [id]);
    if (rows.length === 0) return null;
    return rowToVaultItem(rows[0]);
  }

  async getItemIncludeDeleted(id: string): Promise<VaultItem | null> {
    return this.getItemIncludeDeletedSync(id);
  }

  getItemIncludeDeletedSync(id: string): VaultItem | null {
    const rows = this.db.query('SELECT * FROM vault_items WHERE id = ?', [id]);
    if (rows.length === 0) return null;
    return rowToVaultItem(rows[0]);
  }

  async deleteItem(id: string): Promise<boolean> {
    return this.deleteItemSync(id);
  }

  deleteItemSync(id: string): boolean {
    const existing = this.db.query('SELECT 1 FROM vault_items WHERE id = ?', [id]);
    if (existing.length === 0) return false;
    this.db.execute('UPDATE vault_items SET deleted = 1, updated_at = ? WHERE id = ?', [
      Date.now(),
      id,
    ]);
    return true;
  }

  async queryFTS(text: string, limit: number): Promise<VaultItem[]> {
    return this.queryFTSSync(text, limit);
  }

  queryFTSSync(text: string, limit: number): VaultItem[] {
    const rows = this.db.query(
      `SELECT vi.* FROM vault_items vi
       JOIN vault_items_fts fts ON vi.rowid = fts.rowid
       WHERE vault_items_fts MATCH ?
         AND vi.deleted = 0
         AND vi.retrieval_policy IN ('normal', 'caveated', '')
       ORDER BY rank
       LIMIT ?`,
      [text, limit],
    );
    return rows.map(rowToVaultItem);
  }

  async queryAll(limit: number): Promise<VaultItem[]> {
    return this.queryAllSync(limit);
  }

  queryAllSync(limit: number): VaultItem[] {
    const rows = this.db.query(
      `SELECT * FROM vault_items
       WHERE deleted = 0
         AND retrieval_policy IN ('normal', 'caveated', '')
       ORDER BY timestamp DESC
       LIMIT ?`,
      [limit],
    );
    return rows.map(rowToVaultItem);
  }

  async storeBatch(items: VaultItem[]): Promise<void> {
    this.storeBatchSync(items);
  }

  storeBatchSync(items: VaultItem[]): void {
    this.db.transaction(() => {
      for (const item of items) {
        this.storeItemSync(item);
      }
    });
  }

  valuesSync(): VaultItem[] {
    // Filter deleted at the DB layer — matches the contract's "deleted
    // rows are invisible" rule (see `VaultRepository.valuesSync` docs).
    const rows = this.db.query(
      'SELECT * FROM vault_items WHERE deleted = 0 ORDER BY timestamp DESC',
    );
    return rows.map(rowToVaultItem);
  }
}

/**
 * In-memory VaultRepository — the fallback when no SQLite-backed repo
 * is wired. Used by tests + by `vault/crud.ts`'s auto-provisioning path
 * so the service layer always has a repo to route through; the Map
 * never escapes into production-grade code.
 *
 * Implements the same interface as SQLiteVaultRepository. Search
 * behaviour is substring-based keyword scan (no true FTS5 tokeniser) —
 * sufficient for tests that assert "query for 'emma' returns items
 * whose summary/body contains 'emma'".
 */
export class InMemoryVaultRepository implements VaultRepository {
  private readonly items = new Map<string, VaultItem>();

  async storeItem(item: VaultItem): Promise<void> {
    this.storeItemSync(item);
  }

  storeItemSync(item: VaultItem): void {
    this.items.set(item.id, { ...item });
  }

  async getItem(id: string): Promise<VaultItem | null> {
    return this.getItemSync(id);
  }

  getItemSync(id: string): VaultItem | null {
    const item = this.items.get(id);
    if (!item || item.deleted) return null;
    return { ...item };
  }

  async getItemIncludeDeleted(id: string): Promise<VaultItem | null> {
    return this.getItemIncludeDeletedSync(id);
  }

  getItemIncludeDeletedSync(id: string): VaultItem | null {
    const item = this.items.get(id);
    return item ? { ...item } : null;
  }

  async deleteItem(id: string): Promise<boolean> {
    return this.deleteItemSync(id);
  }

  deleteItemSync(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    item.deleted = 1;
    item.updated_at = Date.now();
    return true;
  }

  async queryFTS(text: string, limit: number): Promise<VaultItem[]> {
    return this.queryFTSSync(text, limit);
  }

  /** Substring keyword scan — mimics SQLite FTS5 behaviour at the API
   *  level without actually tokenising. Accepts the same FTS5 MATCH
   *  syntax produced by `vault/crud.ts::sanitizeFTSMatch` (quoted
   *  tokens joined with `OR`) AND bare text; both are extracted into
   *  terms and matched against summary + body + content fields.
   *
   *  FTS5 operator words (`OR`/`AND`/`NOT`/`NEAR`) are filtered OUT
   *  — they're join syntax from the sanitizer, not content search
   *  terms. Otherwise "when" OR "is" OR "emma" would try to match
   *  the literal string "or" against the haystack. */
  queryFTSSync(text: string, limit: number): VaultItem[] {
    const terms = text
      .toLowerCase()
      // Strip FTS5 token-quote marks so `"emma" OR "birthday"` ⇒ `emma  birthday`.
      .replace(/"/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0 && !/^(and|or|not|near)$/i.test(t));
    if (terms.length === 0) return [];

    type Scored = { item: VaultItem; score: number };
    const scored: Scored[] = [];
    for (const item of this.items.values()) {
      if (item.deleted) continue;
      if (item.retrieval_policy === 'briefing_only' || item.retrieval_policy === 'quarantined') {
        continue;
      }
      const haystack = [item.summary, item.body, item.content_l0, item.content_l1]
        .join(' ')
        .toLowerCase();
      let score = 0;
      for (const t of terms) if (haystack.includes(t)) score++;
      if (score > 0) scored.push({ item: { ...item }, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.item);
  }

  async queryAll(limit: number): Promise<VaultItem[]> {
    return this.queryAllSync(limit);
  }

  queryAllSync(limit: number): VaultItem[] {
    const live: VaultItem[] = [];
    for (const item of this.items.values()) {
      if (!item.deleted) live.push({ ...item });
    }
    live.sort((a, b) => b.timestamp - a.timestamp);
    return live.slice(0, limit);
  }

  async storeBatch(items: VaultItem[]): Promise<void> {
    this.storeBatchSync(items);
  }

  storeBatchSync(items: VaultItem[]): void {
    for (const item of items) this.storeItemSync(item);
  }

  /** Test helper — clear everything. */
  clear(): void {
    this.items.clear();
  }

  valuesSync(): VaultItem[] {
    // Filter deleted rows — matches the contract's "deleted rows are
    // invisible" rule. Previously this impl returned EVERY item (incl.
    // deleted) which drifted from SQLite's `WHERE deleted = 0`
    // behaviour; callers already defend with `if (item.deleted)`
    // checks, but a contract-consistent impl means those become true
    // no-ops instead of masking a latent divergence.
    const live: VaultItem[] = [];
    for (const item of this.items.values()) {
      if (!item.deleted) live.push({ ...item });
    }
    return live;
  }
}

/** Convert a SQL row to a VaultItem. */
function rowToVaultItem(row: DBRow): VaultItem {
  const embeddingRaw = row.embedding as Uint8Array | null;
  const embedding = embeddingRaw
    ? new Uint8Array(embeddingRaw.buffer, embeddingRaw.byteOffset, embeddingRaw.byteLength)
    : undefined;

  return {
    id: String(row.id ?? ''),
    type: String(row.type ?? 'note'),
    source: String(row.source ?? ''),
    source_id: String(row.source_id ?? ''),
    contact_did: String(row.contact_did ?? ''),
    summary: String(row.summary ?? ''),
    body: String(row.body ?? ''),
    metadata: String(row.metadata ?? '{}'),
    tags: String(row.tags ?? '[]'),
    content_l0: String(row.content_l0 ?? ''),
    content_l1: String(row.content_l1 ?? ''),
    deleted: Number(row.deleted ?? 0),
    timestamp: Number(row.timestamp ?? 0),
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
    sender: String(row.sender ?? ''),
    sender_trust: String(row.sender_trust ?? 'unknown'),
    source_type: String(row.source_type ?? ''),
    confidence: String(row.confidence ?? 'medium'),
    retrieval_policy: String(row.retrieval_policy ?? 'normal'),
    contradicts: String(row.contradicts ?? ''),
    enrichment_status: String(row.enrichment_status ?? 'pending'),
    enrichment_version: String(row.enrichment_version ?? ''),
    ...(embedding ? { embedding } : {}),
  };
}
