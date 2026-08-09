/**
 * Order acknowledgement (§9.10): accepted | rejected | counterproposal.
 * Silence is not acceptance.
 *
 * The rejected variant carries a typed `reason_code` (open, bounded
 * vocabulary — the KNOWN_REJECTION_REASONS are the protocol-defined
 * ones) and, with `quote_superseded`, the `current_quote_digest` head so
 * the buyer can re-approve against live terms (§9.8). A
 * counterproposal embeds a full replacement SignedQuote that MUST
 * start a fresh quote_id at revision "1" with `replaces_quote_digest`
 * carrying the cross-family lineage (§9.9).
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
import { verifyCommerceRecordDigest, type Sha256Fn } from './digests';
import { validateSignedQuote, type SignedQuote } from './quote';

import type { PurchaseOrderProposal } from './order';

export interface OrderAcknowledgementBase {
  protocol_version: string;
  acknowledgement_id: string;
  purchase_order_id: string;
  order_digest: string;
  buyer_did: string;
  supplier_did: string;
  issued_at: string;
  acknowledgement_digest: string;
}

export type OrderAcknowledgement = OrderAcknowledgementBase &
  (
    | {
        kind: 'accepted';
        supplier_order_id: string;
        accepted_quote_digest: string;
        accepted_at: string;
      }
    | {
        kind: 'rejected';
        reason_code?: string;
        current_quote_digest?: string;
      }
    | {
        kind: 'counterproposal';
        replacement_quote: SignedQuote;
      }
  );

/** Protocol-defined rejection reasons (§9.9/§9.10). The set is open
 *  for supplier-policy codes; these are the ones with pinned
 *  semantics. */
export const KNOWN_REJECTION_REASONS = [
  'quote_consumed',
  'quote_superseded',
  'quote_expired',
  // §16.2: the family was VOIDED by a restore. Distinct from
  // quote_superseded because there is no live head to re-approve
  // against — the supplier must issue a fresh quote_id, and
  // quote_superseded's current_quote_digest would point at a digest that
  // can never become live again (registerSignedQuote refuses further
  // revisions on a voided family), livelocking the buyer.
  'quote_voided',
  'projection_mismatch',
  'decision_timeout',
] as const;

export const MAX_REASON_CODE_LENGTH = 64;

export function validateOrderAcknowledgement(ack: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(ack)) return 'ack: must be an object';
  const checks: (string | null)[] = [
    validateProtocolVersionShape(ack.protocol_version, 'ack.protocol_version'),
    validateId(ack.acknowledgement_id, 'ack.acknowledgement_id'),
    validateId(ack.purchase_order_id, 'ack.purchase_order_id'),
    validateHex64(ack.order_digest, 'ack.order_digest'),
    validateDid(ack.buyer_did, 'ack.buyer_did'),
    validateDid(ack.supplier_did, 'ack.supplier_did'),
    validateIsoUtc(ack.issued_at, 'ack.issued_at'),
  ];
  for (const err of checks) if (err) return err;

  switch (ack.kind) {
    case 'accepted': {
      const err =
        validateId(ack.supplier_order_id, 'ack.supplier_order_id') ??
        validateHex64(ack.accepted_quote_digest, 'ack.accepted_quote_digest') ??
        validateIsoUtc(ack.accepted_at, 'ack.accepted_at');
      if (err) return err;
      break;
    }
    case 'rejected': {
      if (ack.reason_code !== undefined) {
        if (
          typeof ack.reason_code !== 'string' ||
          ack.reason_code.length === 0 ||
          ack.reason_code.length > MAX_REASON_CODE_LENGTH ||
          !/^[a-z0-9_]+$/.test(ack.reason_code)
        ) {
          return 'ack.reason_code: must be a bounded snake_case code';
        }
      }
      if (ack.current_quote_digest !== undefined) {
        const err = validateHex64(ack.current_quote_digest, 'ack.current_quote_digest');
        if (err) return err;
      }
      if (ack.reason_code === 'quote_superseded' && ack.current_quote_digest === undefined) {
        return 'ack: quote_superseded requires current_quote_digest so the buyer can re-approve (§9.8)';
      }
      break;
    }
    case 'counterproposal': {
      const quoteError = validateSignedQuote(ack.replacement_quote, sha256);
      if (quoteError) return `ack.replacement_quote: ${quoteError}`;
      const replacement = ack.replacement_quote as unknown as SignedQuote;
      if (replacement.quote_revision !== '1') {
        return 'ack.replacement_quote: a counterproposal starts a fresh quote family at revision "1"';
      }
      if (replacement.replaces_quote_digest === undefined) {
        return 'ack.replacement_quote: replaces_quote_digest is required — cross-family lineage (§9.9)';
      }
      break;
    }
    default:
      return 'ack.kind: must be accepted | rejected | counterproposal';
  }
  return verifyCommerceRecordDigest('acknowledgement', ack, sha256);
}

