/**
 * PDS attestation publishing — sign and publish to AT Protocol PDS.
 *
 * Portable subset of pds_test.go:
 * - Attestation record signing with Ed25519 identity key
 * - Lexicon validation (required fields, enums)
 * - Rating range enforcement (0-100)
 * - Publishing to PDS via XRPC (com.atproto.repo.createRecord)
 *
 * Source: core/test/pds_test.go (portable parts)
 */

import { canonicalize, signCanonical, verifyCanonical } from '../identity/signing';
import { TRUST_RATING_MIN, TRUST_RATING_MAX } from '../constants';

export interface AttestationRecord {
  subject_did: string;
  category: string;
  rating: number; // 0-100
  verdict: Record<string, unknown>;
  evidence_uri?: string;
}

export interface SignedAttestation {
  record: AttestationRecord;
  signature_hex: string;
  signer_did: string;
}

const VALID_CATEGORIES = new Set([
  'product_review',
  'service_review',
  'trust_vouch',
  'identity_verification',
  'content_quality',
]);

/** AT Protocol lexicon NSID for Dina trust attestations. */
const ATTESTATION_LEXICON = 'community.dina.trust.attestation';

/** Injectable fetch for testing. */
let fetchFn: typeof globalThis.fetch = globalThis.fetch;

/** Set the fetch function (for testing). */
export function setPDSFetchFn(fn: typeof globalThis.fetch): void {
  fetchFn = fn;
}

/** Reset the fetch function (for testing). */
export function resetPDSFetchFn(): void {
  fetchFn = globalThis.fetch;
}

/**
 * Validate rating is in range 0-100 (inclusive), integer.
 */
export function isValidRating(rating: number): boolean {
  return Number.isInteger(rating) && rating >= TRUST_RATING_MIN && rating <= TRUST_RATING_MAX;
}

/**
 * Validate a record against the attestation lexicon. Returns error strings.
 * Empty array = valid.
 */
export function validateLexicon(record: AttestationRecord): string[] {
  const errors: string[] = [];

  if (!record.subject_did || typeof record.subject_did !== 'string') {
    errors.push('subject_did is required');
  } else if (!record.subject_did.startsWith('did:')) {
    errors.push('subject_did must be a valid DID');
  }

  if (!record.category || typeof record.category !== 'string') {
    errors.push('category is required');
  } else if (!VALID_CATEGORIES.has(record.category)) {
    errors.push(`category must be one of: ${[...VALID_CATEGORIES].sort().join(', ')}`);
  }

  if (!isValidRating(record.rating)) {
    errors.push('rating must be an integer between 0 and 100');
  }

  if (!record.verdict || typeof record.verdict !== 'object' || Array.isArray(record.verdict)) {
    errors.push('verdict must be a non-null object');
  }

  if (record.evidence_uri !== undefined) {
    if (
      typeof record.evidence_uri !== 'string' ||
      (!record.evidence_uri.startsWith('https://') && !record.evidence_uri.startsWith('http://'))
    ) {
      errors.push('evidence_uri must be a valid HTTP(S) URL');
    }
  }

  return errors;
}

/**
 * Sign an attestation record with the identity key.
 */
export function signAttestation(
  record: AttestationRecord,
  privateKey: Uint8Array,
  signerDID: string,
): SignedAttestation {
  const canonical = canonicalize(record as unknown as Record<string, unknown>);
  const signatureHex = signCanonical(canonical, privateKey);

  return {
    record,
    signature_hex: signatureHex,
    signer_did: signerDID,
  };
}

/**
 * Verify a signed attestation's signature.
 */
export function verifyAttestation(attestation: SignedAttestation, publicKey: Uint8Array): boolean {
  const canonical = canonicalize(attestation.record as unknown as Record<string, unknown>);
  return verifyCanonical(canonical, attestation.signature_hex, publicKey);
}

/**
 * Publish a signed attestation to the AT Protocol PDS.
 *
 * Uses the XRPC endpoint com.atproto.repo.createRecord to publish
 * the attestation under the signer's DID repo.
 *
 * Validates the attestation's record against the lexicon before publishing.
 * Returns the AT-URI of the created record (at://did/collection/rkey).
 *
 * Throws on validation failure, HTTP errors, or network issues.
 */
export async function publishToPDS(
  attestation: SignedAttestation,
  pdsURL: string,
): Promise<string> {
  // Validate before publishing
  const errors = validateLexicon(attestation.record);
  if (errors.length > 0) {
    throw new Error(`pds_publish: validation failed — ${errors.join('; ')}`);
  }

  const url = pdsURL.replace(/\/$/, '') + '/xrpc/com.atproto.repo.createRecord';

  const body = {
    repo: attestation.signer_did,
    collection: ATTESTATION_LEXICON,
    record: {
      ...attestation.record,
      signature_hex: attestation.signature_hex,
      signer_did: attestation.signer_did,
      $type: ATTESTATION_LEXICON,
      createdAt: new Date().toISOString(),
    },
  };

  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`pds_publish: HTTP ${response.status} — ${text}`);
  }

  const result = (await response.json()) as Record<string, unknown>;
  return (result.uri as string) ?? `at://${attestation.signer_did}/${ATTESTATION_LEXICON}`;
}
