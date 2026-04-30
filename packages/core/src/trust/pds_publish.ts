/**
 * PDS attestation publishing — sign and publish to AT Protocol PDS.
 *
 * Wire types come from `@dina/protocol` (TN-PROTO-001) so Lite, Brain
 * and mobile share one definition. The validator below mirrors
 * AppView's `attestationSchema` in
 * `appview/src/ingester/record-validator.ts` byte-for-byte — records
 * that pass `validateLexicon` here MUST be accepted by AppView; any
 * tightening here over what AppView accepts is a deliberate Lite
 * choice (e.g. the "must have ≥1 subject identifier" check).
 *
 * Source: core/test/pds_test.go (portable parts) +
 *         appview/src/ingester/record-validator.ts (wire contract).
 */

import {
  TRUST_NSIDS,
  type Attestation,
  type Confidence,
  type DimensionRating,
  type DimensionValue,
  type EvidenceItem,
  type Sentiment,
  type SubjectRef,
  type SubjectType,
} from '@dina/protocol';
import { canonicalize, signCanonical, verifyCanonical } from '../identity/signing';

// ── Re-exports of the canonical wire types ─────────────────────────

// Re-exported from `@dina/protocol` — Lite consumers continue
// importing from `@dina/core/trust/pds_publish`, but the type
// definitions live in one place. See `@dina/protocol/trust/types`.
export type {
  Attestation,
  Confidence,
  DimensionRating,
  DimensionValue,
  EvidenceItem,
  Sentiment,
  SubjectRef,
  SubjectType,
};

/**
 * Lite-side wrapper around an `Attestation` that adds the
 * pre-atproto signing model. Real atproto records are signed at the
 * commit (CAR) layer; this struct is what Lite carries before it
 * hands the record off to a PDS.
 */
export interface SignedAttestation {
  record: Attestation;
  signature_hex: string;
  signer_did: string;
}

// ── Validator constraints (mirrored from AppView Zod) ───────────────

const SUBJECT_TYPES: ReadonlySet<SubjectType> = new Set([
  'did',
  'content',
  'product',
  'dataset',
  'organization',
  'claim',
  'place',
]);

const SENTIMENTS: ReadonlySet<Sentiment> = new Set(['positive', 'neutral', 'negative']);

const DIMENSION_VALUES: ReadonlySet<DimensionValue> = new Set([
  'exceeded',
  'met',
  'below',
  'failed',
]);

const CONFIDENCES: ReadonlySet<Confidence> = new Set([
  'certain',
  'high',
  'moderate',
  'speculative',
]);

// Bound limits — match AppView's Zod schema. Diverging from these
// here is a recipe for "Lite says it's valid, AppView rejects on
// ingest" surprises.
const MAX_CATEGORY_LEN = 200;
const MAX_TEXT_LEN = 2000;
const MAX_TAGS = 10;
const MAX_TAG_LEN = 50;
const MAX_DOMAIN_LEN = 253;
const MAX_DIMENSIONS = 10;
const MAX_DIMENSION_NAME_LEN = 100;
const MAX_DIMENSION_NOTE_LEN = 500;
const MAX_EVIDENCE = 10;
const MAX_EVIDENCE_TYPE_LEN = 100;
const MAX_EVIDENCE_URI_LEN = 2048;
const MAX_EVIDENCE_HASH_LEN = 256;
const MAX_EVIDENCE_DESCRIPTION_LEN = 300;
const MAX_SUBJECT_NAME_LEN = 200;
const MAX_SUBJECT_IDENTIFIER_LEN = 500;
const MIN_DID_LEN = 8;
const MAX_DID_LEN = 2048;
const MIN_URI_LEN = 1;
const MAX_URI_LEN = 2048;

const DID_PREFIX_REGEX = /^did:[a-z]+:/;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * AT Protocol lexicon NSID for Dina trust attestations.
 *
 * Sourced from `@dina/protocol`'s canonical NSID table, which mirrors
 * the collections registered in AppView's ingester
 * (`appview/src/ingester/handlers/index.ts`).
 */
const ATTESTATION_LEXICON = TRUST_NSIDS.attestation;

// ── Injectable fetch (for testing) ──────────────────────────────────

let fetchFn: typeof globalThis.fetch = globalThis.fetch;

export function setPDSFetchFn(fn: typeof globalThis.fetch): void {
  fetchFn = fn;
}

export function resetPDSFetchFn(): void {
  fetchFn = globalThis.fetch;
}

// ── Validation ──────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDateNotTooFuture(value: string): boolean {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  return ms <= Date.now() + CLOCK_SKEW_MS;
}

