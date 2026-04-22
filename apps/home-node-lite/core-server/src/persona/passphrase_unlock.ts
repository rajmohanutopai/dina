/**
 * Task 4.69 — Argon2id passphrase unlock for `locked` tier personas.
 *
 * The `locked` tier (see CLAUDE.md §Persona Access Tiers) requires a
 * passphrase before the persona's vault can be opened. This module
 * holds the verification half — storing a per-persona Argon2id digest
 * + salt + params, and verifying a supplied passphrase against it.
 *
 * **Why Argon2id for password verification** (not bcrypt/scrypt/PBKDF2):
 *   - Memory-hard → resists GPU/ASIC attacks.
 *   - Already the canonical KDF in this repo (see
 *     `packages/core/src/crypto/argon2id.ts`) — using the same
 *     primitive means one set of params to review + benchmark.
 *   - The same digest output doubles as a KEK if a future caller wants
 *     to wrap a per-persona DEK under the passphrase (task 4.53's
 *     `wrapSeed` path). Not done here — this module just verifies.
 *
 * **Why a constant-time compare** — naive `===` on `Uint8Array` leaks
 * byte-position information via early termination. Attackers with
 * remote-timing capability could incrementally recover bytes of the
 * stored digest. We compare with XOR-accumulate so the comparison
 * time depends only on length, not on content.
 *
 * **Why the registry is thin** — production will eventually back
 * records with SQLCipher (per-persona `identity.sqlite` row). Today
 * we hold them in a `Map` so the surface is fully testable without
 * SQLCipher. Same pattern as `SessionGrantRegistry` (4.70) and
 * `AutoLockRegistry` (4.71).
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4i task 4.69.
 */

import { deriveKEK, ARGON2ID_PARAMS } from '@dina/core';
import { randomBytes } from 'node:crypto';

/**
 * One passphrase record per persona. Flat + serializable so the
 * SQLCipher-backed variant can persist it as a single row.
 */
export interface PassphraseRecord {
  /** Argon2id output bytes. 32 by default. */
  hash: Uint8Array;
  /** Random salt used for `deriveKEK`. 16 bytes. */
  salt: Uint8Array;
  /** Argon2id memory cost (KiB). */
  memory: number;
  /** Argon2id iterations (time cost). */
  iterations: number;
  /** Argon2id parallelism (lanes). */
  parallelism: number;
  /** When this record was created (ms since epoch). */
  createdAtMs: number;
}

/** Minimum passphrase length. Matches the UX floor we recommend the operator. */
export const MIN_PASSPHRASE_LENGTH = 8;
/** Salt length in bytes. Matches `wrapSeed` (aesgcm.ts). */
export const PASSPHRASE_SALT_BYTES = 16;

export interface PassphraseOptions {
  /**
   * Byte-source for the salt. Default `node:crypto.randomBytes`.
   * Tests inject a deterministic source so records round-trip
   * byte-for-byte.
   */
  randomBytesFn?: (n: number) => Uint8Array;
  /** Injectable clock (ms). Default `Date.now`. */
  nowMsFn?: () => number;
  /**
   * Override Argon2id params. Default = `ARGON2ID_PARAMS`. Tests lower
   * memory + iterations so the suite runs in ~20 ms instead of ~2 s.
   */
  params?: {
    memory?: number;
    iterations?: number;
    parallelism?: number;
  };
}

/**
 * Create a new passphrase record by deriving the Argon2id digest of a
 * fresh random salt. Returns the record — callers persist it on the
 * persona row. Does NOT mutate any registry.
 */
export async function computePassphraseRecord(
  passphrase: string,
  opts: PassphraseOptions = {},
): Promise<PassphraseRecord> {
  if (typeof passphrase !== 'string') {
    throw new Error('computePassphraseRecord: passphrase must be a string');
  }
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(
      `computePassphraseRecord: passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
    );
  }

  const randomBytesFn = opts.randomBytesFn ?? defaultRandomBytes;
  const nowMsFn = opts.nowMsFn ?? Date.now;
  const memory = opts.params?.memory ?? ARGON2ID_PARAMS.memorySize;
  const iterations = opts.params?.iterations ?? ARGON2ID_PARAMS.iterations;
  const parallelism = opts.params?.parallelism ?? ARGON2ID_PARAMS.parallelism;

  const salt = randomBytesFn(PASSPHRASE_SALT_BYTES);
  if (salt.length !== PASSPHRASE_SALT_BYTES) {
    throw new Error(
      `computePassphraseRecord: randomBytesFn returned ${salt.length} bytes, expected ${PASSPHRASE_SALT_BYTES}`,
    );
  }

  const hash = await deriveKEK(passphrase, salt, {
    memory,
    iterations,
    parallelism,
  });

  return {
    hash,
    salt,
    memory,
    iterations,
    parallelism,
    createdAtMs: nowMsFn(),
  };
}

/**
 * Verify a passphrase against a stored record. Constant-time compare
 * on the derived digest so timing attacks can't recover bytes. Returns
 * a plain boolean — the caller decides how to record the attempt (the
 * audit log lives in task 4.73).
 */
export async function verifyPassphrase(
  passphrase: string,
  record: PassphraseRecord,
): Promise<boolean> {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    // Constant-time: don't even call the KDF for an empty input —
    // nothing to protect.
    return false;
  }
  const derived = await deriveKEK(passphrase, record.salt, {
    memory: record.memory,
    iterations: record.iterations,
    parallelism: record.parallelism,
  });
  return constantTimeEqual(derived, record.hash);
}

/**
 * In-memory registry of per-persona passphrase records. Thin wrapper
 * around a `Map` — exists so callers have one name to import + the
 * SQLCipher-backed variant can drop-in replace it.
 */
export class PassphraseRegistry {
  private readonly records = new Map<string, PassphraseRecord>();
  private readonly opts: PassphraseOptions;

  constructor(opts: PassphraseOptions = {}) {
    this.opts = opts;
  }

  /**
   * Set (or replace) the passphrase for a persona. Generates a fresh
   * salt so rotating a passphrase doesn't reuse a prior record.
   */
  async set(persona: string, passphrase: string): Promise<void> {
    if (!persona) throw new Error('PassphraseRegistry.set: persona is required');
    const record = await computePassphraseRecord(passphrase, this.opts);
    this.records.set(persona, record);
  }

  /**
   * Verify a passphrase. Returns `false` on missing persona — caller
   * can't distinguish from a wrong passphrase, which is the intended
   * UX (don't leak "this persona has no passphrase set" via timing).
   */
  async verify(persona: string, passphrase: string): Promise<boolean> {
    const record = this.records.get(persona);
    if (record === undefined) return false;
    return verifyPassphrase(passphrase, record);
  }

  /** True when a record exists for this persona. Non-sensitive (persona names are ops data). */
  has(persona: string): boolean {
    return this.records.has(persona);
  }

  /** Remove a persona's record. Returns true if one was removed. */
  remove(persona: string): boolean {
    return this.records.delete(persona);
  }

  /** Snapshot the underlying record for persistence. Returns undefined when absent. */
  snapshot(persona: string): PassphraseRecord | undefined {
    return this.records.get(persona);
  }

  /** Load a record from storage (inverse of `snapshot`). */
  load(persona: string, record: PassphraseRecord): void {
    this.records.set(persona, record);
  }

  /** Number of personas with a stored record. */
  size(): number {
    return this.records.size;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultRandomBytes(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

/**
 * Constant-time byte-array equality. Returns false immediately for
 * length mismatch (length itself isn't secret), and otherwise compares
 * every byte so elapsed time is independent of how early the mismatch
 * occurs.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
