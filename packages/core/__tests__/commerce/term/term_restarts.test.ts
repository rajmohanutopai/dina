/**
 * SHELF_SPACE_TEST_PLAN T-10, T-11, T-12, T-14 — delivery across lost
 * receipts and app relaunches (SHELF_SPACE_NEGOTIATION §5.3, §9).
 *
 * Every timing below comes from §5.3: resend at once, then every 6 hours; a
 * `held` answer slows resends to once a day; a held document is refused 30
 * days after it arrived; a request stops at its `respond_by`, agreement
 * documents after 30 days. A restart is `node.restart()` then the boot sweep.
 */

import { TERM_PROPOSAL_CARD } from '../../../src/commerce/term/term_buyer';
import { TERM_DELIVERY_FAILED_CARD, termDelivery } from '../../../src/commerce/term/term_engine';
import { TERM_DECISION_CARD } from '../../../src/commerce/term/term_seller';

import { publishListing } from './term_harness';
import { BRAND_DID, DAY, Fleet, HOUR, juicePolicy, STORE_DID, type Node } from './term_harness';

import type { TermPolicy } from '../../../src/commerce/term/term_policy';
import type { TermOutboxRow } from '../../../src/commerce/term/term_store';
import type { TermListing } from '@dina/commerce-protocol';

