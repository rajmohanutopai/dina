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
}

/** Map of persona → repository. */
const repos = new Map<string, VaultRepository>();

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

  /** Sync-only internal store, used inside `storeBatch`'s transaction
   *  callback where awaiting would break atomicity. */
  private storeItemSync(item: VaultItem): void {
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
    const rows = this.db.query('SELECT * FROM vault_items WHERE id = ? AND deleted = 0', [id]);
    if (rows.length === 0) return null;
    return rowToVaultItem(rows[0]);
  }

  async getItemIncludeDeleted(id: string): Promise<VaultItem | null> {
    const rows = this.db.query('SELECT * FROM vault_items WHERE id = ?', [id]);
    if (rows.length === 0) return null;
    return rowToVaultItem(rows[0]);
  }

  async deleteItem(id: string): Promise<boolean> {
    const existing = this.db.query('SELECT 1 FROM vault_items WHERE id = ?', [id]);
    if (existing.length === 0) return false;
    this.db.execute('UPDATE vault_items SET deleted = 1, updated_at = ? WHERE id = ?', [
      Date.now(),
      id,
    ]);
    return true;
  }

  async queryFTS(text: string, limit: number): Promise<VaultItem[]> {
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
    this.db.transaction(() => {
      for (const item of items) {
        this.storeItemSync(item);
      }
    });
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
