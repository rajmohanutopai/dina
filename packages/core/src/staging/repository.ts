/**
 * Staging SQL repository — backs the staging inbox with SQLite.
 *
 * Handles the complex state machine (received → classifying → stored/pending_unlock/failed)
 * and 3-part dedup key (producer_id, source, source_id).
 *
 * **Sync on purpose.** This repository is a small adapter over the
 * exempt sync `DatabaseAdapter` (op-sqlite JSI / better-sqlite3 style
 * native SQLite). Staging service calls are intentionally synchronous
 * because claim/resolve/fail must persist before the in-memory cache
 * changes; a Promise facade forced fire-and-forget writes and
 * made SQLite non-authoritative across restart.
 *
 * Source: ARCHITECTURE.md — op-sqlite persistence layer
 */

import { isValidDataScope } from '../scope/data_scope';

import type { StagingItem } from './service';
import type { DataScope } from '../scope/data_scope';
import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export interface StagingRepository {
  /** Returns true if new, false if duplicate (4-part dedup key incl. scope). */
  ingest(item: StagingItem): boolean;
  get(id: string): StagingItem | null;
  /**
   * Find an existing row by the dedup key. `scope` is part of the key: a demo
   * row and a user row with the SAME (producer, source, source_id) are distinct,
   * so dedup must be per-scope (mirrors the v13 UNIQUE constraint).
   */
  findByDedup(
    producerId: string,
    source: string,
    sourceId: string,
    scope: DataScope,
  ): StagingItem | null;
  /**
   * PLG-32 #10: delete the row holding a dedup key regardless of whether it
   * projects. `findByDedup` returns null for a CORRUPT row (it quarantines at
   * read), yet the raw row still occupies the UNIQUE(producer, source,
   * source_id, scope) key — so `INSERT OR IGNORE` silently no-ops AND the read
   * returns nothing, dead-locking that key. `ingest`'s reconcile uses this to
   * evict the unreadable row and retry the insert (repair-on-conflict).
   */
  deleteByDedup(producerId: string, source: string, sourceId: string, scope: DataScope): void;
  /**
   * Claim up to `limit` `received` items IN `scope` (data-scope isolation: the
   * drain must not claim a guided-demo row while on the user scope, or vice
   * versa). Atomically leases them.
   */
  claim(limit: number, leaseDuration: number, now: number, scope: DataScope): StagingItem[];
  updateStatus(id: string, status: string, updates?: Partial<StagingItem>): void;
  sweep(now: number): {
    expired: number;
    leaseReverted: number;
    requeued: number;
    deadLettered: number;
  };
  listByStatus(status: string): StagingItem[];
  listAll(): StagingItem[];
  size(): number;
  clear(): void;
}

let repo: StagingRepository | null = null;
export function setStagingRepository(r: StagingRepository | null): void {
  repo = r;
}
export function getStagingRepository(): StagingRepository | null {
  return repo;
}

