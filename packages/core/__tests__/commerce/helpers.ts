/**
 * Commerce document fixtures for Core engine tests — built through
 * the @dina/commerce-protocol PUBLIC API (digest-correct by
 * construction, §9.1-consistent arithmetic).
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';

import { buildMessageJSON } from '@dina/protocol';

import { getPublicKey, sign } from '../../src/crypto/ed25519';
import { makeHeldEvidenceVerifier } from '../../src/commerce/held_evidence_verifier';

import type { RetainedEnvelope } from '@dina/commerce-protocol';

import {
  commerceRecordDigest,
  computeLineSubtotal,
  computeProjectionDigest,
  termsDigestInput,
  type DeliveryProjection,
  type PurchaseOrderProposal,
  type QuoteRequest,
  type Sha256Fn,
  type SignedQuote,
  type SignedQuoteLine,
} from '@dina/commerce-protocol';

import {
  CommerceAdmissionEngine,
  CommerceAdmissionService,
  CommerceTransaction,
  CommerceLifecycleEngine,
  CommerceReconciliationService,
  CommerceOrderStore,
  type AdmissionEngineDeps,
  type LifecycleEngineDeps,
  QuoteFamilyStore,
  StatusChainStore,
  type CommerceOrderRefRepository,
  type CommerceQuoteLedgerRepository,
  type CommerceStatusHeadRepository,
} from '../../src/commerce';

export const hash: Sha256Fn = (data) => sha256(data);

/**
 * Quote state as the production code sees it: an aggregate store, never
 * the raw ledger. Tests that reach past this are testing a surface the
 * engines no longer have.
 */
/**
 * Status-chain state as the production code sees it: an aggregate store,
 * never the raw head repository.
 */
/** Order state as production sees it: an aggregate store. */
export function makeOrders(
  refs: CommerceOrderRefRepository,
  clock: { now: number },
): CommerceOrderStore {
  return new CommerceOrderStore({ refs, now: () => clock.now });
}

export function makeChains(
  heads: CommerceStatusHeadRepository,
  clock: { now: number },
  currentEpoch: () => string = () => '1',
): StatusChainStore {
  return new StatusChainStore({ heads, currentEpoch, now: () => clock.now });
}

export function makeFamilies(
  ledger: CommerceQuoteLedgerRepository,
  clock: { now: number },
  currentEpoch: () => string = () => '1',
  supplierDid: string = SUPPLIER_DID,
): QuoteFamilyStore {
  return new QuoteFamilyStore({
    ledger,
    currentEpoch,
    supplierDid: () => supplierDid,
    now: () => clock.now,
  });
}

export const BUYER_DID = 'did:plc:buyer1234';
export const SUPPLIER_DID = 'did:plc:supplier5678';

export function makeProjection(
  fields: Partial<Omit<DeliveryProjection, 'projection_digest'>> = {},
): DeliveryProjection {
  const base: Omit<DeliveryProjection, 'projection_digest'> = {
    region: { scheme: 'postal_area', value: '682001' },
    ...fields,
  };
  return { ...base, projection_digest: computeProjectionDigest(base, hash) };
}

export function makeQuoteRequest(overrides: Partial<QuoteRequest> = {}): QuoteRequest {
  const draft = {
    protocol_version: '1.0',
    request_id: 'req-1',
    buyer_did: BUYER_DID,
    supplier_did: SUPPLIER_DID,
    lines: [
      {
        line_id: 'l1',
        product: { scheme: 'gtin' as const, value: '09506000134352' },
        requested_quantity: { value: '100', unit_code: 'each' },
      },
    ],
    delivery: { projection: makeProjection() },
    issued_at: '2026-08-07T10:00:00.000Z',
    expires_at: '2026-08-08T10:00:00.000Z',
    idempotency_key: 'idem-req-1',
    ...overrides,
  };
  return {
    ...draft,
    request_digest: commerceRecordDigest('request', draft as Record<string, unknown>, hash),
  } as QuoteRequest;
}