/**
 * Bindings between an acknowledgement and the order it answers —
 * what the buyer checks before trusting the ack:
 *
 * - identity + purchase_order_id + order_digest match;
 * - accepted: accepted_quote_digest is the order's quote digest;
 * - counterproposal: the replacement's lineage points at the
 *   countered quote, under a FRESH quote_id (consumption state never
 *   carries across families, §9.9).
 */
/**
 * The order fields an acknowledgement is bound AGAINST.
 *
 * A `Pick` rather than the whole proposal, because a node checking an answer
 * that arrives LATER does not still hold the order — it holds a record of what
 * it sent. Demanding the full proposal is why this function shipped with no
 * production caller: the one place that needed it could not satisfy the type,
 * so the check was skipped rather than written. These six fields are exactly
 * what the check reads.
 */
export type AcknowledgementOrderBinding = Pick<
  PurchaseOrderProposal,
  'purchase_order_id' | 'order_digest' | 'buyer_did' | 'supplier_did' | 'quote_digest' | 'quote_id'
> &
  // §9.13's conversation version, when the caller has it. Optional because a
  // node checking a LATE answer holds a RECORD rather than the proposal; a
  // record carrying it gets the check, one that does not is no worse off than
  // before — and demanding it would put this function back out of reach of the
  // one place that most needs it, which is how it shipped with no caller.
  Partial<Pick<PurchaseOrderProposal, 'protocol_version'>>;

export function verifyAcknowledgementForOrder(
  ack: OrderAcknowledgement,
  order: AcknowledgementOrderBinding,
): string | null {
  if (ack.purchase_order_id !== order.purchase_order_id) return 'ack: purchase_order_id mismatch';
  if (ack.order_digest !== order.order_digest) return 'ack: order_digest mismatch';
  if (ack.buyer_did !== order.buyer_did || ack.supplier_did !== order.supplier_did) {
    return 'ack: buyer/supplier identity mismatch';
  }
  // §9.13 — the answer speaks the conversation's dialect. Checked only when
  // the binding carries the order's version: a caller holding a record rather
  // than the proposal may not have it, and demanding it would put this
  // function back out of reach of the one place that needs it most.
  if (order.protocol_version !== undefined) {
    const versioned = verifyConversationVersion(
      order.protocol_version,
      ack.protocol_version,
      'ack',
    );
    if (versioned !== null) return versioned;
  }
  if (ack.kind === 'accepted' && ack.accepted_quote_digest !== order.quote_digest) {
    return 'ack: accepted_quote_digest does not match the order quote digest';
  }
  if (ack.kind === 'counterproposal') {
    if (ack.replacement_quote.replaces_quote_digest !== order.quote_digest) {
      return 'ack: replacement quote lineage does not point at the countered quote';
    }
    if (ack.replacement_quote.quote_id === order.quote_id) {
      return 'ack: replacement quote must start a fresh quote_id';
    }
    // §9.13 — "a counterproposal cannot silently upgrade the conversation".
    // The acknowledgement's OWN version is checked above, and that is not the
    // same statement: the counterproposal carries a whole replacement quote,
    // and it is the quote's version an order gets built against. Checking only
    // the envelope would let a 1.0 exchange be answered in 1.0 while the terms
    // inside it moved to 1.5.
    //
    // A counterproposal starts a fresh quote FAMILY, so the intra-family
    // revision rule cannot see this — it compares revisions of one quote_id,
    // and this is a different one by construction.
    if (order.protocol_version !== undefined) {
      const countered = verifyConversationVersion(
        order.protocol_version,
        ack.replacement_quote.protocol_version,
        'ack.replacement_quote',
      );
      if (countered !== null) return countered;
    }
  }
  return null;
}
