/**
 * PLC directory client — create and update did:plc identities.
 *
 * did:plc creation:
 *   1. Derive root signing key (Ed25519, m/9999'/0'/0')
 *   2. Derive rotation key (secp256k1, m/9999'/2'/{gen}')
 *   3. Build creation operation (signed JSON)
 *   4. POST to PLC directory → get did:plc:{hash}
 *
 * The PLC directory returns the DID based on the SHA-256 hash of the
 * signed creation operation. Same keys always produce the same DID.
 *
 * Source: ARCHITECTURE.md Task 2.30, AT Protocol PLC directory spec
 */

import { getPublicKey } from '../crypto/ed25519';
import { deriveRotationKey } from '../crypto/slip0010';
import { deriveDIDKey, publicKeyToMultibase } from './did';
import { buildDIDDocument } from './did_document';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { base32LowercaseNoPad } from './base32';

/** Multicodec varint prefix for secp256k1 public key: 0xe7 0x01. */
const SECP256K1_MULTICODEC = new Uint8Array([0xe7, 0x01]);

/** Encode a secp256k1 compressed public key (33 bytes) as did:key multibase. */
function secp256k1ToMultibase(pubKey: Uint8Array): string {
  const payload = new Uint8Array(SECP256K1_MULTICODEC.length + pubKey.length);
  payload.set(SECP256K1_MULTICODEC, 0);
  payload.set(pubKey, SECP256K1_MULTICODEC.length);
  return 'z' + base58.encode(payload);
}

import { DEFAULT_PLC_DIRECTORY } from '../constants';
const DEFAULT_PLC_URL = DEFAULT_PLC_DIRECTORY;

export interface PLCCreateParams {
  /** 32-byte root signing seed (Ed25519). */
  signingKey: Uint8Array;
  /** 32-byte seed for secp256k1 rotation key derivation. */
  rotationSeed: Uint8Array;
  /** MsgBox WebSocket endpoint. */
  msgboxEndpoint?: string;
  /** Rotation key generation (default: 0). */
  rotationGeneration?: number;
  /** Display handle (optional, for PLC directory). */
  handle?: string;
}

export interface PLCCreateResult {
  did: string;
  didKey: string;
  publicKeyMultibase: string;
  rotationKeyHex: string;
  operationHash: string;
}

