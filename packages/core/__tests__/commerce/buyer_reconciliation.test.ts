/**
 * WS-7.7 — the buyer's side of an ambiguous outcome (§12.7, FR-P6).
 *
 * One property runs through nearly every case: the buyer never blindly creates
 * a second order. The interesting failures are not "it crashed" — they are
 * "it decided, on a clock or on a denial, that an effect which may have fired
 * did not", and each of those decisions would place a duplicate order for real
 * goods.
 */

import {
  applyReconcileResult,
  describeOrderForOwner,
  isPollDue,
  newBuyerOrder,
  MAX_REPOLL_SECONDS,
  MIN_REPOLL_SECONDS,
  type BuyerOrderRecord,
} from '../../src/commerce/buyer_reconciliation';

import type {
  OrderAcknowledgement,
  OrderReconcileRequest,
  OrderReconcileResult,
} from '@dina/commerce-protocol';

const NOW = 1_700_000_000_000;
const PO = 'po-1';
const ORDER_DIGEST = 'a'.repeat(64);
const QUOTE_DIGEST = 'b'.repeat(64);
const QUOTE_ID = 'q-1';
const BUYER = 'did:plc:sancho42';
const SUPPLIER = 'did:plc:chairmaker99';

/**
 * The order this node SENT, as the record remembers it.
 *
 * Every settling test needs one now, because an answer is checked against the
 * order before it is believed. That is not fixture overhead: `newBuyerOrder(PO)`
 * with no description is a record that cannot say what it ordered, and the one
 * test below that still uses it is asserting exactly that such a record refuses
 * to settle.
 */
const DESCRIBED = {
  orderDigest: ORDER_DIGEST,
  idempotencyKey: 'idem-1',
  protocolVersion: '1.0',
  serviceRkey: 'wholesale',
  quoteDigest: QUOTE_DIGEST,
  quoteId: QUOTE_ID,
  buyerDid: BUYER,
  supplierDid: SUPPLIER,
};

function described(): BuyerOrderRecord {
  return newBuyerOrder(PO, DESCRIBED);
}

function request(overrides: Partial<OrderReconcileRequest> = {}): OrderReconcileRequest {
  return {
    protocol_version: '1.0',
    purchase_order_id: PO,
    order_digest: 'a'.repeat(64),
    idempotency_key: 'idem-1',
    ...overrides,
  };
}

/**
 * An acknowledgement that is ABOUT the described order.
 *
 * The first version was `{ kind } as unknown as OrderAcknowledgement` — a
 * stand-in with no identity at all, which passed every state-machine test and
 * would have passed a binding check that did not exist. It has to name the
 * order now, and the mismatch cases below vary exactly one field from this.
 */
function ack(
  kind: 'accepted' | 'rejected' | 'counterproposal',
  overrides: Record<string, unknown> = {},
): OrderAcknowledgement {
  return {
    kind,
    protocol_version: '1.0',
    purchase_order_id: PO,
    order_digest: ORDER_DIGEST,
    buyer_did: BUYER,
    supplier_did: SUPPLIER,
    ...(kind === 'accepted' ? { accepted_quote_digest: QUOTE_DIGEST } : {}),
    ...(kind === 'counterproposal'
      ? {
          // §9.13 — the replacement carries the terms a new order would be
          // built against, so it speaks the conversation's version too. The
          // stand-in here had no version at all, which is a shape no real
          // supplier sends; the counterproposal bind now checks it.
          replacement_quote: {
            protocol_version: '1.0',
            replaces_quote_digest: QUOTE_DIGEST,
            quote_id: 'q-2',
          },
        }
      : {}),
    ...overrides,
  } as unknown as OrderAcknowledgement;
}

function apply(
  record: BuyerOrderRecord,
  result: OrderReconcileResult,
  req: OrderReconcileRequest = request(),
  nowMs = NOW,
): BuyerOrderRecord {
  return applyReconcileResult({ record, request: req, result, nowMs });
}

