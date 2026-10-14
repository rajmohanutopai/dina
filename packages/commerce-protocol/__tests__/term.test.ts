/**
 * Term negotiation (SHELF_SPACE_NEGOTIATION §5): document shapes and
 * closed vocabularies, the date arithmetic, the pairwise chain rules, the
 * period schedule with proration, the settlement rules and the fold —
 * with golden vectors for every digest domain and every money case §5.6
 * names.
 */

import { createHash } from 'node:crypto';

import {
  addCalendarMonthsUtc,
  computedShareMinor,
  revshareRecordDigest,
  addWeeksUtc,
  computeTermAgreementFold,
  deriveTermSchedule,
  findTermPeriod,
  isFinalReceiptOutcome,
  sealTermRecord,
  TERM_DIGEST_DOMAINS,
  TERM_NAMES,
  termMeetsBuyerTarget,
  termRecordDigest,
  termsFromValues,
  termValues,
  validateSettlementNote,
  validateTermAgreementProposal,
  validateTermCounter,
  validateTermGeneral,
  validateTermListing,
  validateTermOffer,
  validateTermReceipt,
  validateTermRequest,
  verifySettlementAgainstAgreement,
  verifyTermCounterAgainstOffer,
  verifyTermOfferAgainstRequest,
  verifyTermOfferRevision,
  verifyTermProposalAgainstOffer,
  verifyTermRenewal,
  verifyTermRequestAgainstListing,
  verifyTermSettlement,
  verifyTermTerminationNotice,
  type TermGeneral,
  TermListing,
} from '../src/index';

import {
  BRAND,
  generalFor,
  hash,
  makeCounter,
  makeListing,
  makeOffer,
  makeReceipt,
  makeRequest,
  makeTermProposal,
  makeTermSettlement,
  reviseOffer,
  STORE,
  terms,
} from './helpers/term_fixtures';

describe('digest domains', () => {
  it('every term domain separates: one payload, six different digests', () => {
    const digests = TERM_DIGEST_DOMAINS.map((d) => termRecordDigest(d, { x: 1 }, hash));
    expect(new Set(digests).size).toBe(TERM_DIGEST_DOMAINS.length);
  });

  it('golden vectors — frozen; a change here is a protocol change, never a fix', () => {
    const listing = makeListing();
    const request = makeRequest({}, listing);
    const offer = makeOffer(request);
    const counter = makeCounter(offer);
    const receipt = makeReceipt(offer.offer_digest);
    const proposal = makeTermProposal(offer);
    expect({
      listing: listing.listing_digest,
      request: request.request_digest,
      offer: offer.offer_digest,
      counter: counter.counter_digest,
      receipt: receipt.receipt_digest,
      proposal: proposal.proposal_digest,
    }).toEqual({
      listing: 'a7df58f425236ddde976c03940278a7f005c9ff6e51d6a90e8e80211126b6db4',
      request: '42b8bca92294722cbdf6b7b9a48c921701b309f9885534c4154861b8af7ace9d',
      offer: 'd959583c05fdb9dd414d34722d246f41fa0e3beb58965a0befb2e4acc7998838',
      counter: 'ed8143ea47e83d5cf0273b01bc2fbc5687e88f980d69e602deb1d8574dad30f6',
      receipt: '7e8221fb20e60a758df9b9e0dc130076fd696cfd18da8f499e6a1a494a54c468',
      proposal: 'ad85cc7ec57b53831136c3f87980f6c938093eb3b186bb70b353369787731249',
    });
  });

  it('the preimage is "dina:commerce:term:v1:<domain>\\n" + canonical JSON, SHA-256 hex', () => {
    const expected = createHash('sha256')
      .update('dina:commerce:term:v1:term_receipt\n{"a":1,"b":"x"}')
      .digest('hex');
    expect(termRecordDigest('term_receipt', { b: 'x', a: 1 }, hash)).toBe(expected);
  });

  it('sealTermRecord excludes the digest field from its own input', () => {
    const sealed = sealTermRecord('term_receipt', { a: 1 }, hash);
    expect(sealed.receipt_digest).toBe(termRecordDigest('term_receipt', { a: 1 }, hash));
  });
});

