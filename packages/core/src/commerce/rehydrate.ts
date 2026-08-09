/**
 * Rehydration through the ingress validator (WS-0.7 / ARCH-3).
 *
 * A record arriving on the wire is validated before anything acts on it. The
 * SAME record read back from the receipt store was, until now, `JSON.parse(…)
 * as PurchaseOrderProposal` — a cast, which is a promise to the compiler and a
 * check of nothing.
 *
 * WHY THAT ASYMMETRY IS WORTH CLOSING. The store is not an attacker, so this
 * is not a security hole; it is an INTEGRITY one, and the difference matters
 * for how it fails. A receipt written by an older build, truncated by a
 * half-finished migration, or corrupted on disk flows straight into decision
 * logic that was written assuming ingress had already checked it — and the
 * first symptom is a wrong commercial outcome rather than an error. Running
 * the same validator on the way out turns that into a loud, immediate refusal
 * at the point of reading.
 *
 * WHY A NULL RETURN RATHER THAN A THROW HERE. The caller knows what an
 * unreadable record means in its context: for most of them it is impossible
 * state and becomes a `CommerceIntegrityError`, but the reconcile path can
 * legitimately meet a record it cannot use and must answer rather than crash.
 * Returning the failure lets each caller say which it is.
 */

import type { EnvelopeEvidence } from './buyer_status';

import {
  readPurchaseOrderProposal,
  readSignedQuote,
  validateCatalogPointer,
  validateCommerceOrderStatus,
  validatePurchaseOrderLines,
  validatePurchaseOrderProposal,
  validateOrderAcknowledgement,
  validateQuoteRequest,
  type CatalogPointer,
  type CommerceOrderStatus,
  type OrderAcknowledgement,
  type PurchaseOrderLine,
  type PurchaseOrderProposal,
  type QuoteRequest,
  type RetainedEnvelope,
  type SignedQuote,
} from '@dina/commerce-protocol';

export type Sha256Fn = Parameters<typeof validatePurchaseOrderProposal>[1];

export interface RehydrateFailure {
  error: string;
}

export type Rehydrated<T> = { ok: true; value: T } | ({ ok: false } & RehydrateFailure);

