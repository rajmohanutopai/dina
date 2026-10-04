/**
 * Lane 3 byte-exact contracts (design §8.2): the directory envelope, the
 * fence, and the attempted-record digest. These are cross-codebase
 * cryptographic seams (the node signs, AppView verifies), so their bytes are
 * pinned by golden vectors.
 *
 * Every signature is Ed25519 under the publisher's `dina_signing` key, over
 * the UTF-8 bytes of the RFC 8785 canonical JSON of every field except `sig`,
 * and is carried as standard padded base64. The `domain` field separates the
 * two signed shapes; `did`, `collection` and `rkey` bind an envelope to the
 * one record it belongs to, so it cannot be replayed onto another record.
 *
 * Crypto is injected: `sha256` returns the 32-byte digest, `ed25519Verify`
 * checks a 64-byte signature against the 32-byte public key the caller
 * resolved from the publisher's DID document.
 */

import { base64Decode, base64Encode } from './base64';
import { canonicalize } from './jcs';
import { LOWER_HEX_64, bytesToHex, hasOwn, isPlainObject, utf8Bytes, type JsonValue } from './json';

export const A2A_CARD_COLLECTION = 'com.dinakernel.a2a.card';
export const A2A_FENCE_COLLECTION = 'com.dinakernel.a2a.fence';
/** Both records use `key: literal:self` (design §8.2). */
export const A2A_SELF_RKEY = 'self';

/**
 * The directory's search contract (design §8.3), held by AppView and by
 * every client: the longest `q` (UTF-16 code units, as a JS string counts),
 * and the most results one page holds. A `skill` is any id a card may carry
 * (`MAX_ID_LENGTH`).
 */
export const A2A_DIRECTORY_QUERY_MAX_LENGTH = 200;
export const A2A_DIRECTORY_PAGE_MAX = 50;

export const DIRECTORY_ENVELOPE_DOMAIN = 'dina:a2a:directory-envelope:v1' as const;
export const FENCE_DOMAIN = 'dina:a2a:fence:v1' as const;

export type Sha256Fn = (bytes: Uint8Array) => Uint8Array;
export type Ed25519SignFn = (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;
export type Ed25519VerifyFn = (message: Uint8Array, signature: Uint8Array) => boolean;

/** A verifier that throws has verified nothing. */
function safeVerify(verify: Ed25519VerifyFn, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return verify(message, signature) === true;
  } catch {
    return false;
  }
}

export interface DirectoryEnvelope {
  v: 1;
  domain: typeof DIRECTORY_ENVELOPE_DOMAIN;
  did: string;
  collection: string;
  rkey: string;
  card_hash: string;
  freshness_epoch: number;
  publisher_epoch: number;
  publisher_instance: string;
  sig: string;
}

export interface Fence {
  v: 1;
  domain: typeof FENCE_DOMAIN;
  did: string;
  publisher_epoch: number;
  publisher_instance: string;
  sig: string;
}

const DID_RE = /^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.:%-]{1,253})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ENVELOPE_KEYS = [
  'v',
  'domain',
  'did',
  'collection',
  'rkey',
  'card_hash',
  'freshness_epoch',
  'publisher_epoch',
  'publisher_instance',
  'sig',
] as const;
const FENCE_KEYS = ['v', 'domain', 'did', 'publisher_epoch', 'publisher_instance', 'sig'] as const;

function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(obj);
  return own.length === keys.length && keys.every((k) => hasOwn(obj, k));
}

function signingBytes(record: Record<string, unknown>): Uint8Array {
  const { sig: _sig, ...unsigned } = record;
  return utf8Bytes(canonicalize(unsigned));
}

/** Lowercase sha256 hex over the exact UTF-8 bytes of the published `card` string. */
export function cardStringHash(cardText: string, sha256: Sha256Fn): string {
  return bytesToHex(sha256(utf8Bytes(cardText)));
}

export type EnvelopeFields = Omit<DirectoryEnvelope, 'v' | 'domain' | 'sig'>;

export async function signDirectoryEnvelope(
  fields: EnvelopeFields,
  sign: Ed25519SignFn,
): Promise<DirectoryEnvelope> {
  const unsigned = { v: 1 as const, domain: DIRECTORY_ENVELOPE_DOMAIN, ...fields };
  const err = validateDirectoryEnvelope({ ...unsigned, sig: base64Encode(new Uint8Array(64)) });
  if (err !== null) throw new Error(`directory envelope: ${err}`);
  const sig = await sign(signingBytes(unsigned));
  return { ...unsigned, sig: base64Encode(sig) };
}

export type FenceFields = Omit<Fence, 'v' | 'domain' | 'sig'>;

export async function signFence(fields: FenceFields, sign: Ed25519SignFn): Promise<Fence> {
  const unsigned = { v: 1 as const, domain: FENCE_DOMAIN, ...fields };
  const err = validateFence({ ...unsigned, sig: base64Encode(new Uint8Array(64)) });
  if (err !== null) throw new Error(`fence: ${err}`);
  const sig = await sign(signingBytes(unsigned));
  return { ...unsigned, sig: base64Encode(sig) };
}

