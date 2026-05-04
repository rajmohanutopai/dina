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

import type { StagingItem } from './service';
import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export interface StagingRepository {
  /** Returns true if new, false if duplicate (3-part dedup key). */
  ingest(item: StagingItem): boolean;
  get(id: string): StagingItem | null;
  findByDedup(producerId: string, source: string, sourceId: string): StagingItem | null;
  claim(limit: number, leaseDuration: number, now: number): StagingItem[];
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
    const result = this.db.run(
      `INSERT OR IGNORE INTO staging_inbox (id, source, source_id, producer_id, status, persona, retry_count, lease_until, expires_at, created_at, data, source_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ],
    );
    return result > 0;
  }

  get(id: string): StagingItem | null {
    const rows = this.db.query('SELECT * FROM staging_inbox WHERE id = ?', [id]);
    return rows.length > 0 ? rowToStagingItem(rows[0]) : null;
  }

  findByDedup(producerId: string, source: string, sourceId: string): StagingItem | null {
    const rows = this.db.query(
      'SELECT * FROM staging_inbox WHERE producer_id = ? AND source = ? AND source_id = ?',
      [producerId, source, sourceId],
    );
    return rows.length > 0 ? rowToStagingItem(rows[0]) : null;
  }

  claim(limit: number, leaseDuration: number, now: number): StagingItem[] {
    const leaseUntil = now + leaseDuration;
    const candidates = this.db.query<{ id: string }>(
      `SELECT id FROM staging_inbox
       WHERE status = 'received'
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
      [limit],
    );
    const ids = candidates.map((row) => String(row.id));
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(', ');
    this.db.transaction(() => {
      this.db.execute(
        `UPDATE staging_inbox SET status = 'classifying', lease_until = ?
         WHERE id IN (${placeholders})`,
        [leaseUntil, ...ids],
      );
    });
    const rows = this.db.query(
      `SELECT * FROM staging_inbox
       WHERE id IN (${placeholders})
       ORDER BY created_at ASC, id ASC`,
      ids,
    );
    return rows.map(rowToStagingItem);
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
    return this.db
      .query('SELECT * FROM staging_inbox WHERE status = ?', [status])
      .map(rowToStagingItem);
  }

  listAll(): StagingItem[] {
    return this.db
      .query('SELECT * FROM staging_inbox ORDER BY created_at ASC, id ASC')
      .map(rowToStagingItem);
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
    const key = dedupKey(item.producer_id, item.source, item.source_id);
    const existing = this.dedup.get(key);
    if (existing && this.rows.has(existing)) return false;
    this.rows.set(item.id, cloneItem(item));
    this.dedup.set(key, item.id);
    return true;
  }

  get(id: string): StagingItem | null {
    return cloneNullable(this.rows.get(id));
  }

  findByDedup(producerId: string, source: string, sourceId: string): StagingItem | null {
    const id = this.dedup.get(dedupKey(producerId, source, sourceId));
    return id ? this.get(id) : null;
  }

  claim(limit: number, leaseDuration: number, now: number): StagingItem[] {
    const leaseUntil = now + leaseDuration;
    const claimed: StagingItem[] = [];
    const received = Array.from(this.rows.values())
      .filter((item) => item.status === 'received')
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
        this.dedup.delete(dedupKey(item.producer_id, item.source, item.source_id));
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

function rowToStagingItem(row: DBRow): StagingItem {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(String(row.data ?? '{}'));
  } catch {
    /* */
  }

  let classifiedItem: Record<string, unknown> | undefined;
  if (row.classified_item) {
    try {
      classifiedItem = JSON.parse(String(row.classified_item));
    } catch {
      /* */
    }
  }

  return {
    id: String(row.id ?? ''),
    source: String(row.source ?? ''),
    source_id: String(row.source_id ?? ''),
    producer_id: String(row.producer_id ?? ''),
    status: String(row.status ?? 'received') as StagingItem['status'],
    persona: String(row.persona ?? ''),
    retry_count: Number(row.retry_count ?? 0),
    lease_until: Number(row.lease_until ?? 0),
    expires_at: Number(row.expires_at ?? 0),
    created_at: Number(row.created_at ?? 0),
    data,
    source_hash: String(row.source_hash ?? ''),
    classified_item: classifiedItem,
    error: row.error ? String(row.error) : undefined,
    approval_id: row.approval_id ? String(row.approval_id) : undefined,
  };
}

function dedupKey(producerId: string, source: string, sourceId: string): string {
  return `${producerId}|${source}|${sourceId}`;
}

function cloneNullable(item: StagingItem | undefined): StagingItem | null {
  return item ? cloneItem(item) : null;
}

function cloneItem(item: StagingItem): StagingItem {
  return {
    ...item,
    data: { ...item.data },
    ...(item.classified_item ? { classified_item: { ...item.classified_item } } : {}),
  };
}