function validateSubjectRef(ref: SubjectRef, errors: string[]): void {
  if (!isPlainObject(ref)) {
    errors.push('subject must be an object');
    return;
  }
  if (!ref.type || !SUBJECT_TYPES.has(ref.type)) {
    errors.push(
      `subject.type must be one of: ${[...SUBJECT_TYPES].sort().join(', ')}`,
    );
  }
  if (ref.did !== undefined) {
    if (
      typeof ref.did !== 'string' ||
      ref.did.length < MIN_DID_LEN ||
      ref.did.length > MAX_DID_LEN ||
      !DID_PREFIX_REGEX.test(ref.did)
    ) {
      errors.push(
        `subject.did must be a valid DID (${MIN_DID_LEN}–${MAX_DID_LEN} chars, did:method: prefix)`,
      );
    }
  }
  if (ref.uri !== undefined) {
    if (typeof ref.uri !== 'string' || ref.uri.length < MIN_URI_LEN || ref.uri.length > MAX_URI_LEN) {
      errors.push(`subject.uri must be a string ${MIN_URI_LEN}–${MAX_URI_LEN} chars`);
    }
  }
  if (ref.name !== undefined) {
    if (typeof ref.name !== 'string' || ref.name.length > MAX_SUBJECT_NAME_LEN) {
      errors.push('subject.name must be a string ≤200 chars');
    }
  }
  if (ref.identifier !== undefined) {
    if (typeof ref.identifier !== 'string' || ref.identifier.length > MAX_SUBJECT_IDENTIFIER_LEN) {
      errors.push('subject.identifier must be a string ≤500 chars');
    }
  }
  // Practical resolvability check: at least one identifying field
  // must be present. AppView's Zod doesn't formally require this,
  // but downstream subject resolution silently produces unusable
  // rows when none are set. Better to reject at the publisher.
  const hasIdentifier =
    typeof ref.did === 'string' ||
    typeof ref.uri === 'string' ||
    typeof ref.name === 'string' ||
    typeof ref.identifier === 'string';
  if (!hasIdentifier) {
    errors.push('subject must include at least one of: did, uri, name, identifier');
  }
}

function validateDimensions(dimensions: DimensionRating[], errors: string[]): void {
  if (!Array.isArray(dimensions)) {
    errors.push('dimensions must be an array');
    return;
  }
  if (dimensions.length > MAX_DIMENSIONS) {
    errors.push(`dimensions must have at most ${MAX_DIMENSIONS} entries`);
  }
  for (const [i, d] of dimensions.entries()) {
    if (!isPlainObject(d)) {
      errors.push(`dimensions[${i}] must be an object`);
      continue;
    }
    if (typeof d.dimension !== 'string' || d.dimension.length > MAX_DIMENSION_NAME_LEN) {
      errors.push(`dimensions[${i}].dimension must be a string ≤${MAX_DIMENSION_NAME_LEN} chars`);
    }
    if (!d.value || !DIMENSION_VALUES.has(d.value)) {
      errors.push(
        `dimensions[${i}].value must be one of: ${[...DIMENSION_VALUES].sort().join(', ')}`,
      );
    }
    if (d.note !== undefined) {
      if (typeof d.note !== 'string' || d.note.length > MAX_DIMENSION_NOTE_LEN) {
        errors.push(`dimensions[${i}].note must be a string ≤500 chars`);
      }
    }
  }
}

function validateEvidence(evidence: EvidenceItem[], errors: string[]): void {
  if (!Array.isArray(evidence)) {
    errors.push('evidence must be an array');
    return;
  }
  if (evidence.length > MAX_EVIDENCE) {
    errors.push(`evidence must have at most ${MAX_EVIDENCE} entries`);
  }
  for (const [i, e] of evidence.entries()) {
    if (!isPlainObject(e)) {
      errors.push(`evidence[${i}] must be an object`);
      continue;
    }
    if (typeof e.type !== 'string' || e.type.length > MAX_EVIDENCE_TYPE_LEN) {
      errors.push(`evidence[${i}].type must be a string ≤${MAX_EVIDENCE_TYPE_LEN} chars`);
    }
    if (e.uri !== undefined) {
      if (typeof e.uri !== 'string' || e.uri.length > MAX_EVIDENCE_URI_LEN) {
        errors.push(`evidence[${i}].uri must be a string ≤2048 chars`);
      }
    }
    if (e.hash !== undefined) {
      if (typeof e.hash !== 'string' || e.hash.length > MAX_EVIDENCE_HASH_LEN) {
        errors.push(`evidence[${i}].hash must be a string ≤256 chars`);
      }
    }
    if (e.description !== undefined) {
      if (typeof e.description !== 'string' || e.description.length > MAX_EVIDENCE_DESCRIPTION_LEN) {
        errors.push(`evidence[${i}].description must be a string ≤300 chars`);
      }
    }
  }
}

