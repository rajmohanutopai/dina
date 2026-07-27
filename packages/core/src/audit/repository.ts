/**
 * Audit SQL repository — backs the hash-chained audit log with SQLite.
 *
 * Critical: uses AUTOINCREMENT for seq. The service layer computes
 * entry_hash and prev_hash before INSERT — the repository just persists.
 *
 * Sync on purpose: DatabaseAdapter uses native SQLite bindings on both Node and
 * mobile. Audit append is an authorization-side effect, so the durable row must
 * commit before the service publishes the new chain head in memory.
 *
 * Source: ARCHITECTURE.md — op-sqlite persistence layer
 */

import type { AuditEntry } from './hash_chain';
import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export interface AuditRetentionCheckpoint {
  firstRetainedSeq: number;
  anchorHash: string;
}

export interface AuditRepository {
  append(entry: AuditEntry): void;
  latest(): AuditEntry | null;
  query(filters: {
    actor?: string;
    action?: string;
    resource?: string;
    since?: number;
    until?: number;
    limit?: number;
  }): AuditEntry[];
  compact(checkpoint: AuditRetentionCheckpoint): number;
  count(): number;
  allEntries(): AuditEntry[];
  highestSequence(): number;
  retentionCheckpoint(): AuditRetentionCheckpoint | null;
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

  append(entry: AuditEntry): void {
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

  latest(): AuditEntry | null {
    const rows = this.db.query('SELECT * FROM audit_log ORDER BY seq DESC LIMIT 1');
    return rows.length > 0 ? rowToAuditEntry(rows[0]) : null;
  }

  query(filters: {
    actor?: string;
    action?: string;
    resource?: string;
    since?: number;
    until?: number;
    limit?: number;
  }): AuditEntry[] {
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

  compact(checkpoint: AuditRetentionCheckpoint): number {
    const before = this.count();
    this.db.transaction(() => {
      this.db.execute(
        `INSERT INTO audit_retention_checkpoint
           (singleton, first_retained_seq, anchor_hash, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           first_retained_seq = excluded.first_retained_seq,
           anchor_hash = excluded.anchor_hash,
           updated_at = excluded.updated_at`,
        [checkpoint.firstRetainedSeq, checkpoint.anchorHash, Math.floor(Date.now() / 1000)],
      );
      // Retention always removes a chain prefix. Deleting by timestamp can
      // punch an interior hole when the wall clock moves backwards or an
      // imported entry carries an older timestamp.
      this.db.execute('DELETE FROM audit_log WHERE seq < ?', [checkpoint.firstRetainedSeq]);
    });
    return before - this.count();
  }

  count(): number {
    const rows = this.db.query<{ c: number }>('SELECT COUNT(*) as c FROM audit_log');
    return Number(rows[0]?.c ?? 0);
  }

  allEntries(): AuditEntry[] {
    const rows = this.db.query('SELECT * FROM audit_log ORDER BY seq ASC');
    return rows.map(rowToAuditEntry);
  }

  highestSequence(): number {
    const rows = this.db.query<{ seq: number }>(
      `SELECT seq FROM sqlite_sequence WHERE name = 'audit_log' LIMIT 1`,
    );
    return Number(rows[0]?.seq ?? 0);
  }

  retentionCheckpoint(): AuditRetentionCheckpoint | null {
    const rows = this.db.query<{
      first_retained_seq: number;
      anchor_hash: string;
    }>(
      `SELECT first_retained_seq, anchor_hash
       FROM audit_retention_checkpoint
       WHERE singleton = 1
       LIMIT 1`,
    );
    if (rows.length === 0) return null;
    return {
      firstRetainedSeq: Number(rows[0].first_retained_seq),
      anchorHash: String(rows[0].anchor_hash),
    };
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
