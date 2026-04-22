/**
 * NaCl crypto_box_seal and Ed25519↔X25519 key conversion.
 *
 * Used for D2D message encryption (anonymous sender, authenticated recipient).
 *
 * Sealed box protocol (libsodium-compatible):
 *   seal:   eph_pk || crypto_box(m, sha512(eph_pk||pk)[:24], pk, eph_sk)
 *   unseal: extract eph_pk, recompute nonce, crypto_box_open(ct, nonce, eph_pk, sk)
 *
 * Uses @noble ecosystem exclusively:
 *   - @noble/curves/ed25519 (x25519 DH)
 *   - @noble/ciphers/salsa (xsalsa20poly1305, hsalsa)
 *   - @noble/hashes/blake2 (nonce derivation)
 *   - @noble/hashes/sha2 (Ed25519→X25519 private key conversion)
 *
 * Source of truth: core/internal/adapter/crypto/nacl.go
 */

import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { xsalsa20poly1305, hsalsa } from '@noble/ciphers/salsa.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { NACL_EPHEMERAL_KEY_BYTES, NACL_TAG_BYTES, ED25519_PUBLIC_KEY_BYTES } from '../constants';

/** Overhead added by sealed box: ephemeral public key + Poly1305 tag. */
const SEAL_OVERHEAD = NACL_EPHEMERAL_KEY_BYTES + NACL_TAG_BYTES;

/**
 * Compute the NaCl crypto_box shared key from a raw X25519 shared secret.
 *
 * Equivalent to libsodium's crypto_box_beforenm: HSalsa20(shared, zeros).
 */
function cryptoBoxBeforenm(sharedSecret: Uint8Array): Uint8Array {
  const k = new Uint32Array(8);
  const dv = new DataView(sharedSecret.buffer, sharedSecret.byteOffset, 32);
  for (let i = 0; i < 8; i++) k[i] = dv.getUint32(i * 4, true);

  const sigma = new Uint32Array(4); // 16 zero bytes — Dina-Go custom
  const out = new Uint32Array(8);
  const state = new Uint32Array(16);

  hsalsa(state, k, sigma, out);

  const result = new Uint8Array(32);
  const rdv = new DataView(result.buffer);
  for (let i = 0; i < 8; i++) rdv.setUint32(i * 4, out[i], true);
  return result;
}

/**
 * libsodium-compatible `crypto_box_beforenm` — HSalsa20 with the
 * standard σ ("expand 32-byte k") constant. Required to decrypt
 * ciphertexts from `nacl.public.SealedBox` (dina-cli, PyNaCl,
 * libsodium). See the comment on `sealDecryptWithScheme` for why
 * mobile also carries a `'sha512'` variant (Dina Go Core custom).
 *
 * σ bytes: b'expand 32-byte k' as 4 little-endian uint32s.
 */
function cryptoBoxBeforenmStd(sharedSecret: Uint8Array): Uint8Array {
  const k = new Uint32Array(8);
  const dv = new DataView(sharedSecret.buffer, sharedSecret.byteOffset, 32);
  for (let i = 0; i < 8; i++) k[i] = dv.getUint32(i * 4, true);

  // σ = "expand 32-byte k" — salsa20's standard initial constants.
  const sigma = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  const nonce = new Uint32Array(4); // 16-byte zero nonce
  const out = new Uint32Array(8);

  hsalsa(sigma, k, nonce, out);

  const result = new Uint8Array(32);
  const rdv = new DataView(result.buffer);
  for (let i = 0; i < 8; i++) rdv.setUint32(i * 4, out[i], true);
  return result;
}

/**
 * Derive the sealed box nonce: SHA-512(eph_pub || recipient_pub) truncated to 24 bytes.
 *
 * Matches Go's custom Dina nonce derivation (NOT libsodium's BLAKE2b).
 * Go: SHA-512(ephPub||recipientPub)[:24]
 * libsodium standard: BLAKE2b(ephPub||recipientPub, outlen=24)
 *
 * Using SHA-512 ensures D2D messages between Go and TypeScript interoperate.
 */
function sealNonce(ephPub: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  const data = new Uint8Array(64);
  data.set(ephPub, 0);
  data.set(recipientPub, 32);
  return sha512(data).slice(0, 24);
}

/**
 * Alternate sealed-box nonce: libsodium's standard `crypto_box_seal`
 * uses `BLAKE2b(ephPub || recipientPub, outlen=24)`. Python dina-cli
 * encrypts via `nacl.public.SealedBox` which goes through this path.
 * Mobile's `sealDecrypt` tries SHA-512 first (Go interop) and falls
 * back to this form so CLI-sourced ciphertexts decrypt correctly.
 */
