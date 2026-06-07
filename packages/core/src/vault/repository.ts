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

import { currentDataScope, type DataScope } from '../scope/data_scope';
import { scopedInsertFields, scopedParams, scopedWhere } from '../scope/repository';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';
import type { VaultItem } from '@dina/test-harness';

/** Options for a `vault_item_subjects` link (the structured recall edge). */
export interface SubjectLinkOptions {
  /** subject | mentioned | about (default 'about'). */
  relation?: string;
  /** high | medium | low (default 'medium'). */
  confidence?: string;
  /** llm | contact_match | manual (default 'manual'). */
  source?: string;
}

export interface VaultRepository {
  storeItem(item: VaultItem): Promise<void>;
  getItem(id: string): Promise<VaultItem | null>;
  getItemIncludeDeleted(id: string): Promise<VaultItem | null>;
  deleteItem(id: string): Promise<boolean>;
  queryFTS(text: string, limit: number): Promise<VaultItem[]>;
  queryAll(limit: number): Promise<VaultItem[]>;
  storeBatch(items: VaultItem[]): Promise<void>;
  /**
   * Link a vault item to a person it is *about* (`vault_item_subjects`)
   * — the structured recall edge that replaces name/FTS-only matching.
   * Idempotent on `(item_id, person_id)`. Empty ids are a no-op.
   */
  linkSubject(itemId: string, personId: string, opts?: SubjectLinkOptions): Promise<void>;
  /**
   * Vault item ids a person is a subject of, newest-linked first.
   * The inbound `did → person_id → subjects` recall hot path.
   */
  getItemIdsForPerson(personId: string): Promise<string[]>;

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
  linkSubjectSync(itemId: string, personId: string, opts?: SubjectLinkOptions): void;
  getItemIdsForPersonSync(personId: string): string[];
  getItemsForPersonSync(personId: string, limit: number): VaultItem[];
  /**
   * Re-point every subject link from `fromPersonId` to `toPersonId`
   * (used by a people-merge). On an (item, toPerson) collision the
   * survivor's link is kept and the loser dropped. No-op for equal/empty
   * ids.
   */
  repointSubjectsSync(fromPersonId: string, toPersonId: string): void;
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

/** Personas that currently have a wired vault repository. */
export function listVaultPersonas(): string[] {
  return [...repos.keys()];
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
        id, type, source, source_id, contact_did, author_person_id, summary, body, metadata, tags,
        content_l0, content_l1, deleted, timestamp, created_at, updated_at,
        sender, sender_trust, source_type, confidence, retrieval_policy,
        contradicts, enrichment_status, enrichment_version, embedding, data_scope
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        item.id,
        item.type,
        item.source,
        item.source_id,
        item.contact_did,
        item.author_person_id ?? '',
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
        // Stamp the active scope: 'user' normally, 'guided_demo:<id>' in a demo.
        scopedInsertFields().data_scope,
      ],
    );
  }

  async getItem(id: string): Promise<VaultItem | null> {
    return this.getItemSync(id);
  }

  getItemSync(id: string): VaultItem | null {
    const rows = this.db.query(
      `SELECT * FROM vault_items WHERE id = ? AND deleted = 0 AND ${scopedWhere()}`,
      [id, ...scopedParams()],
    );
    if (rows.length === 0) return null;
    return rowToVaultItem(rows[0]);
  }

  async getItemIncludeDeleted(id: string): Promise<VaultItem | null> {
    return this.getItemIncludeDeletedSync(id);
  }

  getItemIncludeDeletedSync(id: string): VaultItem | null {
    const rows = this.db.query(`SELECT * FROM vault_items WHERE id = ? AND ${scopedWhere()}`, [
      id,
      ...scopedParams(),
    ]);
    if (rows.length === 0) return null;
    return rowToVaultItem(rows[0]);
  }

  async deleteItem(id: string): Promise<boolean> {
    return this.deleteItemSync(id);
  }

  deleteItemSync(id: string): boolean {
    // Exact-ID + scope (design doc "Exact-ID Safety"): a demo id can never
    // soft-delete a user row and vice versa.
    const existing = this.db.query(`SELECT 1 FROM vault_items WHERE id = ? AND ${scopedWhere()}`, [
      id,
      ...scopedParams(),
    ]);
    if (existing.length === 0) return false;
    this.db.execute(
      `UPDATE vault_items SET deleted = 1, updated_at = ? WHERE id = ? AND ${scopedWhere()}`,
      [Date.now(), id, ...scopedParams()],
    );
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
         AND ${scopedWhere('vi')}
       ORDER BY rank
       LIMIT ?`,
      [text, ...scopedParams(), limit],
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
         AND ${scopedWhere()}
       ORDER BY timestamp DESC
       LIMIT ?`,
      [...scopedParams(), limit],
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
      `SELECT * FROM vault_items WHERE deleted = 0 AND ${scopedWhere()} ORDER BY timestamp DESC`,
      [...scopedParams()],
    );
    return rows.map(rowToVaultItem);
  }

  async linkSubject(itemId: string, personId: string, opts?: SubjectLinkOptions): Promise<void> {
    this.linkSubjectSync(itemId, personId, opts);
  }

  linkSubjectSync(itemId: string, personId: string, opts?: SubjectLinkOptions): void {
    if (itemId === '' || personId === '') return;
    const nowSec = Math.floor(Date.now() / 1000);
    // Idempotent on (item_id, person_id): re-linking refreshes the
    // relation/confidence/source rather than duplicating.
    this.db.execute(
      `INSERT INTO vault_item_subjects (item_id, person_id, relation, confidence, source, created_at, data_scope)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id, person_id) DO UPDATE SET
         relation = excluded.relation,
         confidence = excluded.confidence,
         source = excluded.source`,
      [
        itemId,
        personId,
        opts?.relation ?? 'about',
        opts?.confidence ?? 'medium',
        opts?.source ?? 'manual',
        nowSec,
        // The link inherits the active scope (matches the item's scope, since
        // links are created in the same scope the item was stored in).
        scopedInsertFields().data_scope,
      ],
    );
  }

  async getItemIdsForPerson(personId: string): Promise<string[]> {
    return this.getItemIdsForPersonSync(personId);
  }

  getItemIdsForPersonSync(personId: string): string[] {
    if (personId === '') return [];
    const rows = this.db.query(
      `SELECT item_id FROM vault_item_subjects WHERE person_id = ? AND ${scopedWhere()} ORDER BY created_at DESC`,
      [personId, ...scopedParams()],
    );
    return rows.map((r) => String(r.item_id));
  }

  getItemsForPersonSync(personId: string, limit: number): VaultItem[] {
    if (personId === '' || limit <= 0) return [];
    // Join subjects → items, newest-linked first, non-deleted only.
    // Scope BOTH joined tables (design doc: "joins include scope on both
    // sides where both tables are scoped").
    const rows = this.db.query(
      `SELECT vi.* FROM vault_item_subjects vis
       JOIN vault_items vi ON vi.id = vis.item_id
       WHERE vis.person_id = ? AND vi.deleted = 0
         AND ${scopedWhere('vi')} AND ${scopedWhere('vis')}
       ORDER BY vis.created_at DESC
       LIMIT ?`,
      [personId, ...scopedParams(), ...scopedParams(), limit],
    );
    return rows.map(rowToVaultItem);
  }

  repointSubjectsSync(fromPersonId: string, toPersonId: string): void {
    if (fromPersonId === '' || toPersonId === '' || fromPersonId === toPersonId) return;
    // Move links to the survivor; `OR IGNORE` skips any (item, survivor)
    // pair that already exists (PK collision), then drop the leftovers.
    this.db.execute(
      `UPDATE OR IGNORE vault_item_subjects SET person_id = ? WHERE person_id = ? AND ${scopedWhere()}`,
      [toPersonId, fromPersonId, ...scopedParams()],
    );
    this.db.execute(`DELETE FROM vault_item_subjects WHERE person_id = ? AND ${scopedWhere()}`, [
      fromPersonId,
      ...scopedParams(),
    ]);
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
  /** id → scope the item was stored under (mirrors the SQLite data_scope column). */
  private readonly itemScope = new Map<string, DataScope>();

  async storeItem(item: VaultItem): Promise<void> {
    this.storeItemSync(item);
  }

  storeItemSync(item: VaultItem): void {
    this.items.set(item.id, { ...item });
    this.itemScope.set(item.id, currentDataScope());
  }

  /** True iff `id` belongs to the active scope (read-isolation gate). */
  private inScope(id: string): boolean {
    return this.itemScope.get(id) === currentDataScope();
  }

  async getItem(id: string): Promise<VaultItem | null> {
    return this.getItemSync(id);
  }

  getItemSync(id: string): VaultItem | null {
    if (!this.inScope(id)) return null;
    const item = this.items.get(id);
    if (!item || item.deleted) return null;
    return { ...item };
  }

  async getItemIncludeDeleted(id: string): Promise<VaultItem | null> {
    return this.getItemIncludeDeletedSync(id);
  }

  getItemIncludeDeletedSync(id: string): VaultItem | null {
    if (!this.inScope(id)) return null;
    const item = this.items.get(id);
    return item ? { ...item } : null;
  }

  async deleteItem(id: string): Promise<boolean> {
    return this.deleteItemSync(id);
  }

  deleteItemSync(id: string): boolean {
    if (!this.inScope(id)) return false;
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
      if (!this.inScope(item.id)) continue;
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
      if (!item.deleted && this.inScope(item.id)) live.push({ ...item });
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
    this.itemScope.clear();
    this.subjects.clear();
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
      if (!item.deleted && this.inScope(item.id)) live.push({ ...item });
    }
    return live;
  }

  // person_id -> links (newest-linked last; we reverse on read). Each link
  // carries its OWN scope (set at link time), matching the SQLite repo's
  // vault_item_subjects.data_scope column — NOT derived from the item, so a
  // link to a not-yet-stored item ("ghost" link) still belongs to a scope.
  private readonly subjects = new Map<string, Array<{ itemId: string; scope: DataScope }>>();

  async linkSubject(itemId: string, personId: string, opts?: SubjectLinkOptions): Promise<void> {
    this.linkSubjectSync(itemId, personId, opts);
  }

  linkSubjectSync(itemId: string, personId: string, _opts?: SubjectLinkOptions): void {
    if (itemId === '' || personId === '') return;
    const list = this.subjects.get(personId) ?? [];
    // Idempotent on (item, person): keep the existing link + its scope
    // (matches SQLite's ON CONFLICT(item_id, person_id), which leaves
    // data_scope unchanged).
    if (!list.some((l) => l.itemId === itemId)) {
      list.push({ itemId, scope: currentDataScope() });
    }
    this.subjects.set(personId, list);
  }

  async getItemIdsForPerson(personId: string): Promise<string[]> {
    return this.getItemIdsForPersonSync(personId);
  }

  getItemIdsForPersonSync(personId: string): string[] {
    if (personId === '') return [];
    // Links in the active scope only (parity with `vis.data_scope = ?`).
    const scope = currentDataScope();
    return (this.subjects.get(personId) ?? [])
      .filter((l) => l.scope === scope)
      .map((l) => l.itemId)
      .reverse(); // newest-linked first
  }

  getItemsForPersonSync(personId: string, limit: number): VaultItem[] {
    if (personId === '' || limit <= 0) return [];
    const out: VaultItem[] = [];
    for (const id of this.getItemIdsForPersonSync(personId)) {
      const item = this.items.get(id);
      // Both the link AND the item must be in scope (parity with the SQLite
      // join scoping both vis + vi); ghost links resolve to no item.
      if (item && !item.deleted && this.inScope(id)) out.push({ ...item });
      if (out.length >= limit) break;
    }
    return out;
  }

  repointSubjectsSync(fromPersonId: string, toPersonId: string): void {
    if (fromPersonId === '' || toPersonId === '' || fromPersonId === toPersonId) return;
    const fromList = this.subjects.get(fromPersonId);
    if (fromList === undefined) return;
    const scope = currentDataScope();
    const toList = this.subjects.get(toPersonId) ?? [];
    // Only repoint in-scope links (parity with the SQLite repo's scoped
    // UPDATE/DELETE); leave other-scope links on the source person.
    const remaining: Array<{ itemId: string; scope: DataScope }> = [];
    for (const link of fromList) {
      if (link.scope === scope) {
        if (!toList.some((l) => l.itemId === link.itemId)) toList.push(link);
      } else {
        remaining.push(link);
      }
    }
    this.subjects.set(toPersonId, toList);
    if (remaining.length > 0) this.subjects.set(fromPersonId, remaining);
    else this.subjects.delete(fromPersonId);
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
    author_person_id: String(row.author_person_id ?? ''),
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
