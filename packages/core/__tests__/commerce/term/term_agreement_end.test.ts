/**
 * SHELF_SPACE_TEST_PLAN G-10 and G-13 (SHELF_SPACE_NEGOTIATION §5.5–5.6):
 * how a term agreement ends, how its last period is settled after the end,
 * and how a disputed settlement is kept out of the statement and corrected.
 *
 * The deal both tests run on (juicePolicy, slot-3): start 2027-02-01, end
 * 2027-08-01, a 14-day trial to 2027-02-15 at 50000, then monthly periods
 * anchored on 2027-02-15, the brand as cash handler, 30 days' exit notice.
 */

import { createHash } from 'node:crypto';

import {
  revshareRecordDigest,
  type SettlementNote,
  type TermAgreementProposal,
  type TermListing,
} from '@dina/commerce-protocol';

import {
  termAgreementStatus,
  termHoldingCount,
  termResourceFree,
} from '../../../src/commerce/term/term_agreements';
import { TERM_PROPOSAL_CARD } from '../../../src/commerce/term/term_buyer';
import { TERM_DECISION_CARD } from '../../../src/commerce/term/term_seller';

import { publishListing } from './term_harness';
import { BRAND_DID, DAY, Fleet, juicePolicy, must, STORE_DID, type Node } from './term_harness';