function sealNonceBlake2(ephPub: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  const data = new Uint8Array(64);
  data.set(ephPub, 0);
  data.set(recipientPub, 32);
  return blake2b(data, { dkLen: 24 });
}

/**
 * Encrypt with NaCl crypto_box_seal (anonymous sender).
 *
 * The sender generates an ephemeral X25519 keypair, so the recipient
 * cannot identify who sent the message — only that it was meant for them.
 *
 * @param plaintext - Message to encrypt
 * @param recipientEd25519Pub - Recipient's Ed25519 public key (32 bytes)
 * @returns Sealed box: eph_pub (32) || ciphertext || Poly1305 tag (16)
 */
export function sealEncrypt(
  plaintext: Uint8Array,
  recipientEd25519Pub: Uint8Array,
  // Default to libsodium-standard BLAKE2b sealed-box format so outbound
  // messages decrypt cleanly on Go Home Nodes — they use
  // `crypto_box_seal_open` (via libsodium's `OpenAnonymous`) which
  // expects BLAKE2b nonce + standard beforenm. The earlier default
  // `'sha512'` produced envelopes Go silently rejected with
  // "transport: decrypt inbound: nacl: decryption failed", which was
  // the last mile blocker in the iOS → docker D2D smoke. `'sha512'` is
  // kept as an opt-in for paths that specifically talk to TS peers
  // using the Dina-Go-internal scheme.
  scheme: 'sha512' | 'blake2b' = 'blake2b',
): Uint8Array {
  if (!recipientEd25519Pub || recipientEd25519Pub.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error('nacl: recipient public key must be 32 bytes');
  }

  // Convert Ed25519 public key → X25519
  const recipientX25519Pub = ed25519PubToX25519(recipientEd25519Pub);

  // Generate ephemeral X25519 keypair
  const ephPriv = randomBytes(32);
  const ephPub = x25519.getPublicKey(ephPriv);

  // Derive nonce + box-key scheme matching the caller's preference.
  // SHA-512 + zero-σ beforenm (Dina-Go custom) for Go Core interop;
  // BLAKE2b + "expand 32-byte k" beforenm (libsodium standard) for
  // dina-cli / PyNaCl.
  const shared = x25519.getSharedSecret(ephPriv, recipientX25519Pub);
  const nonce =
    scheme === 'blake2b'
      ? sealNonceBlake2(ephPub, recipientX25519Pub)
      : sealNonce(ephPub, recipientX25519Pub);
  const boxKey = scheme === 'blake2b' ? cryptoBoxBeforenmStd(shared) : cryptoBoxBeforenm(shared);

  // Encrypt
  const ciphertext = xsalsa20poly1305(boxKey, nonce).encrypt(plaintext);

  // sealed = eph_pub || ciphertext (includes Poly1305 tag)
  const sealed = new Uint8Array(32 + ciphertext.length);
  sealed.set(ephPub, 0);
  sealed.set(ciphertext, 32);
  return sealed;
}

/**
 * Decrypt with NaCl crypto_box_seal_open.
 *
 * @param ciphertext - Sealed box (eph_pub || encrypted || tag)
 * @param recipientEd25519Pub - Recipient's Ed25519 public key (32 bytes)
 * @param recipientEd25519Priv - Recipient's Ed25519 private key/seed (32 bytes)
 * @returns Decrypted plaintext
 * @throws if authentication fails (wrong key or corrupted)
 */
export function sealDecrypt(
  ciphertext: Uint8Array,
  recipientEd25519Pub: Uint8Array,
  recipientEd25519Priv: Uint8Array,
): Uint8Array {
  if (!ciphertext || ciphertext.length < SEAL_OVERHEAD) {
    throw new Error(`nacl: ciphertext too short (need at least ${SEAL_OVERHEAD} bytes)`);
  }
  if (!recipientEd25519Pub || recipientEd25519Pub.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error('nacl: recipient public key must be 32 bytes');
  }
  if (!recipientEd25519Priv || recipientEd25519Priv.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error('nacl: recipient private key must be 32 bytes');
  }

  // Convert keys
  const recipientX25519Pub = ed25519PubToX25519(recipientEd25519Pub);
  const recipientX25519Priv = ed25519SecToX25519(recipientEd25519Priv);

  // Extract ephemeral public key and encrypted data
  const ephPub = ciphertext.slice(0, 32);
  const encrypted = ciphertext.slice(32);

  // Derive shared key (same regardless of nonce scheme).
  const shared = x25519.getSharedSecret(recipientX25519Priv, ephPub);
  const boxKeyGo = cryptoBoxBeforenm(shared);
  const boxKeyStd = cryptoBoxBeforenmStd(shared);

  // Try SHA-512 nonce + Dina-Go crypto_box_beforenm first (matches Go
  // Core + mobile sealEncrypt). Fall back to BLAKE2b nonce + libsodium
  // crypto_box_beforenm (what `nacl.public.SealedBox` / dina-cli
  // sends).
  try {
    return xsalsa20poly1305(boxKeyGo, sealNonce(ephPub, recipientX25519Pub)).decrypt(encrypted);
  } catch {
    /* try BLAKE2b next */
  }
  try {
    return xsalsa20poly1305(boxKeyStd, sealNonceBlake2(ephPub, recipientX25519Pub)).decrypt(
      encrypted,
    );
  } catch {
    throw new Error('nacl: decryption failed — wrong key or corrupted ciphertext');
  }
}

