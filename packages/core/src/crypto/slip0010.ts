/**
 * SLIP-0010 hierarchical key derivation for Ed25519 and secp256k1.
 *
 * Derives all Dina keys from the master seed using hardened-only paths.
 *
 * Ed25519: HMAC key "ed25519 seed", child key = IL (direct).
 * secp256k1: HMAC key "Bitcoin seed", child key = (parse256(IL) + kpar) mod n (BIP-32).
 *
 * SLIP-0010 spec: https://github.com/satoshilabs/slips/blob/master/slip-0010.md
 */

import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { getPublicKey } from './ed25519';
import { HARDENED_OFFSET as HARDENED } from '../constants';

export interface DerivedKey {
  privateKey: Uint8Array; // 32 bytes
  publicKey: Uint8Array; // 32 bytes (Ed25519) or 33 bytes (secp256k1 compressed)
  chainCode: Uint8Array; // 32 bytes
}

const HARDENED_OFFSET = HARDENED;
const SECP256K1_ORDER = secp256k1.Point.Fn.ORDER;

/**
 * Parse a SLIP-0010 path string into an array of uint32 indices.
 * Enforces: hardened-only, no BIP-44 purpose 44'.
 */
function parsePath(path: string): number[] {
  if (!path || !path.startsWith('m/')) {
    throw new Error(`slip0010: invalid path format — must start with "m/", got "${path}"`);
  }

  const segments = path
    .slice(2)
    .split('/')
    .filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new Error('slip0010: path has no segments after "m/"');
  }

  const indices: number[] = [];
  for (const seg of segments) {
    const isHardened = seg.endsWith("'");
    if (!isHardened) {
      throw new Error(
        `slip0010: non-hardened index "${seg}" — Dina requires hardened-only derivation`,
      );
    }

    const numStr = seg.slice(0, -1);
    const num = parseInt(numStr, 10);
    if (isNaN(num) || num < 0) {
      throw new Error(`slip0010: invalid index "${seg}" — must be a non-negative integer`);
    }

    indices.push(num + HARDENED_OFFSET);
  }

  // Reject BIP-44 purpose 44'
  if (indices.length > 0 && indices[0] === 44 + HARDENED_OFFSET) {
    throw new Error("slip0010: BIP-44 purpose 44' is forbidden in Dina");
  }

  return indices;
}

/** Validate seed: non-empty, >= 16 bytes, not all-zero. */
function validateSeed(seed: Uint8Array): void {
  if (!seed || seed.length === 0) {
    throw new Error('slip0010: empty seed');
  }
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
  if (allZero) {
    throw new Error('slip0010: all-zero seed rejected (fail-closed)');
  }
}

/**
 * Derive master key from seed using HMAC-SHA512.
 */
function deriveMasterKey(
  seed: Uint8Array,
  hmacKey: string,
): { key: Uint8Array; chainCode: Uint8Array } {
  const I = hmac(sha512, new TextEncoder().encode(hmacKey), seed);
  return {
    key: I.slice(0, 32),
    chainCode: I.slice(32, 64),
  };
}

/**
 * Derive a hardened child key (Ed25519 mode: child key = IL).
 */
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
  return {
    key: I.slice(0, 32),
    chainCode: I.slice(32, 64),
  };
}

/**
 * Derive a hardened child key (secp256k1 / BIP-32 mode: child key = (IL + kpar) mod n).
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

  // BIP-32: if IL >= n, this key is invalid (probability ~2^-128)
  if (ilBigInt >= SECP256K1_ORDER) {
    throw new Error('slip0010: IL >= curve order — invalid child key (extremely unlikely)');
  }

  const keyBigInt = BigInt('0x' + bytesToHex(parentKey));
  const childKeyBigInt = (ilBigInt + keyBigInt) % SECP256K1_ORDER;

  // BIP-32: if child key is zero, it's invalid (probability ~2^-256)
  if (childKeyBigInt === 0n) {
    throw new Error('slip0010: child key is zero — invalid (extremely unlikely)');
  }

  const hexStr = childKeyBigInt.toString(16).padStart(64, '0');
  return {
    key: hexToBytes(hexStr),
    chainCode: IR,
  };
}

// ---------------------------------------------------------------
// Public API: Ed25519
// ---------------------------------------------------------------

/**
 * Derive an Ed25519 keypair from a seed at a SLIP-0010 hardened path.
 *
 * @param seed - BIP-39 seed (64 bytes) or any seed material
 * @param path - Derivation path (e.g., "m/9999'/0'/0'"). Hardened only.
 */