describe('the term table', () => {
  it('is Core-owned and sorted; both terms favour the buyer when lower', () => {
    expect(TERM_NAMES).toEqual(['fee', 'share_bps']);
    expect(termMeetsBuyerTarget('fee', 100n, 120n)).toBe(true);
    expect(termMeetsBuyerTarget('fee', 130n, 120n)).toBe(false);
    expect(termMeetsBuyerTarget('share_bps', 600n, 600n)).toBe(true);
  });

  it('round-trips through value maps', () => {
    expect(termsFromValues(termValues(terms('12', '7')))).toEqual(terms('12', '7'));
  });

  it.each([
    [
      [
        { name: 'share_bps', value: '1' },
        { name: 'fee', value: '1' },
      ],
      'sorted',
    ],
    [[{ name: 'fee', value: '1' }], 'exactly once'],
    [
      [
        { name: 'fee', value: '01' },
        { name: 'share_bps', value: '1' },
      ],
      'canonical',
    ],
    [
      [
        { name: 'fee', value: '1' },
        { name: 'share_bps', value: '10001' },
      ],
      'exceed',
    ],
    [
      [
        { name: 'fee', value: 1 },
        { name: 'share_bps', value: '1' },
      ],
      'integer string',
    ],
    [
      [
        { name: 'fee', value: '1', extra: 1 },
        { name: 'share_bps', value: '1' },
      ],
      'exactly name and value',
    ],
  ])('refuses a malformed terms list (%#)', (bad, message) => {
    const request = makeRequest({ wanted_terms: bad as never });
    expect(validateTermRequest(request, hash)).toContain(message);
  });
});

describe('the general block', () => {
  const base = generalFor(makeRequest());

  it('accepts the fixture', () => {
    expect(validateTermGeneral(base, 'g')).toBeNull();
  });

  it.each<[Partial<TermGeneral> & Record<string, unknown>, string]>([
    [{ period: 'daily' as never }, 'monthly or weekly'],
    [{ cash_handler: 'bank' as never }, 'host or vendor'],
    [{ end: '2027-01-31T00:00:00Z' }, 'must follow start'],
    [{ end: '2037-02-28T00:00:00Z' }, 'at most 120 months'],
    [
      { trial: { end: '2027-08-01T00:00:00Z', fee: { currency: 'INR', minor_units: '1' } } },
      'no later than end',
    ],
    [
      { trial: { end: '2027-02-14T00:00:00Z', fee: { currency: 'USD', minor_units: '1' } } },
      'general currency',
    ],
    [{ exit_notice_days: 400 }, 'exit_notice_days'],
    [{ stock_duties: { min_skus: 0 } }, 'min_skus'],
    [{ stock_duties: { colour: 1 } as never }, 'not a stock duty'],
    [{ price: '100' }, 'not a general-block field'],
  ])('refuses %o', (override, message) => {
    expect(validateTermGeneral({ ...base, ...override }, 'g')).toContain(message);
  });
});

describe('date arithmetic — anchored months, clamped to the month end', () => {
  it.each([
    ['2027-01-31T00:00:00Z', 1, '2027-02-28T00:00:00.000Z'],
    ['2027-01-31T00:00:00Z', 2, '2027-03-31T00:00:00.000Z'],
    ['2027-01-31T00:00:00Z', 13, '2028-02-29T00:00:00.000Z'],
    ['2027-01-31T18:30:00.250Z', 3, '2027-04-30T18:30:00.250Z'],
    ['2027-11-15T00:00:00Z', 3, '2028-02-15T00:00:00.000Z'],
    ['2027-03-10T00:00:00Z', 0, '2027-03-10T00:00:00.000Z'],
  ])('%s + %i months = %s', (anchor, months, expected) => {
    expect(addCalendarMonthsUtc(anchor, months)).toBe(expected);
  });

  it('never drifts: k from the anchor, not stepped from the last result', () => {
    // Stepping would give 28 Feb → 28 Mar; anchoring gives 31 Mar.
    const stepped = addCalendarMonthsUtc(addCalendarMonthsUtc('2027-01-31T00:00:00Z', 1), 1);
    expect(stepped).toBe('2027-03-28T00:00:00.000Z');
    expect(addCalendarMonthsUtc('2027-01-31T00:00:00Z', 2)).toBe('2027-03-31T00:00:00.000Z');
  });

  it('weeks are seven exact days', () => {
    expect(addWeeksUtc('2027-03-27T12:00:00Z', 1)).toBe('2027-04-03T12:00:00.000Z');
  });

  it('refuses negative or fractional counts', () => {
    expect(() => addCalendarMonthsUtc('2027-01-01T00:00:00Z', -1)).toThrow();
    expect(() => addWeeksUtc('2027-01-01T00:00:00Z', 1.5)).toThrow();
  });
});