describe('the answers that end the ambiguity', () => {
  it.each([
    ['received_accepted', 'accepted', 'accepted'],
    ['received_rejected', 'rejected', 'rejected'],
    ['received_countered', 'counterproposal', 'countered'],
  ] as const)('%s becomes %s and keeps the signed evidence', (outcome, kind, state) => {
    // The EVIDENCE, not just the verdict: §12.7 says a bare claim without the
    // acknowledgement payload is invalid, because the buyer's record of what
    // was agreed is the signed document rather than this reply.
    const next = apply(described(), {
      outcome,
      acknowledgement: ack(kind),
    } as OrderReconcileResult);
    expect(next.state).toBe(state);
    expect(next.acknowledgement).toEqual(ack(kind));
    expect(next.nextPollAtMs).toBeNull();
    expect(next.resubmissionAuthorized).toBe(false);
  });

  it('does not move an order that already has an answer', () => {
    // A late reply arriving after the supplier acknowledged is not new
    // information. Letting it overwrite would make the last message win rather
    // than the first commitment.
    const accepted = apply(described(), {
      outcome: 'received_accepted',
      acknowledgement: ack('accepted'),
    } as OrderReconcileResult);
    const late = apply(accepted, { outcome: 'never_received' });
    expect(late).toEqual(accepted);
  });
});

/**
 * §9.12/§20.4 — THE ANSWER MUST BE ABOUT THIS ORDER.
 *
 * Before this, the acknowledgement was validated for shape and for its own
 * digest and then stored as the settled commercial evidence. Both of those
 * checks pass for a perfectly well-formed acknowledgement about a DIFFERENT
 * order: a supplier answering the question about order A with the
 * acknowledgement for order B would have had it recorded as "Accepted", and
 * §16.2 re-adoption would later present it back as proof of what was agreed.
 *
 * Each case below varies exactly ONE field from an answer that would settle,
 * because a check that only fires when everything is wrong is a check that
 * misses the interesting attack.
 */
describe('an answer that is not about this order', () => {
  it.each([
    ['a different purchase order', { purchase_order_id: 'po-somebody-else' }],
    ['a different order digest', { order_digest: 'f'.repeat(64) }],
    ['a different buyer', { buyer_did: 'did:plc:someoneelse' }],
    ['a different supplier', { supplier_did: 'did:plc:notchairmaker' }],
    ['terms the owner never approved', { accepted_quote_digest: 'e'.repeat(64) }],
    // §9.13 — one conversation pins one version. A structurally valid answer
    // at another version is an answer written in a different field set, and
    // "a counterproposal cannot silently upgrade the conversation".
    ['a silently upgraded protocol version', { protocol_version: '1.7' }],
    ['a downgraded protocol version', { protocol_version: '1.0.0' }],
  ])('refuses to settle on %s', (_name, override) => {
    const next = apply(described(), {
      outcome: 'received_accepted',
      acknowledgement: ack('accepted', override),
    } as OrderReconcileResult);

    // PARKED, not accepted and not rejected. The supplier said something this
    // node cannot attribute to this order, so the real outcome is still
    // unknown and the loop asks again.
    expect(next.state).toBe('outcome_unknown');
    expect(next.acknowledgement).toBeNull();
    expect(next.protocolFault).not.toBeNull();
    // And above all: it must never authorize sending the order again.
    expect(next.resubmissionAuthorized).toBe(false);
  });

  it('refuses a counterproposal whose replacement does not descend from the countered quote', () => {
    // §9.9 lineage. A replacement pointing at some other quote would let a
    // supplier answer with terms from an unrelated negotiation.
    const next = apply(described(), {
      outcome: 'received_countered',
      acknowledgement: ack('counterproposal', {
        replacement_quote: {
          protocol_version: '1.0',
          replaces_quote_digest: 'e'.repeat(64),
          quote_id: 'q-2',
        },
      }),
    } as OrderReconcileResult);
    expect(next.state).toBe('outcome_unknown');
    expect(next.protocolFault).not.toBeNull();
  });

  it('refuses a counterproposal that reuses the countered quote id', () => {
    // Consumption state never carries across families (§9.9), so a
    // replacement under the SAME id would inherit capacity it never earned.
    const next = apply(described(), {
      outcome: 'received_countered',
      acknowledgement: ack('counterproposal', {
        replacement_quote: {
          protocol_version: '1.0',
          replaces_quote_digest: QUOTE_DIGEST,
          quote_id: QUOTE_ID,
        },
      }),
    } as OrderReconcileResult);
    expect(next.state).toBe('outcome_unknown');
    expect(next.protocolFault).not.toBeNull();
  });

  it('FAILS CLOSED on a record that cannot say what it ordered', () => {
    // "I do not know what I sent" must not read as "then anything matches".
    // Same rule the re-poll already applies when it refuses to ASK from such
    // a record.
    const next = apply(newBuyerOrder(PO), {
      outcome: 'received_accepted',
      acknowledgement: ack('accepted'),
    } as OrderReconcileResult);
    expect(next.state).toBe('outcome_unknown');
    expect(next.acknowledgement).toBeNull();
    expect(next.protocolFault).toContain('cannot say what it ordered');
  });

  it('still settles the answer that DOES match, so the check is not simply always-refuse', () => {
    const next = apply(described(), {
      outcome: 'received_accepted',
      acknowledgement: ack('accepted'),
    } as OrderReconcileResult);
    expect(next.state).toBe('accepted');
    expect(next.protocolFault).toBeNull();
  });
});

