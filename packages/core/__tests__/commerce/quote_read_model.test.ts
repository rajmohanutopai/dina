/**
 * The supplier's own quote surface — one projection (FR-P10, WS-7.8).
 *
 * Orders got this first: one function decides the headline and the action
 * list, so mobile and web cannot disagree. The quote surface has the same
 * shape and its own version of the risk. A quote's state is a JOIN — voided,
 * validity window, capacity — and a client computing "live" from any one of
 * those alone is wrong in a specific, expensive way: an owner told a voided
 * quote is live will honour terms this node has already refused to stand
 * behind, and a supplier who says a thing twice and means it once has a
 * dispute rather than a sale.
 *
 * The precedence tested here is the SAME order `QuoteFamily` uses when it
 * refuses. That is the property, not a coincidence: a card that ranked expiry
 * above voiding would tell an owner a quote merely lapsed when this node
 * disowned it, and they would reasonably re-offer the same terms.
 */

import { describeQuoteForOwner } from '../../src/commerce/quote_read_model';

import type { CommerceQuoteHead } from '../../src/commerce/quote_ledger';

const NOW = Date.parse('2026-08-09T09:00:00.000Z');
const BUYER = 'did:plc:sancho42';

function head(over: Partial<CommerceQuoteHead> = {}): CommerceQuoteHead {
  return {
    quoteId: 'q-1',
    buyerDid: BUYER,
    headDigest: 'a'.repeat(64),
    headRevision: '1',
    maxUses: '1',
    validUntil: NOW + 3_600_000,
    supplierEpoch: '1',
    voided: false,
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    ...over,
  };
}

describe('the ordinary states', () => {
  it('calls a signed, in-date, unspent quote LIVE and offers to void it', () => {
    const view = describeQuoteForOwner(head(), 0, NOW);
    expect(view.state).toBe('live');
    // VIEW ONLY. `void` was offered here and nothing performed it — see
    // `OwnerQuoteAction`. A card that offers a button which can only dead-end
    // tells an owner they withdrew an offer they did not.
    expect(view.actions).toEqual(['view']);
    expect(view.buyerDid).toBe(BUYER);
  });

  it('calls a lapsed quote EXPIRED, and says nothing went wrong', () => {
    const view = describeQuoteForOwner(head(), 0, NOW + 7_200_000);
    expect(view.state).toBe('expired');
    expect(view.detail).toBeNull();
  });

  it('calls a fully-used quote CONSUMED', () => {
    const view = describeQuoteForOwner(head({ maxUses: '3' }), 3, NOW);
    expect(view.state).toBe('consumed');
    expect(view.detail).toContain('3');
  });

  it('reports remaining capacity on a multi-use quote', () => {
    // A supplier deciding whether to re-offer needs the number, not "some".
    const view = describeQuoteForOwner(head({ maxUses: '5' }), 2, NOW);
    expect(view.state).toBe('live');
    expect(view.detail).toContain('3 of 5');
  });
});

describe('precedence, which is where a card gets it wrong', () => {
  it('says VOIDED even when the quote has also expired', () => {
    // The two are different facts. Expiry is time passing; voiding is this
    // node disowning the offer. An owner told "expired" would re-issue the
    // same terms, which is exactly what a restore-voided quote must not
    // invite (§16.2).
    const view = describeQuoteForOwner(head({ voided: true }), 0, NOW + 7_200_000);
    expect(view.state).toBe('voided');
    expect(view.headline.toLowerCase()).toContain('withdrawn');
  });

  it('says VOIDED even when the quote is also fully used', () => {
    const view = describeQuoteForOwner(head({ voided: true, maxUses: '2' }), 2, NOW);
    expect(view.state).toBe('voided');
  });

  it('says EXPIRED rather than CONSUMED when both are true', () => {
    // Matches the refusal order the family itself uses, so the card and the
    // wire tell an operator the same story about the same quote.
    const view = describeQuoteForOwner(head({ maxUses: '1' }), 1, NOW + 7_200_000);
    expect(view.state).toBe('expired');
  });
});

describe('what is never offered', () => {
  it.each([
    ['voided', head({ voided: true }), 0, NOW],
    ['expired', head(), 0, NOW + 7_200_000],
    ['consumed', head({ maxUses: '1' }), 1, NOW],
  ] as const)('does not offer to void a %s quote', (_name, h, spent, now) => {
    // Voiding changes nothing in these states. Offering it invites an owner to
    // "cancel" something already over and then wonder what they just did.
    expect(describeQuoteForOwner(h, spent, now).actions).toEqual(['view']);
  });

  it('never claims a live quote is safe from being ordered against', () => {
    // The honesty rule the order card has: nothing here may imply an outcome
    // the supplier has not committed to. A live quote CAN be ordered against,
    // and the headline says exactly that.
    const view = describeQuoteForOwner(head(), 0, NOW);
    expect(view.headline).toContain('can still order');
  });
});

describe('a max_uses this build cannot read', () => {
  it.each(['', 'lots', '0', '-2', '1e3'])('treats %p as one, the protocol default', (maxUses) => {
    // The safe reading. Rendering NaN puts "NaN of 3 used" on somebody's
    // screen; treating an unreadable ceiling as UNLIMITED would keep offering
    // a quote whose capacity nobody can count.
    const view = describeQuoteForOwner(head({ maxUses }), 1, NOW);
    expect(view.maxUses).toBe(1);
    expect(view.state).toBe('consumed');
  });
});
