/**
 * Task 4.62 — 8-character pairing code generator + registry.
 *
 * A pairing code is a short, human-readable secret the operator shows
 * on the Home Node display (or reads aloud) so a new device can
 * register with the node. The code must be:
 *
 *   - **Short + typable** — 8 characters
 *   - **Unambiguous** — no visually-confusable letters
 *   - **Single-use** — consumed on `complete()`; second use errors
 *   - **TTL-bounded** — expires 5 minutes after generation so an
 *     abandoned display doesn't leave a valid code lying around
 *   - **Collision-free** — 32^8 ≈ 1.1 trillion values; we still do a
 *     collision-retry against live codes because hash-derived codes
 *     can repeat before the secret does
 *
 * **Alphabet**: Crockford Base32 (`0-9 A-Z` minus `I L O U`). Matches
 * Go's `core/internal/adapter/pairing/pairing.go` byte-for-byte so a
 * code generated on either side displays identically.
 *
 * **Derivation**: `code[i] = alphabet[sha256(secret)[i] % 32]`. The
 * 32-byte secret (not the code) is the cryptographic material —
 * `@dina/protocol` uses it for HKDF key derivation on `complete()`.
 * The code is merely a UX lookup key.
 *
 * **Cap**: 100 pending codes (`MAX_PENDING_CODES`). Prevents a
 * pathological caller from exhausting memory by spamming `generate()`
 * without ever completing a pairing. Hits the Go SEC-MED-13 threshold.
 *
 * **Storage**: in-memory — same pattern as 4.70 / 4.71 / 4.72. The
 * SQLCipher-backed variant for crash-persistence lands later; codes
 * are ephemeral enough (5-min TTL) that process restart simply
 * invalidates them, which is acceptable for a pairing code.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4h task 4.62.
 */

import { randomBytes, createHash } from 'node:crypto';

/** Crockford Base32 alphabet — matches Go pairing exactly. */
export const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 32^8 = 1.1 trillion distinct codes. */
export const PAIRING_CODE_LENGTH = 8;

/** 32-byte secret per code — same as Go. */
export const PAIRING_SECRET_BYTES = 32;

/** Default 5-minute TTL (matches Go `DefaultCodeTTL`). */
export const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;

/** Hard cap on live pending codes (SEC-MED-13 parity). */
export const MAX_PENDING_CODES = 100;

/** Retry budget when `deriveCode` produces a live-collision. */
export const CODE_COLLISION_RETRIES = 5;

export type PairingCodeErrorReason =
  | 'too_many_pending'
  | 'collision_retries_exhausted'
  | 'invalid_code'
  | 'code_used'
  | 'code_expired';

export class PairingCodeError extends Error {
  constructor(
    public readonly reason: PairingCodeErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'PairingCodeError';
  }
}

export interface PairingCodeRecord {
  readonly code: string;
  readonly secret: Uint8Array;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  used: boolean;
}

export interface PairingCodeOptions {
  /** TTL in ms. Default `DEFAULT_PAIRING_TTL_MS`. */
  ttlMs?: number;
  /** Injectable clock. Default `Date.now`. */
  nowMsFn?: () => number;
  /** Injectable random source. Default `node:crypto.randomBytes`. */
  randomBytesFn?: (n: number) => Uint8Array;
  /** Diagnostic hook. Fires on state transitions. */
  onEvent?: (event: PairingCodeEvent) => void;
}

export type PairingCodeEvent =
  | { kind: 'generated'; code: string; createdAtMs: number; expiresAtMs: number }
  | { kind: 'consumed'; code: string; consumedAtMs: number }
  | { kind: 'expired'; code: string; expiredAtMs: number };

/**
 * Derive a human-readable pairing code from a 32-byte secret.
 *
 * Pure function — same secret + same length always produces the same
 * code. Exported so `@dina/protocol` (the consuming side) can verify a
 * supplied (code, secret) pair matches without touching the registry.
 */
export function deriveCode(secret: Uint8Array, length = PAIRING_CODE_LENGTH): string {
  if (!(secret instanceof Uint8Array) || secret.length === 0) {
    throw new Error('deriveCode: secret must be a non-empty Uint8Array');
  }
  if (!Number.isInteger(length) || length <= 0 || length > 32) {
    throw new Error(`deriveCode: length must be 1..32 (got ${length})`);
  }
  // SHA-256 is 32 bytes; we consume the first `length` bytes mod 32.
  const hash = createHash('sha256').update(secret).digest();
  const out = new Array<string>(length);
  for (let i = 0; i < length; i++) {
    out[i] = PAIRING_ALPHABET[hash[i]! % PAIRING_ALPHABET.length]!;
  }
  return out.join('');
}