function parse(json: string): { ok: true; value: unknown } | ({ ok: false } & RehydrateFailure) {
  try {
    return { ok: true, value: JSON.parse(json) };
  } catch (error) {
    return {
      ok: false,
      error: `stored record is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Read a purchase order back from a receipt, through the ingress validator.
 *
 * `validatePurchaseOrderProposal` re-derives the order digest, so this also
 * catches a record whose stored digest no longer matches its own content —
 * the one corruption a shape check alone would miss.
 */
export function rehydratePurchaseOrder(
  json: string,
  sha256: Sha256Fn,
): Rehydrated<PurchaseOrderProposal> {
  const parsed = parse(json);
  if (!parsed.ok) return parsed;
  const read = readPurchaseOrderProposal(parsed.value, sha256);
  // No cast: the reader hands back a TYPED order or the reason it is not one.
  return read.ok
    ? { ok: true, value: read.order }
    : { ok: false, error: `stored order failed validation: ${read.error}` };
}

/** Read a signed quote back from a receipt, through the ingress validator. */
export function rehydrateSignedQuote(json: string, sha256: Sha256Fn): Rehydrated<SignedQuote> {
  const parsed = parse(json);
  if (!parsed.ok) return parsed;
  const read = readSignedQuote(parsed.value, sha256);
  return read.ok
    ? { ok: true, value: read.quote }
    : { ok: false, error: `stored quote failed validation: ${read.error}` };
}

/**
 * Read a quote REQUEST back from a receipt, through the ingress validator.
 *
 * WHY THIS ONE MATTERS MORE THAN THE OTHER FOUR. The retained request carries
 * the PRICED DELIVERY PROJECTION, and admission checks an incoming order's
 * delivery against it (§9.9). So this record is not merely data being read
 * back — it is the yardstick a commercial decision is measured with. Reading
 * it as `JSON.parse(…) as {delivery: {projection}}`, which is what admission
 * did, meant a projection edited in the store after writing became the
 * standard the order had to match, and a mismatched order would pass.
 *
 * `validateQuoteRequest` ends in `verifyCommerceRecordDigest`, so it
 * re-derives the request digest from the content and catches exactly that.
 * The cast could not.
 *
 * It also removes a throw. `JSON.parse` on a corrupt record threw out of
 * `admitInTx` — inside a transaction, on the inbound D2D path — where the
 * surrounding code is written to return typed refusals.
 */
export function rehydrateQuoteRequest(json: string, sha256: Sha256Fn): Rehydrated<QuoteRequest> {
  const parsed = parse(json);
  if (!parsed.ok) return parsed;
  const invalid = validateQuoteRequest(parsed.value, sha256);
  if (invalid !== null) return { ok: false, error: invalid };
  return { ok: true, value: parsed.value as QuoteRequest };
}

/**
 * Read a stored ACKNOWLEDGEMENT back, through the ingress validator.
 *
 * This is the supplier's committed answer, and a replayed submission receives
 * it verbatim — so an unreadable one must not become the answer. Two failures
 * were reachable through the cast it replaces: a corrupt column THREW out of
 * admission, and `JSON.parse('null') as OrderAcknowledgement` produced a
 * `null` typed as a commitment, which would have been handed back to a buyer
 * as "here is what we agreed".
 *
 * `validateOrderAcknowledgement` re-derives the acknowledgement digest, so a
 * record edited after writing is caught here rather than believed.
 */
export function rehydrateAcknowledgement(
  json: string | null,
  sha256: Sha256Fn,
): Rehydrated<OrderAcknowledgement> {
  if (json === null || json === '') {
    return { ok: false, error: 'stored acknowledgement is absent' };
  }
  const parsed = parse(json);
  if (!parsed.ok) return parsed;
  const invalid = validateOrderAcknowledgement(parsed.value, sha256);
  if (invalid !== null) return { ok: false, error: invalid };
  return { ok: true, value: parsed.value as OrderAcknowledgement };
}

/**
 * Read this node's OWN published catalog pointer back (§10.2).
 *
 * The odd one out: no digest to re-derive, because a pointer is not a digested
 * record — it is the mutable head that NAMES one. What it gets instead is the
 * same structural validator a CONSUMER runs against a pointer it fetched from
 * the repo, which is the strongest check available and the right one: a row
 * this build cannot read the way a buyer would is a row this node must not act
 * on either.
 *
 * The failure it prevents is specific. The stored pointer decides where the
 * chain is, so a row that lost `snapshot_sequence` — or that reads back as
 * `null`, which `JSON.parse` will happily produce — would either throw on the
 * owner's screen or, worse, be treated as "nothing published yet" and invite a
 * GENESIS publication over a live chain.
 */
export function rehydrateCatalogPointer(json: string): Rehydrated<CatalogPointer> {
  const parsed = parse(json);
  if (!parsed.ok) return parsed;
  const invalid = validateCatalogPointer(parsed.value);
  if (invalid !== null) return { ok: false, error: `stored catalog pointer: ${invalid}` };
  return { ok: true, value: parsed.value as CatalogPointer };
}

/**
 * Read a supplier-signed status back from the buyer's chain.
 *
 * The strictest of these, because this record is not merely data being read
 * back — it is the YARDSTICK the next inbound status is measured against. A
 * tampered head would let a real successor be called a fork, or a forged one
 * be called a successor, so the digest is re-derived and the row's own digest
 * column must agree with the record it stores.
 */
export function rehydrateOrderStatus(
  json: string,
  expectedDigest: string,
  sha256: Sha256Fn,
): Rehydrated<CommerceOrderStatus> {
  const parsed = parse(json);
  if (!parsed.ok) return parsed;
  const error = validateCommerceOrderStatus(parsed.value, sha256);
  if (error !== null) return { ok: false, error };
  const status = parsed.value as CommerceOrderStatus;
  if (status.status_digest !== expectedDigest) {
    return { ok: false, error: `stored status does not match its row digest ${expectedDigest}` };
  }
  return { ok: true, value: status };
}

/**
 * Read back the order lines a buyer kept when it sent the order (§9.11).
 *
 * No digest to re-derive — the lines are stored beside the order rather than
 * as a signed record — so the check is the ingress line rule, run through the
 * protocol's own function rather than a second copy of it here.
 */
export function rehydrateOrderLines(json: string): Rehydrated<PurchaseOrderLine[]> {
  const parsed = parse(json);
  if (!parsed.ok) return parsed;
  const error = validatePurchaseOrderLines(parsed.value, 'order_lines_json');
  if (error !== null) return { ok: false, error };
  return { ok: true, value: parsed.value as PurchaseOrderLine[] };
}

/**
 * Read the retained D2D envelope beside a stored commerce record (§12.7).
 *
 * NULL rather than a throw, and the distinction matters: a record whose
 * envelope cannot be read is a record the buyer cannot ATTRIBUTE, which is a
 * weaker claim than "the chain is corrupt". It drops out of the evidence view
 * and the record itself stands.
 *
 * No digest to re-derive — the envelope signature is verified by the
 * COUNTERPARTY that receives it, against the supplier's key, which this node
 * does not hold. All that is checked here is that both halves are present:
 * an id with no signature proves nothing, and a signature with no id names
 * nothing to verify it against.
 */
export function rehydrateEnvelopeEvidence(json: unknown): EnvelopeEvidence | null {
  if (typeof json !== 'string' || json === '') return null;
  const parsed = parse(json);
  if (!parsed.ok) return null;
  const value = parsed.value;
  if (value === null || typeof value !== 'object') return null;
  const { envelopeId, signature, envelope } = value as Record<string, unknown>;
  if (typeof envelopeId !== 'string' || envelopeId === '') return null;
  if (typeof signature !== 'string' || signature === '') return null;
  const retained = rehydrateRetainedEnvelope(envelope);
  // ALL OR NOTHING. A row written before the envelope was retained holds a
  // signature over bytes nobody kept, so it can never verify. Returning it
  // without the envelope would present unverifiable evidence as evidence —
  // the supplier would read a failed check as a fork rather than as a gap in
  // what this buyer stored. Dropping it is the honest answer: nothing held.
  if (retained === null) return null;
  return { envelopeId, signature, envelope: retained };
}

function rehydrateRetainedEnvelope(value: unknown): RetainedEnvelope | null {
  if (value === null || typeof value !== 'object') return null;
  const { id, type, from, to, created_time, body } = value as Record<string, unknown>;
  for (const field of [id, type, from, body]) {
    if (typeof field !== 'string' || field === '') return null;
  }
  // A NUMBER, and checked as one. JSON round-trips it faithfully, but a row
  // written by an older build (or edited by anything with the file open) could
  // hold a string, and the rebuilt bytes would then differ from the signed
  // ones in a way no error would name.
  if (typeof created_time !== 'number' || !Number.isFinite(created_time)) return null;
  if (!Array.isArray(to) || to.length === 0) return null;
  if (to.some((entry) => typeof entry !== 'string' || entry === '')) return null;
  return {
    id: id as string,
    type: type as string,
    from: from as string,
    to: to as string[],
    created_time,
    body: body as string,
  };
}
