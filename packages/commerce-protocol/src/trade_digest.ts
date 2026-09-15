/**
 * The trade digest family (TRADE_FIRST_STRATEGY §3.4, §4.2, §4.3) — the ONE
 * prefix family, `dina:commerce:trade:v1:<domain>`, shared by the tender
 * decline (`quote_decline.ts`, money-free, kernel-side) and the khata
 * documents (`trade_documents.ts`, the Commerce Pack's). Split out so the
 * decline wire can be carved from the money wire (RESEARCHER_KERNEL §5.B1)
 * without either side re-deriving the family: the domains, the field names
 * and the preimage are byte-identical to what shipped, and the frozen digest
 * vectors pin them.
 *
 * Every digest excludes its own field from its preimage and is
 * domain-separated; the ten §9.12 order domains are a closed vocabulary pinned
 * by frozen vectors and are not reopened here.
 */

import { bytesToHex, canonicalJson, utf8Bytes } from './canonical';

import type { Sha256Fn } from './digests';

// ---------------------------------------------------------------------------
// Digest family
// ---------------------------------------------------------------------------

/** Domain separation for trade documents. Distinct from §9.12's closed set. */
const TRADE_PREFIX = 'dina:commerce:trade:v1:';

export const TRADE_DIGEST_DOMAINS = [
  'quote_decline',
  'delivery_note',
  'delivery_receipt',
  'payment_note',
  'payment_ack',
] as const;

export type TradeDigestDomain = (typeof TRADE_DIGEST_DOMAINS)[number];

/** The digest field each domain excludes from its own input. */
export const TRADE_DIGEST_FIELD_BY_DOMAIN: Readonly<Record<TradeDigestDomain, string>> = {
  quote_decline: 'decline_digest',
  delivery_note: 'note_digest',
  delivery_receipt: 'receipt_digest',
  payment_note: 'note_digest',
  payment_ack: 'ack_digest',
};

/** Digest a record under a trade domain, excluding its own digest field. */
export function tradeRecordDigest(
  domain: TradeDigestDomain,
  record: Record<string, unknown>,
  sha256: Sha256Fn,
): string {
  const digestField = TRADE_DIGEST_FIELD_BY_DOMAIN[domain];
  const { [digestField]: _excluded, ...rest } = record;
  const preimage = `${TRADE_PREFIX}${domain}\n${canonicalJson(rest)}`;
  return bytesToHex(sha256(utf8Bytes(preimage)));
}

/** Verify a trade record's digest field against a recomputation. */
export function verifyTradeRecordDigest(
  domain: TradeDigestDomain,
  record: Record<string, unknown>,
  sha256: Sha256Fn,
): string | null {
  const digestField = TRADE_DIGEST_FIELD_BY_DOMAIN[domain];
  const claimed = record[digestField];
  if (typeof claimed !== 'string' || !/^[0-9a-f]{64}$/.test(claimed)) {
    return `digest: ${digestField} must be a 64-char lowercase hex string`;
  }
  const recomputed = tradeRecordDigest(domain, record, sha256);
  if (claimed !== recomputed) {
    return `digest: ${digestField} does not match the canonical ${domain} recomputation`;
  }
  return null;
}


/** `reason_code` bound shared by the decline and the receipt (§3.4, §4.2). */
export const MAX_TRADE_REASON_CODE_LENGTH = 64;

export function validateReasonCode(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TRADE_REASON_CODE_LENGTH) {
    return `${field}: must be a non-empty string of at most ${MAX_TRADE_REASON_CODE_LENGTH} characters`;
  }
  return null;
}

