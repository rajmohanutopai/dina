/**
 * Domain-separated commerce digests (§9.12).
 *
 * Ten digest domains, one per record family. Each digest:
 *
 * - has an explicit domain separator line, so a byte-identical payload
 *   digested under two domains yields two different hashes — a quote
 *   can never masquerade as an order;
 * - EXCLUDES its own digest field from the input;
 * - covers the canonical JSON bytes of everything else the record
 *   carries (envelope signatures and transport metadata are not
 *   record fields and therefore never in the input).
 *
 * The digest preimage is:
 *
 *     "dina:commerce:v1:<domain>" + "\n" + canonicalJson(input)
 *
 * hashed with SHA-256, hex-encoded. Hashing is caller-injected
 * (`Sha256Fn`) — this package is zero-runtime-deps; each runtime
 * supplies its own crypto, the @dina/protocol convention.
 *
 * The stage-recompute rule for delivery projections (§9.0) falls out
 * naturally: `projection_digest` is computed over exactly the fields
 * PRESENT at that disclosure stage, so widening the projection between
 * quote and order changes the digest.
 */

import { bytesToHex, canonicalJson, utf8Bytes } from './canonical';

/** Caller-injected SHA-256. Input: UTF-8 bytes. Output: 32-byte digest. */
export type Sha256Fn = (data: Uint8Array) => Uint8Array;

export const COMMERCE_DIGEST_DOMAINS = [
  'projection',
  'request',
  'quote',
  'terms',
  'order',
  'acknowledgement',
  'status',
  'cancellation',
  'result',
  'epoch',
] as const;

export type CommerceDigestDomain = (typeof COMMERCE_DIGEST_DOMAINS)[number];

/** The digest field each domain excludes from its own input. */
export const DIGEST_FIELD_BY_DOMAIN: Readonly<Record<CommerceDigestDomain, string>> = {
  projection: 'projection_digest',
  request: 'request_digest',
  quote: 'quote_digest',
  terms: 'terms_digest',
  order: 'order_digest',
  acknowledgement: 'acknowledgement_digest',
  status: 'status_digest',
  cancellation: 'cancellation_digest',
  result: 'result_digest',
  epoch: 'epoch_digest',
};

const DOMAIN_PREFIX = 'dina:commerce:v1:';

/**
 * Digest an arbitrary already-projected input under a domain. Most
 * callers want `commerceRecordDigest`, which also strips the record's
 * own digest field.
 */
export function commerceDigest(
  domain: CommerceDigestDomain,
  input: unknown,
  sha256: Sha256Fn,
): string {
  const preimage = `${DOMAIN_PREFIX}${domain}\n${canonicalJson(input)}`;
  return bytesToHex(sha256(utf8Bytes(preimage)));
}

/**
 * Digest a record under its domain, excluding the record's own digest
 * field (§9.12: "a digest field is excluded from its own input").
 * Other embedded digests (e.g. a quote's `terms_digest`, an order's
 * `quote_digest`) are ordinary fields and stay in.
 */
export function commerceRecordDigest(
  domain: CommerceDigestDomain,
  record: Record<string, unknown>,
  sha256: Sha256Fn,
): string {
  const digestField = DIGEST_FIELD_BY_DOMAIN[domain];
  const { [digestField]: _excluded, ...rest } = record;
  return commerceDigest(domain, rest, sha256);
}

/**
 * Verify a record's digest field against a recomputation. Returns
 * null when it matches, an error string when it does not or when the
 * field is missing/malformed.
 */
export function verifyCommerceRecordDigest(
  domain: CommerceDigestDomain,
  record: Record<string, unknown>,
  sha256: Sha256Fn,
): string | null {
  const digestField = DIGEST_FIELD_BY_DOMAIN[domain];
  const claimed = record[digestField];
  if (typeof claimed !== 'string' || !/^[0-9a-f]{64}$/.test(claimed)) {
    return `digest: ${digestField} must be a 64-char lowercase hex string`;
  }
  const recomputed = commerceRecordDigest(domain, record, sha256);
  if (claimed !== recomputed) {
    return `digest: ${digestField} does not match the canonical ${domain} recomputation`;
  }
  return null;
}
