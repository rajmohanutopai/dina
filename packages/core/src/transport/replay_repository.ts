/**
 * Seen D2D message keys, kept across restarts (SEC-HIGH-08).
 *
 * The replay check keys on `sender|message id`. Held only in memory, the
 * set emptied on every restart, so a message captured once could be fed in
 * again afterwards. The SQLite store keeps each key until the message
 * itself is too old to accept (`adversarial.ts` refuses anything older than
 * the replay window), so nothing old enough to have left the store can get
 * past the age check.
 */

import type { DatabaseAdapter } from '../storage/db_adapter';

export interface ReplayRepository {
  /** True when `key` is held and has not expired at `now` (Unix seconds). */
  has(key: string, now: number): boolean;
  /** Hold `key` until `expiresAt` (Unix seconds). */
  record(key: string, expiresAt: number): void;
  /** Drop keys whose hold ended before `now`. Returns the count. */
  purgeExpired(now: number): number;
  /** Forget everything (tests). */
  clear(): void;
}

export class InMemoryReplayRepository implements ReplayRepository {
  private readonly keys = new Map<string, number>();

  has(key: string, now: number): boolean {
    const until = this.keys.get(key);
    return until !== undefined && until >= now;
  }

  record(key: string, expiresAt: number): void {
    const held = this.keys.get(key);
    this.keys.set(key, held === undefined ? expiresAt : Math.max(held, expiresAt));
  }

  purgeExpired(now: number): number {
    let purged = 0;
    for (const [key, until] of this.keys) {
      if (until < now) {
        this.keys.delete(key);
        purged++;
      }
    }
    return purged;
  }

  clear(): void {
    this.keys.clear();
  }
}

export class SQLiteReplayRepository implements ReplayRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  has(key: string, now: number): boolean {
    const rows = this.db.query(
      'SELECT 1 AS hit FROM d2d_replay_seen WHERE replay_key = ? AND expires_at >= ?',
      [key, now],
    );
    return rows.length > 0;
  }

  record(key: string, expiresAt: number): void {
    this.db.execute(
      `INSERT INTO d2d_replay_seen (replay_key, expires_at) VALUES (?, ?)
       ON CONFLICT(replay_key) DO UPDATE SET expires_at = MAX(expires_at, excluded.expires_at)`,
      [key, expiresAt],
    );
  }

  purgeExpired(now: number): number {
    return this.db.run('DELETE FROM d2d_replay_seen WHERE expires_at < ?', [now]);
  }

  clear(): void {
    this.db.execute('DELETE FROM d2d_replay_seen');
  }
}

let repo: ReplayRepository | null = null;
export function setReplayRepository(r: ReplayRepository | null): void {
  repo = r;
}
export function getReplayRepository(): ReplayRepository | null {
  return repo;
}
