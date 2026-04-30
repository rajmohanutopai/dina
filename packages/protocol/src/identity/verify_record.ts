/**
 * Trust-record commit signature verifier (TN-AUTH-002).
 *
 * Per Trust Network V1 plan §3.5.2, a `com.dina.trust.*` record's
 * commit signature must verify against the namespace key referenced
 * by the record's `namespace` field — that key being registered as
 * an `assertionMethod` verification method on the author's published
 * DID document. This module is the pure verifier the AppView
 * ingester gate (and any mobile-side preflight) calls.
 *
 * Resolution chain (closed-default — any failure → `false`):
 *
 *   record.namespace                       (e.g. "namespace_0")
 *     ↓ resolveAssertionMethod(doc, ns)    — TN-AUTH-001
 *   matching VerificationMethod
 *     ↓ decodePublicKeyMultibase(vm.publicKeyMultibase)
 *   raw 32-byte Ed25519 public key
 *     ↓ verify(pubKey, recordCanonicalBytes, signatureBytes)
 *   boolean
 *
 * Authoritative validation belongs upstream in the wire-layer
 * validators; this module's contract is "given the record bytes
 * and the author's DID doc, does the signature check out?". It does
 * NOT serialize records (the canonical-bytes layer is the caller's
 * concern — atproto's commit-signing logic produces those) and does
 * NOT decode multibase (zero runtime deps; caller injects).
 *
 * Why the closed-default failure mode: this verifier is the
 * trust-record signature gate. A "fail open" path (silently treating
 * a missing key as a wildcard match, or coercing a malformed
 * signature to "verified") would cause AppView to ingest forged
 * records. Every error path returns `false`. The verifier never
 * throws on bad input — it shouldn't crash the whole ingester
 * because one record's wire format is malformed.
 *
 * Why dependency injection on the verifier + multibase decoder:
 * `@dina/protocol` is zero-runtime-deps so it can run on every
 * platform Dina targets. Each runtime supplies its own crypto
 * (`@noble/ed25519` on Node, native sodium on iOS/Android, etc.)
 * and its own multibase decoder. The protocol package owns the
 * SHAPE of the verification flow; runtimes own the CRYPTO.
 *
 * Pure function. Zero runtime deps.
 */

import { resolveAssertionMethod } from './did_resolver';

import type { DIDDocument } from '../types/plc_document';
import type { Ed25519VerifyFn } from '../validators';

/**
 * Caller-injected decoder for a `publicKeyMultibase` string into the
 * raw Ed25519 32-byte public key.
 *
 * The caller's implementation parses the `z`-prefixed base58btc
 * encoding (per W3C Multikey), strips the multicodec prefix
 * (`0xed01` for Ed25519), and returns the 32-byte key.
 *
 * Returns `null` (not throws) for any malformed input — the verifier
 * treats `null` as an unverifiable record (closed-default: `false`).
 * Throwing is also acceptable; the verifier catches and treats the
 * same.
 */
export type MultikeyDecodeFn = (publicKeyMultibase: string) => Uint8Array | null;

export interface VerifyRecordCommitInput {
  /**
   * Author's DID document (already resolved by the caller from PLC
   * directory or the federation cache). The verifier does NOT fetch
   * — separation of concerns keeps this module pure.
   */
  readonly authorDoc: DIDDocument;
  /**
   * The `namespace` field on the record (e.g. `"namespace_0"`).
   * The fragment portion only — without `did:` prefix and without
   * leading `#`. The resolver normalises all three forms (bare /
   * fragment-with-hash / fully-qualified) so callers passing the
   * raw record field don't need to pre-format.
   */
  readonly namespace: string;
  /**
   * Canonical bytes that were signed. atproto's commit-signing layer
   * defines these (DAG-CBOR encoding of the commit op including the
   * record CID); the caller produces them — this verifier doesn't
   * re-derive.
   */
  readonly recordCanonicalBytes: Uint8Array;
  /** The Ed25519 signature produced over `recordCanonicalBytes`. */
  readonly signatureBytes: Uint8Array;
  readonly verify: Ed25519VerifyFn;
  readonly decodeMultikey: MultikeyDecodeFn;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Verify a record commit signature against the namespace key in the
 * author's DID document.
 *
 * Returns `true` only when the full chain succeeds:
 *   1. `authorDoc.assertionMethod` lists the claimed namespace.
 *   2. The matching verification method decodes to a valid 32-byte
 *      Ed25519 public key.
 *   3. The injected `verify` function returns `true` for the bytes.
 *
 * Any earlier failure → `false` (closed-default — see module
 * docstring).
 */
export function verifyRecordCommit(input: VerifyRecordCommitInput): boolean {
  if (!isValidByteSequence(input.recordCanonicalBytes)) return false;
  if (!isValidByteSequence(input.signatureBytes)) return false;
  if (typeof input.namespace !== 'string' || input.namespace.length === 0) return false;

  const vm = resolveAssertionMethod(input.authorDoc, input.namespace);
  if (vm === null) return false;
  if (typeof vm.publicKeyMultibase !== 'string' || vm.publicKeyMultibase.length === 0) {
    return false;
  }

  let publicKey: Uint8Array | null;
  try {
    publicKey = input.decodeMultikey(vm.publicKeyMultibase);
  } catch {
    return false;
  }
  if (!isValidByteSequence(publicKey)) return false;

  try {
    return input.verify(publicKey, input.recordCanonicalBytes, input.signatureBytes) === true;
  } catch {
    return false;
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────

function isValidByteSequence(bytes: unknown): bytes is Uint8Array {
  return bytes instanceof Uint8Array && bytes.length > 0;
}
