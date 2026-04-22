/**
 * Audit SQL repository — backs the hash-chained audit log with SQLite.
 *
 * Critical: uses AUTOINCREMENT for seq. The service layer computes
 * entry_hash and prev_hash before INSERT — the repository just persists.
 *
 * **Phase 2.3 (task 2.3).** Port methods return `Promise<T>`. SQLite is
 * sync under go-sqlcipher so each implementation returns
 * `Promise.resolve(result)` without microtask overhead beyond one promise
 * per call. Service-layer `appendAudit()` in `audit/service.ts` stays
 * sync by firing `append()` fire-and-forget — it's already wrapped in
 * try/catch with a fail-safe comment, so losing the await is the
 * intended semantic.
 *
 * Source: ARCHITECTURE.md — op-sqlite persistence layer
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';
import type { AuditEntry } from './hash_chain';

export interface AuditRepository {
  append(entry: AuditEntry): Promise<void>;
  latest(): Promise<AuditEntry | null>;
  query(filters: {
    actor?: string;
    action?: string;
    resource?: string;
    since?: number;
    until?: number;
    limit?: number;
  }): Promise<AuditEntry[]>;
  sweep(cutoffTs: number): Promise<number>;
  count(): Promise<number>;
  allEntries(): Promise<AuditEntry[]>;
}

let repo: AuditRepository | null = null;
export function setAuditRepository(r: AuditRepository | null): void {
  repo = r;
}
export function getAuditRepository(): AuditRepository | null {
  return repo;
}

export class SQLiteAuditRepository implements AuditRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async append(entry: AuditEntry): Promise<void> {
    this.db.execute(
      `INSERT INTO audit_log (seq, ts, actor, action, resource, detail, prev_hash, entry_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.seq,
        entry.ts,
        entry.actor,
        entry.action,
        entry.resource,
        entry.detail,
        entry.prev_hash,
        entry.entry_hash,
      ],
    );
  }

  async latest(): Promise<AuditEntry | null> {
    const rows = this.db.query('SELECT * FROM audit_log ORDER BY seq DESC LIMIT 1');
    return rows.length > 0 ? rowToAuditEntry(rows[0]) : null;
  }

  async query(filters: {
    actor?: string;
    action?: string;
    resource?: string;
    since?: number;
    until?: number;
    limit?: number;
  }): Promise<AuditEntry[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.actor) {
      conditions.push('actor = ?');
      params.push(filters.actor);
    }
    if (filters.action) {
      conditions.push('action = ?');
      params.push(filters.action);
    }
    if (filters.resource) {
      conditions.push('resource = ?');
      params.push(filters.resource);
    }
    if (filters.since) {
      conditions.push('ts >= ?');
      params.push(Math.floor(filters.since / 1000));
    }
    if (filters.until) {
      conditions.push('ts <= ?');
      params.push(Math.floor(filters.until / 1000));
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 200, 200);

    const rows = this.db.query(`SELECT * FROM audit_log ${where} ORDER BY seq DESC LIMIT ?`, [
      ...params,
      limit,
    ]);
    return rows.map(rowToAuditEntry);
  }

  async sweep(cutoffTs: number): Promise<number> {
    const before = await this.count();
    this.db.execute('DELETE FROM audit_log WHERE ts < ?', [cutoffTs]);
    return before - (await this.count());
  }

  async count(): Promise<number> {
    const rows = this.db.query<{ c: number }>('SELECT COUNT(*) as c FROM audit_log');
    return Number(rows[0]?.c ?? 0);
  }

  async allEntries(): Promise<AuditEntry[]> {
    const rows = this.db.query('SELECT * FROM audit_log ORDER BY seq ASC');
    return rows.map(rowToAuditEntry);
  }
}

function rowToAuditEntry(row: DBRow): AuditEntry {
  return {
    seq: Number(row.seq ?? 0),
    ts: Number(row.ts ?? 0),
    actor: String(row.actor ?? ''),
    action: String(row.action ?? ''),
    resource: String(row.resource ?? ''),
    detail: String(row.detail ?? ''),
    prev_hash: String(row.prev_hash ?? ''),
    entry_hash: String(row.entry_hash ?? ''),
  };
}