export interface PLCDirectoryConfig {
  plcURL?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Build the PLC creation operation (unsigned).
 *
 * The creation operation defines the identity:
 * - type: "plc_operation" (or "create" for v1)
 * - signingKey: Ed25519 public key (multibase)
 * - rotationKeys: secp256k1 compressed public keys (multibase)
 * - services: { "dina-messaging": { type, endpoint } }  — PLC adds `#` in the resolved doc
 * - handle (optional)
 */
export function buildCreationOperation(params: PLCCreateParams): {
  operation: Record<string, unknown>;
  signingPubKey: Uint8Array;
  rotationPubKey: Uint8Array;
} {
  const signingPubKey = getPublicKey(params.signingKey);
  const signingMultibase = publicKeyToMultibase(signingPubKey);

  const rotationGen = params.rotationGeneration ?? 0;
  const rotationDerived = deriveRotationKey(params.rotationSeed, rotationGen);
  const rotationPubKey = rotationDerived.publicKey;

  const services: Record<string, unknown> = {};
  if (params.msgboxEndpoint) {
    // PLC prefixes `#` to service map keys when generating the DID doc,
    // so store the bare name here. The resolved doc then exposes
    // `service[].id = "#dina-messaging"` — what the CLI looks up.
    services['dina-messaging'] = {
      type: 'DinaMsgBox',
      endpoint: params.msgboxEndpoint,
    };
  }

  const operation: Record<string, unknown> = {
    type: 'plc_operation',
    // Key layout matches main-dina:
    //   - `dina_signing`: Ed25519, m/9999'/0'/0' — D2D + request signing,
    //     and CLI-side keyAgreement derivation (via ed25519 → X25519).
    //   - `#atproto` is PDS-managed and added by the PDS's update op
    //     when createAccount binds this DID, so we DO NOT include it
    //     in the genesis op.
    verificationMethods: {
      dina_signing: `did:key:${signingMultibase}`,
    },
    rotationKeys: [`did:key:${secp256k1ToMultibase(rotationPubKey)}`],
    alsoKnownAs: params.handle ? [`at://${params.handle}`] : [],
    services,
    prev: null, // genesis operation
  };

  return { operation, signingPubKey, rotationPubKey };
}

/**
 * Sign a PLC operation with the rotation key.
 *
 * ATProto PLC spec:
 *   1. Strip the `sig` field (if present).
 *   2. Encode as dag-cbor (IPLD canonical).
 *   3. SHA-256 the cbor bytes.
 *   4. secp256k1 ECDSA sign, low-s normalised.
 *   5. Encode the 64-byte compact (r || s) signature as base64url (no padding).
 *   6. Attach `sig: <base64url>` to the operation.
 *
 * The rotationSeed param is the raw 32-byte secp256k1 private key
 * (NOT the SLIP-0010 seed — that's `deriveRotationKey`'s input).
 */
export function signOperation(
  operation: Record<string, unknown>,
  rotationPrivKey: Uint8Array,
): { signedOperation: Record<string, unknown>; operationHash: string } {
  if (rotationPrivKey.length !== 32) {
    throw new Error(
      `signOperation: rotationPrivKey must be 32 bytes (got ${rotationPrivKey.length})`,
    );
  }
  const unsigned = { ...operation };
  delete unsigned.sig;
  const cborBytes = dagCborEncode(unsigned);
  const hash = sha256(cborBytes);
  // `@noble/curves` v2 defaults to `prehash: true` (sha256 the input
  // internally). We've already hashed, so disable that to avoid
  // double-hashing — otherwise PLC rejects the sig as invalid.
  const sigBytes = secp256k1.sign(hash, rotationPrivKey, {
    lowS: true,
    prehash: false,
  });
  const sigB64url = base64urlEncode(sigBytes);
  return {
    signedOperation: { ...operation, sig: sigB64url },
    operationHash: bytesToHex(hash),
  };
}

/**
 * Minimal `dag-cbor` encoder — just the subset the PLC op uses:
 *   - text strings (major 3)
 *   - arrays (major 4)
 *   - maps with string keys, sorted by length-then-lex (major 5)
 *   - null (major 7, simple 22)
 *   - booleans (major 7, simple 20/21)
 *   - unsigned ints (major 0)
 *
 * Matches IPLD DAG-CBOR — deterministic, no tags, no floats, no
 * negative integers required for our payloads.
 */
export function dagCborEncode(value: unknown): Uint8Array {
  const chunks: number[] = [];
  encodeValue(value, chunks);
  return new Uint8Array(chunks);
}

function encodeValue(v: unknown, out: number[]): void {
  if (v === null) {
    out.push(0xf6);
    return;
  }
  if (v === false) {
    out.push(0xf4);
    return;
  }
  if (v === true) {
    out.push(0xf5);
    return;
  }
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(`dagCborEncode: non-negative-integer numbers not supported (got ${v})`);
    }
    encodeHead(0, v, out);
    return;
  }
  if (typeof v === 'string') {
    const bytes = new TextEncoder().encode(v);
    encodeHead(3, bytes.length, out);
    for (const b of bytes) out.push(b);
    return;
  }
  if (Array.isArray(v)) {
    encodeHead(4, v.length, out);
    for (const item of v) encodeValue(item, out);
    return;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      // DAG-CBOR maps are sorted by key bytes: length first, then lexicographic.
      .sort((a, b) => {
        if (a[0].length !== b[0].length) return a[0].length - b[0].length;
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      });
    encodeHead(5, entries.length, out);
    for (const [k, vv] of entries) {
      encodeValue(k, out);
      encodeValue(vv, out);
    }
    return;
  }
  throw new Error(`dagCborEncode: unsupported value type: ${typeof v}`);
}