export function makeSignedQuote(
  request: QuoteRequest,
  overrides: Partial<SignedQuote> = {},
): SignedQuote {
  const lineBase = {
    line_id: 'l1',
    requested_product: { scheme: 'gtin' as const, value: '09506000134352' },
    offered_product: { scheme: 'gtin' as const, value: '09506000134352' },
    quantity: { value: '100', unit_code: 'each' },
    price_basis: { value: '1', unit_code: 'each' },
    unit_price: { currency: 'INR', minor_units: '500' },
    stock_status: 'available' as const,
  };
  const subtotal = computeLineSubtotal(
    lineBase.unit_price,
    lineBase.quantity,
    lineBase.price_basis,
  );
  if (subtotal.error || !subtotal.value) throw new Error(String(subtotal.error));
  const line: SignedQuoteLine = { ...lineBase, line_subtotal: subtotal.value };
  const draft = {
    protocol_version: '1.0',
    quote_id: 'q-1',
    request_id: request.request_id,
    request_digest: request.request_digest,
    buyer_did: request.buyer_did,
    supplier_did: request.supplier_did,
    quote_revision: '1',
    priced_delivery_projection_digest: request.delivery.projection.projection_digest,
    lines: [line],
    charges: [],
    total: subtotal.value,
    issued_at: '2026-08-07T11:00:00.000Z',
    valid_until: '2026-08-08T09:00:00.000Z',
    supplier_epoch: '1',
    ...overrides,
  };
  const terms_digest = commerceRecordDigest('terms', termsDigestInput(draft as never), hash);
  const withTerms = { ...draft, terms_digest };
  return {
    ...withTerms,
    quote_digest: commerceRecordDigest('quote', withTerms as Record<string, unknown>, hash),
  } as SignedQuote;
}

/** Revision N+1 extending `held` (same family). */
export function makeRevision(held: SignedQuote, overrides: Partial<SignedQuote> = {}): SignedQuote {
  const { quote_digest: _q, terms_digest: _t, ...rest } = held;
  const draft = {
    ...rest,
    quote_revision: (BigInt(held.quote_revision) + 1n).toString(10),
    previous_quote_digest: held.quote_digest,
    ...overrides,
  };
  const terms_digest = commerceRecordDigest('terms', termsDigestInput(draft as never), hash);
  const withTerms = { ...draft, terms_digest };
  return {
    ...withTerms,
    quote_digest: commerceRecordDigest('quote', withTerms as Record<string, unknown>, hash),
  } as SignedQuote;
}

export function makeOrder(
  quote: SignedQuote,
  priced_projection: DeliveryProjection,
  overrides: Partial<PurchaseOrderProposal> = {},
): PurchaseOrderProposal {
  const { projection_digest: _d, ...pricedFields } = priced_projection;
  const deliveryBase = { ...pricedFields, recipient_name: 'Stores Desk' };
  const draft = {
    protocol_version: '1.0',
    purchase_order_id: 'po-1',
    buyer_did: quote.buyer_did,
    supplier_did: quote.supplier_did,
    quote_id: quote.quote_id,
    quote_digest: quote.quote_digest,
    accepted_lines: quote.lines.map((l) => ({
      line_id: l.line_id,
      product: l.offered_product,
      quantity: l.quantity,
    })),
    delivery: { ...deliveryBase, projection_digest: computeProjectionDigest(deliveryBase, hash) },
    approved_total: quote.total,
    accepted_terms_digest: quote.terms_digest,
    idempotency_key: 'idem-po-1',
    submitted_at: '2026-08-07T12:00:00.000Z',
    ...overrides,
  };
  return {
    ...draft,
    order_digest: commerceRecordDigest('order', draft as Record<string, unknown>, hash),
  } as PurchaseOrderProposal;
}

/**
 * The admission surface as PRODUCTION sees it: the service, not the engine.
 *
 * After ARCH-0b the engine holds no transaction runner and exposes only
 * `…InTx` methods, so a test that constructed one directly would be driving a
 * shape no caller has. This helper takes the same deps the engine always took
 * — `tx` included — and returns the service composed over it, which is what
 * the runtime hands out.
 *
 * The engine comes back too, for the two tests that need to reach an `…InTx`
 * method from inside a transaction they opened themselves.
 */
