/**
 * Per-payload leaf erasure-key store — the crypto-shred backend
 * (INTERACTIVE_SERVICES_ARCHITECTURE.md §13/§20).
 *
 * Each payload's data key `k_p` is wrapped under a per-payload, independently
 * destroyable *leaf erasure key* `k_e`. Crypto-shred = destroy `k_e`, which
 * renders the wrapped `k_p` — and therefore the ciphertext — undecryptable,
 * needs no persona DEK (so it works while the persona is locked), and (with a
 * conforming NON-BACKED backend) defeats WAL/snapshot/backup copies.
 *
 * The backend's guarantee is a FROZEN, owner-visible `mode`:
 *  - `backup_resistant` — the leaf key is kept out of every backup/snapshot and
 *    destroyed crash-safely (Secure Enclave / StrongBox / a backup-excluded
 *    keyfile). NOT provided by the shipping keystores.
 *  - `logical_deletion` — the leaf key lives in a backup-restorable store (the
 *    Tier-0 SQLCipher DB); destroying it is a logical delete + physical GC. This
 *    is the honest V1 mode on the current stack (§20).
 *
 * A hardened backend drops in later without touching the payload-store or run
 * lifecycle — it just reports `mode = 'backup_resistant'` and keeps `k_e` off
 * every backup.
 */

import type { ErasureMode } from './domain';
import type { DatabaseAdapter } from '../storage/db_adapter';

export interface ErasureKeyStore {
  /** The FROZEN guarantee this backend provides (§13). */
  readonly mode: ErasureMode;
  /** Store a payload's leaf erasure key. */
  put(payloadId: string, key: Uint8Array): void;
  /** Fetch a payload's leaf key, or null if it was crypto-shredded / absent. */
  get(payloadId: string): Uint8Array | null;
  /** True iff the leaf key is still present (not yet shredded). */
  has(payloadId: string): boolean;
  /** Crypto-shred: destroy the payload's leaf key. Idempotent. */
  destroy(payloadId: string): void;
}

/**
 * Tier-0-backed leaf-key store. Because the key sits in the (backed-up) Tier-0
 * SQLCipher DB, this backend is honestly `logical_deletion`: a restored backup
 * would still contain the key, so `destroy` is a logical delete + physical GC,
 * NOT backup-resistant crypto-shred. It is the correct V1 backend on the
 * shipping keystores (§20).
 */
export class SQLiteErasureKeyStore implements ErasureKeyStore {
  readonly mode: ErasureMode = 'logical_deletion';

  constructor(private readonly db: DatabaseAdapter) {}

  put(payloadId: string, key: Uint8Array): void {
    this.db.run(
      'INSERT OR REPLACE INTO run_erasure_keys (payload_id, key, created_at) VALUES (?, ?, ?)',
      [payloadId, key, Date.now()],
    );
  }

  get(payloadId: string): Uint8Array | null {
    const rows = this.db.query<{ key: Uint8Array }>(
      'SELECT key FROM run_erasure_keys WHERE payload_id = ? LIMIT 1',
      [payloadId],
    );
    const v = rows[0]?.key;
    return v instanceof Uint8Array ? v : v === undefined ? null : new Uint8Array(v);
  }

  has(payloadId: string): boolean {
    return (
      this.db.query('SELECT 1 FROM run_erasure_keys WHERE payload_id = ? LIMIT 1', [payloadId])
        .length > 0
    );
  }

  destroy(payloadId: string): void {
    this.db.run('DELETE FROM run_erasure_keys WHERE payload_id = ?', [payloadId]);
  }
}

/**
 * In-memory leaf-key store for tests. `mode` is configurable so a test can
 * exercise the `backup_resistant` assertion path (the leaf key is genuinely
 * gone from every copy after `destroy`, since there is only the one Map).
 */
export class InMemoryErasureKeyStore implements ErasureKeyStore {
  private readonly keys = new Map<string, Uint8Array>();

  constructor(public readonly mode: ErasureMode = 'logical_deletion') {}

  put(payloadId: string, key: Uint8Array): void {
    this.keys.set(payloadId, new Uint8Array(key));
  }

  get(payloadId: string): Uint8Array | null {
    const v = this.keys.get(payloadId);
    return v ? new Uint8Array(v) : null;
  }

  has(payloadId: string): boolean {
    return this.keys.has(payloadId);
  }

  destroy(payloadId: string): void {
    this.keys.delete(payloadId);
  }
}

// ---------------------------------------------------------------------------
// Singleton + probe
// ---------------------------------------------------------------------------

let store: ErasureKeyStore | null = null;

export function setErasureKeyStore(s: ErasureKeyStore | null): void {
  store = s;
}

export function getErasureKeyStore(): ErasureKeyStore | null {
  return store;
}

/**
 * Freeze the platform's crypto-shred guarantee at run creation (§13/§5). Reads
 * the wired backend's `mode`; falls back to the honest weaker guarantee
 * (`logical_deletion`) when no backend is wired. A hardened backend returning
 * `backup_resistant` upgrades every run created after it is wired — no other
 * code changes.
 */
export function probeErasureMode(): ErasureMode {
  return store?.mode ?? 'logical_deletion';
}