/**
 * In-memory registry of pending pairing codes. All transitions
 * (`generate` / `complete` / `expire`) are synchronous — the 32-byte
 * randomness is the only heavy primitive and it's non-blocking on
 * Node.
 */
export class PairingCodeRegistry {
  private readonly codes = new Map<string, PairingCodeRecord>();
  private readonly ttlMs: number;
  private readonly nowMsFn: () => number;
  private readonly randomBytesFn: (n: number) => Uint8Array;
  private readonly onEvent?: (event: PairingCodeEvent) => void;

  constructor(opts: PairingCodeOptions = {}) {
    const ttl = opts.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error(`PairingCodeRegistry: ttlMs must be > 0 (got ${ttl})`);
    }
    this.ttlMs = ttl;
    this.nowMsFn = opts.nowMsFn ?? Date.now;
    this.randomBytesFn = opts.randomBytesFn ?? defaultRandomBytes;
    this.onEvent = opts.onEvent;
  }

  /**
   * Generate a new pairing code. Returns `{code, secret, record}` so
   * the caller can display the short code + hand the raw secret to
   * `@dina/protocol`'s key-derivation step. Throws on cap exhaustion
   * or collision retries.
   */
  generate(): { code: string; secret: Uint8Array; record: PairingCodeRecord } {
    // Opportunistically sweep expired entries so the cap reflects
    // live-code pressure, not stale accumulation.
    this.sweepExpired();

    if (this.codes.size >= MAX_PENDING_CODES) {
      throw new PairingCodeError(
        'too_many_pending',
        `PairingCodeRegistry: too many pending codes (cap=${MAX_PENDING_CODES})`,
      );
    }

    for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt++) {
      const secret = this.randomBytesFn(PAIRING_SECRET_BYTES);
      if (secret.length !== PAIRING_SECRET_BYTES) {
        throw new Error(
          `PairingCodeRegistry: randomBytesFn returned ${secret.length} bytes, expected ${PAIRING_SECRET_BYTES}`,
        );
      }
      const code = deriveCode(secret);
      const existing = this.codes.get(code);
      if (existing !== undefined && !existing.used && !this.isExpired(existing)) {
        // Live collision — retry with a fresh secret.
        continue;
      }
      const now = this.nowMsFn();
      const record: PairingCodeRecord = {
        code,
        secret,
        createdAtMs: now,
        expiresAtMs: now + this.ttlMs,
        used: false,
      };
      this.codes.set(code, record);
      this.onEvent?.({
        kind: 'generated',
        code,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      });
      return { code, secret, record };
    }

    throw new PairingCodeError(
      'collision_retries_exhausted',
      `PairingCodeRegistry: failed to generate a unique code after ${CODE_COLLISION_RETRIES} attempts`,
    );
  }

  /**
   * Complete a pairing by code. Returns the stored record so the
   * caller can use the secret for key derivation. Throws:
   *   - `invalid_code` — unknown code
   *   - `code_used`    — already consumed (replay attempt)
   *   - `code_expired` — past TTL (auto-removed)
   */
  complete(code: string): PairingCodeRecord {
    const record = this.codes.get(code);
    if (record === undefined) {
      throw new PairingCodeError('invalid_code', `pairing code not found`);
    }
    if (record.used) {
      throw new PairingCodeError('code_used', `pairing code already consumed`);
    }
    if (this.isExpired(record)) {
      this.codes.delete(code);
      this.onEvent?.({ kind: 'expired', code, expiredAtMs: this.nowMsFn() });
      throw new PairingCodeError('code_expired', `pairing code expired`);
    }
    record.used = true;
    this.codes.delete(code);
    this.onEvent?.({ kind: 'consumed', code, consumedAtMs: this.nowMsFn() });
    return record;
  }

  /**
   * Remove expired codes. Returns the count removed. Idempotent —
   * calling twice in quick succession returns 0 on the second call.
   */
  sweepExpired(): number {
    const now = this.nowMsFn();
    let swept = 0;
    for (const [code, record] of this.codes) {
      if (!record.used && record.expiresAtMs <= now) {
        this.codes.delete(code);
        this.onEvent?.({ kind: 'expired', code, expiredAtMs: now });
        swept++;
      }
    }
    return swept;
  }

  /**
   * Check whether a code is currently live (exists, unused, unexpired).
   * Does NOT consume. Useful for `/v1/pair/initiate` probes or admin UI.
   */
  isLive(code: string): boolean {
    const record = this.codes.get(code);
    if (record === undefined || record.used) return false;
    return !this.isExpired(record);
  }

  /** Count of records currently tracked (live + used-but-not-yet-GC'd). */
  size(): number {
    return this.codes.size;
  }

  private isExpired(record: PairingCodeRecord): boolean {
    return record.expiresAtMs <= this.nowMsFn();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultRandomBytes(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}
