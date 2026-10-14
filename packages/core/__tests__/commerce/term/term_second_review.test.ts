/**
 * SHELF_SPACE_NEGOTIATION — the faults the second review found in the first
 * round's fixes, each pinned:
 *
 *   - an owner's yes the inbox committed and the engine never heard is acted
 *     on by the next sweep (a crash between the two lost it);
 *   - a revision the relay delivered after the brand's card was raised
 *     supersedes the card, and the loop raises one for the newer offer;
 *   - a body that fails shape never changes the answer its digest already has;
 *   - a trial termination that arrives after the trial ended is refused;
 *   - a stranger yes whose request is then refused is not "decided";
 *   - a send that fails outright is tried again within a minute, and a near
 *     deadline gets its first resend before it, not 6 hours later;
 *   - ranking never compares costs in different periods;
 *   - the directory upkeep withdraws listings nothing backs and retries removals;
 *   - a refused termination releases the cut notes held for it at once.
 */

import { TERM_PROPOSAL_CARD } from '../../../src/commerce/term/term_buyer';
import {
  installTermListingRepo,
  reconcileTermListings,
  withdrawEverywhere,
  withListingsLock,
} from '../../../src/commerce/term/term_listing_repo';
import { TERM_DECISION_CARD, TERM_STRANGER_CARD } from '../../../src/commerce/term/term_seller';

import {
  BRAND2_DID,
  BRAND_DID,
  DAY,
  Fleet,
  HOUR,
  juicePolicy,
  must,
  publishListing,
  STORE_DID,
  type Node,
} from './term_harness';

import type { TermBuyerPolicy, TermPolicy } from '../../../src/commerce/term/term_policy';
import type { TermListing, TermRequest } from '@dina/commerce-protocol';

interface Published {
  listing: TermListing;
  uri: string;
}

function setUpStore(
  fleet: Fleet,
  policy: TermPolicy = juicePolicy(),
  did = STORE_DID,
): { store: Node } & Published {
  const store = fleet.add(did);
  const set = store.engine.setPolicy(policy);
  if (!set.ok) throw new Error(set.refusal);
  const published = publishListing(store, {
    listingId: 'slot-3',
    resourceRef: 'slot-3',
    kind: 'shelf',
    region: { scheme: 'postal_area', value: 'IN-560034' },
    tags: ['beverages.juice', 'snacks'],
  });
  if (!published.ok) throw new Error(published.refusal);
  return { store, listing: published.listing, uri: published.uri };
}

const BRAND_POLICY: TermBuyerPolicy = {
  currency: 'INR',
  targets: { fee: '170000', share_bps: '600' },
  ceilings: { fee: '300000', share_bps: '1000' },
  max_rounds: 3,
  deadline_seconds: 3 * 24 * 60 * 60,
};

function ask(brand: Node, at: Published, policy: Partial<TermBuyerPolicy> = {}): string {
  const started = brand.engine.startNegotiation({
    listing: at.listing,
    listingUri: at.uri,
    tag: 'beverages.juice',
    attributes: { skus: 4 },
    start: '2027-02-01T00:00:00Z',
    end: '2027-08-01T00:00:00Z',
    policy: { ...BRAND_POLICY, ...policy },
  });
  if (!started.ok) throw new Error(started.refusal);
  return started.request.request_id;
}

function pending(node: Node, type: string) {
  return node.cards.filter(
    (c) => c.type === type && node.store.getCard(c.cardId)?.state === 'pending',
  );
}

function dropInFlight(fleet: Fleet, kind: string): void {
  for (let i = fleet.inFlight.length - 1; i >= 0; i -= 1) {
    if (fleet.inFlight[i]?.kind === kind) fleet.inFlight.splice(i, 1);
  }
}

function agreedDeal(fleet: Fleet): { store: Node; brand: Node; digest: string } {
  const { store, ...at } = setUpStore(fleet);
  const brand = fleet.add(BRAND_DID);
  const requestId = ask(brand, at);
  fleet.pump();
  brand.engine.decideCard(must(pending(brand, TERM_PROPOSAL_CARD)[0]).cardId, true);
  fleet.pump();
  store.engine.decideCard(must(pending(store, TERM_DECISION_CARD)[0]).cardId, true);
  fleet.pump();
  const digest = must(
    brand.store.listByRequest(requestId, 'term_agreement_proposal')[0],
  ).recordDigest;
  expect(brand.engine.agreement(digest).status).toBe('accepted');
  return { store, brand, digest };
}

