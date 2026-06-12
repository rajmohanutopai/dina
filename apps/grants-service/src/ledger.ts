/**
 * Grant ledger — SQLite (better-sqlite3), identity-free by schema.
 *
 * Four columns, ops-only: there is structurally nothing here that maps
 * a grant to a person or device (the per-device state lives in Apple's
 * DeviceCheck bits). Adding an identity-bearing column is a spec
 * violation (docs/CREDITS_DESIGN.md "anonymous claim").
 */

import Database from 'better-sqlite3';

import type { GrantLedger } from './ports';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS grants (
  grant_id   TEXT PRIMARY KEY,
  or_key_id  TEXT NOT NULL,
  platform   TEXT NOT NULL,
  granted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grants_granted_at ON grants(granted_at);
`;

export class SqliteGrantLedger implements GrantLedger {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  insert(row: { grantId: string; orKeyId: string; platform: string; grantedAt: number }): void {
    this.db
      .prepare(
        'INSERT INTO grants (grant_id, or_key_id, platform, granted_at) VALUES (?, ?, ?, ?)',
      )
      .run(row.grantId, row.orKeyId, row.platform, row.grantedAt);
  }

  countSince(sinceMs: number): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM grants WHERE granted_at >= ?')
      .get(sinceMs) as { n: number };
    return r.n;
  }

  close(): void {
    this.db.close();
  }
}