describe('the listing — a closed public vocabulary with no money and no free text', () => {
  it('accepts the fixture', () => {
    expect(validateTermListing(makeListing(), hash)).toBeNull();
  });

  it.each([
    [{ asking_price: { currency: 'INR', minor_units: '1500' } }, 'not a field of this document'],
    [{ description: 'only ₹1,500 a month' }, 'not a field of this document'],
    [{ size: { width_cm: 90, note: 'cheap' } }, 'not a field of this document'],
    [{ tags: ['snacks', 'beverages.juice'] }, 'sorted and unique'],
    [{ tags: [] }, 'between 1 and'],
    [
      { available: { from: '2027-02-01T00:00:00Z', to: '2027-01-01T00:00:00Z' } },
      'must follow from',
    ],
  ])('refuses %o', (override, message) => {
    const listing = { ...makeListing(), ...override };
    expect(validateTermListing(listing, hash)).toContain(message);
  });

  // The region was the one field that took free text: a generic RegionRef
  // admits extra keys, a custom scheme with an issuer, and any value up to its
  // length limit. Each case is SEALED, so only the region check can refuse it.
  it.each([
    [
      { scheme: 'postal_area', value: 'IN-560034', note: 'rent 1500' },
      'not a field of this document',
    ],
    [{ scheme: 'custom', value: 'ZONE7' }, 'must be country | admin_area | postal_area | geohash'],
    [{ scheme: 'postal_area', value: '560034', issuer_did: STORE }, 'not a field of this document'],
    [{ scheme: 'postal_area', value: 'only 1500 a month, call us' }, 'not a postal_area code'],
    [{ scheme: 'postal_area', value: 'in-560034' }, 'not a postal_area code'],
    [{ scheme: 'country', value: 'India' }, 'not a country code'],
    [{ scheme: 'admin_area', value: 'IN KA' }, 'not a admin_area code'],
    [{ scheme: 'geohash', value: 'tdr1yaio' }, 'not a geohash code'],
  ])('refuses the region %o, even under a valid digest', (region, message) => {
    expect(
      validateTermListing(makeListing({ region } as unknown as Partial<TermListing>), hash),
    ).toContain(message);
  });

  it.each([
    { scheme: 'country', value: 'IN' },
    { scheme: 'admin_area', value: 'IN-KA' },
    { scheme: 'postal_area', value: '560034' },
    { scheme: 'postal_area', value: 'SW1A 1AA' },
    { scheme: 'geohash', value: 'tdr1y' },
  ])('accepts the region %o', (region) => {
    expect(
      validateTermListing(makeListing({ region } as unknown as Partial<TermListing>), hash),
    ).toBeNull();
  });

  it('refuses a listing whose digest does not cover it', () => {
    expect(validateTermListing({ ...makeListing(), kind: 'end_cap' }, hash)).toContain(
      'does not match',
    );
  });
});

