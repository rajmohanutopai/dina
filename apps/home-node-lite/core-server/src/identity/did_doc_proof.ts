/**
 * Task 4.58 — self-certify + sign DID doc.
 *
 * Produces a self-signed DID document where the signing key IS the
 * same key the document publishes (verification method at
 * `<did>#dina_signing`). A resolver that fetches the doc can verify
 * the signature against the embedded pubkey without a third-party
 * registry — the doc certifies itself.
 *
 * **Proof shape** follows W3C DID Core's Data Integrity convention
 * (a JSON "proof" sibling of the doc), simplified to what Dina
 * actually needs:
 *
 *   proof: {
 *     type: "Ed25519Signature2020",
 *     created: "<RFC3339>",
 *     verificationMethod: "<did>#dina_signing",
 *     proofPurpose: "assertionMethod",
 *     signatureHex: "<128-char hex>"
 *   }
 *
 * **Canonicalization**: we sign the SHA-256 of the canonical JSON
 * serialization of the document (sorted keys, no whitespace, UTF-8
 * encoding). Any future resolver that canonicalises identically
 * (JCS / RFC 8785 or the sorted-keys subset Dina uses) computes the
 * same digest, so the signature is portable. The signature-hex
 * format matches the rest of the Dina stack (Ed25519 signatures are
 * always 64 raw bytes = 128 hex chars).
 *
 * **Why not embed the proof inside the DID doc**: keeping
 * `{doc, proof}` separate means the canonical-serialisation step
 * doesn't have to worry about a self-referential field. A caller
 * that wants the joined shape does `{...doc, proof}` at the edge;
 * the core API signs the raw doc so the digest is stable.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4g task 4.58.
 */

import { createHash } from 'node:crypto';
import { sign as ed25519Sign, verify as ed25519Verify } from '@dina/core';
import type { DIDDocument } from '@dina/core';

export const PROOF_TYPE = 'Ed25519Signature2020';
export const PROOF_PURPOSE_ASSERTION = 'assertionMethod';
export const SIGNING_VM_FRAGMENT = '#dina_signing';

export interface SelfCertifyInput {
  /** The DID document to certify. */
  doc: DIDDocument;
  /** 32-byte Ed25519 private key corresponding to the doc's signing VM. */
  signingPrivateKey: Uint8Array;
  /** Clock override (RFC3339 timestamp). Default `new Date()`. */
  nowFn?: () => Date;
}

export interface DIDProof {
  readonly type: typeof PROOF_TYPE;
  /** RFC3339 timestamp when the proof was produced. */
  readonly created: string;
  /** Fragment-qualified DID for the VM that signed (e.g. `did:plc:x#dina_signing`). */
  readonly verificationMethod: string;
  readonly proofPurpose: typeof PROOF_PURPOSE_ASSERTION;
  /** Ed25519 signature of `SHA-256(canonicalJson(doc))` — 128 hex chars. */
  readonly signatureHex: string;
}

export interface SelfCertifyOutput {
  doc: DIDDocument;
  proof: DIDProof;
}

/**
 * Sign the given DID document with the supplied Ed25519 key. Returns
 * `{doc, proof}` — caller can ship as a pair OR stitch into a joined
 * envelope.
 */
export function selfCertifyDIDDoc(input: SelfCertifyInput): SelfCertifyOutput {
  if (!input.doc) throw new Error('selfCertifyDIDDoc: doc is required');
  if (!input.doc.id || !input.doc.id.startsWith('did:')) {
    throw new Error(
      'selfCertifyDIDDoc: doc.id must be a DID (starts with "did:")',
    );
  }
  if (!input.signingPrivateKey || input.signingPrivateKey.length !== 32) {
    throw new Error(
      'selfCertifyDIDDoc: signingPrivateKey must be 32 bytes (Ed25519 seed)',
    );
  }

  const digest = digestDoc(input.doc);
  const signature = ed25519Sign(input.signingPrivateKey, digest);
  const proof: DIDProof = {
    type: PROOF_TYPE,
    created: (input.nowFn ?? (() => new Date()))().toISOString(),
    verificationMethod: `${input.doc.id}${SIGNING_VM_FRAGMENT}`,
    proofPurpose: PROOF_PURPOSE_ASSERTION,
    signatureHex: bytesToHex(signature),
  };
  return { doc: input.doc, proof };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyRejectionReason };

export type VerifyRejectionReason =
  | 'wrong_proof_type'
  | 'wrong_purpose'
  | 'vm_mismatch'
  | 'malformed_signature'
  | 'signature_invalid';

/**
 * Verify a DID doc's self-certification. Matches the signature in
 * `selfCertifyDIDDoc` — any caller who can produce the doc + its
 * `#dina_signing` public key can verify without external services.
 *
 * Never throws — structured rejection lets the caller log the reason
 * without hoisting it to an exception.
 */
export function verifyDIDDocProof(
  doc: DIDDocument,
  proof: DIDProof,
  signingPublicKey: Uint8Array,
): VerifyResult {
  if (proof.type !== PROOF_TYPE) {
    return { ok: false, reason: 'wrong_proof_type' };
  }
  if (proof.proofPurpose !== PROOF_PURPOSE_ASSERTION) {
    return { ok: false, reason: 'wrong_purpose' };
  }
  if (proof.verificationMethod !== `${doc.id}${SIGNING_VM_FRAGMENT}`) {
    return { ok: false, reason: 'vm_mismatch' };
  }
  const sig = hexToBytes(proof.signatureHex);
  if (sig === null || sig.length !== 64) {
    return { ok: false, reason: 'malformed_signature' };
  }
  const digest = digestDoc(doc);
  const ok = ed25519Verify(signingPublicKey, digest, sig);
  return ok ? { ok: true } : { ok: false, reason: 'signature_invalid' };
}

/**
 * Canonical JSON of a DID document — sorted keys, no whitespace,
 * UTF-8 serialisation. Exported so callers that need the exact bytes
 * we sign over (e.g. a future JCS-based verifier) can reproduce
 * them without reaching into this module's internals.
 */
export function canonicalizeDIDDoc(doc: DIDDocument): string {
  return stableStringify(doc);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 of `canonicalJson(doc)` — the bytes we sign/verify over. */
function digestDoc(doc: DIDDocument): Uint8Array {
  const canonical = stableStringify(doc);
  const hash = createHash('sha256').update(canonical, 'utf8').digest();
  return new Uint8Array(hash.buffer, hash.byteOffset, hash.byteLength);
}

/**
 * Deterministic JSON with sorted object keys. Sufficient for Dina's
 * internal needs — callers that want full JCS (RFC 8785) swap this
 * for `canonicalize(doc)`; the signature math is the same.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue; // skip undefined per JSON conventions
    parts.push(JSON.stringify(k) + ':' + stableStringify(v));
  }
  return '{' + parts.join(',') + '}';
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}
