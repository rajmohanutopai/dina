/**
 * QuoteDecline (TRADE_FIRST_STRATEGY §3.4) — the tender's OTHER answer: a
 * supplier saying, verifiably, that it is not quoting this request. MONEY-FREE
 * and kernel-side (RESEARCHER_KERNEL §5.B1): the decline closes a conversation
 * on the quote lane and touches no ledger, so it lives apart from the khata
 * documents (`trade_documents.ts`) that move with the Commerce Pack. Same
 * construction discipline, same digest family (`trade_digest.ts`), same
 * bytes on the wire as before the carve.
 */

import {
  verifyConversationVersion,
  isRecord,
  validateDid,
  validateHex64,
  validateId,
  validateIsoUtc,
  validateProtocolVersionShape,
} from './common';
import { validateReasonCode, verifyTradeRecordDigest } from './trade_digest';

import type { Sha256Fn } from './digests';
import type { QuoteRequest } from './quote';

/**
 * Protocol-defined decline reasons (§3.4). The set is open for
 * supplier-policy codes; these carry pinned semantics.
 * `unknown_buyer` joins in phase 3, when strangers can ask at all.
 */
export const KNOWN_QUOTE_DECLINE_REASONS = ['out_of_region', 'capacity', 'policy'] as const;

/* eslint-disable @typescript-eslint/consistent-type-definitions --
   the catalog_publication.ts rule: only a type alias carries the implicit
   index signature that makes these records assignable to the
   `Record<string, unknown>` the digest functions take. As interfaces,
   every digest call site needs an `as unknown as` double-cast — the cast
   family a prior wire bug shipped through. */
export type QuoteDecline = {
  protocol_version: string;
  decline_id: string;
  request_id: string;
  request_digest: string;
  buyer_did: string;
  supplier_did: string;
  reason_code: string;
  issued_at: string;
  decline_digest: string;
}

export type ReadQuoteDecline = { ok: true; decline: QuoteDecline } | { ok: false; error: string };

export function validateQuoteDecline(decline: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(decline)) return 'decline: must be an object';
  const checks: (string | null)[] = [
    validateProtocolVersionShape(decline.protocol_version, 'decline.protocol_version'),
    validateId(decline.decline_id, 'decline.decline_id'),
    validateId(decline.request_id, 'decline.request_id'),
    validateHex64(decline.request_digest, 'decline.request_digest'),
    validateDid(decline.buyer_did, 'decline.buyer_did'),
    validateDid(decline.supplier_did, 'decline.supplier_did'),
    validateReasonCode(decline.reason_code, 'decline.reason_code'),
    validateIsoUtc(decline.issued_at, 'decline.issued_at'),
  ];
  for (const err of checks) if (err) return err;
  return verifyTradeRecordDigest('quote_decline', decline, sha256);
}

export function readQuoteDecline(decline: unknown, sha256: Sha256Fn): ReadQuoteDecline {
  const error = validateQuoteDecline(decline, sha256);
  return error === null ? { ok: true, decline: decline as QuoteDecline } : { ok: false, error };
}

/**
 * A decline against the RETAINED request it claims to answer: identity,
 * digest, parties and the §9.13 version all must line up — a decline for
 * some other request must not close this conversation.
 */
export function verifyQuoteDeclineAgainstRequest(
  decline: QuoteDecline,
  request: QuoteRequest,
): string | null {
  if (decline.request_id !== request.request_id) {
    return 'decline: request_id does not match the retained request';
  }
  if (decline.request_digest !== request.request_digest) {
    return 'decline: request_digest does not match the retained request';
  }
  if (decline.buyer_did !== request.buyer_did || decline.supplier_did !== request.supplier_did) {
    return 'decline: parties do not match the retained request';
  }
  return verifyConversationVersion(request.protocol_version, decline.protocol_version, 'decline');
}