export function makeAdmission(
  deps: { tx: (fn: () => void) => void } & AdmissionEngineDeps,
): CommerceAdmissionService & { engine: CommerceAdmissionEngine } {
  const { tx, ...engineDeps } = deps;
  const engine = new CommerceAdmissionEngine(engineDeps as AdmissionEngineDeps);
  const service = new CommerceAdmissionService({
    transaction: new CommerceTransaction(tx),
    engine,
  });
  return Object.assign(service, { engine });
}

/**
 * The lifecycle surface as PRODUCTION sees it: the reconciliation service.
 *
 * The twin of `makeAdmission`, and for the same reason — after ARCH-0c the
 * engine holds no transaction runner. The engine is returned alongside for the
 * §12.8 genesis seam, which admission calls from inside its own transaction.
 */
export function makeLifecycle(
  deps: { tx: (fn: () => void) => void } & LifecycleEngineDeps,
): CommerceReconciliationService {
  const { tx, ...engineDeps } = deps;
  // No `Object.assign` here, unlike `makeAdmission`: the service already
  // exposes `engine` as a GETTER for the §12.8 seam, and assigning over a
  // getter-only property throws at runtime rather than at compile time.
  return new CommerceReconciliationService({
    transaction: new CommerceTransaction(tx),
    engine: new CommerceLifecycleEngine(engineDeps as LifecycleEngineDeps),
  });
}

// ---------------------------------------------------------------------------
// §12.7/§16.2 held evidence — real envelopes, real signatures
// ---------------------------------------------------------------------------

/**
 * The supplier's signing key for tests.
 *
 * A REAL keypair, and the evidence below carries a REAL signature over a
 * REAL message, because the thing under test is whether a supplier can
 * tell its own past signature from a buyer's claim. Hand-built evidence
 * beside a `() => true` verifier tests the plumbing and nothing else —
 * and the whole defect this fixture exists for was a check that could not
 * fail.
 */
export const SUPPLIER_SIGNING_KEY = new Uint8Array(32).fill(7);
export const SUPPLIER_PUBLIC_KEY = getPublicKey(SUPPLIER_SIGNING_KEY);

/** Resolves ONLY the supplier's DID, like a node that knows its own key. */
export const supplierKeyResolver = (did: string): Uint8Array | null =>
  did === SUPPLIER_DID ? SUPPLIER_PUBLIC_KEY : null;

/** The production verifier, over the test key. Not a stub. */
export const realHeldEvidenceVerifier = makeHeldEvidenceVerifier(supplierKeyResolver);

/**
 * Build held evidence the way a buyer really acquires it: wrap the record
 * in a `service.response` body, build the message, sign it, and keep all
 * three.
 *
 * `overrides` exists so a test can corrupt exactly one thing — send it
 * from the wrong DID, address it to another buyer, or leave the record
 * out of the signed body — and watch that single change be rejected.
 */
export function makeHeldEvidence<T extends object>(
  record: T,
  overrides: {
    from?: string;
    to?: string[];
    /** Replaces the body wholesale, for "signature over other bytes" cases. */
    body?: string;
    /** Signs with a different key, for "not my signature" cases. */
    signingKey?: Uint8Array;
  } = {},
): { record: T; envelope: RetainedEnvelope; signature: string } {
  const body =
    overrides.body ??
    JSON.stringify({
      capability: 'com.dinakernel.commerce.order_status',
      query_id: 'q-held-1',
      status: 'ok',
      result: record,
    });
  const envelope: RetainedEnvelope = {
    id: 'msg-held-1',
    type: 'service.response',
    from: overrides.from ?? SUPPLIER_DID,
    to: overrides.to ?? [BUYER_DID],
    created_time: 1_770_000_000,
    body,
  };
  const signed = buildMessageJSON({
    id: envelope.id,
    type: envelope.type,
    from: envelope.from,
    to: envelope.to,
    created_time: envelope.created_time,
    bodyBase64: base64.encode(new TextEncoder().encode(envelope.body)),
  });
  const signature = bytesToHex(
    sign(overrides.signingKey ?? SUPPLIER_SIGNING_KEY, new TextEncoder().encode(signed)),
  );
  return { record, envelope, signature };
}