/** Shape check only: exact members, bounded values, canonical encodings. */
export function validateDirectoryEnvelope(value: unknown): string | null {
  if (!isPlainObject(value)) return 'not_object';
  if (!exactKeys(value, ENVELOPE_KEYS)) return 'members';
  if (value.v !== 1) return 'version';
  if (value.domain !== DIRECTORY_ENVELOPE_DOMAIN) return 'domain';
  if (typeof value.did !== 'string' || !DID_RE.test(value.did)) return 'did';
  if (value.collection !== A2A_CARD_COLLECTION) return 'collection';
  if (value.rkey !== A2A_SELF_RKEY) return 'rkey';
  if (typeof value.card_hash !== 'string' || !LOWER_HEX_64.test(value.card_hash))
    return 'card_hash';
  if (!isEpoch(value.freshness_epoch)) return 'freshness_epoch';
  if (!isEpoch(value.publisher_epoch)) return 'publisher_epoch';
  if (typeof value.publisher_instance !== 'string' || !UUID_RE.test(value.publisher_instance)) {
    return 'publisher_instance';
  }
  if (typeof value.sig !== 'string' || base64Decode(value.sig)?.length !== 64) return 'sig';
  return null;
}

export function validateFence(value: unknown): string | null {
  if (!isPlainObject(value)) return 'not_object';
  if (!exactKeys(value, FENCE_KEYS)) return 'members';
  if (value.v !== 1) return 'version';
  if (value.domain !== FENCE_DOMAIN) return 'domain';
  if (typeof value.did !== 'string' || !DID_RE.test(value.did)) return 'did';
  if (!isEpoch(value.publisher_epoch)) return 'publisher_epoch';
  if (typeof value.publisher_instance !== 'string' || !UUID_RE.test(value.publisher_instance)) {
    return 'publisher_instance';
  }
  if (typeof value.sig !== 'string' || base64Decode(value.sig)?.length !== 64) return 'sig';
  return null;
}

export interface EnvelopeContext {
  /** The repository the record was read from (event repo DID). */
  repoDid: string;
  collection: string;
  rkey: string;
  /** The record's `card` string, exactly as published. */
  cardText: string;
}

export type ContractCheck = { ok: true } | { ok: false; reason: string };

/**
 * Full check of a directory envelope against the record it arrived in:
 * shape, identity binding (did/collection/rkey equal the record's own),
 * `card_hash` equal to the hash of the published card bytes, then the
 * signature. Identity and hash are checked before the signature so a
 * replayed but validly signed envelope is refused for the right reason.
 */
export function verifyDirectoryEnvelope(
  value: unknown,
  ctx: EnvelopeContext,
  sha256: Sha256Fn,
  ed25519Verify: Ed25519VerifyFn,
): ContractCheck {
  const shapeErr = validateDirectoryEnvelope(value);
  if (shapeErr !== null) return { ok: false, reason: `envelope_${shapeErr}` };
  const env = value as unknown as DirectoryEnvelope;
  if (env.did !== ctx.repoDid) return { ok: false, reason: 'envelope_did_mismatch' };
  if (env.collection !== ctx.collection)
    return { ok: false, reason: 'envelope_collection_mismatch' };
  if (env.rkey !== ctx.rkey) return { ok: false, reason: 'envelope_rkey_mismatch' };
  if (env.card_hash !== cardStringHash(ctx.cardText, sha256)) {
    return { ok: false, reason: 'envelope_card_hash_mismatch' };
  }
  const sig = base64Decode(env.sig) as Uint8Array;
  if (!safeVerify(ed25519Verify, signingBytes(env as unknown as Record<string, unknown>), sig)) {
    return { ok: false, reason: 'envelope_signature' };
  }
  return { ok: true };
}

/** Full check of a fence read from `repoDid`'s repository (design §8.2). */
export function verifyFence(
  value: unknown,
  repoDid: string,
  ed25519Verify: Ed25519VerifyFn,
): ContractCheck {
  const shapeErr = validateFence(value);
  if (shapeErr !== null) return { ok: false, reason: `fence_${shapeErr}` };
  const fence = value as unknown as Fence;
  if (fence.did !== repoDid) return { ok: false, reason: 'fence_did_mismatch' };
  const sig = base64Decode(fence.sig) as Uint8Array;
  if (!safeVerify(ed25519Verify, signingBytes(fence as unknown as Record<string, unknown>), sig)) {
    return { ok: false, reason: 'fence_signature' };
  }
  return { ok: true };
}

/**
 * Lowercase sha256 hex over RFC 8785 of a complete record value (design
 * §8.2's attempted-record digest). A record fetched back from a PDS arrives
 * as a deserialized object and canonicalizes to the same bytes.
 */
export function attemptedRecordDigest(record: JsonValue, sha256: Sha256Fn): string {
  return bytesToHex(sha256(utf8Bytes(canonicalize(record))));
}