function setUpStore(
  fleet: Fleet,
  policy: TermPolicy = juicePolicy(),
): { store: Node; listing: TermListing; uri: string } {
  const store = fleet.add(STORE_DID);
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

/** The juice policy with the store as cash handler on slot-3, so the store settles. */
function storeHandlesCash(): TermPolicy {
  const base = juicePolicy();
  return juicePolicy({
    resources: base.resources.map((r) =>
      r.resource_ref === 'slot-3'
        ? { ...r, conditions: { ...r.conditions, cash_handler: 'host' } }
        : r,
    ),
  });
}

function ask(brand: Node, listing: TermListing, uri: string): string {
  const started = brand.engine.startNegotiation({
    listing,
    listingUri: uri,
    tag: 'beverages.juice',
    attributes: { skus: 4 },
    start: '2027-02-01T00:00:00Z',
    end: '2027-08-01T00:00:00Z',
    policy: {
      currency: 'INR',
      targets: { fee: '170000', share_bps: '600' },
      ceilings: { fee: '300000', share_bps: '1000' },
      max_rounds: 3,
      deadline_seconds: 3 * 24 * 60 * 60,
    },
  });
  if (!started.ok) throw new Error(started.refusal);
  return started.request.request_id;
}

function card(node: Node, type: string, requestId?: string) {
  const found = node.cards.filter(
    (c) => c.type === type && (requestId === undefined || c.payload.request_id === requestId),
  );
  return found[found.length - 1];
}

function outbox(node: Node, digest: string): TermOutboxRow {
  const row = node.store.getOutbox(digest);
  if (row === null) throw new Error('nothing sent with that digest');
  return row;
}

function requestDigest(node: Node, requestId: string): string {
  const row = node.store.listByRequest(requestId, 'term_request')[0];
  if (row === undefined) throw new Error('no request');
  return row.recordDigest;
}

function decisionDigest(store: Node, proposalDigest: string): string {
  const row = store.store.answersTo(proposalDigest, 'agreement_decision')[0];
  if (row === undefined) throw new Error('no decision');
  return row.recordDigest;
}

/** Drop every message of this kind now in flight: a relay that lost it. */
function dropInFlight(fleet: Fleet, kind: string): void {
  for (let i = fleet.inFlight.length - 1; i >= 0; i -= 1) {
    if (fleet.inFlight[i]?.kind === kind) fleet.inFlight.splice(i, 1);
  }
}

/**
 * A brand bargains to an approved proposal and the store accepts it at T0,
 * but the store's decision never reaches the brand (its phone is off).
 */
function acceptedButDecisionLost(
  fleet: Fleet,
  policy: TermPolicy,
): { store: Node; brand: Node; requestId: string; proposalDigest: string } {
  const { store, listing, uri } = setUpStore(fleet, policy);
  const brand = fleet.add(BRAND_DID);
  const requestId = ask(brand, listing, uri);
  fleet.pump();
  const proposalCard = card(brand, TERM_PROPOSAL_CARD, requestId);
  if (proposalCard === undefined) throw new Error('no proposal card');
  brand.engine.decideCard(proposalCard.cardId, true);
  fleet.pump();
  const proposal = brand.store.listByRequest(requestId, 'term_agreement_proposal')[0];
  if (proposal === undefined) throw new Error('no proposal');
  const decisionCard = store.cards.find(
    (c) => c.type === TERM_DECISION_CARD && c.payload.proposal_digest === proposal.recordDigest,
  );
  if (decisionCard === undefined) throw new Error('no decision card');
  fleet.unreachable.add(BRAND_DID);
  store.engine.decideCard(decisionCard.cardId, true);
  fleet.pump();
  fleet.unreachable.delete(BRAND_DID);
  return { store, brand, requestId, proposalDigest: proposal.recordDigest };
}

/** The trial period of the agreement the helpers build (14 days from 1 February). */
const TRIAL = { start: '2027-02-01T00:00:00.000Z', end: '2027-02-15T00:00:00.000Z' };

describe('term delivery across restarts (§5.3)', () => {
  let fleet: Fleet;
  beforeEach(() => {
    fleet = new Fleet();
  });
  afterEach(() => fleet.closeAll());

  it('T-10: a held settlement is stored when the decision lands, though receipts were lost and both nodes restarted', () => {
    const { store, brand, requestId, proposalDigest } = acceptedButDecisionLost(
      fleet,
      storeHandlesCash(),
    );
    const t0 = fleet.nowMs;
    const decision = decisionDigest(store, proposalDigest);

    // An hour on, the store settles the trial; the brand holds it (no decision
    // yet) and its `held` receipt is lost on the way back.
    fleet.advance(HOUR);
    const note = store.engine.issueSettlement({
      proposalDigest,
      periodStart: TRIAL.start,
      periodEnd: TRIAL.end,
      grossMinor: '500000',
    });
    if (!note.ok) throw new Error(note.refusal);
    const settlement = note.document.settlement_digest;
    fleet.unreachable.add(STORE_DID);
    fleet.pump();
    expect(brand.store.getHeld(settlement)?.reason).toBe('prerequisite');
    expect(brand.store.getAnswer(settlement)?.outcome).toBe('held');
    expect(outbox(store, settlement).receiptOutcome).toBeNull();
    expect(termDelivery(outbox(store, settlement))).toBe('sent');

    // The brand's app relaunches: the held settlement survives, and the boot
    // sweep keeps it held while the decision is still missing.
    brand.restart();
    brand.engine.sweep();
    fleet.pump();
    expect(brand.store.getHeld(settlement)?.reason).toBe('prerequisite');
    expect(brand.store.getDocument(settlement)).toBeNull();
    expect(brand.store.getNegotiation(requestId)?.state).toBe('proposed');

    // T0 + 6 h: the decision's first resend is due (the settlement's is not,
    // until T0 + 1 h + 6 h). It lands, and the held settlement is released at
    // once — but both receipts back to the store are lost.
    fleet.nowMs = t0 + 6 * HOUR;
    store.engine.sweep();
    fleet.pump();
    expect(brand.store.getNegotiation(requestId)?.state).toBe('agreed');
    expect(brand.store.getHeld(settlement)).toBeNull();
    expect(brand.store.getDocument(settlement)).not.toBeNull();
    expect(brand.store.getAnswer(settlement)?.outcome).toBe('stored');
    expect(outbox(store, settlement).receiptOutcome).toBeNull();
    expect(outbox(store, decision).receiptOutcome).toBeNull();

    // The store's app relaunches; nothing is due at its boot sweep.
    store.restart();
    fleet.unreachable.delete(STORE_DID);
    store.engine.sweep();
    fleet.pump();
    // The settlement went once (at issue); the decision twice (at T0, T0 + 6 h).
    expect(outbox(store, settlement).attempts).toBe(1);
    expect(outbox(store, decision).attempts).toBe(2);

    // T0 + 7 h: the settlement's resend gets the brand's current answer.
    fleet.nowMs = t0 + 7 * HOUR;
    store.engine.sweep();
    fleet.pump();
    expect(outbox(store, settlement).receiptOutcome).toBe('stored');
    expect(termDelivery(outbox(store, settlement))).toBe('delivered');
    // T0 + 12 h: the decision's resend does too.
    fleet.nowMs = t0 + 12 * HOUR;
    store.engine.sweep();
    fleet.pump();
    expect(outbox(store, decision).receiptOutcome).toBe('stored');

    // Stored once, whatever the resends; and with final receipts nothing goes again.
    expect(brand.store.listByKind('settlement_note', 'inbound').map((r) => r.recordDigest)).toEqual(
      [settlement],
    );
    fleet.advance(2 * DAY);
    expect(store.engine.sweep().resent).toBe(0);
    expect(brand.engine.agreement(proposalDigest).statement).toEqual(
      store.engine.agreement(proposalDigest).statement,
    );
  });

  it('T-11: a held settlement is refused 30 days after it arrived, across lost receipts and a restart', () => {
    const { store, brand, proposalDigest } = acceptedButDecisionLost(fleet, storeHandlesCash());
    // The decision never gets through for the rest of the test.
    const s = fleet.nowMs + HOUR;
    fleet.nowMs = s;
    const note = store.engine.issueSettlement({
      proposalDigest,
      periodStart: TRIAL.start,
      periodEnd: TRIAL.end,
      grossMinor: '500000',
    });
    if (!note.ok) throw new Error(note.refusal);
    const settlement = note.document.settlement_digest;
    const expiry = s + 30 * DAY;

    /** One 6-hourly tick at S + 6 h × k: both nodes sweep, the decision is lost. */
    const tick = (k: number): void => {
      fleet.nowMs = s + 6 * HOUR * k;
      store.engine.sweep();
      brand.engine.sweep();
      dropInFlight(fleet, 'term_decision');
      fleet.pump();
    };

    // The settlement lands and is held; the `held` receipts of the first send
    // and of the first resend (S + 6 h) are both lost.
    fleet.unreachable.add(STORE_DID);
    dropInFlight(fleet, 'term_decision');
    fleet.pump();
    expect(brand.store.getHeld(settlement)?.expiresAt).toBe(expiry);
    tick(1);
    expect(outbox(store, settlement).attempts).toBe(2);
    expect(outbox(store, settlement).receiptOutcome).toBeNull();
    fleet.unreachable.delete(STORE_DID);

    // S + 12 h: the next resend's `held` answer arrives; resends drop to daily.
    tick(2);
    expect(outbox(store, settlement)).toEqual(
      expect.objectContaining({
        attempts: 3,
        receiptOutcome: 'held',
        receiptAt: s + 12 * HOUR,
        nextAttemptAt: s + 36 * HOUR,
      }),
    );
    expect(termDelivery(outbox(store, settlement))).toBe('waiting');
    for (let k = 3; k <= 5; k += 1) tick(k);
    expect(outbox(store, settlement).attempts).toBe(3);
    tick(6);
    expect(outbox(store, settlement).attempts).toBe(4);

    // Day 10: the brand's app relaunches; the held row and its expiry survive.
    for (let k = 7; k < 40; k += 1) tick(k);
    brand.restart();
    tick(40);
    expect(brand.store.getHeld(settlement)?.expiresAt).toBe(expiry);

    // S + 714 h, the last tick before 30 days: still held.
    for (let k = 41; k <= 119; k += 1) tick(k);
    expect(brand.store.getHeld(settlement)).not.toBeNull();
    expect(brand.store.getAnswer(settlement)?.outcome).toBe('held');
    expect(outbox(store, settlement).receiptOutcome).toBe('held');

    // S + 30 days: refused, and the fresh receipt reaches the store at once.
    tick(120);
    expect(fleet.nowMs).toBe(expiry);
    expect(brand.store.getHeld(settlement)).toBeNull();
    expect(brand.store.getDocument(settlement)).toBeNull();
    expect(brand.store.getAnswer(settlement)?.outcome).toBe('refused');
    expect(outbox(store, settlement).receiptOutcome).toBe('refused');
    expect(termDelivery(outbox(store, settlement))).toBe('refused');
    // Sends: at S, S + 6 h, S + 12 h, then daily from S + 36 h while ≤ S + 720 h
    // (36 + 24n ≤ 720 → n = 0..28, 29 sends): 3 + 29 = 32.
    expect(outbox(store, settlement).attempts).toBe(32);

    // A final receipt stops resends: five more days, nothing more goes out.
    for (let k = 121; k <= 140; k += 1) tick(k);
    expect(outbox(store, settlement).attempts).toBe(32);
    expect(outbox(store, settlement).gaveUpAt).toBeNull();
    // The owner is told once about each: the decision ran out of resends
    // unanswered; the settlement was answered, with a refusal — so its figures
    // count on neither side, and the owner who sent them must know.
    const failed = store.cards.filter((c) => c.type === TERM_DELIVERY_FAILED_CARD);
    expect(failed.map((c) => [c.payload.kind, c.payload.why]).sort()).toEqual([
      ['term_decision', 'unanswered'],
      ['term_settlement', 'refused'],
    ]);
  });

  it('T-12: an unanswered request keeps its resends across the brand’s restart, stops at respond_by, and tells the owner once', () => {
    const { listing, uri } = setUpStore(fleet);
    const brand = fleet.add(BRAND_DID);
    fleet.unreachable.add(STORE_DID);
    const t0 = fleet.nowMs;
    const requestId = ask(brand, listing, uri);
    const digest = requestDigest(brand, requestId);
    const respondBy = t0 + 3 * DAY;
    fleet.pump();

    const sentAtHours: number[] = [0];
    const sendsSoFar = (): number => fleet.outcomes('term_request').length;
    // How many times the sweep gave the request up: once, never again after.
    let gaveUp = 0;
    // Hourly for four days; the brand's app relaunches at 30 h and again at 90 h.
    for (let h = 1; h <= 96; h += 1) {
      fleet.nowMs = t0 + h * HOUR;
      if (h === 30 || h === 90) brand.restart();
      const before = sendsSoFar();
      gaveUp += brand.engine.sweep().gaveUp;
      fleet.pump();
      if (sendsSoFar() > before) sentAtHours.push(h);
      if (h === 71) expect(brand.store.getNegotiation(requestId)?.state).toBe('negotiating');
      if (h === 72) {
        // At respond_by the store is treated as silent (§9).
        expect(brand.store.getNegotiation(requestId)).toEqual(
          expect.objectContaining({ state: 'closed', closeReason: 'no_offer' }),
        );
      }
    }

    // Every 6 h from the first send, through the restart at 30 h, up to and
    // including respond_by (72 h); none after it.
    expect(sentAtHours).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66, 72]);
    expect(fleet.outcomes('term_request').every((o) => o === 'lost')).toBe(true);
    // The request's own deadline is the 3-day default, read back from it.
    const stored = brand.store.getDocument(digest);
    expect(
      stored === null ? null : (JSON.parse(stored.recordJson) as { respond_by: string }).respond_by,
    ).toBe(new Date(respondBy).toISOString());
    expect(gaveUp).toBe(1);
    const row = outbox(brand, digest);
    expect(row.attempts).toBe(13);
    expect(row.gaveUpAt).not.toBeNull();
    expect(termDelivery(row)).toBe('not_delivered');
    // Told once, though the node restarted after giving up.
    const failed = brand.cards.filter((c) => c.type === TERM_DELIVERY_FAILED_CARD);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toEqual(
      expect.objectContaining({ kind: 'term_request', request_id: requestId }),
    );
    expect(
      brand.store.pendingCards().filter((c) => c.cardType === TERM_DELIVERY_FAILED_CARD),
    ).toHaveLength(1);
  });

  it('T-14: a termination that arrives before the decision is held across a restart, then lands', () => {
    const { store, brand, requestId, proposalDigest } = acceptedButDecisionLost(
      fleet,
      juicePolicy(),
    );
    const t0 = fleet.nowMs;
    const decision = decisionDigest(store, proposalDigest);

    // The brand's phone stays off; the store resends the decision every 6 h,
    // all lost, until 6 February 00:00 (T0 + 639 h).
    fleet.unreachable.add(BRAND_DID);
    const sixth = Date.parse('2027-02-06T00:00:00Z');
    for (let k = 1; t0 + 6 * HOUR * k < sixth; k += 1) {
      fleet.nowMs = t0 + 6 * HOUR * k;
      store.engine.sweep();
      fleet.pump();
    }
    fleet.unreachable.delete(BRAND_DID);
    // Sends at T0 and every 6 h to T0 + 636 h: 1 + 106.
    expect(outbox(store, decision).attempts).toBe(107);

    // In the trial the store ends the deal at once; the termination reaches
    // the brand before the decision's next resend (T0 + 642 h) and is held.
    fleet.nowMs = sixth;
    const ended = store.engine.terminate({ proposalDigest });
    if (!ended.ok) throw new Error(ended.refusal);
    const termination = ended.document.termination_digest;
    fleet.pump();
    expect(brand.store.getHeld(termination)?.reason).toBe('prerequisite');
    expect(outbox(store, termination).receiptOutcome).toBe('held');
    expect(outbox(store, termination).nextAttemptAt).toBe(sixth + DAY);
    expect(termDelivery(outbox(store, termination))).toBe('waiting');

    // An hour later the brand's app relaunches: still held, nothing invented.
    fleet.nowMs = sixth + HOUR;
    brand.restart();
    brand.engine.sweep();
    fleet.pump();
    expect(brand.store.getHeld(termination)?.reason).toBe('prerequisite');
    expect(brand.engine.agreement(proposalDigest).status).toBe('proposed');

    // The store's app relaunches at T0 + 642 h; its boot sweep resends the
    // decision, which lands and releases the termination.
    fleet.nowMs = t0 + 642 * HOUR;
    store.restart();
    store.engine.sweep();
    fleet.pump();
    expect(brand.store.getNegotiation(requestId)?.state).toBe('agreed');
    expect(brand.store.getHeld(termination)).toBeNull();
    expect(brand.store.getAnswer(termination)?.outcome).toBe('stored');
    expect(outbox(store, decision).receiptOutcome).toBe('stored');
    expect(outbox(store, termination).receiptOutcome).toBe('stored');
    expect(termDelivery(outbox(store, termination))).toBe('delivered');

    // Both sides now hold the same, shortened agreement: 5 of 14 trial days of
    // 50000 = 17857.14 → 17857.
    const ends = (n: Node) =>
      n.engine.agreements().find((a) => a.proposalDigest === proposalDigest);
    expect(ends(brand)?.endsAt).toBe('2027-02-06T00:00:00.000Z');
    expect(ends(store)?.endsAt).toBe('2027-02-06T00:00:00.000Z');
    expect(brand.engine.schedule(proposalDigest)).toEqual([
      expect.objectContaining({
        kind: 'trial',
        end: '2027-02-06T00:00:00.000Z',
        feeDueMinor: '17857',
      }),
    ]);
    expect(brand.engine.schedule(proposalDigest)).toEqual(store.engine.schedule(proposalDigest));
  });
});