describe('the loops that authorize nothing', () => {
  it.each([
    ['received_processing', 'submitted_unconfirmed'],
    ['received_unresolved', 'outcome_unknown'],
  ] as const)('%s schedules another ask and lands in %s', (outcome, state) => {
    // THE TWO STATES DIFFER, and §12.7 says why: `received_processing` means
    // the decision has not reached the external boundary, so the buyer is
    // still simply waiting; `received_unresolved` means the effect MAY have
    // fired. Collapsing them loses the only thing the owner can act on — and
    // a first version did collapse them, which a surviving mutation exposed.
    const next = apply(newBuyerOrder(PO), {
      outcome,
      retry_after_seconds: 30,
    } as OrderReconcileResult);
    expect(next.state).toBe(state);
    expect(next.nextPollAtMs).toBe(NOW + 30_000);
    expect(next.pollCount).toBe(1);
    // NEITHER authorizes resubmission. The difference is what the owner is
    // told, not what the node is allowed to do.
    expect(next.resubmissionAuthorized).toBe(false);
  });

  it('never authorizes resubmission however long received_unresolved loops', () => {
    // There is deliberately NO buyer-side timeout converting this to terminal.
    // A timeout would be the buyer deciding, on a clock, that an effect which
    // may have fired did not — and `received_unresolved` is exactly the state
    // where that guess is most likely to duplicate a real order.
    let record = described();
    let now = NOW;
    for (let i = 0; i < 500; i += 1) {
      record = apply(
        record,
        { outcome: 'received_unresolved', retry_after_seconds: 60 },
        request(),
        now,
      );
      now += 60_000;
      expect(record.resubmissionAuthorized).toBe(false);
      expect(record.state).toBe('outcome_unknown');
    }
    expect(record.pollCount).toBe(500);
    // Only a real acknowledgement exits the loop.
    const resolved = apply(record, {
      outcome: 'received_accepted',
      acknowledgement: ack('accepted'),
    } as OrderReconcileResult);
    expect(resolved.state).toBe('accepted');
  });

  it('keeps the poll count across a simulated restart', () => {
    // The counter is a VALUE the caller persists. An in-memory one would reset
    // on relaunch and quietly restart a bounded backoff from zero.
    const parked = apply(newBuyerOrder(PO), {
      outcome: 'received_processing',
      retry_after_seconds: 30,
    } as OrderReconcileResult);
    const rehydrated: BuyerOrderRecord = JSON.parse(JSON.stringify(parked)) as BuyerOrderRecord;
    const next = apply(rehydrated, {
      outcome: 'received_processing',
      retry_after_seconds: 30,
    } as OrderReconcileResult);
    expect(next.pollCount).toBe(2);
  });

  it('clamps a hostile or absurd retry interval', () => {
    // A supplier that asks for a decade would park the buyer forever, and one
    // that asks for zero would turn a re-poll into a spin.
    const long = apply(newBuyerOrder(PO), {
      outcome: 'received_unresolved',
      retry_after_seconds: 999_999,
    } as OrderReconcileResult);
    expect(long.nextPollAtMs).toBe(NOW + MAX_REPOLL_SECONDS * 1000);

    const zero = apply(newBuyerOrder(PO), {
      outcome: 'received_processing',
      retry_after_seconds: 0,
    } as OrderReconcileResult);
    expect(zero.nextPollAtMs).toBe(NOW + MIN_REPOLL_SECONDS * 1000);
  });

  it('says when the next ask is due', () => {
    const parked = apply(newBuyerOrder(PO), {
      outcome: 'received_processing',
      retry_after_seconds: 30,
    } as OrderReconcileResult);
    expect(isPollDue(parked, NOW + 29_000)).toBe(false);
    expect(isPollDue(parked, NOW + 30_000)).toBe(true);
    expect(isPollDue(newBuyerOrder(PO), NOW)).toBe(false);
  });
});