export function derivePath(seed: Uint8Array, path: string): DerivedKey {
  validateSeed(seed);

  const indices = parsePath(path);
  let { key, chainCode } = deriveMasterKey(seed, 'ed25519 seed');

  for (const index of indices) {
    const child = deriveChildEd25519(key, chainCode, index);
    key = child.key;
    chainCode = child.chainCode;
  }

  return {
    privateKey: key,
    publicKey: getPublicKey(key),
    chainCode,
  };
}

// ---------------------------------------------------------------
// Public API: secp256k1
// ---------------------------------------------------------------

/**
 * Derive a secp256k1 keypair from a seed at a SLIP-0010/BIP-32 hardened path.
 *
 * Uses "Bitcoin seed" HMAC key and BIP-32 child key derivation
 * (addition mod n rather than direct assignment).
 *
 * @param seed - BIP-39 seed (64 bytes) or any seed material
 * @param path - Derivation path (e.g., "m/9999'/2'/0'"). Hardened only.
 */
export function derivePathSecp256k1(seed: Uint8Array, path: string): DerivedKey {
  validateSeed(seed);

  const indices = parsePath(path);
  let { key, chainCode } = deriveMasterKey(seed, 'Bitcoin seed');

  for (const index of indices) {
    const child = deriveChildSecp256k1(key, chainCode, index);
    key = child.key;
    chainCode = child.chainCode;
  }

  // secp256k1 compressed public key (33 bytes)
  const publicKey = secp256k1.getPublicKey(key, true);

  return {
    privateKey: key,
    publicKey,
    chainCode,
  };
}

// ---------------------------------------------------------------
// Convenience functions
// ---------------------------------------------------------------

/** Derive the root identity signing key at m/9999'/0'/{generation}'. */
export function deriveRootSigningKey(seed: Uint8Array, generation: number): DerivedKey {
  return derivePath(seed, `m/9999'/0'/${generation}'`);
}

/** Derive a per-persona signing key at m/9999'/1'/{index}'/{generation}'. */
export function derivePersonaSigningKey(
  seed: Uint8Array,
  personaIndex: number,
  generation: number,
): DerivedKey {
  return derivePath(seed, `m/9999'/1'/${personaIndex}'/${generation}'`);
}

/** Derive the secp256k1 PLC rotation key at m/9999'/2'/{generation}'. */
export function deriveRotationKey(seed: Uint8Array, generation: number): DerivedKey {
  return derivePathSecp256k1(seed, `m/9999'/2'/${generation}'`);
}

/**
 * Derive a service-auth Ed25519 signing key at `m/9999'/3'/{serviceIndex}'`.
 *
 * Used for Core↔Brain (and future sidecar) service authentication. The
 * install-time provisioning script derives these keys under specific
 * indices (Core = 0, Brain = 1; matches CLAUDE.md).
 *
 * Per the architecture tree in ARCHITECTURE.md §"Key Derivation",
 * purpose-3 is Service Auth (Ed25519, NOT secp256k1 — that's purpose 2).
 */
export function deriveServiceKey(seed: Uint8Array, serviceIndex: number): DerivedKey {
  return derivePath(seed, `m/9999'/3'/${serviceIndex}'`);
}

/**
 * Derive a pseudonymous-namespace Ed25519 signing key at
 * `m/9999'/4'/{namespaceIndex}'`.
 *
 * Trust Network V1 lets a user publish attestations under separate
 * cryptographic identities ("namespaces") — health reviews under one,
 * product reviews under another, anonymous restaurant reviews under a
 * third. Each namespace's signing key is appended to the master DID's
 * `assertionMethod` set as `did:plc:xxxx#namespace_<N>`. The user's
 * single recoverable BIP-39 seed deterministically yields every
 * namespace key under purpose-4, so a wipe + restore from seed
 * recovers the full namespace lineage without any side-channel state.
 *
 * Purpose-4 is the next free slot after Service Auth (purpose 3); the
 * full assignment is documented in `ARCHITECTURE.md` §"Key Derivation"
 * and `docs/TRUST_NETWORK_V1_PLAN.md` §3.5 (Pseudonymous Identity).
 */
export function deriveNamespaceKey(seed: Uint8Array, namespaceIndex: number): DerivedKey {
  return derivePath(seed, `m/9999'/4'/${namespaceIndex}'`);
}
