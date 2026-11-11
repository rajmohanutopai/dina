/**
 * The copies, in SQLite (better-sqlite3).
 *
 * A row is a `backup_id`, a counter, the sealed bytes, their size, their
 * SHA-256 and the time they arrived. No DID, no name, no contents: the store
 * cannot open what it keeps (USER_BACKUP.md §6).
 *
 * Copies are immutable. A write for a counter at or below the highest held
 * is refused, so a restored device can never overwrite a newer copy.
 * The digest is computed here, over the bytes received, and checked on every
 * read: a copy that has changed under us is refused, never handed over as if
 * it were the backup.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import Database from 'better-sqlite3';

import { countersToKeep } from './retention';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS copies (
  backup_id TEXT NOT NULL,
  counter   INTEGER NOT NULL,
  size      INTEGER NOT NULL,
  digest    TEXT NOT NULL,
  stored_at INTEGER NOT NULL,
  bytes     BLOB NOT NULL,
  PRIMARY KEY (backup_id, counter)
);
CREATE TABLE IF NOT EXISTS seen_nonces (
  nonce      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seen_nonces_expiry ON seen_nonces(expires_at);
`;

export interface CopyRow {
  counter: number;
  size: number;
  storedAt: number;
}

export type PutOutcome = 'stored' | 'not_newer';
export type GetOutcome =
  | { ok: true; bytes: Uint8Array; counter: number }
  | { ok: false; reason: 'not_found' | 'corrupt' };

export class CopyStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  list(backupId: string): CopyRow[] {
    return (
      this.db
        .prepare('SELECT counter, size, stored_at FROM copies WHERE backup_id = ? ORDER BY counter')
        .all(backupId) as { counter: number; size: number; stored_at: number }[]
    ).map((r) => ({ counter: r.counter, size: r.size, storedAt: r.stored_at }));
  }

  /** Store a copy, then drop what retention no longer keeps. One transaction. */
  put(backupId: string, counter: number, bytes: Uint8Array, nowMs: number): PutOutcome {
    return this.db.transaction((): PutOutcome => {
      const top = this.db
        .prepare('SELECT MAX(counter) AS top FROM copies WHERE backup_id = ?')
        .get(backupId) as { top: number | null };
      if (top.top !== null && counter <= top.top) return 'not_newer';
      this.db
        .prepare(
          'INSERT INTO copies (backup_id, counter, size, digest, stored_at, bytes) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(backupId, counter, bytes.length, bytesToHex(sha256(bytes)), nowMs, Buffer.from(bytes));
      const keep = countersToKeep(this.list(backupId));
      const drop = this.db.prepare('DELETE FROM copies WHERE backup_id = ? AND counter = ?');
      for (const c of this.list(backupId)) if (!keep.has(c.counter)) drop.run(backupId, c.counter);
      return 'stored';
    })();
  }

  get(backupId: string, counter: number | 'latest'): GetOutcome {
    const row = (
      counter === 'latest'
        ? this.db
            .prepare(
              'SELECT counter, digest, bytes FROM copies WHERE backup_id = ? ORDER BY counter DESC LIMIT 1',
            )
            .get(backupId)
        : this.db
            .prepare(
              'SELECT counter, digest, bytes FROM copies WHERE backup_id = ? AND counter = ?',
            )
            .get(backupId, counter)
    ) as { counter: number; digest: string; bytes: Buffer } | undefined;
    if (row === undefined) return { ok: false, reason: 'not_found' };
    const bytes = new Uint8Array(row.bytes);
    if (bytesToHex(sha256(bytes)) !== row.digest) return { ok: false, reason: 'corrupt' };
    return { ok: true, bytes, counter: row.counter };
  }

  /** Every copy under this id; the count removed. */
  deleteAll(backupId: string): number {
    return this.db.prepare('DELETE FROM copies WHERE backup_id = ?').run(backupId).changes;
  }

  /**
   * Record a nonce until it can no longer pass the timestamp check. False
   * when it was already seen: a replay. Kept in the database, so a restart
   * does not reopen the window.
   */
  claimNonce(nonce: string, nowMs: number, ttlMs: number): boolean {
    this.db.prepare('DELETE FROM seen_nonces WHERE expires_at <= ?').run(nowMs);
    const r = this.db
      .prepare('INSERT OR IGNORE INTO seen_nonces (nonce, expires_at) VALUES (?, ?)')
      .run(nonce, nowMs + ttlMs);
    return r.changes === 1;
  }
}