describe('request, offer, counter, receipt and proposal shapes', () => {
  const request = makeRequest();
  const offer = makeOffer(request);

  it('accepts every fixture', () => {
    expect(validateTermRequest(request, hash)).toBeNull();
    expect(validateTermOffer(offer, hash)).toBeNull();
    expect(validateTermCounter(makeCounter(offer), hash)).toBeNull();
    expect(validateTermReceipt(makeReceipt(offer.offer_digest), hash)).toBeNull();
    expect(validateTermAgreementProposal(makeTermProposal(offer), hash)).toBeNull();
  });

  it('a request names a listing in the seller’s own repository', () => {
    const other = makeRequest({
      listing_uri: `at://${BRAND}/com.dinakernel.commerce.termListing/x`,
    });
    expect(validateTermRequest(other, hash)).toContain('seller’s own repository');
  });

  it('a request asks only for tag, currency and dates', () => {
    const r = makeRequest({ general: { ...request.general, period: 'monthly' } as never });
    expect(validateTermRequest(r, hash)).toContain('asks only for');
  });

  it('deadlines run at most seven days', () => {
    expect(
      validateTermRequest(makeRequest({ respond_by: '2026-12-18T10:00:00Z' }), hash),
    ).toContain('at most 7 days');
    expect(
      validateTermOffer(makeOffer(request, { valid_until: '2026-12-10T11:00:00Z' }), hash),
    ).toContain('must follow issued_at');
    expect(
      validateTermCounter(makeCounter(offer, { respond_by: '2026-12-20T00:00:00Z' }), hash),
    ).toContain('at most 7 days');
  });

  it('revision 1 starts a chain; later revisions name their predecessor', () => {
    expect(validateTermOffer(makeOffer(request, { revision: 2 }), hash)).toContain(
      'required after revision 1',
    );
    expect(
      validateTermOffer(makeOffer(request, { previous_offer_digest: offer.offer_digest }), hash),
    ).toContain('starts the chain');
  });

  it('fee and share cannot both be zero; rent-only means the vendor holds the takings', () => {
    expect(validateTermOffer(makeOffer(request, { terms: terms('0', '0') }), hash)).toContain(
      'both be zero',
    );
    const hostRentOnly = makeOffer(request, {
      terms: terms('100', '0'),
      general: generalFor(request, { cash_handler: 'host' }),
    });
    expect(validateTermOffer(hostRentOnly, hash)).toContain('rent-only');
    expect(validateTermOffer(makeOffer(request, { terms: terms('100', '0') }), hash)).toBeNull();
    expect(validateTermOffer(makeOffer(request, { terms: terms('0', '900') }), hash)).toBeNull();
  });

  it('counter targets name table terms only', () => {
    expect(validateTermCounter(makeCounter(offer, { targets: {} }), hash)).toContain(
      'at least one',
    );
    expect(
      validateTermCounter(makeCounter(offer, { targets: { discount: '5' } as never }), hash),
    ).toContain('not a term in the table');
  });

  it('a receipt outcome is stored, held or refused; only held is not final', () => {
    expect(
      validateTermReceipt(makeReceipt(offer.offer_digest, { outcome: 'lost' as never }), hash),
    ).toContain('stored, held or refused');
    expect(isFinalReceiptOutcome('stored')).toBe(true);
    expect(isFinalReceiptOutcome('refused')).toBe(true);
    expect(isFinalReceiptOutcome('held')).toBe(false);
  });

  it('every document refuses an unknown field', () => {
    expect(validateTermRequest({ ...request, note: 'x' }, hash)).toContain('not a field');
    expect(validateTermOffer({ ...offer, note: 'x' }, hash)).toContain('not a field');
    expect(validateTermCounter({ ...makeCounter(offer), note: 'x' }, hash)).toContain(
      'not a field',
    );
    expect(validateTermReceipt({ ...makeReceipt(offer.offer_digest), note: 'x' }, hash)).toContain(
      'not a field',
    );
    expect(
      validateTermAgreementProposal({ ...makeTermProposal(offer), note: 'x' }, hash),
    ).toContain('not a field');
  });
});