function setUpStore(fleet: Fleet): { store: Node; listing: TermListing; uri: string } {
  const store = fleet.add(STORE_DID);
  const set = store.engine.setPolicy(juicePolicy());
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

function card(node: Node, type: string, key: string, value: string) {
  return node.cards.find((c) => c.type === type && c.payload[key] === value);
}

/** Both sides approve; returns the parties, the proposal digest and the agreed fee and share. */
function agreedDeal(fleet: Fleet): {
  store: Node;
  brand: Node;
  digest: string;
  fee: bigint;
  shareBps: bigint;
} {
  const { store, listing, uri } = setUpStore(fleet);
  const brand = fleet.add(BRAND_DID);
  const requestId = ask(brand, listing, uri);
  fleet.pump();
  const proposalCard = card(brand, TERM_PROPOSAL_CARD, 'request_id', requestId);
  if (proposalCard === undefined) throw new Error('no proposal card');
  brand.engine.decideCard(proposalCard.cardId, true);
  fleet.pump();
  const proposalRow = brand.store.listByRequest(requestId, 'term_agreement_proposal')[0];
  if (proposalRow === undefined) throw new Error('no proposal');
  const digest = proposalRow.recordDigest;
  const decision = card(store, TERM_DECISION_CARD, 'proposal_digest', digest);
  if (decision === undefined) throw new Error('no decision card');
  store.engine.decideCard(decision.cardId, true);
  fleet.pump();
  const proposal = JSON.parse(proposalRow.recordJson) as TermAgreementProposal;
  const term = (name: string): bigint => {
    const found = proposal.terms.find((t) => t.name === name);
    if (found === undefined) throw new Error(`no ${name} term`);
    return BigInt(found.value);
  };
  return { store, brand, digest, fee: term('fee'), shareBps: term('share_bps') };
}

/** The one rounding rule (§9.1): n / d, half-even, in integers. */
function halfEven(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  if (r * 2n > d || (r * 2n === d && q % 2n === 1n)) return q + 1n;
  return q;
}

const share = (gross: bigint, bps: bigint): bigint => halfEven(gross * bps, 10_000n);

/** The brand (cash handler) issues a period's note; the store answers it. Returns the note's digest. */
function settle(
  fleet: Fleet,
  parties: { brand: Node; store: Node; digest: string },
  period: { start: string; end: string; gross: string; replaces?: string },
  answer: 'accepted' | 'disputed',
): string {
  const note = parties.brand.engine.issueSettlement({
    proposalDigest: parties.digest,
    periodStart: period.start,
    periodEnd: period.end,
    grossMinor: period.gross,
    ...(period.replaces !== undefined ? { replacesSettlementDigest: period.replaces } : {}),
  });
  if (!note.ok) throw new Error(note.refusal);
  fleet.pump();
  const ack = parties.store.engine.acknowledgeSettlement({
    settlementDigest: note.document.settlement_digest,
    kind: answer,
  });
  if (!ack.ok) throw new Error(ack.refusal);
  fleet.pump();
  return note.document.settlement_digest;
}

const TRIAL = { start: '2027-02-01T00:00:00.000Z', end: '2027-02-15T00:00:00.000Z' };
const FEB = { start: '2027-02-15T00:00:00.000Z', end: '2027-03-15T00:00:00.000Z' };
const MAR = { start: '2027-03-15T00:00:00.000Z', end: '2027-04-15T00:00:00.000Z' };
const TRIAL_FEE = 50000n;

describe('the end of a term agreement (§5.5–5.6)', () => {
  let fleet: Fleet;
  beforeEach(() => {
    fleet = new Fleet();
  });
  afterEach(() => fleet.closeAll());

  it.each([false, true])(
    'a correction that overtakes the note it corrects waits for it, and then stands (store restarts between: %s)',
    (restartBetween) => {
      const { store, brand, digest } = agreedDeal(fleet);
      fleet.nowMs = Date.parse('2027-03-20T00:00:00Z');
      const first = brand.engine.issueSettlement({
        proposalDigest: digest,
        periodStart: FEB.start,
        periodEnd: FEB.end,
        grossMinor: '800000',
      });
      if (!first.ok) throw new Error(first.refusal);
      const fix = brand.engine.issueSettlement({
        proposalDigest: digest,
        periodStart: FEB.start,
        periodEnd: FEB.end,
        grossMinor: '850000',
        replacesSettlementDigest: first.document.settlement_digest,
      });
      if (!fix.ok) throw new Error(fix.refusal);
      // The relay delivers the correction first.
      fleet.inFlight.reverse();
      fleet.pump(1);
      expect(fleet.outcomes('term_settlement')).toEqual(['held']);
      if (restartBetween) {
        store.restart();
        store.engine.sweep();
      }
      fleet.pump();
      // The original arrived and released the correction; the correction is the live note.
      expect(fleet.outcomes('term_settlement')).toEqual(['held', 'applied']);
      expect(store.engine.schedule(digest)[1]?.settlementDigest).toBe(
        fix.document.settlement_digest,
      );
      expect(store.engine.schedule(digest)[1]?.figures?.grossSalesMinor).toBe('850000');
    },
  );

  it('an accepted note for a period a later termination cuts is flagged, and its correction to the cut stands', () => {
    const { store, brand, digest } = agreedDeal(fleet);
    const parties = { store, brand, digest };
    // April's full period, settled and accepted early (the brand settles ahead).
    fleet.nowMs = Date.parse('2027-03-20T00:00:00Z');
    const april = { start: '2027-04-15T00:00:00.000Z', end: '2027-05-15T00:00:00.000Z' };
    const first = settle(fleet, parties, { ...april, gross: '600000' }, 'accepted');
    // Then notice that ends the deal on 25 April, inside that period.
    expect(brand.engine.terminate({ proposalDigest: digest, effectiveAt: '2027-04-25T00:00:00Z' }).ok).toBe(true);
    fleet.pump();
    const cut = must(brand.engine.schedule(digest).find((p) => p.start === april.start));
    expect(cut.end).toBe('2027-04-25T00:00:00.000Z');
    expect(cut.figures?.periodEnd).toBe(april.end);
    // The correction to the cut instant replaces the accepted note.
    const fixed = settle(
      fleet,
      parties,
      { start: april.start, end: cut.end, gross: '200000', replaces: first },
      'accepted',
    );
    const after = must(store.engine.schedule(digest).find((p) => p.start === april.start));
    expect(after.settlementDigest).toBe(fixed);
    expect(after.figures?.periodEnd).toBe(cut.end);
  });

  it('a termination the store sent holds the slot until the brand stores it; a refused one leaves the deal whole', () => {
    const { store, brand, digest } = agreedDeal(fleet);
    const mayToAugust = {
      store: store.store,
      selfDid: STORE_DID,
      manualHoldings: [],
      resourceRef: 'slot-3',
      start: '2027-05-01T00:00:00Z',
      end: '2027-08-01T00:00:00Z',
    };
    fleet.nowMs = Date.parse('2027-03-20T00:00:00Z');
    // The brand's phone is off; the store's notice cannot be delivered yet.
    fleet.unreachable.add(BRAND_DID);
    const notice = store.engine.terminate({ proposalDigest: digest, effectiveAt: '2027-04-25T00:00:00Z' });
    expect(notice.ok).toBe(true);
    fleet.pump();
    // The store's own record shows the end, but the slot is not free to re-let:
    // the brand may still refuse the notice.
    expect(termAgreementStatus(store.store, digest)).toEqual(
      expect.objectContaining({ endsAt: '2027-04-25T00:00:00.000Z', terminated: true }),
    );
    expect(termResourceFree({ ...mayToAugust, nowMs: fleet.nowMs })).toBe(false);
    expect(
      termHoldingCount({ ...mayToAugust, tag: 'beverages.juice', nowMs: fleet.nowMs }),
    ).toBe(1);

    // Four days later the phone is back; the notice arrives past its window and is refused.
    fleet.advance(4 * DAY);
    fleet.unreachable.delete(BRAND_DID);
    store.engine.sweep();
    fleet.pump();
    expect(fleet.outcomes('term_termination')).toContain('refused');
    // The deal stands to its end on both sides, and the slot was never let twice.
    for (const node of [store, brand]) {
      expect(termAgreementStatus(node.store, digest)).toEqual(
        expect.objectContaining({ endsAt: '2027-08-01T00:00:00.000Z', terminated: false }),
      );
    }
    expect(termResourceFree({ ...mayToAugust, nowMs: fleet.nowMs })).toBe(false);

    // A notice the brand stores frees the slot from its effective date.
    const again = store.engine.terminate({ proposalDigest: digest, effectiveAt: '2027-04-30T00:00:00Z' });
    expect(again.ok).toBe(true);
    fleet.pump();
    expect(fleet.outcomes('term_termination').at(-1)).toBe('applied');
    expect(termResourceFree({ ...mayToAugust, nowMs: fleet.nowMs })).toBe(true);
  });

  it('G-10: notice after the trial ends the deal on its date; the cut last period is settled after the end', () => {
    const { store, brand, digest, fee, shareBps } = agreedDeal(fleet);
    const parties = { store, brand, digest };
    const holdingArgs = {
      store: store.store,
      selfDid: STORE_DID,
      manualHoldings: [],
      resourceRef: 'slot-3',
      tag: 'beverages.juice',
      start: '2027-05-01T00:00:00Z',
      end: '2027-08-01T00:00:00Z',
    };

    // Before notice the agreement holds slot-3 to its `end`.
    fleet.nowMs = Date.parse('2027-03-20T00:00:00Z');
    expect(termResourceFree({ ...holdingArgs, nowMs: fleet.nowMs })).toBe(false);
    settle(fleet, parties, { ...TRIAL, gross: '1000000' }, 'accepted');
    settle(fleet, parties, { ...FEB, gross: '800000' }, 'accepted');
    // The store's schedule carries each live note's own figures, for the owner to read.
    expect(store.engine.schedule(digest)[1]?.figures).toEqual({
      grossSalesMinor: '800000',
      computedShareMinor: share(800000n, shareBps).toString(),
      feeDueMinor: fee.toString(),
      periodEnd: FEB.end,
    });
    expect(store.engine.schedule(digest)[2]?.figures).toBeNull();

    // The brand gives notice: 36 days, more than the 30 the deal requires.
    const notice = brand.engine.terminate({
      proposalDigest: digest,
      effectiveAt: '2027-04-25T00:00:00Z',
    });
    expect(notice.ok).toBe(true);
    fleet.pump();
    expect(fleet.outcomes('term_termination')).toEqual(['applied']);
    for (const node of [store, brand]) {
      const status = termAgreementStatus(node.store, digest);
      expect(status).toEqual(
        expect.objectContaining({
          state: 'accepted',
          terminated: true,
          endsAt: '2027-04-25T00:00:00.000Z',
        }),
      );
    }
    // The slot is free from the effective date, not from `end`.
    expect(termResourceFree({ ...holdingArgs, nowMs: fleet.nowMs })).toBe(true);

    // Both derive the same schedule: April's period (15 Apr – 15 May, 30 days)
    // is cut at 25 Apr, 10 of 30 days, and nothing starts at or after it.
    const cutFee = halfEven(fee * 10n, 30n);
    const expected = [
      { start: TRIAL.start, end: TRIAL.end, kind: 'trial', feeDueMinor: TRIAL_FEE.toString() },
      { start: FEB.start, end: FEB.end, kind: 'regular', feeDueMinor: fee.toString() },
      { start: MAR.start, end: MAR.end, kind: 'regular', feeDueMinor: fee.toString() },
      {
        start: '2027-04-15T00:00:00.000Z',
        end: '2027-04-25T00:00:00.000Z',
        kind: 'regular',
        feeDueMinor: cutFee.toString(),
      },
    ];
    for (const node of [store, brand]) {
      expect(node.engine.schedule(digest)).toEqual(
        expected.map((slot) => expect.objectContaining(slot)),
      );
    }

    // The agreement still counts as a juice holding the instant before it
    // ends, and no longer at the effective date.
    const overApril = { start: '2027-04-01T00:00:00Z', end: '2027-04-30T00:00:00Z' };
    expect(
      termHoldingCount({
        ...holdingArgs,
        ...overApril,
        nowMs: Date.parse('2027-04-25T00:00:00Z') - 1,
      }),
    ).toBe(1);
    expect(
      termHoldingCount({ ...holdingArgs, ...overApril, nowMs: Date.parse('2027-04-25T00:00:00Z') }),
    ).toBe(0);

    fleet.nowMs = Date.parse('2027-04-20T00:00:00Z');
    settle(fleet, parties, { ...MAR, gross: '0' }, 'accepted');

    // A week after the end: ending is not forgetting. The cut period settles.
    fleet.nowMs = Date.parse('2027-05-02T00:00:00Z');
    const last = brand.engine.issueSettlement({
      proposalDigest: digest,
      periodStart: '2027-04-15T00:00:00.000Z',
      periodEnd: '2027-04-25T00:00:00.000Z',
      grossMinor: '300000',
    });
    if (!last.ok) throw new Error(last.refusal);
    expect(last.document.fee_due?.minor_units).toBe(cutFee.toString());
    fleet.pump();
    expect(store.store.getDocument(last.document.settlement_digest)).not.toBeNull();
    const lastAck = store.engine.acknowledgeSettlement({
      settlementDigest: last.document.settlement_digest,
      kind: 'accepted',
    });
    expect(lastAck.ok).toBe(true);
    fleet.pump();
    expect(fleet.outcomes('term_settlement')).toEqual(Array(4).fill('applied'));
    expect(fleet.outcomes('term_settlement_ack')).toEqual(Array(4).fill('applied'));

    // No period after the end can be settled: not the rest of the cut month,
    // not the month as first scheduled, not a later month.
    for (const [start, end] of [
      ['2027-04-25T00:00:00.000Z', '2027-05-15T00:00:00.000Z'],
      ['2027-04-15T00:00:00.000Z', '2027-05-15T00:00:00.000Z'],
      ['2027-05-15T00:00:00.000Z', '2027-06-15T00:00:00.000Z'],
    ] as const) {
      expect(
        brand.engine.issueSettlement({
          proposalDigest: digest,
          periodStart: start,
          periodEnd: end,
          grossMinor: '100000',
        }),
      ).toEqual({ ok: false, refusal: 'the period is not one the agreement schedules' });
    }
    // And the store refuses one sent anyway, with the full month's fee as the
    // first schedule had it.
    const forgedDraft = {
      protocol_version: last.document.protocol_version,
      settlement_id: 'tstl-after-end',
      proposal_digest: digest,
      period_start: '2027-05-15T00:00:00.000Z',
      period_end: '2027-06-15T00:00:00.000Z',
      gross_sales: { currency: 'INR', minor_units: '100000' },
      computed_share: { currency: 'INR', minor_units: share(100000n, shareBps).toString() },
      fee_due: { currency: 'INR', minor_units: fee.toString() },
      issued_at: '2027-05-02T00:00:00.000Z',
    };
    const forged: SettlementNote = {
      ...forgedDraft,
      settlement_digest: revshareRecordDigest(
        'settlement_note',
        forgedDraft,
        (d) => new Uint8Array(createHash('sha256').update(d).digest()),
      ),
    };
    expect(
      store.engine.ingest({
        senderDid: BRAND_DID,
        kind: 'term_settlement',
        document: forged,
        evidenceJson: '{}',
      }),
    ).toEqual(
      expect.objectContaining({
        outcome: 'refused',
        detail: 'settlement: the period is not one the agreement schedules',
      }),
    );
    expect(store.store.getDocument(forged.settlement_digest)).toBeNull();
    fleet.pump();

    // Both statements match: three full fees and a cut one; the brand keeps
    // the takings, so it owes the store every fee plus every share.
    const grosses = [1000000n, 800000n, 0n, 300000n];
    const shares = grosses.reduce((sum, g) => sum + share(g, shareBps), 0n);
    const fees = TRIAL_FEE + 2n * fee + cutFee;
    const brandView = brand.engine.agreement(digest);
    expect(store.engine.agreement(digest)).toEqual(brandView);
    expect(brandView.statement).toEqual({
      ok: true,
      direction: 'vendor_owes_host',
      owed_minor: (fees + shares).toString(),
      gross_minor: '2100000',
      share_minor: shares.toString(),
      fee_minor: fees.toString(),
      settlement_count: 4,
    });
    expect(brandView.unanswered).toEqual([]);
  });

  it('G-13: a disputed settlement stays out of the statement; a revision corrects it', () => {
    const { store, brand, digest, fee, shareBps } = agreedDeal(fleet);
    const parties = { store, brand, digest };
    fleet.nowMs = Date.parse('2027-03-20T00:00:00Z');
    settle(fleet, parties, { ...TRIAL, gross: '1000000' }, 'accepted');
    const disputed = settle(fleet, parties, { ...FEB, gross: '400000' }, 'disputed');

    // Only the accepted trial note is in the statement, on both sides; the
    // disputed note is answered, so neither side lists it as waiting.
    const trialOnly = {
      ok: true,
      direction: 'vendor_owes_host',
      owed_minor: (TRIAL_FEE + share(1000000n, shareBps)).toString(),
      gross_minor: '1000000',
      share_minor: share(1000000n, shareBps).toString(),
      fee_minor: TRIAL_FEE.toString(),
      settlement_count: 1,
    };
    for (const node of [store, brand]) {
      expect(node.engine.agreement(digest)).toEqual({
        status: 'accepted',
        statement: trialOnly,
        unanswered: [],
      });
    }

    // The first answer stands: the store cannot turn the dispute into an acceptance.
    expect(
      store.engine.acknowledgeSettlement({ settlementDigest: disputed, kind: 'accepted' }),
    ).toEqual(expect.objectContaining({ ok: false }));

    // §5.6: a disputed note is still live, so a fresh note for its period
    // overlaps it; a correction supersedes it by revision, for the same period.
    expect(
      brand.engine.issueSettlement({
        proposalDigest: digest,
        periodStart: FEB.start,
        periodEnd: FEB.end,
        grossMinor: '450000',
      }),
    ).toEqual({
      ok: false,
      refusal: 'the period overlaps a live settlement — supersede it by revision',
    });
    expect(
      brand.engine.issueSettlement({
        proposalDigest: digest,
        periodStart: MAR.start,
        periodEnd: MAR.end,
        grossMinor: '450000',
        replacesSettlementDigest: disputed,
      }),
    ).toEqual({ ok: false, refusal: 'a revision must cover the period it corrects' });

    const revision = brand.engine.issueSettlement({
      proposalDigest: digest,
      periodStart: FEB.start,
      periodEnd: FEB.end,
      grossMinor: '450000',
      replacesSettlementDigest: disputed,
    });
    if (!revision.ok) throw new Error(revision.refusal);
    fleet.pump();
    const revised = revision.document.settlement_digest;
    // Until the store answers, the revision waits and the statement is unchanged.
    for (const node of [store, brand]) {
      expect(node.engine.agreement(digest)).toEqual({
        status: 'accepted',
        statement: trialOnly,
        unanswered: [revised],
      });
      expect(node.engine.schedule(digest)[1]).toEqual(
        expect.objectContaining({ start: FEB.start, settlementDigest: revised }),
      );
    }

    const ack = store.engine.acknowledgeSettlement({ settlementDigest: revised, kind: 'accepted' });
    expect(ack.ok).toBe(true);
    fleet.pump();
    const shares = share(1000000n, shareBps) + share(450000n, shareBps);
    const fees = TRIAL_FEE + fee;
    const brandView = brand.engine.agreement(digest);
    expect(store.engine.agreement(digest)).toEqual(brandView);
    expect(brandView.statement).toEqual({
      ok: true,
      direction: 'vendor_owes_host',
      owed_minor: (fees + shares).toString(),
      gross_minor: '1450000',
      share_minor: shares.toString(),
      fee_minor: fees.toString(),
      settlement_count: 2,
    });
    expect(brandView.unanswered).toEqual([]);
  });
});
