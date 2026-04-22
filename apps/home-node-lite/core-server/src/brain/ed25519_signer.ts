/**
 * Task 5.9 (half A) — Ed25519 signer primitive.
 *
 * Half of the signed-HTTP client (task 5.9): the crypto half. Takes
 * the 32-byte seed loaded by `loadServiceKey` (task 5.8) and produces
 * Ed25519 signatures over arbitrary bytes using **only** Node's
 * built-in `node:crypto`. No `@noble/ed25519`, no `tweetnacl`, no
 * libsodium bindings — zero native deps keeps the brain-server's
 * container image slim and ducks the "wrong architecture for your
 * prebuilt" failure mode entirely.
 *
 * **Why a dedicated primitive**: the signing step is the hottest path
 * in brain→core RPC + the hottest attack surface. Keeping it in its
 * own module means:
 *
 *   - The `CanonicalRequestSigner` impl (still to come) can focus on
 *     canonical-payload construction without sprouting crypto calls.
 *   - Tests can validate signature shape + round-trip verification
 *     without HTTP mocking.
 *   - A later swap to hardware-backed signing (HSM, secure enclave)
 *     replaces this one file; nothing else moves.
 *
 * **Seed → KeyObject**: Node's `createPrivateKey` accepts PKCS8 DER.
 * Ed25519 PKCS8 has a fixed 16-byte prefix (per RFC 8410):
 *
 *   `30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 || <seed>`
 *
 * We concatenate once at construction; every sign call reuses the
 * same KeyObject.
 *
 * **Output**: raw 64-byte signature (R || S). Base64 / hex encoding
 * is the caller's concern — the signer speaks bytes.
 *
 * **Public-key accessor**: the caller often wants the pub-key DID
 * or JWK for logging / validation. `publicKey()` returns a 32-byte
 * Uint8Array derived from the private key.
 *
 * **Mutation isolation**: the seed is copied into the PKCS8 buffer at
 * construction; the caller's original `Uint8Array` can be zeroised
 * without affecting the signer.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5b task 5.9.
 */

import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

export const ED25519_SEED_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;
export const ED25519_PUBLIC_KEY_BYTES = 32;

/** RFC 8410 PKCS8 prefix for Ed25519 private keys — precedes the raw 32-byte seed. */
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export interface Ed25519Signer {
  /** Produce a 64-byte Ed25519 signature over `message`. */
  sign(message: Uint8Array): Uint8Array;
  /** Return the 32-byte public key derived from the seed. */
  publicKey(): Uint8Array;
}

/**
 * Build a signer from a 32-byte seed. Throws on wrong length — the
 * caller (brain-server boot) catches and logs a fatal so the service
 * doesn't run with a bad key.
 */
export function createEd25519Signer(seed: Uint8Array): Ed25519Signer {
  if (!(seed instanceof Uint8Array)) {
    throw new TypeError('createEd25519Signer: seed must be a Uint8Array');
  }
  if (seed.byteLength !== ED25519_SEED_BYTES) {
    throw new RangeError(
      `createEd25519Signer: seed must be ${ED25519_SEED_BYTES} bytes, got ${seed.byteLength}`,
    );
  }
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.byteLength + seed.byteLength);
  pkcs8.set(ED25519_PKCS8_PREFIX, 0);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.byteLength);

  const privateKey: KeyObject = createPrivateKey({
    key: Buffer.from(pkcs8),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKeyObject: KeyObject = createPublicKey(privateKey);

  // Cache the raw public-key bytes via JWK export (`x` is base64url
  // of the 32-byte ed25519 pubkey per RFC 8037).
  const jwk = publicKeyObject.export({ format: 'jwk' }) as { x?: string };
  if (typeof jwk.x !== 'string') {
    throw new Error('createEd25519Signer: public-key JWK missing `x` component');
  }
  const rawPub = Buffer.from(jwk.x, 'base64url');
  if (rawPub.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error(
      `createEd25519Signer: derived public key is ${rawPub.byteLength} bytes, expected ${ED25519_PUBLIC_KEY_BYTES}`,
    );
  }
  const publicBytes = new Uint8Array(rawPub);

  return {
    sign(message: Uint8Array): Uint8Array {
      if (!(message instanceof Uint8Array)) {
        throw new TypeError('Ed25519Signer.sign: message must be a Uint8Array');
      }
      const sig = sign(null, Buffer.from(message), privateKey);
      return new Uint8Array(sig);
    },
    publicKey(): Uint8Array {
      // Return a copy so callers can't mutate our cached buffer.
      return new Uint8Array(publicBytes);
    },
  };
}

/**
 * Verify an Ed25519 signature against a public key. Pure helper —
 * intended for tests + for integrity checks on signatures the brain
 * receives (the reverse direction). Uses Node's built-in verify; no
 * external crypto dep.
 */
export function verifyEd25519(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (!(publicKey instanceof Uint8Array) || publicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
    return false;
  }
  if (!(message instanceof Uint8Array)) return false;
  if (!(signature instanceof Uint8Array) || signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    return false;
  }
  const publicKeyObject = createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(publicKey).toString('base64url'),
    },
    format: 'jwk',
  });
  try {
    return verify(null, Buffer.from(message), publicKeyObject, Buffer.from(signature));
  } catch {
    return false;
  }
}
