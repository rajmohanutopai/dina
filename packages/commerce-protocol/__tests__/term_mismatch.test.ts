/**
 * P-20 — version and currency mismatch between documents of one chain
 * (SHELF_SPACE_NEGOTIATION §5.3, §5.6).
 *
 * §5.3: every term document carries a `protocol_version` that "must match
 * across the chain" (`verifyConversationVersion`, §9.13), and
 * "`protocol_version`, `currency`, `pack`, `resource_ref` and `general`
 * cannot change within a chain". So inside one chain the version must be
 * EQUAL, not merely the same major: a minor difference is refused too.
 * Minors stay additive in the other sense §9.13 gives them: a node parses a
 * whole chain written at a newer minor (`checkProtocolVersion`), as long as
 * no document carries a field it does not know — term documents refuse
 * unknown fields (conformance.md), so a later field is a new kind or a major.
 */

import {
  checkProtocolVersion,
  validateSettlementNote,
  validateTermAgreementProposal,
  validateTermCounter,
  validateTermListing,
  validateTermOffer,
  validateTermRequest,
  verifyTermCounterAgainstOffer,
  verifyTermOfferAgainstRequest,
  verifyTermOfferRevision,
  verifyTermProposalAgainstOffer,
  verifyTermRequestAgainstListing,
  verifyTermSettlement,
  type SettlementNote,
  type TermAgreementProposal,
  type TermListing,
  type TermOffer,
  type TermRequest,
} from '../src/index';

import {
  generalFor,
  hash,
  makeCounter,
  makeListing,
  makeOffer,
  makeRequest,
  makeTermProposal,
  makeTermSettlement,
  reviseOffer,
  terms,
} from './helpers/term_fixtures';

/** One chain, every document at `version`, built link by link. */
function chainAt(version: string): {
  listing: TermListing;
  request: TermRequest;
  offer: TermOffer;
  revision: TermOffer;
  proposal: TermAgreementProposal;
  note: SettlementNote;
} {
  const listing = makeListing({ protocol_version: version });
  const request = makeRequest({ protocol_version: version }, listing);
  const offer = makeOffer(request);
  const revision = reviseOffer(offer, terms('170000', '700'));
  const proposal = makeTermProposal(revision);
  return { listing, request, offer, revision, proposal, note: trialNote(proposal) };
}

/**
 * The fixture's trial: 2027-01-31 to 2027-02-14, fee 50000 INR. Gross
 * 1000000 at 700 bps is a share of 70000.
 */
function trialNote(
  proposal: TermAgreementProposal,
  overrides: Partial<SettlementNote> = {},
): SettlementNote {
  return makeTermSettlement(
    proposal,
    {
      periodStart: '2027-01-31T00:00:00Z',
      periodEnd: '2027-02-14T00:00:00Z',
      grossMinor: '1000000',
      feeMinor: '50000',
      shareBps: 700,
    },
    overrides,
  );
}

/** Every pairwise rule a chain of these documents meets, in order. */
function pairwise(c: ReturnType<typeof chainAt>, counter = makeCounter(c.revision)) {
  return [
    verifyTermRequestAgainstListing(c.request, c.listing),
    verifyTermOfferAgainstRequest(c.offer, c.request),
    verifyTermOfferRevision(c.offer, c.revision),
    verifyTermCounterAgainstOffer(counter, c.revision),
    verifyTermProposalAgainstOffer(c.proposal, c.revision),
    verifyTermSettlement({ note: c.note, proposal: c.proposal }),
  ];
}