/**
 * Decrypt + report which nonce scheme succeeded. Callers use this to
 * mirror the scheme when encrypting a reply — otherwise a BLAKE2b-
 * encrypting counterparty (dina-cli) can't decode an SHA-512-encrypted
 * response.
 */
export function sealDecryptWithScheme(
  ciphertext: Uint8Array,
  recipientEd25519Pub: Uint8Array,
  recipientEd25519Priv: Uint8Array,
): { plaintext: Uint8Array; scheme: 'sha512' | 'blake2b' } {
  if (!ciphertext || ciphertext.length < SEAL_OVERHEAD) {
    throw new Error(`nacl: ciphertext too short (need at least ${SEAL_OVERHEAD} bytes)`);
  }
  const recipientX25519Pub = ed25519PubToX25519(recipientEd25519Pub);
  const recipientX25519Priv = ed25519SecToX25519(recipientEd25519Priv);
  const ephPub = ciphertext.slice(0, 32);
  const encrypted = ciphertext.slice(32);
  const shared = x25519.getSharedSecret(recipientX25519Priv, ephPub);
  // SHA-512 path: Dina-Go custom crypto_box_beforenm (zero σ).
  const boxKeyGo = cryptoBoxBeforenm(shared);
  // BLAKE2b path: libsodium-standard crypto_box_beforenm ("expand 32-byte k" σ).
  const boxKeyStd = cryptoBoxBeforenmStd(shared);
  try {
    const plaintext = xsalsa20poly1305(boxKeyGo, sealNonce(ephPub, recipientX25519Pub)).decrypt(
      encrypted,
    );
    return { plaintext, scheme: 'sha512' };
  } catch {
    /* try BLAKE2b */
  }
  try {
    const plaintext = xsalsa20poly1305(
      boxKeyStd,
      sealNonceBlake2(ephPub, recipientX25519Pub),
    ).decrypt(encrypted);
    return { plaintext, scheme: 'blake2b' };
  } catch {
    throw new Error('nacl: decryption failed — wrong key or corrupted ciphertext');
  }
}

/**
 * Convert Ed25519 public key to X25519 (Curve25519) public key.
 *
 * Edwards → Montgomery point conversion: u = (1 + y) / (1 - y) mod p
 * where y is the affine y-coordinate of the Ed25519 point.
 */
export function ed25519PubToX25519(ed25519Pub: Uint8Array): Uint8Array {
  if (!ed25519Pub || ed25519Pub.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error('nacl: Ed25519 public key must be 32 bytes');
  }

  const Point = ed25519.Point;
  const Fp = Point.Fp;

  // Decode the compressed Edwards point
  const point = Point.fromHex(bytesToHex(ed25519Pub));

  // Get affine y coordinate: Y / Z mod p
  const y = Fp.div(point.Y, point.Z);

  // Montgomery u = (1 + y) / (1 - y) mod p
  const u = Fp.div(Fp.add(1n, y), Fp.sub(1n, y));

  // Encode as 32 bytes little-endian
  const bytes = new Uint8Array(32);
  let val = u;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return bytes;
}

/**
 * Convert Ed25519 private key (seed) to X25519 private key (scalar).
 *
 * Standard conversion (same as libsodium crypto_sign_ed25519_sk_to_curve25519):
 * SHA-512(ed25519_seed)[0:32] with clamping.
 */
export function ed25519SecToX25519(ed25519Sec: Uint8Array): Uint8Array {
  if (!ed25519Sec || ed25519Sec.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error('nacl: Ed25519 private key must be 32 bytes');
  }

  const h = sha512(ed25519Sec);
  const scalar = h.slice(0, 32);

  // Clamp (RFC 7748 / X25519 scalar format). `scalar` is a 32-byte
  // slice of the sha512 digest — indices 0 and 31 are always present;
  // assertions are required under noUncheckedIndexedAccess.
  scalar[0] = (scalar[0]! & 248);
  scalar[31] = (scalar[31]! & 127) | 64;

  return scalar;
}