export class SQLiteStagingRepository implements StagingRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  ingest(item: StagingItem): boolean {
    // ON CONFLICT(producer_id, source, source_id) DO NOTHING handles dedup
    // PLG-30 #3: persist `classified_item` + `approval_id` AT INGEST. The
    // resolveMulti locked-secondary path creates copies carrying BOTH (the vault
    // payload + its approval task), but ingest() used to drop them — so after a
    // restart the copy could neither be found by its approval (approval_id NULL)
    // nor written (classified_item NULL). `updateStatus` already persists them;
    // mirror that here so an item that arrives with them round-trips. The
    // InMemory store already clones both, so this closes a dual-store divergence.
    const result = this.db.run(
      `INSERT OR IGNORE INTO staging_inbox (id, source, source_id, producer_id, status, persona, retry_count, lease_until, expires_at, created_at, data, source_hash, data_scope, classified_item, approval_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.source,
        item.source_id,
        item.producer_id,
        item.status,
        item.persona,
        item.retry_count,
        item.lease_until,
        item.expires_at,
        item.created_at,
        JSON.stringify(item.data),
        item.source_hash,
        item.data_scope,
        item.classified_item !== undefined ? JSON.stringify(item.classified_item) : null,
        item.approval_id ?? null,
      ],
    );
    return result > 0;
  }

  get(id: string): StagingItem | null {
    const rows = this.db.query('SELECT * FROM staging_inbox WHERE id = ?', [id]);
    return rows.length > 0 ? rowToStagingItem(rows[0]) : null;
  }

  findByDedup(
    producerId: string,
    source: string,
    sourceId: string,
    scope: DataScope,
  ): StagingItem | null {
    const rows = this.db.query(
      'SELECT * FROM staging_inbox WHERE producer_id = ? AND source = ? AND source_id = ? AND data_scope = ?',
      [producerId, source, sourceId, scope],
    );
    return rows.length > 0 ? rowToStagingItem(rows[0]) : null;
  }

  deleteByDedup(producerId: string, source: string, sourceId: string, scope: DataScope): void {
    this.db.execute(
      'DELETE FROM staging_inbox WHERE producer_id = ? AND source = ? AND source_id = ? AND data_scope = ?',
      [producerId, source, sourceId, scope],
    );
  }

  claim(limit: number, leaseDuration: number, now: number, scope: DataScope): StagingItem[] {
    const leaseUntil = now + leaseDuration;
    const candidates = this.db.query<{ id: string }>(
      `SELECT id FROM staging_inbox
       WHERE status = 'received' AND data_scope = ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
      [scope, limit],
    );
    const ids = candidates.map((row) => String(row.id));
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(', ');
    this.db.transaction(() => {
      // PLG-31 #4: GUARD the claim write on `status='received'` (+ scope) so a row
      // another worker already claimed between the candidate SELECT and here is not
      // re-flipped — the SELECT and UPDATE were previously separate unguarded
      // statements (two connections could both claim the same rows).
      this.db.execute(
        `UPDATE staging_inbox SET status = 'classifying', lease_until = ?
         WHERE id IN (${placeholders}) AND status = 'received' AND data_scope = ?`,
        [leaseUntil, ...ids, scope],
      );
    });
    // Return ONLY the rows THIS call transitioned — filter on the just-stamped
    // lease (a claim token) + 'classifying', so a concurrent claimer that took some
    // candidates can't have them double-returned here.
    const rows = this.db.query(
      `SELECT * FROM staging_inbox
       WHERE id IN (${placeholders}) AND status = 'classifying' AND lease_until = ?
       ORDER BY created_at ASC, id ASC`,
      [...ids, leaseUntil],
    );
    return mapStagingItems(rows);
  }

  updateStatus(id: string, status: string, updates?: Partial<StagingItem>): void {
    const sets = ['status = ?'];
    const params: unknown[] = [status];
    if (updates?.persona !== undefined) {
      sets.push('persona = ?');
      params.push(updates.persona);
    }
    if (updates?.retry_count !== undefined) {
      sets.push('retry_count = ?');
      params.push(updates.retry_count);
    }
    if (updates?.lease_until !== undefined) {
      sets.push('lease_until = ?');
      params.push(updates.lease_until);
    }
    if (updates?.data !== undefined) {
      sets.push('data = ?');
      params.push(JSON.stringify(updates.data));
    }
    if (updates?.classified_item !== undefined) {
      sets.push('classified_item = ?');
      params.push(JSON.stringify(updates.classified_item));
    }
    if (updates?.error !== undefined) {
      sets.push('error = ?');
      params.push(updates.error);
    }
    if (updates?.approval_id !== undefined) {
      sets.push('approval_id = ?');
      params.push(updates.approval_id);
    }
    params.push(id);
    this.db.execute(`UPDATE staging_inbox SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  sweep(now: number): {
    expired: number;
    leaseReverted: number;
    requeued: number;
    deadLettered: number;
  } {
    const result = { expired: 0, leaseReverted: 0, requeued: 0, deadLettered: 0 };

    // 1. Delete expired (7d TTL)
    const expiredRows = this.db.query<{ c: number }>(
      'SELECT COUNT(*) as c FROM staging_inbox WHERE expires_at < ?',
      [now],
    );
    result.expired = Number(expiredRows[0]?.c ?? 0);
    this.db.execute('DELETE FROM staging_inbox WHERE expires_at < ?', [now]);

    // 2. Revert stale leases
    const staleRows = this.db.query<{ c: number }>(
      "SELECT COUNT(*) as c FROM staging_inbox WHERE status = 'classifying' AND lease_until < ?",
      [now],
    );
    result.leaseReverted = Number(staleRows[0]?.c ?? 0);
    this.db.execute(
      "UPDATE staging_inbox SET status = 'received', lease_until = 0 WHERE status = 'classifying' AND lease_until < ?",
      [now],
    );

    // 3. Requeue failed (retry_count <= 3)
    const requeueRows = this.db.query<{ c: number }>(
      "SELECT COUNT(*) as c FROM staging_inbox WHERE status = 'failed' AND retry_count <= 3",
    );
    result.requeued = Number(requeueRows[0]?.c ?? 0);
    this.db.execute(
      "UPDATE staging_inbox SET status = 'received', lease_until = 0 WHERE status = 'failed' AND retry_count <= 3",
    );

    // 4. Dead-letter exhausted (retry_count > 3 stays failed)
    const deadRows = this.db.query<{ c: number }>(
      "SELECT COUNT(*) as c FROM staging_inbox WHERE status = 'failed' AND retry_count > 3",
    );
    result.deadLettered = Number(deadRows[0]?.c ?? 0);

    return result;
  }

  listByStatus(status: string): StagingItem[] {
    return mapStagingItems(this.db.query('SELECT * FROM staging_inbox WHERE status = ?', [status]));
  }

  listAll(): StagingItem[] {
    return mapStagingItems(
      this.db.query('SELECT * FROM staging_inbox ORDER BY created_at ASC, id ASC'),
    );
  }

  size(): number {
    const rows = this.db.query<{ c: number }>('SELECT COUNT(*) as c FROM staging_inbox');
    return Number(rows[0]?.c ?? 0);
  }

  clear(): void {
    this.db.execute('DELETE FROM staging_inbox');
  }
}

export class InMemoryStagingRepository implements StagingRepository {
  private readonly rows = new Map<string, StagingItem>();
  private readonly dedup = new Map<string, string>();

  ingest(item: StagingItem): boolean {
    const key = dedupKey(item.producer_id, item.source, item.source_id, item.data_scope);
    const existing = this.dedup.get(key);
    if (existing && this.rows.has(existing)) return false;
    this.rows.set(item.id, cloneItem(item));
    this.dedup.set(key, item.id);
    return true;
  }

  get(id: string): StagingItem | null {
    return cloneNullable(this.rows.get(id));
  }

  findByDedup(
    producerId: string,
    source: string,
    sourceId: string,
    scope: DataScope,
  ): StagingItem | null {
    const id = this.dedup.get(dedupKey(producerId, source, sourceId, scope));
    return id ? this.get(id) : null;
  }

  deleteByDedup(producerId: string, source: string, sourceId: string, scope: DataScope): void {
    const key = dedupKey(producerId, source, sourceId, scope);
    const id = this.dedup.get(key);
    if (id !== undefined) this.rows.delete(id);
    this.dedup.delete(key);
  }

  claim(limit: number, leaseDuration: number, now: number, scope: DataScope): StagingItem[] {
    const leaseUntil = now + leaseDuration;
    const claimed: StagingItem[] = [];
    const received = Array.from(this.rows.values())
      .filter((item) => item.status === 'received' && item.data_scope === scope)
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    for (const item of received) {
      if (claimed.length >= limit) break;
      const next = { ...item, status: 'classifying' as const, lease_until: leaseUntil };
      this.rows.set(next.id, next);
      claimed.push(cloneItem(next));
    }
    return claimed;
  }

  updateStatus(id: string, status: string, updates?: Partial<StagingItem>): void {
    const current = this.rows.get(id);
    if (!current) return;
    const next: StagingItem = {
      ...current,
      ...updates,
      status: status as StagingItem['status'],
    };
    this.rows.set(id, cloneItem(next));
  }

  sweep(now: number): {
    expired: number;
    leaseReverted: number;
    requeued: number;
    deadLettered: number;
  } {
    const result = { expired: 0, leaseReverted: 0, requeued: 0, deadLettered: 0 };
    for (const [id, item] of Array.from(this.rows.entries())) {
      if (item.expires_at < now) {
        this.rows.delete(id);
        this.dedup.delete(dedupKey(item.producer_id, item.source, item.source_id, item.data_scope));
        result.expired++;
        continue;
      }
      if (item.status === 'classifying' && item.lease_until < now) {
        this.rows.set(id, { ...item, status: 'received', lease_until: 0 });
        result.leaseReverted++;
        continue;
      }
      if (item.status === 'failed') {
        if (item.retry_count <= 3) {
          this.rows.set(id, { ...item, status: 'received', lease_until: 0 });
          result.requeued++;
        } else {
          result.deadLettered++;
        }
      }
    }
    return result;
  }

  listByStatus(status: string): StagingItem[] {
    return Array.from(this.rows.values())
      .filter((item) => item.status === status)
      .map(cloneItem);
  }

  listAll(): StagingItem[] {
    return Array.from(this.rows.values())
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
      .map(cloneItem);
  }

  size(): number {
    return this.rows.size;
  }

  clear(): void {
    this.rows.clear();
    this.dedup.clear();
  }
}

/** PLG-31 #6: the known staging states — a row outside this set is corrupt. */
const VALID_STAGING_STATUSES: ReadonlySet<string> = new Set([
  'received',
  'classifying',
  'stored',
  'pending_unlock',
  'pending_approval',
  'failed',
]);

/**
 * Project a DB row to a StagingItem, or QUARANTINE it (return null) when it is
 * CORRUPT (PLG-31 #6). Previously a malformed `data` / `classified_item` JSON was
 * silently swallowed to a benign default and every scalar blind-cast, so a corrupt
 * row was returned as a valid-looking empty item — which `drainForPersona` would
 * then mark `stored` with nothing written (silent data loss). Mirror the plugin
 * registry's rowToInstall→null quarantine: a parse failure or an out-of-enum
 * status means the row is dropped from `claim`/`listByStatus`/`listAll` and read
 * as null by `get`/`findByDedup`, never normalized.
 */
function rowToStagingItem(row: DBRow): StagingItem | null {
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(row.data ?? '{}')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  let classifiedItem: Record<string, unknown> | undefined;
  if (
    row.classified_item !== null &&
    row.classified_item !== undefined &&
    row.classified_item !== ''
  ) {
    try {
      const parsed = JSON.parse(String(row.classified_item)) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      classifiedItem = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  const status = String(row.status ?? 'received');
  if (!VALID_STAGING_STATUSES.has(status)) return null;

  // PLG-32 #11: quarantine on corrupt SCALAR columns too, not just bad JSON /
  // out-of-enum status. An unknown `data_scope` yields a row invisible to every
  // scope-filtered claim (stuck forever); a NaN / negative timestamp makes the
  // `expires_at < now` sweep never delete it (NaN comparisons are always false)
  // and a negative retry_count corrupts the dead-letter arithmetic. Drop the row
  // (same null-quarantine contract) rather than surface a normalized-but-broken
  // item the drain would mishandle.
  const dataScope = String(row.data_scope ?? 'user') || 'user';
  if (!isValidDataScope(dataScope)) return null;
  const retry_count = Number(row.retry_count ?? 0);
  const lease_until = Number(row.lease_until ?? 0);
  const expires_at = Number(row.expires_at ?? 0);
  const created_at = Number(row.created_at ?? 0);
  if (
    ![retry_count, lease_until, expires_at, created_at].every((n) => Number.isFinite(n) && n >= 0)
  )
    return null;

  return {
    id: String(row.id ?? ''),
    source: String(row.source ?? ''),
    source_id: String(row.source_id ?? ''),
    producer_id: String(row.producer_id ?? ''),
    status: status as StagingItem['status'],
    persona: String(row.persona ?? ''),
    retry_count,
    lease_until,
    expires_at,
    created_at,
    data,
    source_hash: String(row.source_hash ?? ''),
    classified_item: classifiedItem,
    error: row.error ? String(row.error) : undefined,
    approval_id: row.approval_id ? String(row.approval_id) : undefined,
    data_scope: dataScope as DataScope,
  };
}

/** Map rows to items, dropping any that quarantined (PLG-31 #6). */
function mapStagingItems(rows: readonly DBRow[]): StagingItem[] {
  return rows.map(rowToStagingItem).filter((x): x is StagingItem => x !== null);
}

function dedupKey(producerId: string, source: string, sourceId: string, scope: DataScope): string {
  return `${producerId}|${source}|${sourceId}|${scope}`;
}

function cloneNullable(item: StagingItem | undefined): StagingItem | null {
  return item ? cloneItem(item) : null;
}

function cloneItem(item: StagingItem): StagingItem {
  // PLG-32 #27: DEEP-clone `data` / `classified_item` so the in-memory repo
  // matches SQLite's serialize-on-store semantics (a JSON round-trip). A shallow
  // `{ ...item.data }` left nested objects/arrays shared by reference, so a caller
  // mutating a nested value would leak into the "stored" row — a divergence from
  // the SQLite path that serializes (deep-copies) on write.
  return {
    ...item,
    data: JSON.parse(JSON.stringify(item.data)) as Record<string, unknown>,
    ...(item.classified_item
      ? {
          classified_item: JSON.parse(JSON.stringify(item.classified_item)) as Record<
            string,
            unknown
          >,
        }
      : {}),
  };
}