describe('pairwise chain rules', () => {
  const listing = makeListing();
  const request = makeRequest({}, listing);
  const offer = makeOffer(request);

  it('a request agrees with its listing', () => {
    expect(verifyTermRequestAgainstListing(request, listing)).toBeNull();
    expect(
      verifyTermRequestAgainstListing(
        makeRequest({ general: { ...request.general, tag: 'dairy' } }, listing),
        listing,
      ),
    ).toContain('does not want this tag');
    expect(verifyTermRequestAgainstListing(request, makeListing({ kind: 'end_cap' }))).toContain(
      'different listing',
    );
    const elsewhere = makeRequest(
      { listing_uri: `at://${STORE}/com.dinakernel.commerce.termListing/slot-9` },
      listing,
    );
    expect(verifyTermRequestAgainstListing(elsewhere, listing)).toContain(
      'names a different record',
    );
  });

  it('the first offer keeps the tag, currency and dates the buyer asked for', () => {
    expect(verifyTermOfferAgainstRequest(offer, request)).toBeNull();
    const moved = makeOffer(request, {
      general: generalFor(request, { start: '2027-02-01T00:00:00Z' }),
    });
    expect(verifyTermOfferAgainstRequest(moved, request)).toContain('tag, currency and dates');
    const upgraded = makeOffer(request, { protocol_version: '1.1' });
    expect(verifyTermOfferAgainstRequest(upgraded, request)).toContain('§9.13');
  });

  it('a revision keeps every immutable and names the head', () => {
    const next = reviseOffer(offer, terms('170000', '700'));
    expect(verifyTermOfferRevision(offer, next)).toBeNull();
    const skipped = { ...next, revision: 3 };
    expect(verifyTermOfferRevision(offer, skipped)).toContain('by one');
    const moved = makeOffer(request, {
      revision: 2,
      previous_offer_digest: offer.offer_digest,
      general: generalFor(request, { exit_notice_days: 0 }),
    });
    expect(verifyTermOfferRevision(offer, moved)).toContain('fixed within a chain');
  });

  it('a counter names the head and the same parties', () => {
    expect(verifyTermCounterAgainstOffer(makeCounter(offer), offer)).toBeNull();
    const next = reviseOffer(offer, terms('170000', '700'));
    expect(verifyTermCounterAgainstOffer(makeCounter(offer), next)).toContain('different offer');
  });

  it('a proposal equals its offer field by field', () => {
    expect(verifyTermProposalAgainstOffer(makeTermProposal(offer), offer)).toBeNull();
    expect(
      verifyTermProposalAgainstOffer(
        makeTermProposal(offer, { terms: terms('190000', '800') }),
        offer,
      ),
    ).toContain('terms differ');
    expect(
      verifyTermProposalAgainstOffer(
        makeTermProposal(offer, { general: generalFor(request, { exit_notice_days: 1 }) }),
        offer,
      ),
    ).toContain('general differs');
    expect(
      verifyTermProposalAgainstOffer(
        makeTermProposal(offer, { host_did: BRAND, vendor_did: STORE }),
        offer,
      ),
    ).toContain('parties');
  });

  it('a renewal starts where the renewed agreement ends, same parties and resource', () => {
    const first = makeTermProposal(offer);
    const renewal = makeTermProposal(offer, {
      proposal_id: 'tagr-2',
      replaces_proposal_digest: first.proposal_digest,
      general: {
        ...first.general,
        start: first.general.end,
        end: '2028-01-31T00:00:00Z',
      } as TermGeneral,
    });
    const { trial: _t, ...noTrial } = renewal.general;
    const clean = makeTermProposal(offer, {
      proposal_id: 'tagr-2',
      replaces_proposal_digest: first.proposal_digest,
      general: noTrial as TermGeneral,
    });
    expect(verifyTermRenewal(first, clean)).toBeNull();
    expect(
      verifyTermRenewal(first, {
        ...clean,
        general: { ...clean.general, start: '2027-07-01T00:00:00Z' },
      }),
    ).toContain('starts where');
    expect(verifyTermRenewal(first, { ...clean, resource_ref: 'slot-4' })).toContain('resource');
  });
});

describe('termination notice', () => {
  const general = generalFor(makeRequest());

  it('during the trial, immediate effect is allowed', () => {
    expect(
      verifyTermTerminationNotice({
        general,
        terminatedAt: '2027-02-05T00:00:00Z',
        effectiveAt: '2027-02-05T00:00:00Z',
      }),
    ).toBeNull();
  });

  it('after the trial, effect is at least exit_notice_days after issue', () => {
    expect(
      verifyTermTerminationNotice({
        general,
        terminatedAt: '2027-03-01T00:00:00Z',
        effectiveAt: '2027-03-20T00:00:00Z',
      }),
    ).toContain('at least 30 days');
    expect(
      verifyTermTerminationNotice({
        general,
        terminatedAt: '2027-03-01T00:00:00Z',
        effectiveAt: '2027-03-31T00:00:00Z',
      }),
    ).toBeNull();
  });

  it('never before issue', () => {
    expect(
      verifyTermTerminationNotice({
        general,
        terminatedAt: '2027-03-01T00:00:00Z',
        effectiveAt: '2027-02-28T00:00:00Z',
      }),
    ).toContain('before it is issued');
  });
});

