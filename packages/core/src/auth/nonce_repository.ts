/**
 * Signed-request nonces kept across restarts (STATE_MACHINES TT-04).
 *
 * The in-memory `NonceCache` empties on every restart and evicts on a flood,
 * so a captured request could run again inside its time window. This store
 * holds each nonce, per signer, until its timestamp could no longer pass.
 * Only callers Core knows are written here: a DID no caller holds is refused
 * at authorization whatever it signs, and must not be able to grow a table.
 */

import type { DatabaseAdapter } from '../storage/db_adapter';

export interface SignedNonceRepository {
  /**
   * Spend a nonce: true the first time, false while it is held. Throws when
   * the store cannot answer; the caller refuses the request.
   */
  spend(did: string, nonce: string, expiresAtMs: number, nowMs: number): boolean;
}

const PURGE_EVERY_MS = 10 * 60 * 1000;

export class SQLiteSignedNonceRepository implements SignedNonceRepository {
  private lastPurgeMs = 0;

  constructor(private readonly db: DatabaseAdapter) {}

  spend(did: string, nonce: string, expiresAtMs: number, nowMs: number): boolean {
    if (nowMs - this.lastPurgeMs >= PURGE_EVERY_MS) {
      this.lastPurgeMs = nowMs;
      this.purgeExpired(nowMs);
    }
    return (
      this.db.run(
        `INSERT INTO signed_request_nonces (did, nonce, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(did, nonce) DO UPDATE SET expires_at = excluded.expires_at
           WHERE signed_request_nonces.expires_at <= ?`,
        [did, nonce, expiresAtMs, nowMs],
      ) > 0
    );
  }

  /** Drop nonces whose hold has ended. Returns the count. */
  purgeExpired(nowMs: number): number {
    return this.db.run('DELETE FROM signed_request_nonces WHERE expires_at <= ?', [nowMs]);
  }
}

let repo: SignedNonceRepository | null = null;
export function setSignedNonceRepository(r: SignedNonceRepository | null): void {
  repo = r;
}
export function getSignedNonceRepository(): SignedNonceRepository | null {
  return repo;
}