describe('P-20 — one chain, one protocol version', () => {
  it('a chain at 1.0 passes every pairwise rule (the baseline)', () => {
    const c = chainAt('1.0');
    expect(c.note.gross_sales.currency).toBe('INR');
    expect(c.note.computed_share.minor_units).toBe('70000');
    expect(pairwise(c)).toEqual([null, null, null, null, null, null]);
  });

  it.each([
    ['another major', '2.0'],
    ['another minor', '1.1'],
  ])('%s at any link of a 1.0 chain is refused at that link', (_label, other) => {
    const listing = makeListing();
    const request = makeRequest({}, listing);
    const offer = makeOffer(request);
    const revision = reviseOffer(offer, terms('170000', '700'));
    const proposal = makeTermProposal(revision);

    expect(
      verifyTermRequestAgainstListing(makeRequest({ protocol_version: other }, listing), listing),
    ).toContain('§9.13');
    expect(
      verifyTermOfferAgainstRequest(makeOffer(request, { protocol_version: other }), request),
    ).toContain('§9.13');
    // Revision 2 of `offer`, written at the other version.
    const moved = reviseOffer({ ...offer, protocol_version: other }, terms('170000', '700'));
    expect(verifyTermOfferRevision(offer, moved)).toContain('protocol version');
    expect(
      verifyTermCounterAgainstOffer(makeCounter(revision, { protocol_version: other }), revision),
    ).toContain('§9.13');
    expect(
      verifyTermProposalAgainstOffer(
        makeTermProposal(revision, { protocol_version: other }),
        revision,
      ),
    ).toContain('§9.13');
    expect(
      verifyTermSettlement({
        note: trialNote(proposal, { protocol_version: other }),
        proposal,
      }),
    ).toContain('§9.13');
  });

  it('a chain written wholly at a newer minor parses and binds; a newer major does not parse', () => {
    const c = chainAt('1.1');
    expect(validateTermListing(c.listing, hash)).toBeNull();
    expect(validateTermRequest(c.request, hash)).toBeNull();
    expect(validateTermOffer(c.revision, hash)).toBeNull();
    expect(validateTermCounter(makeCounter(c.revision), hash)).toBeNull();
    expect(validateTermAgreementProposal(c.proposal, hash)).toBeNull();
    expect(validateSettlementNote(c.note, hash)).toBeNull();
    expect(pairwise(c)).toEqual([null, null, null, null, null, null]);
    // §9.13 admission: same major parses, another major is refused.
    expect(checkProtocolVersion('1.1')).toBeNull();
    expect(checkProtocolVersion('2.0')).toEqual(
      expect.objectContaining({ code: 'unsupported_version', requested_version: '2.0' }),
    );
  });

  it('a newer minor cannot add a field to a term document: the field is refused', () => {
    const c = chainAt('1.1');
    const grown = { ...c.request, wanted_slot_height_cm: 40 };
    expect(validateTermRequest(grown, hash)).toBe(
      'request.wanted_slot_height_cm: is not a field of this document',
    );
  });
});

describe('P-20 — one chain, one currency', () => {
  const listing = makeListing();
  const request = makeRequest({}, listing);
  const offer = makeOffer(request);

  /** The fixture's general block moved wholly into USD, trial fee included. */
  const inUsd = generalFor(request, {
    currency: 'USD',
    trial: { end: '2027-02-14T00:00:00Z', fee: { currency: 'USD', minor_units: '50000' } },
  });

  it('a first offer in another currency than the request asked for is refused', () => {
    const usd = makeOffer(request, { general: inUsd });
    expect(validateTermOffer(usd, hash)).toBeNull();
    expect(verifyTermOfferAgainstRequest(usd, request)).toBe(
      'offer: tag, currency and dates must be the ones the request asked for',
    );
  });

  it('a revision cannot change the currency', () => {
    const moved = reviseOffer({ ...offer, general: inUsd }, terms('170000', '700'));
    expect(validateTermOffer(moved, hash)).toBeNull();
    expect(verifyTermOfferRevision(offer, moved)).toBe(
      'offer: protocol version, parties, pack, resource, attributes and general are fixed within a chain',
    );
  });

  it('a proposal in another currency than its offer is refused', () => {
    const usd = makeTermProposal(offer, { general: inUsd });
    expect(validateTermAgreementProposal(usd, hash)).toBeNull();
    expect(verifyTermProposalAgainstOffer(usd, offer)).toBe(
      'term proposal: general differs from the offer',
    );
  });

  it('a settlement note with any amount in another currency than the agreement is refused', () => {
    // 1000000 at the fixture offer's 800 bps is a share of 80000.
    const proposal = makeTermProposal(offer);
    const base = makeTermSettlement(proposal, {
      periodStart: '2027-01-31T00:00:00Z',
      periodEnd: '2027-02-14T00:00:00Z',
      grossMinor: '1000000',
      feeMinor: '50000',
      shareBps: 800,
    });
    expect(base.computed_share.minor_units).toBe('80000');
    expect(verifyTermSettlement({ note: base, proposal })).toBeNull();
    const usd = { currency: 'USD' };
    for (const field of ['gross_sales', 'computed_share', 'fee_due'] as const) {
      const moved = { ...base, [field]: { ...base[field], ...usd } } as SettlementNote;
      expect(verifyTermSettlement({ note: moved, proposal })).toBe(
        'settlement: currency differs from the agreement',
      );
    }
  });
});