describe('the period schedule — golden vectors', () => {
  const offer = makeOffer();
  const proposal = makeTermProposal(offer);

  it('trial, anchored monthly periods, and a last period cut at end and prorated', () => {
    const schedule = deriveTermSchedule({ general: proposal.general, terms: proposal.terms });
    expect(schedule.map((s) => [s.kind, s.start, s.end, s.fee_due_minor])).toEqual([
      ['trial', '2027-01-31T00:00:00.000Z', '2027-02-14T00:00:00.000Z', '50000'],
      ['regular', '2027-02-14T00:00:00.000Z', '2027-03-14T00:00:00.000Z', '195000'],
      ['regular', '2027-03-14T00:00:00.000Z', '2027-04-14T00:00:00.000Z', '195000'],
      ['regular', '2027-04-14T00:00:00.000Z', '2027-05-14T00:00:00.000Z', '195000'],
      ['regular', '2027-05-14T00:00:00.000Z', '2027-06-14T00:00:00.000Z', '195000'],
      ['regular', '2027-06-14T00:00:00.000Z', '2027-07-14T00:00:00.000Z', '195000'],
      // 17 of 31 days: 195000 × 17 / 31 = 106935.48… → 106935
      ['regular', '2027-07-14T00:00:00.000Z', '2027-07-31T00:00:00.000Z', '106935'],
    ]);
  });

  it('termination inside the trial cuts the trial and charges it pro rata', () => {
    const schedule = deriveTermSchedule({
      general: proposal.general,
      terms: proposal.terms,
      endedAt: '2027-02-05T00:00:00Z',
    });
    // 5 of 14 days of 50000 = 17857.14… → 17857
    expect(schedule).toEqual([
      expect.objectContaining({
        kind: 'trial',
        end: '2027-02-05T00:00:00.000Z',
        fee_due_minor: '17857',
      }),
    ]);
  });

  it('termination inside a regular period cuts it; none starts after', () => {
    const schedule = deriveTermSchedule({
      general: proposal.general,
      terms: proposal.terms,
      endedAt: '2027-03-29T12:00:00Z',
    });
    const last = schedule[schedule.length - 1];
    // 15.5 of 31 days: exactly half of 195000 = 97500
    expect(last).toEqual(
      expect.objectContaining({
        start: '2027-03-14T00:00:00.000Z',
        end: '2027-03-29T12:00:00.000Z',
        fee_due_minor: '97500',
      }),
    );
    expect(schedule).toHaveLength(3);
  });

  it('half-even on an exact tie', () => {
    const general = {
      ...generalFor(makeRequest()),
      start: '2027-01-01T00:00:00Z',
      end: '2027-03-01T00:00:00Z',
    };
    const { trial: _t, ...noTrial } = general;
    // Fee 5, a period cut at exactly half of 28 days: 2.5 → 2 (even).
    const schedule = deriveTermSchedule({
      general: noTrial as TermGeneral,
      terms: terms('5', '100'),
      endedAt: '2027-02-15T00:00:00Z',
    });
    expect(schedule.map((s) => s.fee_due_minor)).toEqual(['5', '2']);
  });

  it('weekly periods from the anchor', () => {
    const general = { ...proposal.general, period: 'weekly' as const, end: '2027-03-01T00:00:00Z' };
    const schedule = deriveTermSchedule({ general, terms: proposal.terms });
    expect(schedule.slice(0, 3).map((s) => s.start)).toEqual([
      '2027-01-31T00:00:00.000Z',
      '2027-02-14T00:00:00.000Z',
      '2027-02-21T00:00:00.000Z',
    ]);
  });

  it('a note must match a scheduled period exactly', () => {
    const schedule = deriveTermSchedule({ general: proposal.general, terms: proposal.terms });
    expect(findTermPeriod(schedule, '2027-02-14T00:00:00Z', '2027-03-14T00:00:00Z')).not.toBeNull();
    expect(findTermPeriod(schedule, '2027-02-14T00:00:00Z', '2027-03-15T00:00:00Z')).toBeNull();
  });
});