/** CBOR head byte (major type + argument) with correct length encoding. */
function encodeHead(major: number, arg: number, out: number[]): void {
  const mt = major << 5;
  if (arg < 24) {
    out.push(mt | arg);
    return;
  }
  if (arg < 0x100) {
    out.push(mt | 24, arg);
    return;
  }
  if (arg < 0x10000) {
    out.push(mt | 25, (arg >> 8) & 0xff, arg & 0xff);
    return;
  }
  if (arg < 0x100000000) {
    out.push(mt | 26, (arg >>> 24) & 0xff, (arg >>> 16) & 0xff, (arg >>> 8) & 0xff, arg & 0xff);
    return;
  }
  // Uint64 — not expected in PLC ops.
  throw new Error('dagCborEncode: argument > 2^32 not supported');
}

/** base64url encoder (no padding) — used for PLC sig field. */
function base64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 =
    typeof btoa !== 'undefined' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Derive the did:plc from the signed creation operation.
 *
 * Matches ATProto PLC spec:
 *   did:plc = base32-lower-no-pad(sha256(dag_cbor(signed_op)))[:24]
 */
export function derivePLCDID(signedOperation: Record<string, unknown>): string {
  const cborBytes = dagCborEncode(signedOperation);
  const hash = sha256(cborBytes);
  // PLC spec truncates to 24 chars; alphabet is already lowercase.
  const b32 = base32LowercaseNoPad(hash).slice(0, 24);
  return `did:plc:${b32}`;
}

/**
 * Create a did:plc identity — build, sign, and optionally register.
 *
 * If no fetch/plcURL is provided, returns the operation without posting
 * (useful for testing and offline DID derivation).
 */
export async function createDIDPLC(
  params: PLCCreateParams,
  config?: PLCDirectoryConfig,
): Promise<PLCCreateResult> {
  // 1. Build creation operation
  const { operation, signingPubKey, rotationPubKey } = buildCreationOperation(params);

  // 2. Sign with the secp256k1 ROTATION private key (per PLC spec — the
  //    genesis op must be signed by a key listed in `rotationKeys`).
  //    Re-derive the same rotation key the op published so caller only
  //    has to pass `rotationSeed` + generation.
  const rotationGen = params.rotationGeneration ?? 0;
  const rotationDerived = deriveRotationKey(params.rotationSeed, rotationGen);
  const rotationPrivKey = rotationDerived.privateKey;
  const { signedOperation, operationHash } = signOperation(operation, rotationPrivKey);

  // 3. Derive the DID
  const did = derivePLCDID(signedOperation);

  // 4. Derive did:key for the signing key
  const didKey = deriveDIDKey(signingPubKey);
  const publicKeyMultibase = publicKeyToMultibase(signingPubKey);
  const rotationKeyHex = bytesToHex(rotationPubKey);

  // 5. Register on PLC directory (if configured)
  if (config?.fetch) {
    const plcURL = (config.plcURL ?? DEFAULT_PLC_URL).replace(/\/$/, '');
    const response = await config.fetch(`${plcURL}/${did}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signedOperation),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`PLC directory registration failed: HTTP ${response.status} — ${errorText}`);
    }
  }

  return {
    did,
    didKey,
    publicKeyMultibase,
    rotationKeyHex,
    operationHash,
  };
}

/**
 * Resolve a did:plc from the PLC directory.
 */
export async function resolveDIDPLC(
  did: string,
  config?: PLCDirectoryConfig,
): Promise<Record<string, unknown>> {
  const fetchFn = config?.fetch ?? globalThis.fetch;
  const plcURL = (config?.plcURL ?? DEFAULT_PLC_URL).replace(/\/$/, '');

  const response = await fetchFn(`${plcURL}/${did}`, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`PLC resolve failed: HTTP ${response.status}`);
  }

  return response.json() as Promise<Record<string, unknown>>;
}

// Helpers moved to `./base32.ts` so the PLC namespace update composer
// (`./plc_namespace_update.ts`) can share the same implementation. See
// that file's header for the rationale.
