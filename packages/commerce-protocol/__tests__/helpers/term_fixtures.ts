/**
 * Deterministic term-negotiation fixtures (no clocks, no randomness) —
 * shared by the protocol tests and the golden vectors.
 */

import { createHash } from 'node:crypto';

import {
  computedShareMinor,
  revshareRecordDigest,
  sealTermRecord,
  type SettlementNote,
  type Sha256Fn,
  type Term,
  type TermAgreementProposal,
  type TermCounter,
  type TermGeneral,
  type TermListing,
  type TermOffer,
  type TermReceipt,
  type TermRequest,
} from '../../src/index';

export const hash: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());

export const STORE = 'did:plc:corner0store00000000000000';
export const BRAND = 'did:plc:juicebrand0000000000000000';
export const PACK = { plugin_id: 'dina.slot_pack', schema_major: 1 };
export const LISTING_URI = `at://${STORE}/com.dinakernel.commerce.termListing/slot-3`;

export function terms(fee: string, shareBps: string): Term[] {
  return [
    { name: 'fee', value: fee },
    { name: 'share_bps', value: shareBps },
  ];
}

export function makeListing(overrides: Partial<TermListing> = {}): TermListing {
  const { listing_digest: _ignored, ...rest } = overrides;
  const draft = {
    protocol_version: '1.0',
    listing_id: 'slot-3',
    seller_did: STORE,
    pack: PACK,
    resource_ref: 'slot-3',
    kind: 'shelf',
    size: { width_cm: 90, shelves: 3 },
    region: { scheme: 'postal_area' as const, value: 'IN-560034' },
    available: { from: '2027-01-01T00:00:00Z', to: '2027-12-31T00:00:00Z' },
    tags: ['beverages.juice', 'snacks'],
    published_at: '2026-12-01T09:00:00Z',
    ...rest,
  };
  return sealTermRecord('term_listing', draft, hash) as unknown as TermListing;
}

export function makeRequest(
  overrides: Partial<TermRequest> = {},
  listing = makeListing(),
): TermRequest {
  const { request_digest: _ignored, ...rest } = overrides;
  const draft = {
    protocol_version: '1.0',
    request_id: 'treq-1',
    buyer_did: BRAND,
    seller_did: STORE,
    listing_uri: LISTING_URI,
    listing_digest: listing.listing_digest,
    pack: PACK,
    resource_ref: 'slot-3',
    attributes: { products: 'cold-pressed juice', skus: 4 },
    general: {
      tag: 'beverages.juice',
      currency: 'INR',
      start: '2027-01-31T00:00:00Z',
      end: '2027-07-31T00:00:00Z',
    },
    wanted_terms: terms('120000', '500'),
    issued_at: '2026-12-10T10:00:00Z',
    respond_by: '2026-12-13T10:00:00Z',
    ...rest,
  };
  return sealTermRecord('term_request', draft, hash) as unknown as TermRequest;
}

export function generalFor(
  request: TermRequest,
  overrides: Partial<TermGeneral> = {},
): TermGeneral {
  return {
    ...request.general,
    period: 'monthly',
    cash_handler: 'vendor',
    trial: { end: '2027-02-14T00:00:00Z', fee: { currency: 'INR', minor_units: '50000' } },
    exit_notice_days: 30,
    stock_duties: { min_skus: 3 },
    ...overrides,
  };
}

export function makeOffer(
  request: TermRequest = makeRequest(),
  overrides: Partial<TermOffer> = {},
): TermOffer {
  const { offer_digest: _ignored, ...rest } = overrides;
  const draft = {
    protocol_version: request.protocol_version,
    offer_id: 'toff-1',
    request_id: request.request_id,
    request_digest: request.request_digest,
    seller_did: request.seller_did,
    buyer_did: request.buyer_did,
    pack: request.pack,
    resource_ref: request.resource_ref,
    attributes: request.attributes,
    general: generalFor(request),
    terms: terms('195000', '800'),
    issued_at: '2026-12-10T12:00:00Z',
    valid_until: '2026-12-13T12:00:00Z',
    revision: 1,
    ...rest,
  };
  return sealTermRecord('term_offer', draft, hash) as unknown as TermOffer;
}

