/**
 * SHELF_SPACE_NEGOTIATION §5.3 at the real D2D gates: with the commerce
 * runtime installed, a `commerce.trade` term document crosses for a
 * non-contact only when it binds — and a blocked DID never reaches the
 * waiver.
 */

import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import { blockDestination, checkEgressGates } from '../../../src/d2d/gates';
import { isTradeCounterparty } from '../../../src/d2d/trade_ingress_seam';

import { publishListing , BRAND2_DID, BRAND_DID, Fleet, juicePolicy, STORE_DID } from './term_harness';


import type { TermRequest } from '@dina/commerce-protocol';

describe('term documents at the D2D gates', () => {
  let fleet: Fleet;
  afterEach(() => {
    installCommerceRuntime(null);
    fleet.closeAll();
  });

  function setUp(): { request: TermRequest } {
    fleet = new Fleet();
    const store = fleet.add(STORE_DID);
    store.engine.setPolicy(juicePolicy());
    const published = publishListing(store, {
      listingId: 'slot-3',
      resourceRef: 'slot-3',
      kind: 'shelf',
      region: { scheme: 'country', value: 'IN' },
      tags: ['beverages.juice'],
    });
    if (!published.ok) throw new Error(published.refusal);
    const brand = fleet.add(BRAND_DID);
    const started = brand.engine.startNegotiation({
      listing: published.listing,
      listingUri: published.uri,
      tag: 'beverages.juice',
      attributes: {},
      start: '2027-02-01T00:00:00Z',
      end: '2027-08-01T00:00:00Z',
      policy: {
        currency: 'INR',
        targets: { fee: '170000', share_bps: '600' },
        ceilings: { fee: '300000', share_bps: '1000' },
        max_rounds: 1,
        deadline_seconds: 86_400,
      },
    });
    if (!started.ok) throw new Error(started.refusal);
    // The BRAND's node is the one under test for egress.
    installCommerceRuntime({ terms: brand.engine } as unknown as CommerceRuntime);
    return { request: started.request };
  }

  it('egress: the brand may send its request to the store that published the listing, to nobody else', () => {
    const { request } = setUp();
    const body = { document: request, direction: 'outbound' as const };
    expect(checkEgressGates(STORE_DID, 'commerce.trade', [], 'term_request', request).allowed).toBe(
      true,
    );
    expect(
      checkEgressGates(BRAND2_DID, 'commerce.trade', [], 'term_request', request).allowed,
    ).toBe(false);
    expect(isTradeCounterparty(STORE_DID, 'term_request', body)).toBe(true);
    // Not a term document: the order-bound waiver alone decides, and it says no.
    expect(
      checkEgressGates(STORE_DID, 'commerce.trade', [], 'agreement_proposal', request).allowed,
    ).toBe(false);
  });

  it('ingress: an offer from the store for that request binds; one from a stranger does not', () => {
    const { request } = setUp();
    const offerLike = { request_id: request.request_id };
    expect(
      isTradeCounterparty(STORE_DID, 'term_offer', { document: offerLike, direction: 'inbound' }),
    ).toBe(true);
    expect(
      isTradeCounterparty(BRAND2_DID, 'term_offer', { document: offerLike, direction: 'inbound' }),
    ).toBe(false);
  });

  it('a blocked destination never reaches the waiver', () => {
    const { request } = setUp();
    blockDestination(STORE_DID);
    expect(checkEgressGates(STORE_DID, 'commerce.trade', [], 'term_request', request)).toEqual(
      expect.objectContaining({ allowed: false, deniedAt: 'contact' }),
    );
  });
});
