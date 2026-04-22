/**
 * Staging SQL repository — backs the staging inbox with SQLite.
 *
 * Handles the complex state machine (received → classifying → stored/pending_unlock/failed)
 * and 3-part dedup key (producer_id, source, source_id).
 *
 * **Phase 2.3 (task 2.3).** Port methods return `Promise<T>`. SQLite
 * under go-sqlcipher is sync internally; each `async` method wraps
 * the sync result in a resolved Promise. Service-layer `ingestStaging`
 * in `staging/service.ts` keeps its sync signature via fire-and-forget
 * write-through (same pattern as AuditRepository / DeviceRepository /
 * ReminderRepository).
 *
 * Source: ARCHITECTURE.md — op-sqlite persistence layer
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';
import type { StagingItem } from './service';

export interface StagingRepository {
  /** Returns true if new, false if duplicate (3-part dedup key). */
  ingest(item: StagingItem): Promise<boolean>;
  get(id: string): Promise<StagingItem | null>;
  claim(limit: number, leaseDuration: number, now: number): Promise<StagingItem[]>;
  updateStatus(id: string, status: string, updates?: Partial<StagingItem>): Promise<void>;
  sweep(now: number): Promise<{
    expired: number;
    leaseReverted: number;
    requeued: number;
    deadLettered: number;
  }>;
  listByStatus(status: string): Promise<StagingItem[]>;
  size(): Promise<number>;
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

  async ingest(item: StagingItem): Promise<boolean> {
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

  async get(id: string): Promise<StagingItem | null> {
    const rows = this.db.query('SELECT * FROM staging_inbox WHERE id = ?', [id]);
    return rows.length > 0 ? rowToStagingItem(rows[0]) : null;
  }

  async claim(limit: number, leaseDuration: number, now: number): Promise<StagingItem[]> {
    const leaseUntil = now + leaseDuration;
    this.db.execute(
      `UPDATE staging_inbox SET status = 'classifying', lease_until = ?
       WHERE id IN (SELECT id FROM staging_inbox WHERE status = 'received' LIMIT ?)`,
      [leaseUntil, limit],
    );
    const rows = this.db.query(
      `SELECT * FROM staging_inbox WHERE status = 'classifying' AND lease_until = ?`,
      [leaseUntil],
    );
    return rows.map(rowToStagingItem);
  }

  async updateStatus(id: string, status: string, updates?: Partial<StagingItem>): Promise<void> {
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

  async sweep(now: number): Promise<{
    expired: number;
    leaseReverted: number;
    requeued: number;
    deadLettered: number;
  }> {
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

  async listByStatus(status: string): Promise<StagingItem[]> {
    return this.db
      .query('SELECT * FROM staging_inbox WHERE status = ?', [status])
      .map(rowToStagingItem);
  }

  async size(): Promise<number> {
    const rows = this.db.query<{ c: number }>('SELECT COUNT(*) as c FROM staging_inbox');
    return Number(rows[0]?.c ?? 0);
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