export function reviseOffer(
  head: TermOffer,
  nextTerms: Term[],
  issuedAt = '2026-12-11T09:00:00Z',
): TermOffer {
  const { offer_digest: _ignored, previous_offer_digest: _prev, ...rest } = head;
  const draft = {
    ...rest,
    terms: nextTerms,
    issued_at: issuedAt,
    valid_until: '2026-12-14T09:00:00Z',
    revision: head.revision + 1,
    previous_offer_digest: head.offer_digest,
  };
  return sealTermRecord('term_offer', draft, hash) as unknown as TermOffer;
}

export function makeCounter(offer: TermOffer, overrides: Partial<TermCounter> = {}): TermCounter {
  const { counter_digest: _ignored, ...rest } = overrides;
  const draft = {
    protocol_version: offer.protocol_version,
    counter_id: 'tctr-1',
    offer_id: offer.offer_id,
    offer_digest: offer.offer_digest,
    buyer_did: offer.buyer_did,
    seller_did: offer.seller_did,
    round: 1,
    targets: { fee: '150000', share_bps: '600' },
    issued_at: '2026-12-10T13:00:00Z',
    respond_by: '2026-12-11T01:00:00Z',
    ...rest,
  };
  return sealTermRecord('term_counter', draft, hash) as unknown as TermCounter;
}

export function makeReceipt(ofDigest: string, overrides: Partial<TermReceipt> = {}): TermReceipt {
  const { receipt_digest: _ignored, ...rest } = overrides;
  const draft = {
    protocol_version: '1.0',
    receipt_id: 'trcp-1',
    of_digest: ofDigest,
    outcome: 'stored' as const,
    issued_at: '2026-12-10T12:00:05Z',
    ...rest,
  };
  return sealTermRecord('term_receipt', draft, hash) as unknown as TermReceipt;
}

export function makeTermProposal(
  offer: TermOffer = makeOffer(),
  overrides: Partial<TermAgreementProposal> = {},
): TermAgreementProposal {
  const { proposal_digest: _ignored, ...rest } = overrides;
  const draft = {
    protocol_version: offer.protocol_version,
    proposal_id: 'tagr-1',
    host_did: offer.seller_did,
    vendor_did: offer.buyer_did,
    offer_digest: offer.offer_digest,
    pack: offer.pack,
    resource_ref: offer.resource_ref,
    general: offer.general,
    terms: offer.terms,
    proposed_at: '2026-12-12T08:00:00Z',
    ...rest,
  };
  return sealTermRecord('term_agreement_proposal', draft, hash) as unknown as TermAgreementProposal;
}

/** A settlement note pinned to a term agreement, for one period. */
export function makeTermSettlement(
  proposal: TermAgreementProposal,
  args: {
    periodStart: string;
    periodEnd: string;
    grossMinor: string;
    feeMinor: string;
    shareBps: number;
  },
  overrides: Partial<SettlementNote> = {},
): SettlementNote {
  const currency = proposal.general.currency;
  const draft = {
    protocol_version: proposal.protocol_version,
    settlement_id: 'stl-t1',
    proposal_digest: proposal.proposal_digest,
    period_start: args.periodStart,
    period_end: args.periodEnd,
    gross_sales: { currency, minor_units: args.grossMinor },
    computed_share: {
      currency,
      minor_units: computedShareMinor(BigInt(args.grossMinor), args.shareBps).toString(),
    },
    fee_due: { currency, minor_units: args.feeMinor },
    issued_at: '2027-03-01T00:00:00Z',
    ...overrides,
  };
  return {
    ...draft,
    settlement_digest: revshareRecordDigest('settlement_note', draft, hash),
  } as SettlementNote;
}