describe('second review fixes', () => {
  let fleet: Fleet;
  beforeEach(() => {
    fleet = new Fleet();
  });
  afterEach(() => {
    installTermListingRepo(null);
    fleet.closeAll();
  });

  describe('an owner’s answer the engine never heard', () => {
    it('a yes left in the inbox is acted on by the next sweep, and the inbox task closed', () => {
      const { store, ...at } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      ask(brand, at);
      fleet.pump();
      const card = must(pending(brand, TERM_PROPOSAL_CARD)[0]);
      // The workflow committed the yes; the process died before the hook ran.
      brand.inboxAnswers.set(card.cardId, 'approved');
      brand.engine.sweep();
      fleet.pump();
      expect(brand.store.getCard(card.cardId)?.state).toBe('approved');
      expect(brand.finished).toEqual([{ cardId: card.cardId, ok: true }]);
      expect(pending(store, TERM_DECISION_CARD)).toHaveLength(1);
    });

    it('a no left in the inbox is acted on too: the store rejects, the brand hears it', () => {
      const { store, brand } = (() => {
        const s = setUpStore(fleet);
        const b = fleet.add(BRAND_DID);
        ask(b, s);
        fleet.pump();
        b.engine.decideCard(must(pending(b, TERM_PROPOSAL_CARD)[0]).cardId, true);
        fleet.pump();
        return { store: s.store, brand: b };
      })();
      const card = must(pending(store, TERM_DECISION_CARD)[0]);
      store.inboxAnswers.set(card.cardId, 'declined');
      store.engine.sweep();
      fleet.pump();
      expect(store.store.getCard(card.cardId)?.state).toBe('declined');
      const proposal = must(brand.store.listByKind('term_agreement_proposal')[0]);
      expect(brand.engine.agreement(proposal.recordDigest).status).toBe('rejected');
    });
  });

  it('a revision delivered after the brand’s card supersedes it; the newer offer gets its own card', () => {
    const { store, ...at } = setUpStore(fleet);
    const brand = fleet.add(BRAND_DID);
    const requestId = ask(brand, at, { max_rounds: 1 });
    // One message at a time: the request, the first offer, the brand's counter;
    // then the store's revision is lost on its way to the brand.
    fleet.pump(1);
    fleet.pump(1);
    fleet.pump(1);
    fleet.unreachable.add(BRAND_DID);
    fleet.pump();
    // The counter's 12-hour window passes: rounds are spent, the first offer is put to the owner.
    for (let h = 1; h <= 13; h += 1) {
      fleet.advance(HOUR);
      brand.engine.sweep();
      fleet.pump();
    }
    const first = must(pending(brand, TERM_PROPOSAL_CARD)[0]);
    expect(brand.store.getNegotiation(requestId)?.state).toBe('ready');
    // The relay delivers the store's revision at its next resend.
    fleet.unreachable.delete(BRAND_DID);
    for (let h = 1; h <= 6; h += 1) {
      fleet.advance(HOUR);
      store.engine.sweep();
      fleet.pump();
    }
    expect(brand.store.getCard(first.cardId)?.state).toBe('lapsed');
    expect(brand.closed).toContain(first.cardId);
    const second = pending(brand, TERM_PROPOSAL_CARD);
    expect(second).toHaveLength(1);
    expect(must(second[0]).cardId).not.toBe(first.cardId);
    // And a yes on it binds: the store gets the proposal.
    expect(brand.engine.decideCard(must(second[0]).cardId, true)).toEqual({ ok: true });
    fleet.pump();
    expect(pending(store, TERM_DECISION_CARD)).toHaveLength(1);
  });

  it('a corrupted resend never changes the answer its digest already has', () => {
    const { store, ...at } = setUpStore(fleet, juicePolicy({ access: 'contacts_or_card' }));
    const brand = fleet.add(BRAND_DID);
    const requestId = ask(brand, at);
    fleet.pump();
    const request = JSON.parse(
      must(brand.store.listByRequest(requestId, 'term_request')[0]).recordJson,
    ) as TermRequest;
    expect(store.store.getAnswer(request.request_digest)?.outcome).toBe('held');
    const result = store.engine.ingest({
      senderDid: BRAND_DID,
      kind: 'term_request',
      document: { ...request, wanted_terms: 'not a list' },
      evidenceJson: '{}',
    });
    expect(result.outcome).toBe('unreadable');
    expect(store.store.getAnswer(request.request_digest)?.outcome).toBe('held');
    expect(store.store.getHeld(request.request_digest)).not.toBeNull();
    // And the owner's yes still lets the real request run.
    expect(
      store.engine.decideCard(must(pending(store, TERM_STRANGER_CARD)[0]).cardId, true),
    ).toEqual({ ok: true });
    expect(store.store.getAnswer(request.request_digest)?.outcome).toBe('stored');
  });

  it('a trial termination that reaches the store after the trial ended is refused; both keep the deal', () => {
    const { store, brand, digest } = agreedDeal(fleet);
    // The trial runs 1–15 February. Dated the 14th, it arrives on the 16th.
    fleet.nowMs = Date.parse('2027-02-14T00:00:00Z');
    fleet.unreachable.add(STORE_DID);
    const ended = brand.engine.terminate({ proposalDigest: digest });
    if (!ended.ok) throw new Error(ended.refusal);
    fleet.pump();
    fleet.nowMs = Date.parse('2027-02-16T00:00:00Z');
    fleet.unreachable.delete(STORE_DID);
    brand.engine.sweep();
    fleet.pump();
    expect(fleet.outcomes('term_termination')).toContain('refused');
    expect(brand.engine.agreements()[0]?.endsAt).toBe('2027-08-01T00:00:00.000Z');
    expect(store.engine.agreements()[0]?.endsAt).toBe('2027-08-01T00:00:00.000Z');
  });

  it('a stranger yes whose request is then refused reads as refused, not decided', () => {
    const { store, ...at } = setUpStore(fleet, juicePolicy({ access: 'contacts_or_card' }));
    const brand = fleet.add(BRAND_DID);
    ask(brand, at);
    fleet.pump();
    // Renting is switched off before the owner answers the card.
    store.packActive.seller = false;
    expect(
      store.engine.decideCard(must(pending(store, TERM_STRANGER_CARD)[0]).cardId, true),
    ).toEqual({
      ok: false,
      refusal: 'no_longer_available',
    });
  });

  describe('resend timing', () => {
    it('a send that fails outright is tried again within a minute', async () => {
      const at = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      fleet.sendsFail.add(BRAND_DID);
      const requestId = ask(brand, at);
      await new Promise((resolve) => setImmediate(resolve));
      const digest = must(brand.store.listByRequest(requestId, 'term_request')[0]).recordDigest;
      expect(must(brand.store.getOutbox(digest)).nextAttemptAt).toBe(fleet.nowMs + 60_000);
    });

    it('a request with an hour to its deadline gets its first resend in half an hour, not six', () => {
      const at = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, at, { deadline_seconds: 60 * 60 });
      const digest = must(brand.store.listByRequest(requestId, 'term_request')[0]).recordDigest;
      expect(must(brand.store.getOutbox(digest)).nextAttemptAt).toBe(fleet.nowMs + 30 * 60_000);
    });
  });

  it('offers under brand policies in different periods are never ranked against each other', () => {
    const one = setUpStore(fleet);
    const two = setUpStore(fleet, juicePolicy(), BRAND2_DID.replace('secondjuice', 'otherstore0'));
    const brand = fleet.add(BRAND_DID);
    ask(brand, one, { expected_sales_minor: '2000000', period: 'monthly', max_rounds: 1 });
    ask(brand, two, { expected_sales_minor: '500000', period: 'weekly', max_rounds: 1 });
    fleet.pump();
    const ranked = brand.engine.ranked();
    expect(ranked.map((r) => r.costPeriod).sort()).toEqual(['monthly', 'weekly']);
    // The first is ranked; the other, in another unit, is listed after it, unranked.
    const anchor = must(ranked[0]);
    expect(ranked.filter((r) => r.costPeriod === anchor.costPeriod)).toHaveLength(1);
    expect(must(ranked[1]).costPeriod).not.toBe(anchor.costPeriod);
  });

  it('the directory upkeep withdraws listings nothing backs, and retries a removal until it lands', async () => {
    const { store } = setUpStore(fleet);
    let failNext = true;
    const removed: string[] = [];
    installTermListingRepo({
      put: async () => ({ cid: 'bafy' }),
      remove: async (id) => {
        if (failNext) {
          failNext = false;
          throw new Error('directory down');
        }
        removed.push(id);
      },
    });
    // The store's half is uninstalled: the listing is no longer backed.
    store.packRemoved.seller = true;
    await reconcileTermListings(store.engine);
    expect(store.engine.listings().map((l) => [l.state, l.recordPublic])).toEqual([
      ['withdrawn', true],
    ]);
    await reconcileTermListings(store.engine);
    expect(removed).toEqual(['slot-3']);
    expect(store.engine.listings().map((l) => [l.state, l.recordPublic])).toEqual([
      ['withdrawn', false],
    ]);
  });

  it('the write queue: a removal and a republish of one listing never interleave (route-level cases in commerce_terms.test)', async () => {
    const { store } = setUpStore(fleet);
    const records = new Set<string>(['slot-3']);
    let releaseRemove: () => void = () => undefined;
    const removeStarted = new Promise<void>((started) => {
      installTermListingRepo({
        put: async (listing) => {
          records.add(listing.listing_id);
          return { cid: 'bafy' };
        },
        remove: async (id) => {
          started();
          // The directory is slow: the remove lands only when released.
          await new Promise<void>((land) => (releaseRemove = land));
          records.delete(id);
        },
      });
    });
    const removal = withdrawEverywhere(store.engine, 'slot-3');
    await removeStarted;
    // The owner republishes the same id while the removal is in flight, as the route does.
    const composed = store.engine.composeListing({
      listingId: 'slot-3',
      resourceRef: 'slot-3',
      kind: 'shelf',
      region: { scheme: 'postal_area', value: 'IN-560034' },
      tags: ['snacks'],
    });
    if (!composed.ok) throw new Error(composed.refusal);
    const republish = withListingsLock(async () => {
      records.add(composed.listing.listing_id);
      store.engine.storeListing(composed.listing);
    });
    releaseRemove();
    await Promise.all([removal, republish]);
    // The republish waited for the removal; its record stands, and the row agrees.
    expect(records.has('slot-3')).toBe(true);
    expect(store.engine.listings().map((l) => [l.state, l.recordPublic])).toEqual([
      ['published', true],
    ]);
  });

  it('a PAUSED store half keeps its listings (a pause or a restore deletes nothing)', async () => {
    const { store } = setUpStore(fleet);
    const removed: string[] = [];
    installTermListingRepo({
      put: async () => ({ cid: 'bafy' }),
      remove: async (id) => void removed.push(id),
    });
    store.packActive.seller = false;
    await reconcileTermListings(store.engine);
    expect(store.engine.listings().map((l) => l.state)).toEqual(['published']);
    expect(removed).toEqual([]);
  });

  it('only a first failed send is pulled forward; a send that keeps failing keeps the normal schedule', async () => {
    const at = setUpStore(fleet);
    const brand = fleet.add(BRAND_DID);
    fleet.sendsFail.add(BRAND_DID);
    const requestId = ask(brand, at);
    await new Promise((resolve) => setImmediate(resolve));
    const digest = must(brand.store.listByRequest(requestId, 'term_request')[0]).recordDigest;
    expect(must(brand.store.getOutbox(digest)).nextAttemptAt).toBe(fleet.nowMs + 60_000);
    fleet.advance(60_000);
    brand.engine.sweep();
    await new Promise((resolve) => setImmediate(resolve));
    // The resend failed too: the next try is on the schedule, not in a minute.
    expect(must(brand.store.getOutbox(digest)).nextAttemptAt).toBe(fleet.nowMs + 6 * HOUR);
  });

  it('a termination refused when its 30-day hold expires releases the cut note held behind it', () => {
    // The store keeps the takings, so it settles; the brand never learns the
    // deal was accepted (every decision is lost), so it holds what follows.
    const base = juicePolicy();
    const { store, ...at } = setUpStore(
      fleet,
      juicePolicy({
        resources: base.resources.map((r) =>
          r.resource_ref === 'slot-3'
            ? { ...r, conditions: { ...r.conditions, cash_handler: 'host' } }
            : r,
        ),
      }),
    );
    const brand = fleet.add(BRAND_DID);
    ask(brand, at);
    fleet.pump();
    brand.engine.decideCard(must(pending(brand, TERM_PROPOSAL_CARD)[0]).cardId, true);
    fleet.pump();
    store.engine.decideCard(must(pending(store, TERM_DECISION_CARD)[0]).cardId, true);
    dropInFlight(fleet, 'term_decision');
    fleet.pump();
    const digest = must(store.store.listByKind('term_agreement_proposal')[0]).recordDigest;
    fleet.nowMs = Date.parse('2027-02-06T00:00:00Z');
    const ended = store.engine.terminate({ proposalDigest: digest });
    if (!ended.ok) throw new Error(ended.refusal);
    fleet.pump();
    fleet.advance(DAY);
    const note = store.engine.issueSettlement({
      proposalDigest: digest,
      periodStart: '2027-02-01T00:00:00.000Z',
      periodEnd: '2027-02-06T00:00:00.000Z',
      grossMinor: '500000',
    });
    if (!note.ok) throw new Error(note.refusal);
    fleet.pump();
    expect(brand.store.getAnswer(ended.document.termination_digest)?.outcome).toBe('held');
    expect(brand.store.getAnswer(note.document.settlement_digest)?.outcome).toBe('held');
    // Thirty days after the termination arrived — a day before the note's own hold ends.
    fleet.nowMs = Date.parse('2027-02-06T00:00:00Z') + 30 * DAY;
    brand.engine.sweep();
    expect(brand.store.getAnswer(ended.document.termination_digest)?.outcome).toBe('refused');
    expect(brand.store.getAnswer(note.document.settlement_digest)?.outcome).toBe('refused');
  });

  it('a refused termination releases the cut note held for it at once, not after 30 days', () => {
    const { store, brand, digest } = agreedDeal(fleet);
    fleet.nowMs = Date.parse('2027-03-01T00:00:00Z');
    const ended = brand.engine.terminate({
      proposalDigest: digest,
      effectiveAt: '2027-04-25T00:00:00Z',
    });
    if (!ended.ok) throw new Error(ended.refusal);
    // The termination is lost on its first trip; the cut note gets through and is held.
    dropInFlight(fleet, 'term_termination');
    const note = brand.engine.issueSettlement({
      proposalDigest: digest,
      periodStart: '2027-04-15T00:00:00.000Z',
      periodEnd: '2027-04-25T00:00:00.000Z',
      grossMinor: '500000',
    });
    if (!note.ok) throw new Error(note.refusal);
    fleet.pump();
    expect(store.store.getAnswer(note.document.settlement_digest)?.outcome).toBe('held');
    // Four days later the termination's resend lands — past the arrival window.
    for (let h = 1; h <= 4 * 24; h += 1) {
      fleet.advance(HOUR);
      if (h < 4 * 24) dropInFlight(fleet, 'term_termination');
      brand.engine.sweep();
      if (h < 4 * 24) dropInFlight(fleet, 'term_termination');
      fleet.pump();
    }
    expect(store.store.getAnswer(ended.document.termination_digest)?.outcome).toBe('refused');
    expect(store.store.getAnswer(note.document.settlement_digest)?.outcome).toBe('refused');
    expect(store.store.getHeld(note.document.settlement_digest)).toBeNull();
    expect(fleet.nowMs - Date.parse('2027-03-01T00:00:00Z')).toBeLessThan(5 * DAY);
  });
});
