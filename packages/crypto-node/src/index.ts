/**
 * `@dina/crypto-node` — crypto-primitive adapter for the Node build target.
 *
 * Phase 3b task roadmap:
 *   - 3.20 ✅ Scaffold + port interfaces
 *   - 3.21 ✅ Ed25519: sign, verify, SLIP-0010 derivePath
 *   - 3.22 ✅ X25519: fromEd25519Public/Private, scalarMult
 *   - 3.23 ✅ Secp256k1: SLIP-0010/BIP-32 derivePath, sign, verify
 *   - 3.24 ✅ SHA-256, BLAKE2b
 *   - 3.25 ✅ HKDF-SHA256
 *   - 3.26 ✅ NaCl sealed-box (libsodium-wrappers)
 *   - 3.27 ✅ Argon2id (argon2 native npm)
 *   - 3.28 ✅ randomBytes
 *
 * **Method naming convention.** Each port's methods are prefixed with
 * the primitive name (`ed25519Sign`, `x25519ScalarMult`, etc.) rather
 * than plain `sign` / `scalarMult`. This lets the aggregate
 * `CryptoAdapterNode` implement every port without collisions (two
 * ports might legitimately want a method called `derivePath`, for
 * instance). Consumers typed against a specific port see the prefix
 * as light redundancy; consumers typed against the aggregate see it
 * as disambiguation.
 *
 * **Byte-parity with `@dina/core/src/crypto/*`.** Every primitive here
 * delegates to the same `@noble/*` libraries `@dina/core` already
 * uses — Ed25519 seed→pubkey, SLIP-0010 derivation, sign/verify all
 * produce byte-identical output across the two code paths. This is
 * the whole point of the pure-JS choice: one reference impl across
 * pure core and Node adapter.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 3b.
 */

