/**
 * Argon2id KEK derivation for seed wrapping.
 *
 * Parameters (IDENTICAL to server):
 *   memory:      64 MB (65536 KiB)
 *   iterations:  3
 *   parallelism: 4
 *   output:      32 bytes
 *
 * Backends:
 *   Node / WASM-capable browsers — `hash-wasm` (WebAssembly), ~200 ms
 *     at the params above. This is the DEFAULT path and what every
 *     test suite hits.
 *   React Native — `react-native-argon2` via `setKDFOverride` (see
 *     app/src/polyfills.ts). Native C binding; ~200 ms on-device.
 *     Required because RN has no WASM runtime; calling hash-wasm
 *     directly throws `WebAssembly is not supported in this
 *     environment`.
 *
 * The override mechanism lets us keep ONE code path here and pick the
 * right backend per platform without sprinkling platform guards
 * through Core.
 *
 * Source of truth: core/internal/adapter/crypto/argon2.go
 */

import { argon2id } from 'hash-wasm';

/**
 * Argon2id parameters — match the server-side Go config exactly.
 *
 * 128 MiB / t=3 / p=4 is server-equal so archives cross-verify between
 * Go (server) and TS (mobile) — downgrading mobile to weaker params
 * would silently produce archives the server cannot import. On a
 * modern phone with the native react-native-argon2 binding this
 * finishes in ~400 ms; hash-wasm in Node CI handles it in ~2 s.
 *
 * Source of truth: core/internal/adapter/crypto/argon2.go +
 * packages/test-harness/src/fixtures/constants.ts.
 */
export const ARGON2ID_PARAMS = {
  memorySize: 128 * 1024, // 131072 KiB = 128 MB
  iterations: 3,
  parallelism: 4,
  hashLength: 32,
} as const;

export interface Argon2idDerivationParams {
  /** Memory cost in KiB. */
  memory: number;
  /** Time cost (iterations). */
  iterations: number;
  /** Degree of parallelism (number of lanes). */
  parallelism: number;
}

/**
 * Pluggable KDF backend. Node + Jest don't register anything, so
 * `deriveKEK` falls through to the pure-JS Noble implementation below.
 * The React Native app registers a native Argon2 binding at startup
 * (see app/src/polyfills.ts) so unlock runs in ~200 ms instead of
 * tens of seconds.
 *
 * The override MUST be pure (no captured state) and return the raw
 * 32-byte KEK. Anything else is the caller's fault — we don't double-
 * check length before handing the KEK to AES-GCM.
 */
export type KDFBackend = (
  passphrase: string,
  salt: Uint8Array,
  params: Argon2idDerivationParams,
) => Promise<Uint8Array>;

let kdfOverride: KDFBackend | null = null;

/** Install a native KDF backend. Pass `null` to revert to the JS impl. */
export function setKDFOverride(fn: KDFBackend | null): void {
  kdfOverride = fn;
}

/** For tests: snapshot the current override (nullable). */
export function getKDFOverride(): KDFBackend | null {
  return kdfOverride;
}

/**
 * Derive a 32-byte Key Encryption Key from a passphrase using Argon2id.
 *
 * When `params` is omitted, uses the current module defaults. Unwrap
 * callers MUST pass the params stored on the WrappedSeed so a record
 * wrapped under a prior default (e.g. older 128 MB params) still
 * decrypts after we tune the defaults down — see aesgcm.unwrapSeed.
 *
 * @param passphrase - User's passphrase
 * @param salt - 16-byte random salt
 * @param params - Optional override for memory/iters/parallelism
 * @returns 32-byte KEK for AES-256-GCM seed wrapping
 */
export async function deriveKEK(
  passphrase: string,
  salt: Uint8Array,
  params?: Argon2idDerivationParams,
): Promise<Uint8Array> {
  if (!passphrase || passphrase.length === 0) {
    throw new Error('argon2id: empty passphrase');
  }
  if (!salt || salt.length < 8) {
    throw new Error('argon2id: salt must be at least 8 bytes');
  }

  const effectiveParams: Argon2idDerivationParams = {
    memory: params?.memory ?? ARGON2ID_PARAMS.memorySize,
    iterations: params?.iterations ?? ARGON2ID_PARAMS.iterations,
    parallelism: params?.parallelism ?? ARGON2ID_PARAMS.parallelism,
  };

  // Platform override (RN → native Argon2 binding via setKDFOverride).
  // Falls through to hash-wasm on Node / WASM-capable browsers.
  if (kdfOverride !== null) {
    return kdfOverride(passphrase, salt, effectiveParams);
  }

  return argon2id({
    password: passphrase,
    salt,
    iterations: effectiveParams.iterations,
    memorySize: effectiveParams.memory,
    parallelism: effectiveParams.parallelism,
    hashLength: ARGON2ID_PARAMS.hashLength,
    outputType: 'binary',
  });
}
