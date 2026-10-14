/**
 * SHELF_SPACE_NEGOTIATION §7 end to end: a store and a brand, each with its
 * own engine on real SQLite, talking only through both sides' gates.
 */

import { TERM_PROPOSAL_CARD } from '../../../src/commerce/term/term_buyer';
import { TERM_DECISION_CARD } from '../../../src/commerce/term/term_seller';

import { publishListing } from './term_harness';
import { BRAND_DID, Fleet, juicePolicy, must, STORE_DID, type Node } from './term_harness';

import type { TermListing, TermOffer } from '@dina/commerce-protocol';

function setUpStore(
  fleet: Fleet,
  policy = juicePolicy(),
): { store: Node; listing: TermListing; uri: string } {
  const store = fleet.add(STORE_DID);
  expect(store.engine.setPolicy(policy)).toEqual({ ok: true, revision: 1 });
  const published = publishListing(store, {
    listingId: 'slot-3',
    resourceRef: 'slot-3',
    kind: 'shelf',
    size: { width_cm: 90, shelves: 3 },
    region: { scheme: 'postal_area', value: 'IN-560034' },
    tags: ['snacks', 'beverages.juice'],
  });
  if (!published.ok) throw new Error(published.refusal);
  return { store, listing: published.listing, uri: published.uri };
}

function startBrand(
  fleet: Fleet,
  brand: Node,
  listing: TermListing,
  uri: string,
  overrides: Record<string, unknown> = {},
) {
  return brand.engine.startNegotiation({
    listing,
    listingUri: uri,
    tag: 'beverages.juice',
    attributes: { products: 'cold-pressed juice', skus: 4 },
    start: '2027-02-01T00:00:00Z',
    end: '2027-08-01T00:00:00Z',
    policy: {
      currency: 'INR',
      targets: { fee: '170000', share_bps: '600' },
      ceilings: { fee: '220000', share_bps: '900' },
      expected_sales_minor: '2000000',
      max_rounds: 3,
      deadline_seconds: 3 * 24 * 60 * 60,
      ...overrides,
    },
  });
}

function chain(node: Node, requestId: string): TermOffer[] {
  const rows = node.store.listByRequest(requestId, 'term_offer');
  return rows
    .map((r) => JSON.parse(r.recordJson) as TermOffer)
    .sort((a, b) => a.revision - b.revision);
}

describe('term negotiation, end to end', () => {
  let fleet: Fleet;
  beforeEach(() => {
    fleet = new Fleet();
  });
  afterEach(() => fleet.closeAll());

  it('a stranger brand asks, they bargain, both approve, and the deal settles', () => {
    const { store, listing, uri } = setUpStore(fleet);
    const brand = fleet.add(BRAND_DID);
    const started = startBrand(fleet, brand, listing, uri);
    if (!started.ok) throw new Error(started.refusal);
    const requestId = started.request.request_id;
    fleet.pump();

    // The first offer starts from the private asking terms.
    expect(fleet.outcomes('term_request')).toEqual(['applied']);
    const first = must(chain(brand, requestId)[0]);
    expect(first.revision).toBe(1);
    expect(first.terms).toEqual([
      { name: 'fee', value: '250000' },
      { name: 'share_bps', value: '1000' },
    ]);

    // The loop counters until the store stops moving or the targets are met:
    // three rounds, each answered at once, then the owner is asked.
    fleet.pump();
    const offers = chain(brand, requestId);
    expect(offers.map((o) => o.revision)).toEqual([1, 2, 3, 4]);
    // Halfway each round from 250000 toward 170000 — 210000, 190000, then the
    // automatic limit of 180000 stops it; the share halves toward 600.
    expect(offers.map((o) => o.terms.map((t) => t.value))).toEqual([
      ['250000', '1000'],
      ['210000', '800'],
      ['190000', '700'],
      ['180000', '650'],
    ]);
    expect(brand.store.getNegotiation(requestId)?.state).toBe('ready');
    // The runner asked exactly the automatic limit, not past it: no owner card.
    expect(store.cards.filter((c) => c.type === 'term_floor_approval')).toHaveLength(0);

    // The brand's owner sees one card and says yes.
    const proposalCard = brand.cards.find((c) => c.type === TERM_PROPOSAL_CARD);
    expect(proposalCard).toBeDefined();
    expect(brand.engine.decideCard(must(proposalCard).cardId, true)).toEqual({ ok: true });
    fleet.pump();
    expect(fleet.outcomes('term_proposal')).toEqual(['applied']);

    // The store's owner sees one card and says yes; Core runs the acceptance check.
    const decisionCard = store.cards.find((c) => c.type === TERM_DECISION_CARD);
    expect(decisionCard).toBeDefined();
    expect(store.engine.decideCard(must(decisionCard).cardId, true)).toEqual({ ok: true });
    fleet.pump();
    expect(fleet.outcomes('term_decision')).toEqual(['applied']);
    expect(brand.store.getNegotiation(requestId)?.state).toBe('agreed');

    // Both sides read the same accepted agreement.
    const proposalDigest = must(brand.store.listByRequest(requestId, 'term_agreement_proposal')[0])
      .recordDigest;
    expect(brand.engine.agreement(proposalDigest).status).toBe('accepted');
    expect(store.engine.agreement(proposalDigest).status).toBe('accepted');

    // The brand holds the takings (cash_handler vendor): it settles the trial period.
    const settled = brand.engine.issueSettlement({
      proposalDigest,
      periodStart: '2027-02-01T00:00:00.000Z',
      periodEnd: '2027-02-15T00:00:00.000Z',
      grossMinor: '1000000',
    });
    if (!settled.ok) throw new Error(settled.refusal);
    expect(settled.document.fee_due).toEqual({ currency: 'INR', minor_units: '50000' });
    fleet.pump();
    const acked = store.engine.acknowledgeSettlement({
      settlementDigest: settled.document.settlement_digest,
      kind: 'accepted',
    });
    expect(acked.ok).toBe(true);
    fleet.pump();
    const brandView = brand.engine.agreement(proposalDigest);
    const storeView = store.engine.agreement(proposalDigest);
    expect(brandView.statement).toEqual(storeView.statement);
    expect(brandView.statement).toEqual(
      expect.objectContaining({ ok: true, direction: 'vendor_owes_host', fee_minor: '50000' }),
    );

    // Every document was answered `stored`, and no gate refused anything.
    expect(fleet.deliveries.filter((d) => d.outcome.endsWith('denied'))).toEqual([]);
    expect(fleet.outcomes('term_receipt').every((o) => o === 'applied')).toBe(true);
  });
});