import * as ed from '@noble/ed25519';
import { sha256 as nobleSha256, sha512 } from '@noble/hashes/sha2.js';
import { blake2b as nobleBlake2b } from '@noble/hashes/blake2.js';
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { ed25519 as ed25519Curve, x25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { randomBytes as nodeRandomBytes } from 'node:crypto';

// Configure @noble/ed25519 v3+'s sync SHA-512 the same way @dina/core
// does. Without this, `ed.sign` / `ed.getPublicKey` throw at runtime
// because SHA-512 is a required prerequisite and v3+ doesn't bundle
// it by default. Must happen at module load, before any sign/verify
// call hits it.
const edHashes = ed.hashes as { sha512?: (...msgs: Uint8Array[]) => Uint8Array };
if (!edHashes.sha512) {
  edHashes.sha512 = (...msgs: Uint8Array[]) => {
    const h = sha512.create();
    for (const m of msgs) h.update(m);
    return h.digest();
  };
}

// ---------------------------------------------------------------------------
// Port interfaces
// ---------------------------------------------------------------------------

/** A derived key result from SLIP-0010 / BIP-32 style HDKD. */
export interface DerivedKey {
  /** 32-byte Ed25519 or 33-byte secp256k1-compressed public key. */
  publicKey: Uint8Array;
  /** 32-byte private key / seed. */
  privateKey: Uint8Array;
  /** 32-byte chain code (used by child derivation; callers can ignore). */
  chainCode: Uint8Array;
}

export interface Ed25519Port {
  /**
   * SLIP-0010 derive an Ed25519 keypair at a hardened-only path.
   * Example path: `m/9999'/0'/0'`. Matches `@dina/core`'s
   * `derivePath(seed, path)` byte-for-byte.
   */
  ed25519DerivePath(seed: Uint8Array, path: string): Promise<DerivedKey>;
  /** Sign `message` with `privateKey` (32 bytes). Returns 64-byte sig. */
  ed25519Sign(privateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array>;
  /** Verify `signature` over `message` against `publicKey`. Fail-closed
   *  on malformed inputs (returns false rather than throwing). */
  ed25519Verify(
    publicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean>;
}

export interface X25519Port {
  /** Convert an Ed25519 public key (32 bytes) to its X25519 equivalent. */
  x25519FromEd25519Public(edPubKey: Uint8Array): Promise<Uint8Array>;
  /** Convert an Ed25519 private key (32-byte seed) to its X25519 equivalent. */
  x25519FromEd25519Private(edPrivKey: Uint8Array): Promise<Uint8Array>;
  /**
   * X25519 scalar multiplication (ECDH). `scalar` is an X25519 private
   * key, `point` is an X25519 public key. Returns the shared secret
   * (32 bytes).
   */
  x25519ScalarMult(scalar: Uint8Array, point: Uint8Array): Promise<Uint8Array>;
}

export interface Secp256k1Port {
  /** SLIP-0010/BIP-32 derive a secp256k1 keypair at a hardened path.
   *  Used for did:plc rotation keys. */
  secp256k1DerivePath(seed: Uint8Array, path: string): Promise<DerivedKey>;
  secp256k1Sign(privateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array>;
  secp256k1Verify(
    publicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean>;
}

export interface HashPort {
  sha256(data: Uint8Array): Promise<Uint8Array>;
  blake2b(data: Uint8Array, outLen: number): Promise<Uint8Array>;
}

export interface HKDFPort {
  hkdfSha256(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    outLen: number,
  ): Promise<Uint8Array>;
}

export interface SealedBoxPort {
  sealedBoxSeal(message: Uint8Array, recipientEd25519Pub: Uint8Array): Promise<Uint8Array>;
  sealedBoxOpen(
    sealed: Uint8Array,
    recipientEd25519Pub: Uint8Array,
    recipientEd25519Priv: Uint8Array,
  ): Promise<Uint8Array>;
}

export interface ArgonPort {
  argon2idHash(
    password: Uint8Array,
    salt: Uint8Array,
    outLen: number,
    params?: { timeCost?: number; memoryCost?: number; parallelism?: number },
  ): Promise<Uint8Array>;
}

export interface RandomPort {
  randomBytes(count: number): Promise<Uint8Array>;
}

export interface CryptoAdapterNode
  extends Ed25519Port,
    X25519Port,
    Secp256k1Port,
    HashPort,
    HKDFPort,
    SealedBoxPort,
    ArgonPort,
    RandomPort {}

// ---------------------------------------------------------------------------
// SLIP-0010 internals — mirrors @dina/core/src/crypto/slip0010.ts byte-for-byte
// so this adapter and pure core produce identical derived keys.
// ---------------------------------------------------------------------------

const HARDENED_OFFSET = 0x80000000;

function validateSeed(seed: Uint8Array): void {
  if (!seed || seed.length === 0) throw new Error('slip0010: empty seed');
  if (seed.length < 16) {
    throw new Error(`slip0010: seed too short (${seed.length} bytes, need >= 16)`);
  }
  let allZero = true;
  for (let i = 0; i < seed.length; i++) {
    if (seed[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) throw new Error('slip0010: all-zero seed rejected (fail-closed)');
}

function parsePath(path: string): number[] {
  if (!path || !path.startsWith('m/')) {
    throw new Error(`slip0010: invalid path format — must start with "m/", got "${path}"`);
  }
  const segments = path
    .slice(2)
    .split('/')
    .filter((s) => s.length > 0);
  if (segments.length === 0) throw new Error('slip0010: path has no segments after "m/"');
  const indices: number[] = [];
  for (const seg of segments) {
    if (!seg.endsWith("'")) {
      throw new Error(
        `slip0010: non-hardened index "${seg}" — Dina requires hardened-only derivation`,
      );
    }
    const n = parseInt(seg.slice(0, -1), 10);
    if (isNaN(n) || n < 0) {
      throw new Error(`slip0010: invalid index "${seg}" — must be a non-negative integer`);
    }
    indices.push(n + HARDENED_OFFSET);
  }
  if (indices[0] === 44 + HARDENED_OFFSET) {
    throw new Error("slip0010: BIP-44 purpose 44' is forbidden in Dina");
  }
  return indices;
}

function deriveMasterEd25519(seed: Uint8Array): { key: Uint8Array; chainCode: Uint8Array } {
  const I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32, 64) };
}

function deriveChildEd25519(
  parentKey: Uint8Array,
  parentChainCode: Uint8Array,
  index: number,
): { key: Uint8Array; chainCode: Uint8Array } {
  const data = new Uint8Array(1 + 32 + 4);
  data[0] = 0x00;
  data.set(parentKey, 1);
  data[33] = (index >>> 24) & 0xff;
  data[34] = (index >>> 16) & 0xff;
  data[35] = (index >>> 8) & 0xff;
  data[36] = index & 0xff;
  const I = hmac(sha512, parentChainCode, data);
  return { key: I.slice(0, 32), chainCode: I.slice(32, 64) };
}

const SECP256K1_ORDER = secp256k1.Point.Fn.ORDER;

function deriveMasterSecp256k1(seed: Uint8Array): { key: Uint8Array; chainCode: Uint8Array } {
  const I = hmac(sha512, new TextEncoder().encode('Bitcoin seed'), seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32, 64) };
}

/**
 * Derive a hardened child key (secp256k1 / BIP-32 mode:
 * child key = (IL + kpar) mod n). Mirrors core's impl byte-for-byte.
 */
function deriveChildSecp256k1(
  parentKey: Uint8Array,
  parentChainCode: Uint8Array,
  index: number,
): { key: Uint8Array; chainCode: Uint8Array } {
  const data = new Uint8Array(1 + 32 + 4);
  data[0] = 0x00;
  data.set(parentKey, 1);
  data[33] = (index >>> 24) & 0xff;
  data[34] = (index >>> 16) & 0xff;
  data[35] = (index >>> 8) & 0xff;
  data[36] = index & 0xff;
  const I = hmac(sha512, parentChainCode, data);
  const IL = I.slice(0, 32);
  const IR = I.slice(32, 64);

  // BIP-32: child key = (parse256(IL) + kpar) mod n
  const ilBigInt = BigInt('0x' + bytesToHex(IL));
  if (ilBigInt >= SECP256K1_ORDER) {
    throw new Error('slip0010: IL >= curve order — invalid child key (extremely unlikely)');
  }
  const keyBigInt = BigInt('0x' + bytesToHex(parentKey));
  const childKeyBigInt = (ilBigInt + keyBigInt) % SECP256K1_ORDER;
  if (childKeyBigInt === 0n) {
    throw new Error('slip0010: child key is zero — invalid (extremely unlikely)');
  }
  const hexStr = childKeyBigInt.toString(16).padStart(64, '0');
  return { key: hexToBytes(hexStr), chainCode: IR };
}

// ---------------------------------------------------------------------------
// libsodium loader — `libsodium-wrappers` is WASM and ships a one-time
// async init. We cache the `ready` promise so every call after the
// first resolves immediately without re-entering sodium's init path.
// ---------------------------------------------------------------------------

type SodiumModule = {
  ready: Promise<void>;
  crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  crypto_box_seal_open(
    cipher: Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
  ): Uint8Array;
};

let sodiumInstance: SodiumModule | undefined;
let sodiumPromise: Promise<SodiumModule> | undefined;

async function loadSodium(): Promise<SodiumModule> {
  if (sodiumInstance) return sodiumInstance;
  if (!sodiumPromise) {
    sodiumPromise = (async () => {
      const mod = (await import('libsodium-wrappers')) as {
        default?: SodiumModule;
      } & Partial<SodiumModule>;
      const sodium = (mod.default ?? (mod as unknown as SodiumModule)) as SodiumModule;
      await sodium.ready;
      sodiumInstance = sodium;
      return sodium;
    })();
  }
  return sodiumPromise;
}

// ---------------------------------------------------------------------------
// argon2 loader — the native `argon2` npm is CJS; some runtimes deliver
// it as `{ default: {...} }`, others as the module shape directly. Cache
// the resolved shape so we don't re-dispatch on every hash call.
// ---------------------------------------------------------------------------

interface Argon2Module {
  argon2id: number;
  hash(
    password: Buffer | string,
    options: {
      type: number;
      salt: Buffer;
      hashLength: number;
      timeCost: number;
      memoryCost: number;
      parallelism: number;
      raw: true;
    },
  ): Promise<Buffer>;
}

let argon2Instance: Argon2Module | undefined;

/**
 * OWASP 2024 second-tier Argon2id profile — matches `@dina/core`'s
 * vault passphrase KDF. Exported so callers (tests, crypto-expo) can
 * reference the same canonical cost parameters without duplicating
 * magic numbers.
 */
export const ARGON2_OWASP_DEFAULTS: Readonly<{
  timeCost: number;
  memoryCost: number;
  parallelism: number;
}> = Object.freeze({
  timeCost: 2,
  memoryCost: 19 * 1024, // 19 MiB
  parallelism: 1,
});

async function loadArgon2(): Promise<Argon2Module> {
  if (argon2Instance) return argon2Instance;
  const mod = (await import('argon2')) as { default?: Argon2Module } & Partial<Argon2Module>;
  argon2Instance = (mod.default ?? (mod as unknown as Argon2Module)) as Argon2Module;
  return argon2Instance;
}

// ---------------------------------------------------------------------------
// NodeCryptoAdapter — real impls for tasks 3.21–3.28.
// ---------------------------------------------------------------------------

export class NodeCryptoAdapter implements CryptoAdapterNode {
  // ─── Ed25519 (task 3.21) ────────────────────────────────────────────────

  async ed25519DerivePath(seed: Uint8Array, path: string): Promise<DerivedKey> {
    validateSeed(seed);
    const indices = parsePath(path);
    let { key, chainCode } = deriveMasterEd25519(seed);
    for (const index of indices) {
      const child = deriveChildEd25519(key, chainCode, index);
      key = child.key;
      chainCode = child.chainCode;
    }
    const publicKey = ed.getPublicKey(key);
    return { privateKey: key, publicKey, chainCode };
  }

  async ed25519Sign(privateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
    return ed.sign(message, privateKey);
  }

  async ed25519Verify(
    publicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean> {
    try {
      return ed.verify(signature, message, publicKey);
    } catch {
      // @noble/ed25519 throws on malformed inputs (wrong-length keys,
      // non-canonical signature encoding, etc.); contract is "return
      // false, don't crash" so callers don't need to try/catch.
      return false;
    }
  }

  // ─── X25519 (task 3.22) ─────────────────────────────────────────────────

  async x25519FromEd25519Public(edPubKey: Uint8Array): Promise<Uint8Array> {
    return ed25519Curve.utils.toMontgomery(edPubKey);
  }

  async x25519FromEd25519Private(edPrivKey: Uint8Array): Promise<Uint8Array> {
    return ed25519Curve.utils.toMontgomerySecret(edPrivKey);
  }

  async x25519ScalarMult(scalar: Uint8Array, point: Uint8Array): Promise<Uint8Array> {
    // `getSharedSecret(scalar, point)` is @noble/curves v2's ECDH
    // primitive — same as classic X25519 scalarMult, clamped.
    return x25519.getSharedSecret(scalar, point);
  }

  // ─── Scaffold stubs for 3.23+ ───────────────────────────────────────────

  // ─── secp256k1 (task 3.23) ──────────────────────────────────────────────

  async secp256k1DerivePath(seed: Uint8Array, path: string): Promise<DerivedKey> {
    validateSeed(seed);
    const indices = parsePath(path);
    let { key, chainCode } = deriveMasterSecp256k1(seed);
    for (const index of indices) {
      const child = deriveChildSecp256k1(key, chainCode, index);
      key = child.key;
      chainCode = child.chainCode;
    }
    // Compressed (33-byte) public key — matches core's convention.
    const publicKey = secp256k1.getPublicKey(key, true);
    return { privateKey: key, publicKey, chainCode };
  }

  async secp256k1Sign(privateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
    // @noble/curves v2's `secp256k1.sign(msg, secretKey)` prehashes
    // with SHA-256 by default (matches Bitcoin / did:plc rotation
    // convention). Returns 64-byte compact signature (r || s).
    return secp256k1.sign(message, privateKey);
  }

  async secp256k1Verify(
    publicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean> {
    try {
      return secp256k1.verify(signature, message, publicKey);
    } catch {
      // Fail-closed on malformed inputs (wrong-length keys/sig,
      // non-canonical encoding) — matches Ed25519's pattern.
      return false;
    }
  }

  // ─── Hashes (task 3.24) ─────────────────────────────────────────────────

  async sha256(data: Uint8Array): Promise<Uint8Array> {
    return nobleSha256(data);
  }

  async blake2b(data: Uint8Array, outLen: number): Promise<Uint8Array> {
    // libsodium-compatible: `dkLen` controls the output length.
    // Dina uses blake2b(24) for NaCl sealed-box nonce derivation —
    // must match libsodium's convention (catches the Go-only
    // sha512-truncated-to-24 bug fixed in core PR #9; see CLAUDE.md).
    if (outLen < 1 || outLen > 64) {
      throw new Error(`crypto-node: blake2b outLen must be 1..64 bytes, got ${outLen}`);
    }
    return nobleBlake2b(data, { dkLen: outLen });
  }

  // ─── HKDF (task 3.25) ───────────────────────────────────────────────────

  async hkdfSha256(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    outLen: number,
  ): Promise<Uint8Array> {
    // RFC 5869: extract-then-expand. @noble/hashes's `hkdf(hash, ikm,
    // salt, info, length)` wraps both steps.
    if (outLen < 1) {
      throw new Error(`crypto-node: hkdfSha256 outLen must be >= 1, got ${outLen}`);
    }
    // RFC 5869 caps output at 255 * hashLen (= 255 * 32 = 8160 for SHA-256).
    if (outLen > 8160) {
      throw new Error(
        `crypto-node: hkdfSha256 outLen exceeds RFC 5869 cap (255 * 32 = 8160), got ${outLen}`,
      );
    }
    return nobleHkdf(nobleSha256, ikm, salt, info, outLen);
  }

  // ─── NaCl sealed-box (task 3.26) ────────────────────────────────────────
  //
  // Accepts Ed25519 keys at the port boundary (Dina's canonical identity
  // shape) and internally converts to X25519 for libsodium. This is the
  // same shape @dina/core exposes, so any encrypted-envelope flow that
  // currently calls into core's NaCl bridge can swap in this adapter
  // with no caller changes.
  //
  // libsodium's nonce derivation is `BLAKE2b(24, ephemeral_pk || recipient_pk)`
  // (see CLAUDE.md: "Sealed-box nonce = BLAKE2b(24). NOT SHA-512."). We
  // delegate entirely to libsodium so that invariant is enforced by the
  // reference C impl, not re-derived by hand.

  async sealedBoxSeal(
    message: Uint8Array,
    recipientEd25519Pub: Uint8Array,
  ): Promise<Uint8Array> {
    if (recipientEd25519Pub.length !== 32) {
      throw new Error(
        `crypto-node: sealedBoxSeal recipient pubkey must be 32 bytes, got ${recipientEd25519Pub.length}`,
      );
    }
    const sodium = await loadSodium();
    const xpub = ed25519Curve.utils.toMontgomery(recipientEd25519Pub);
    return sodium.crypto_box_seal(message, xpub);
  }

  async sealedBoxOpen(
    sealed: Uint8Array,
    recipientEd25519Pub: Uint8Array,
    recipientEd25519Priv: Uint8Array,
  ): Promise<Uint8Array> {
    if (recipientEd25519Pub.length !== 32) {
      throw new Error(
        `crypto-node: sealedBoxOpen recipient pubkey must be 32 bytes, got ${recipientEd25519Pub.length}`,
      );
    }
    if (recipientEd25519Priv.length !== 32) {
      throw new Error(
        `crypto-node: sealedBoxOpen recipient privkey must be 32 bytes, got ${recipientEd25519Priv.length}`,
      );
    }
    const sodium = await loadSodium();
    const xpub = ed25519Curve.utils.toMontgomery(recipientEd25519Pub);
    const xpriv = ed25519Curve.utils.toMontgomerySecret(recipientEd25519Priv);
    return sodium.crypto_box_seal_open(sealed, xpub, xpriv);
  }

  // ─── Argon2id (task 3.27) ───────────────────────────────────────────────
  //
  // Defaults match OWASP 2024's second-tier profile (m=19 MiB, t=2, p=1),
  // the same profile @dina/core uses for vault passphrase derivation.
  // Callers that need a different cost (e.g. mobile UX) pass `params`.

  async argon2idHash(
    password: Uint8Array,
    salt: Uint8Array,
    outLen: number,
    params?: { timeCost?: number; memoryCost?: number; parallelism?: number },
  ): Promise<Uint8Array> {
    if (!Number.isInteger(outLen) || outLen < 4 || outLen > 1024) {
      throw new Error(`crypto-node: argon2idHash outLen must be 4..1024 bytes, got ${outLen}`);
    }
    if (salt.length < 8) {
      throw new Error(
        `crypto-node: argon2idHash salt must be at least 8 bytes (RFC 9106), got ${salt.length}`,
      );
    }
    const timeCost = params?.timeCost ?? ARGON2_OWASP_DEFAULTS.timeCost;
    const memoryCost = params?.memoryCost ?? ARGON2_OWASP_DEFAULTS.memoryCost;
    const parallelism = params?.parallelism ?? ARGON2_OWASP_DEFAULTS.parallelism;
    if (!Number.isInteger(timeCost) || timeCost < 1) {
      throw new Error(`crypto-node: argon2idHash timeCost must be >= 1, got ${timeCost}`);
    }
    if (!Number.isInteger(memoryCost) || memoryCost < 8) {
      throw new Error(
        `crypto-node: argon2idHash memoryCost must be >= 8 KiB, got ${memoryCost}`,
      );
    }
    if (!Number.isInteger(parallelism) || parallelism < 1) {
      throw new Error(`crypto-node: argon2idHash parallelism must be >= 1, got ${parallelism}`);
    }
    const argon2 = await loadArgon2();
    const result = await argon2.hash(Buffer.from(password), {
      type: argon2.argon2id,
      salt: Buffer.from(salt),
      hashLength: outLen,
      timeCost,
      memoryCost,
      parallelism,
      raw: true,
    });
    // Detach from Buffer's shared pool so the returned view can't be
    // mutated by a later unrelated Buffer allocation.
    return new Uint8Array(result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength));
  }

  // ─── Random (task 3.28) ─────────────────────────────────────────────────

  async randomBytes(count: number): Promise<Uint8Array> {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`crypto-node: randomBytes count must be a non-negative integer, got ${count}`);
    }
    // `node:crypto.randomBytes` returns a Node Buffer; wrap in a plain
    // Uint8Array view so the output doesn't leak Buffer-only methods
    // into the port contract.
    const buf = nodeRandomBytes(count);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
}