describe('settlement notes under a term agreement', () => {
  const proposal = makeTermProposal(makeOffer());

  it('accepts a note that matches the schedule and derives the share', () => {
    const note = makeTermSettlement(proposal, {
      periodStart: '2027-02-14T00:00:00Z',
      periodEnd: '2027-03-14T00:00:00Z',
      grossMinor: '2000000',
      feeMinor: '195000',
      shareBps: 800,
    });
    expect(validateSettlementNote(note, hash)).toBeNull();
    expect(verifyTermSettlement({ note, proposal })).toBeNull();
  });

  it('refuses a wrong fee, a missing fee, an off-schedule period and a drifted share', () => {
    const base = {
      periodStart: '2027-02-14T00:00:00Z',
      periodEnd: '2027-03-14T00:00:00Z',
      grossMinor: '2000000',
      feeMinor: '195000',
      shareBps: 800,
    };
    // The reasons name the rule, never the deal's figures: they reach logs.
    const wrongFee = verifyTermSettlement({
      note: makeTermSettlement(proposal, { ...base, feeMinor: '195001' }),
      proposal,
    });
    expect(wrongFee).toBe("settlement.fee_due: not this period's fee");
    const { fee_due: _f, ...noFee } = makeTermSettlement(proposal, base);
    expect(verifyTermSettlement({ note: noFee as never, proposal })).toContain('states fee_due');
    expect(
      verifyTermSettlement({
        note: makeTermSettlement(proposal, { ...base, periodEnd: '2027-03-15T00:00:00Z' }),
        proposal,
      }),
    ).toContain('not one the agreement schedules');
    const wrongShare = verifyTermSettlement({
      note: makeTermSettlement(proposal, { ...base, shareBps: 900 }),
      proposal,
    });
    expect(wrongShare).toContain('computed_share');
    expect(wrongShare).not.toMatch(/\d{3,}/);
  });

  it('a cut period after termination is matched against the cut schedule', () => {
    const note = makeTermSettlement(proposal, {
      periodStart: '2027-03-14T00:00:00Z',
      periodEnd: '2027-03-29T12:00:00Z',
      grossMinor: '0',
      feeMinor: '97500',
      shareBps: 800,
    });
    expect(verifyTermSettlement({ note, proposal })).toContain('not one the agreement schedules');
    expect(verifyTermSettlement({ note, proposal, endedAt: '2027-03-29T12:00:00Z' })).toBeNull();
  });

  it('a rent-only deal reports zero gross', () => {
    const rentOnly = makeTermProposal(makeOffer(makeRequest(), { terms: terms('195000', '0') }));
    const note = makeTermSettlement(rentOnly, {
      periodStart: '2027-02-14T00:00:00Z',
      periodEnd: '2027-03-14T00:00:00Z',
      grossMinor: '5000',
      feeMinor: '195000',
      shareBps: 0,
    });
    expect(verifyTermSettlement({ note, proposal: rentOnly })).toContain('zero gross');
  });

  it('a revenue-share agreement refuses a note that carries a fee', () => {
    const draft = {
      protocol_version: '1.0',
      proposal_id: 'agr-1',
      host_did: STORE,
      vendor_did: BRAND,
      share_bps: 800,
      period: 'weekly' as const,
      cash_handler: 'vendor' as const,
      currency: 'INR',
      effective_from: '2026-09-01T00:00:00.000Z',
      proposed_at: '2026-08-18T09:00:00.000Z',
    };
    const revshare = {
      ...draft,
      proposal_digest: revshareRecordDigest('agreement_proposal', draft, hash),
    };
    const note = {
      protocol_version: '1.0',
      settlement_id: 'stl-1',
      proposal_digest: revshare.proposal_digest,
      period_start: '2026-09-01T00:00:00.000Z',
      period_end: '2026-09-08T00:00:00.000Z',
      gross_sales: { currency: 'INR', minor_units: '1250000' },
      computed_share: {
        currency: 'INR',
        minor_units: computedShareMinor(1250000n, 800).toString(),
      },
      fee_due: { currency: 'INR', minor_units: '1' },
      issued_at: '2026-09-08T00:00:00.000Z',
      settlement_digest: '0'.repeat(64),
    };
    expect(verifySettlementAgainstAgreement(note, revshare)).toContain('no fee');
  });

  it('the fee must share the gross currency', () => {
    const note = {
      ...makeTermSettlement(proposal, {
        periodStart: '2027-02-14T00:00:00Z',
        periodEnd: '2027-03-14T00:00:00Z',
        grossMinor: '0',
        feeMinor: '1',
        shareBps: 800,
      }),
      fee_due: { currency: 'USD', minor_units: '1' },
    };
    expect(validateSettlementNote(note, hash)).toContain('fee must share');
  });
});