describe('never_received — the only answer that authorizes sending again', () => {
  it('authorizes resubmission when the buyer presented no evidence', () => {
    const next = apply(newBuyerOrder(PO), { outcome: 'never_received' });
    expect(next.state).toBe('never_received');
    expect(next.resubmissionAuthorized).toBe(true);
  });

  it.each([
    ['a held acknowledgement', request({ held_acknowledgement: ack('accepted') as never })],
    ['held status receipts', request({ held_status_receipts: [{ state: 'dispatched' }] as never })],
  ])('refuses to accept never_received against %s', (_label, req) => {
    // The supplier denied an order while holding its own signature on it. §12.7
    // says it must RE-ADOPT rather than deny, so the denial is unsound — and a
    // buyer that resubmitted here would create the duplicate the whole protocol
    // exists to avoid.
    const next = apply(newBuyerOrder(PO), { outcome: 'never_received' }, req);
    expect(next.state).toBe('outcome_unknown');
    expect(next.resubmissionAuthorized).toBe(false);
    expect(next.protocolFault).toContain('never_received is illegal');
    // Still asking, not closed: the supplier may yet find the order.
    expect(next.nextPollAtMs).toBe(NOW + MIN_REPOLL_SECONDS * 1000);
  });

  it('does not authorize resubmission from an empty held-receipts array', () => {
    // An empty array is "I presented nothing", which is the legal case. Worth
    // pinning because the guard reads a length and an off-by-one there would
    // flip a safe answer into a dangerous one.
    const next = apply(
      newBuyerOrder(PO),
      { outcome: 'never_received' },
      request({ held_status_receipts: [] }),
    );
    expect(next.state).toBe('never_received');
    expect(next.resubmissionAuthorized).toBe(true);
  });
});

