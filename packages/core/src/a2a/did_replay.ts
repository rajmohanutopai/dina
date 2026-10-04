/**
 * The replay guard for DID-signed Lane 2 requests (design §5.1).
 *
 * Each DID's spent nonces are kept in identity.sqlite until the signature
 * they came with can no longer pass the ±5-minute time check: a request
 * dated T passes until T + 5 min, so its nonce is kept until then, or until
 * now + 5 min for one dated in the past. On disk, a nonce outlives a
 * restart, so a captured request cannot be used again after one; kept by
 * its own date, it outlives a signer whose clock runs ahead. The host
 * purges expired rows (`purgeExpiredA2ANonces`); a row only ever follows a
 * proven signature, and the gateway's per-address limit bounds how fast
 * they come.
 */

import { parseRFC3339, TIMESTAMP_WINDOW_SECONDS } from '../auth/timestamp';

import type { A2AStore } from './store';
import type { ReplayGuard } from '../auth/signed_request';

const WINDOW_MS = TIMESTAMP_WINDOW_SECONDS * 1000;
/** The card's rule (`DINA_REQUEST_SIGNING.nonce`); Dina's own nonces are 32 hex characters. */
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The guard over `store`. `now` must be the clock the time check reads
 * (the wall clock), since a nonce's lifetime is measured against it.
 */
export function a2aNonceGuard(store: A2AStore, now: () => number = Date.now): ReplayGuard {
  return {
    check(nonce: string, timestamp: string, did: string): boolean {
      if (!NONCE_RE.test(nonce)) return false;
      let signedAt: number;
      try {
        signedAt = parseRFC3339(timestamp).getTime();
      } catch {
        return false;
      }
      if (!Number.isFinite(signedAt)) return false;
      const kept = store.db.run('INSERT OR IGNORE INTO a2a_request_nonces (did, nonce, expires_at) VALUES (?, ?, ?)', [
        did,
        nonce,
        Math.max(signedAt, now()) + WINDOW_MS,
      ]);
      return kept === 1;
    },
  };
}

/** Forget nonces whose signatures can no longer pass the time check. Returns how many. */
export function purgeExpiredA2ANonces(store: A2AStore, nowMs: number = Date.now()): number {
  return store.db.run('DELETE FROM a2a_request_nonces WHERE expires_at <= ?', [nowMs]);
}