describe('the fold — every §5.6 case, golden', () => {
  it('vendor holds the takings: the vendor owes fee + share', () => {
    expect(
      computeTermAgreementFold({
        cash_handler: 'vendor',
        currency: 'INR',
        settlements: [
          { gross_minor: '2000000', share_minor: '160000', fee_minor: '195000' },
          { gross_minor: '0', share_minor: '0', fee_minor: '195000' },
        ],
      }),
    ).toEqual({
      ok: true,
      direction: 'vendor_owes_host',
      owed_minor: '550000',
      gross_minor: '2000000',
      share_minor: '160000',
      fee_minor: '390000',
      settlement_count: 2,
    });
  });

  it('rent only, zero sales', () => {
    const fold = computeTermAgreementFold({
      cash_handler: 'vendor',
      currency: 'INR',
      settlements: [{ gross_minor: '0', share_minor: '0', fee_minor: '195000' }],
    });
    expect(fold).toEqual(
      expect.objectContaining({ direction: 'vendor_owes_host', owed_minor: '195000' }),
    );
  });

  it('host holds the takings: net = gross − share − fee, host owes the vendor', () => {
    const fold = computeTermAgreementFold({
      cash_handler: 'host',
      currency: 'INR',
      settlements: [{ gross_minor: '2000000', share_minor: '160000', fee_minor: '195000' }],
    });
    expect(fold).toEqual(
      expect.objectContaining({ direction: 'host_owes_vendor', owed_minor: '1645000' }),
    );
  });

  it('host holds the takings but the fee is larger: the vendor owes the difference', () => {
    const fold = computeTermAgreementFold({
      cash_handler: 'host',
      currency: 'INR',
      settlements: [{ gross_minor: '100000', share_minor: '8000', fee_minor: '195000' }],
    });
    expect(fold).toEqual(
      expect.objectContaining({ direction: 'vendor_owes_host', owed_minor: '103000' }),
    );
  });

  it('periods add signed, and can come out even', () => {
    const fold = computeTermAgreementFold({
      cash_handler: 'host',
      currency: 'INR',
      settlements: [
        { gross_minor: '300000', share_minor: '0', fee_minor: '100000' },
        { gross_minor: '0', share_minor: '0', fee_minor: '200000' },
      ],
    });
    expect(fold).toEqual(expect.objectContaining({ direction: 'even', owed_minor: '0' }));
  });

  it('refuses a share above gross, bad money, and overflow', () => {
    expect(
      computeTermAgreementFold({
        cash_handler: 'vendor',
        currency: 'INR',
        settlements: [{ gross_minor: '1', share_minor: '2', fee_minor: '0' }],
      }),
    ).toEqual({ ok: false, error: expect.stringContaining('exceeds the gross') });
    expect(
      computeTermAgreementFold({
        cash_handler: 'vendor',
        currency: 'INR',
        settlements: [{ gross_minor: '-1', share_minor: '0', fee_minor: '0' }],
      }),
    ).toEqual({ ok: false, error: expect.stringContaining('gross') });
    const huge = '999999999999999';
    expect(
      computeTermAgreementFold({
        cash_handler: 'vendor',
        currency: 'INR',
        settlements: [
          { gross_minor: '0', share_minor: '0', fee_minor: huge },
          { gross_minor: '0', share_minor: '0', fee_minor: huge },
        ],
      }),
    ).toEqual({ ok: false, error: expect.stringContaining('representable bound') });
  });
});
