/**
 * Negotiation documents (NEGOTIATION_PLAN §4.2, §4.5).
 *
 * `CounterOffer` — a buyer asks a supplier to come down on a quote it holds.
 * It names the exact head it counters (`quote_digest`), a whole-quote target
 * in the quote's own currency, and a round. It binds nobody: the supplier's
 * answer is either a revision of the held quote (the ordinary §9.8 chain) or
 * the head unchanged. Digest-sealed under its own commerce domain so both
 * sides can retain it as evidence and replay by `counter_id`.
 *
 * `QuoteOutcomeNotice` — the buyer tells a supplier its quote was not
 * awarded. It carries no price and names no winner (TRADE_FIRST §3 price
 * secrecy); it is a notice inside a signed envelope, not a record either
 * side proves anything with, so it has no digest.
 */

import {
  isoUtcMillis,
  isRecord,
  validateDid,
  validateHex64,
  validateId,
  validateIsoUtc,
  validateProtocolVersionShape,
} from './common';
import { verifyCommerceRecordDigest, type Sha256Fn } from './digests';
import { validateMoney, type Money } from './money';
import { validateCanonicalPositiveInteger } from './numeric';

/** Rounds are small by design; nine digits is the revision bound's size. */
export const MAX_COUNTER_ROUND_DIGITS = 9;

export interface CounterOffer {
  protocol_version: string;
  counter_id: string;
  quote_id: string;
  /** The head the buyer is countering. A stale head is answered, never revised. */
  quote_digest: string;
  buyer_did: string;
  supplier_did: string;
  round: string;
  target_total: Money;
  issued_at: string;
  respond_by: string;
  counter_digest: string;
}

export type ReadCounterOffer = { ok: true; counter: CounterOffer } | { ok: false; error: string };

export function validateCounterOffer(value: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(value)) return 'counter: must be an object';
  const checks: (string | null)[] = [
    validateProtocolVersionShape(value.protocol_version, 'counter.protocol_version'),
    validateId(value.counter_id, 'counter.counter_id'),
    validateId(value.quote_id, 'counter.quote_id'),
    validateHex64(value.quote_digest, 'counter.quote_digest'),
    validateDid(value.buyer_did, 'counter.buyer_did'),
    validateDid(value.supplier_did, 'counter.supplier_did'),
    validateIsoUtc(value.issued_at, 'counter.issued_at'),
    validateIsoUtc(value.respond_by, 'counter.respond_by'),
  ];
  for (const err of checks) if (err) return err;
  const roundError = validateCanonicalPositiveInteger(
    value.round as string,
    MAX_COUNTER_ROUND_DIGITS,
  );
  if (roundError) return `counter.round: ${roundError}`;
  const moneyError = validateMoney(value.target_total);
  if (moneyError) return `counter.target_total: ${moneyError}`;
  if (BigInt((value.target_total as Money).minor_units) <= 0n) {
    return 'counter.target_total: must be above zero';
  }
  if (value.buyer_did === value.supplier_did) {
    return 'counter: buyer and supplier must differ';
  }
  if (isoUtcMillis(value.respond_by as string) <= isoUtcMillis(value.issued_at as string)) {
    return 'counter.respond_by: must be after issued_at';
  }
  return verifyCommerceRecordDigest('counter', value, sha256);
}

export function readCounterOffer(value: unknown, sha256: Sha256Fn): ReadCounterOffer {
  const error = validateCounterOffer(value, sha256);
  return error === null ? { ok: true, counter: value as CounterOffer } : { ok: false, error };
}

export const QUOTE_OUTCOMES = ['not_awarded'] as const;
export type QuoteOutcome = (typeof QUOTE_OUTCOMES)[number];

export interface QuoteOutcomeNotice {
  request_id: string;
  quote_id: string;
  outcome: QuoteOutcome;
}

/** Shape only: the receiver binds it to a quote the sender actually holds. */
export function validateQuoteOutcomeNotice(value: unknown): string | null {
  if (!isRecord(value)) return 'quoteOutcome: must be an object';
  const err =
    validateId(value.request_id, 'quoteOutcome.request_id') ??
    validateId(value.quote_id, 'quoteOutcome.quote_id');
  if (err) return err;
  if (
    typeof value.outcome !== 'string' ||
    !(QUOTE_OUTCOMES as readonly string[]).includes(value.outcome)
  ) {
    return `quoteOutcome.outcome: must be ${QUOTE_OUTCOMES.join(' | ')}`;
  }
  // A notice that carried a price or a winner would break price secrecy on
  // the wire; refusing extra fields keeps the notice to what it may say.
  for (const key of Object.keys(value)) {
    if (!['request_id', 'quote_id', 'outcome'].includes(key)) {
      return `quoteOutcome: unexpected field "${key}" — a notice carries no terms`;
    }
  }
  return null;
}