function validateTags(tags: string[], errors: string[]): void {
  if (!Array.isArray(tags)) {
    errors.push('tags must be an array');
    return;
  }
  if (tags.length > MAX_TAGS) {
    errors.push(`tags must have at most ${MAX_TAGS} entries`);
  }
  for (const [i, t] of tags.entries()) {
    if (typeof t !== 'string' || t.length > MAX_TAG_LEN) {
      errors.push(`tags[${i}] must be a string ≤${MAX_TAG_LEN} chars`);
    }
  }
}

/**
 * Validate an attestation record against the AppView wire contract.
 * Returns an array of human-readable error strings — empty when valid.
 */
export function validateLexicon(record: Attestation): string[] {
  const errors: string[] = [];

  if (!isPlainObject(record)) {
    return ['record must be an object'];
  }

  // Required fields
  if (!record.subject) {
    errors.push('subject is required');
  } else {
    validateSubjectRef(record.subject, errors);
  }

  if (!record.category || typeof record.category !== 'string' || record.category.length === 0) {
    errors.push('category is required (non-empty string)');
  } else if (record.category.length > MAX_CATEGORY_LEN) {
    errors.push(`category must be ≤${MAX_CATEGORY_LEN} chars`);
  }

  if (!record.sentiment || !SENTIMENTS.has(record.sentiment)) {
    errors.push(`sentiment must be one of: ${[...SENTIMENTS].sort().join(', ')}`);
  }

  if (!record.createdAt || typeof record.createdAt !== 'string') {
    errors.push('createdAt is required (ISO-8601 datetime with offset)');
  } else if (!isIsoDateNotTooFuture(record.createdAt)) {
    errors.push('createdAt must be a valid ISO datetime no more than 5 minutes in the future');
  }

  // Optional fields
  if (record.dimensions !== undefined) {
    validateDimensions(record.dimensions, errors);
  }
  if (record.text !== undefined) {
    if (typeof record.text !== 'string' || record.text.length > MAX_TEXT_LEN) {
      errors.push(`text must be a string ≤${MAX_TEXT_LEN} chars`);
    }
  }
  if (record.tags !== undefined) {
    validateTags(record.tags, errors);
  }
  if (record.domain !== undefined) {
    if (typeof record.domain !== 'string' || record.domain.length > MAX_DOMAIN_LEN) {
      errors.push(`domain must be a string ≤${MAX_DOMAIN_LEN} chars`);
    }
  }
  if (record.evidence !== undefined) {
    validateEvidence(record.evidence, errors);
  }
  if (record.confidence !== undefined && !CONFIDENCES.has(record.confidence)) {
    errors.push(`confidence must be one of: ${[...CONFIDENCES].sort().join(', ')}`);
  }
  if (record.isAgentGenerated !== undefined && typeof record.isAgentGenerated !== 'boolean') {
    errors.push('isAgentGenerated must be a boolean');
  }

  return errors;
}

// ── Signing + verifying ─────────────────────────────────────────────

/**
 * Sign an attestation record with the publisher's identity key.
 *
 * The canonical bytes cover the entire record including `createdAt`,
 * so any post-sign mutation invalidates the signature. Callers must
 * therefore set `createdAt` before signing.
 */
export function signAttestation(
  record: Attestation,
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
 * Verify a signed attestation's signature against the given public key.
 */
export function verifyAttestation(attestation: SignedAttestation, publicKey: Uint8Array): boolean {
  const canonical = canonicalize(attestation.record as unknown as Record<string, unknown>);
  return verifyCanonical(canonical, attestation.signature_hex, publicKey);
}

// ── Publishing ──────────────────────────────────────────────────────

/**
 * Publish a signed attestation to the AT Protocol PDS via
 * `com.atproto.repo.createRecord`. Returns the AT-URI of the
 * created record.
 *
 * The validator runs first; throws on validation failure, HTTP
 * errors, or network issues.
 */
export async function publishToPDS(
  attestation: SignedAttestation,
  pdsURL: string,
): Promise<string> {
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
      // `signature_hex` and `signer_did` are an artifact of Lite's
      // pre-atproto signing model. Real atproto records are signed
      // at the commit (CAR) layer, not embedded per-record. Kept here
      // for backward compatibility with existing PDS adapters that
      // expect them; future TN-LITE-7 will retire this in favour of
      // commit-level signatures.
      signature_hex: attestation.signature_hex,
      signer_did: attestation.signer_did,
      $type: ATTESTATION_LEXICON,
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
  if (typeof result.uri !== 'string' || result.uri.length === 0) {
    throw new Error('pds_publish: PDS response missing AT-URI');
  }
  return result.uri;
}