describe('what the owner is shown (WS-7.7, WS-7.8)', () => {
  it('offers resend on exactly one state, and only when it was earned', () => {
    // The whole read model in one assertion: `resend` is the dangerous action,
    // and it appears nowhere else.
    const states: BuyerOrderRecord[] = [
      newBuyerOrder(PO),
      apply(newBuyerOrder(PO), {
        outcome: 'received_processing',
        retry_after_seconds: 30,
      } as OrderReconcileResult),
      apply(newBuyerOrder(PO), {
        outcome: 'received_unresolved',
        retry_after_seconds: 30,
      } as OrderReconcileResult),
      apply(newBuyerOrder(PO), {
        outcome: 'received_accepted',
        acknowledgement: ack('accepted'),
      } as OrderReconcileResult),
      apply(newBuyerOrder(PO), {
        outcome: 'received_rejected',
        acknowledgement: ack('rejected'),
      } as OrderReconcileResult),
      apply(newBuyerOrder(PO), {
        outcome: 'received_countered',
        acknowledgement: ack('counterproposal'),
      } as OrderReconcileResult),
      apply(
        newBuyerOrder(PO),
        { outcome: 'never_received' },
        request({ held_acknowledgement: ack('accepted') as never }),
      ),
    ];
    for (const record of states) {
      expect(describeOrderForOwner(record).actions).not.toContain('resend');
    }
    const authorized = apply(newBuyerOrder(PO), { outcome: 'never_received' });
    expect(describeOrderForOwner(authorized).actions).toEqual(['resend']);
  });

  it('withholds resend on a never_received record that never earned it', () => {
    // The read model renders whatever is in the STORE, so it cannot lean on
    // the state machine's invariants. A row saying `never_received` with no
    // authorization — hand-loaded, migrated, or written by an older build — is
    // exactly the case where offering the dangerous action would be worst, and
    // a mutation that offered `resend` unconditionally survived until this
    // test existed: every other case reaching that branch happened to be
    // authorized.
    const unearned: BuyerOrderRecord = {
      ...newBuyerOrder(PO),
      state: 'never_received',
      resubmissionAuthorized: false,
    };
    const view = describeOrderForOwner(unearned);
    expect(view.actions).not.toContain('resend');
    expect(view.actions).toEqual(['wait', 'reconcile_now']);
    expect(view.detail).toContain('did not settle the question');
  });

  it('never claims an ambiguous order failed', () => {
    // "It failed" invites the owner to press send again, and that is the one
    // thing the node must not encourage while an effect may have fired.
    const parked = apply(newBuyerOrder(PO), {
      outcome: 'received_unresolved',
      retry_after_seconds: 30,
    } as OrderReconcileResult);
    const view = describeOrderForOwner(parked);
    expect(view.headline.toLowerCase()).not.toContain('failed');
    expect(view.detail).toContain('rather than send it again');
    expect(view.actions).toEqual(['wait', 'reconcile_now']);
  });

  it('tells the owner when the supplier answered something it could not', () => {
    // Surfaced honestly rather than smoothed over: the owner is the one who
    // has to decide whether to phone the supplier.
    const faulted = apply(
      newBuyerOrder(PO),
      { outcome: 'never_received' },
      request({ held_acknowledgement: ack('accepted') as never }),
    );
    const view = describeOrderForOwner(faulted);
    expect(view.detail).toContain('not one it could give');
    expect(view.actions).not.toContain('resend');
  });

  it('gives every state a headline and a defined action list', () => {
    // A read model with a gap renders as a blank card, and a blank card is
    // where an owner invents their own next step.
    const records: BuyerOrderRecord[] = [
      newBuyerOrder(PO),
      { ...newBuyerOrder(PO), state: 'outcome_unknown' },
      { ...newBuyerOrder(PO), state: 'accepted' },
      { ...newBuyerOrder(PO), state: 'rejected' },
      { ...newBuyerOrder(PO), state: 'countered' },
      { ...newBuyerOrder(PO), state: 'never_received' },
    ];
    for (const record of records) {
      const view = describeOrderForOwner(record);
      expect(view.headline.length).toBeGreaterThan(0);
      expect(view.actions.length).toBeGreaterThan(0);
      expect(view.state).toBe(record.state);
    }
  });
});
