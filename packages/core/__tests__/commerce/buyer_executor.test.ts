/**
 * The buyer-side executor — the one place an order leaves this node
 * (§9.9, §12.7, §15.2, FR-P5, FR-P6).
 *
 * The safety argument is entirely about ORDER OF OPERATIONS, so most of these
 * assert a sequence rather than a value: refuse a duplicate, verify the
 * binding, RECORD then send, settle through the one state machine. Each of
 * those steps in the wrong place produces a real defect — a duplicate order, a
 * dispatched bait-and-switch, a silent lost order, or two components
 * disagreeing about what a buyer state means.
 */

import {
  buildBuyerApprovalPayload,
  type ActingInstall,
  type ApprovingPrincipal,
  type BuyerApprovalContext,
  type BuyerApprovalPayload,
} from '../../src/commerce/approval_payload';
import {
  FIRST_REPOLL_SECONDS,
  submitApprovedOrder,
  type BuyerSendOutcome,
} from '../../src/commerce/buyer_executor';
import { newBuyerOrder } from '../../src/commerce/buyer_reconciliation';
import { InMemoryBuyerOrderRepository } from '../../src/commerce/buyer_orders';
import { installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';

import { BUYER_DID, SUPPLIER_DID, makeOrder, makeQuoteRequest, makeSignedQuote } from './helpers';

import type { OrderAcknowledgement, PurchaseOrderProposal } from '@dina/commerce-protocol';

const NOW = 1_700_000_000_000;

const INSTALL: ActingInstall = {
  installId: 'install-buyer',
  capabilityId: 'com.dinakernel.commerce.submit-order',
  manifestCid: 'bafyreibuyer',
  installScopeHash: 's'.repeat(64),
  configRevision: '1',
};
const PRINCIPAL: ApprovingPrincipal = {
  principalDid: 'did:plc:sanchoowner',
  authorityDomain: 'procurement',
  policyRevision: null,
};

function order(): PurchaseOrderProposal {
  const request = makeQuoteRequest();
  const quote = makeSignedQuote(request, { quote_id: 'q-exec' });
  return makeOrder(quote, request.delivery.projection);
}

function context(overrides: Partial<BuyerApprovalContext> = {}): BuyerApprovalContext {
  return {
    actingBusinessDid: BUYER_DID,
    principal: PRINCIPAL,
    serviceUri: `at://${SUPPLIER_DID}/com.dinakernel.service.profile/self`,
    displayedLabels: { l1: 'Oak dining chair' },
    productKeys: { l1: 'gtin:05012345678900' },
    linePrices: { l1: { currency: 'INR', minor_units: '500' } },
    charges: [],
    quoteRevision: 1,
    quoteExpiresAt: '2026-08-09T09:00:00.000Z',
    install: INSTALL,
    ...overrides,
  };
}

function approvalFor(proposal: PurchaseOrderProposal, ctx = context()): BuyerApprovalPayload {
  const built = buildBuyerApprovalPayload(proposal, ctx);
  if (!built.ok) throw new Error(`fixture is missing ${built.missing.join(', ')}`);
  return built.payload;
}

/**
 * An acknowledgement that is ABOUT the order under test.
 *
 * It used to be `{ kind }` and nothing else, which settled an order without
 * naming it — the gap the binding check closes. It now takes the proposal so
 * the fixture and the record agree by construction rather than by luck.
 */
function ack(kind: string, forOrder: PurchaseOrderProposal = order()): OrderAcknowledgement {
  return {
    kind,
    // §9.13 — the answer speaks the conversation's dialect, which is the
    // ORDER's. Taken from the proposal rather than restated, so a fixture
    // cannot drift from the record it is checked against.
    protocol_version: forOrder.protocol_version,
    purchase_order_id: forOrder.purchase_order_id,
    order_digest: forOrder.order_digest,
    buyer_did: forOrder.buyer_did,
    supplier_did: forOrder.supplier_did,
    ...(kind === 'accepted' ? { accepted_quote_digest: forOrder.quote_digest } : {}),
    ...(kind === 'counterproposal'
      ? {
          replacement_quote: {
            // §9.13 again, and for the REPLACEMENT rather than the envelope:
            // a counterproposal carries the terms a new order would be built
            // against, so it is the quote's version that decides the
            // conversation's dialect. Taken from the proposal for the same
            // reason as above — the two-field stand-in that used to sit here
            // had no version at all, which is a shape no real supplier sends.
            protocol_version: forOrder.protocol_version,
            replaces_quote_digest: forOrder.quote_digest,
            quote_id: `${forOrder.quote_id}-next`,
          },
        }
      : {}),
  } as unknown as OrderAcknowledgement;
}

let buyerOrders: InMemoryBuyerOrderRepository;
let events: string[];

beforeEach(() => {
  buyerOrders = new InMemoryBuyerOrderRepository();
  events = [];
  installCommerceRuntime({ buyerOrders } as unknown as CommerceRuntime);
});

afterEach(() => installCommerceRuntime(null));

/** A sender that records that it ran, so the ORDER of operations is visible. */
function sender(outcome: BuyerSendOutcome) {
  return async (): Promise<BuyerSendOutcome> => {
    events.push(`send:${buyerOrders.listUnsettled().length === 0 ? 'no-record' : 'record-exists'}`);
    return Promise.resolve(outcome);
  };
}

async function submit(
  proposal: PurchaseOrderProposal,
  outcome: BuyerSendOutcome,
  overrides: { approved?: BuyerApprovalPayload; context?: BuyerApprovalContext } = {},
) {
  return submitApprovedOrder({
    order: proposal,
    approved: overrides.approved ?? approvalFor(proposal),
    context: overrides.context ?? context(),
    serviceRkey: 'self',
    send: sender(outcome),
    nowMs: NOW,
  });
}

describe('the order of operations', () => {
  it('records BEFORE it sends', async () => {
    // A crash between the write and the send leaves a record for an order that
    // never left, which reconcile resolves safely. Sending first would leave
    // NO record of an order that may exist, and nothing would ever ask about
    // it — a silent lost order.
    const proposal = order();
    await submit(proposal, { kind: 'ambiguous', reason: 'timeout' });
    expect(events).toEqual(['send:record-exists']);
  });

  it('does not send at all when the binding fails', async () => {
    // The §15.2 check runs before anything is written or dispatched, so a
    // re-planned order between the tap and the send never reaches the wire.
    const proposal = order();
    const approved = approvalFor(proposal);
    const swapped = { ...proposal, supplier_did: 'did:plc:rivalchairs01' };
    const result = await submit(
      swapped,
      { kind: 'acknowledged', acknowledgement: ack('accepted') },
      { approved },
    );
    expect(result).toMatchObject({ ok: false, refusal: 'approval_binding_failed' });
    expect(events).toEqual([]);
    expect(buyerOrders.listUnsettled()).toEqual([]);
  });

  it('refuses a duplicate at the door rather than at the reconcile lane', async () => {
    // §12.7's whole discipline is that a buyer never creates a second order for
    // the same purchase. The cheapest place to honour that is before the send.
    const proposal = order();
    await submit(proposal, { kind: 'ambiguous', reason: 'timeout' });
    events.length = 0;
    const again = await submit(proposal, {
      kind: 'acknowledged',
      acknowledgement: ack('accepted'),
    });
    expect(again).toMatchObject({ ok: false, refusal: 'already_submitted' });
    expect(events).toEqual([]);
    // The caller still gets the tracked state, so a UI can show what IS known
    // rather than an error with no context.
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('expected a refusal');
    expect(again.record?.state).toBe('outcome_unknown');
  });

  it('fails closed with no commerce runtime', async () => {
    installCommerceRuntime(null);
    const result = await submit(order(), {
      kind: 'acknowledged',
      acknowledgement: ack('accepted'),
    });
    expect(result).toMatchObject({ ok: false, refusal: 'commerce_unavailable' });
    expect(events).toEqual([]);
  });
});

/**
 * §12.7 UNDER CONCURRENCY — the interleavings that put a second real order on
 * the wire, or undo a settled one.
 *
 * Every buyer-side write is load → AWAIT → write. Without a swap value the
 * SLOWEST writer wins, and each of these is a case where that is exactly the
 * wrong outcome.
 */
describe('two writers on one order', () => {
  it('sends ONCE when two submissions race past the duplicate read', async () => {
    // The check at step 1 is a READ, and two concurrent submissions both pass
    // it. Only the insert is atomic — and its answer used to be ignored, so
    // both sent.
    const proposal = order();
    const sent: string[] = [];
    const both = [0, 1].map(() =>
      submitApprovedOrder({
        order: proposal,
        approved: approvalFor(proposal),
        context: context(),
        serviceRkey: 'self',
        send: async () => {
          sent.push(proposal.purchase_order_id);
          return { kind: 'ambiguous', reason: 'slow' } as const;
        },
        nowMs: NOW,
      }),
    );
    const results = await Promise.all(both);
    expect(sent).toHaveLength(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.refusal === 'already_submitted')).toHaveLength(1);
  });

  it('does NOT undo a terminal answer that landed while the send was in flight', async () => {
    // A re-poll settles the order while the send is still awaiting. Writing
    // the send's own `outcome_unknown` over it would turn a settled order back
    // into the state that invites a duplicate.
    const proposal = order();
    const answer = ack('accepted', proposal);
    let settledRevision = -1;
    const result = await submitApprovedOrder({
      order: proposal,
      approved: approvalFor(proposal),
      context: context(),
      serviceRkey: 'self',
      send: async () => {
        // Mid-flight: the poller's answer arrives and settles the order.
        const live = buyerOrders.get(proposal.supplier_did, proposal.purchase_order_id);
        if (live === null) throw new Error('expected the pre-send record');
        buyerOrders.put(proposal.supplier_did, {
          ...live,
          state: 'accepted',
          acknowledgement: answer,
          nextPollAtMs: null,
        });
        settledRevision =
          buyerOrders.get(proposal.supplier_did, proposal.purchase_order_id)?.revision ?? -1;
        return { kind: 'ambiguous', reason: 'transport slow' } as const;
      },
      nowMs: NOW,
    });

    expect(result.ok).toBe(true);
    const stored = buyerOrders.get(proposal.supplier_did, proposal.purchase_order_id);
    expect(stored?.state).toBe('accepted');
    expect(stored?.acknowledgement).toEqual(answer);
    // AND NOTHING WAS WRITTEN OVER IT. The state machine would also refuse to
    // move a terminal record, so preserving the STATE alone does not prove the
    // resolver noticed — the revision does. A resolver that fell through to
    // re-apply would rewrite the same values at a new revision, which is a
    // write nobody asked for on a settled order.
    expect(stored?.revision).toBe(settledRevision);
  });

  it('spends ONE resubmission authorization however many workers try', async () => {
    // "One authorization, one resend" is only true if the consume is atomic.
    // Two workers that both read the flag race at the write, and the loser
    // must not send.
    const proposal = order();
    const first = buyerOrders.get(proposal.supplier_did, proposal.purchase_order_id);
    void first;
    buyerOrders.create(proposal.supplier_did, {
      ...newBuyerOrder(proposal.purchase_order_id, {
        orderDigest: proposal.order_digest,
        idempotencyKey: proposal.idempotency_key,
        protocolVersion: proposal.protocol_version,
        serviceRkey: 'self',
        quoteDigest: proposal.quote_digest,
        quoteId: proposal.quote_id,
        buyerDid: proposal.buyer_did,
        supplierDid: proposal.supplier_did,
      }),
      state: 'never_received',
      resubmissionAuthorized: true,
    });

    const sent: string[] = [];
    const resend = (): Promise<unknown> =>
      submitApprovedOrder({
        order: proposal,
        approved: approvalFor(proposal),
        context: context(),
        serviceRkey: 'self',
        resend: true,
        send: async () => {
          sent.push('x');
          return { kind: 'ambiguous', reason: 'slow' } as const;
        },
        nowMs: NOW,
      });
    const results = (await Promise.all([resend(), resend()])) as {
      ok: boolean;
      refusal?: string;
    }[];
    expect(sent).toHaveLength(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.refusal === 'resend_not_authorized')).toHaveLength(1);
  });
});

describe('the crash between recording and sending', () => {
  /**
   * The send NEVER RETURNS — it throws out of the executor, so the settle
   * below it never runs. That is the crash's observable shape from the store's
   * point of view, and the only way to see the pre-send record as it is left.
   *
   * A send that returns `ambiguous` would settle and schedule a poll on its
   * way out, so a test using one proves nothing about the pre-send write. My
   * first version did exactly that.
   */
  async function submitAndCrash(proposal: PurchaseOrderProposal): Promise<void> {
    await expect(
      submitApprovedOrder({
        order: proposal,
        approved: approvalFor(proposal),
        context: context(),
        serviceRkey: 'self',
        send: () => Promise.reject(new Error('the process died mid-send')),
        nowMs: NOW,
      }),
    ).rejects.toThrow('the process died mid-send');
  }

  it('SCHEDULES the first reconcile poll before the send', async () => {
    // Recording before sending only helps if something later ASKS. A record
    // written with `nextPollAtMs` null is invisible to both the sweeper and
    // the poller — they select on a non-null due time — so the order sat in
    // `submitted_unconfirmed` forever and step 3's durability argument was
    // half an argument.
    const proposal = order();
    await submitAndCrash(proposal);
    const stored = buyerOrders.get(proposal.supplier_did, proposal.purchase_order_id);
    expect(stored).not.toBeNull();
    expect(stored?.state).toBe('submitted_unconfirmed');
    expect(stored?.nextPollAtMs).toBe(NOW + FIRST_REPOLL_SECONDS * 1000);
  });

  it('leaves the record where the sweeper will find it', async () => {
    const proposal = order();
    await submitAndCrash(proposal);
    expect(buyerOrders.listUnsettled().map((e) => e.record.purchaseOrderId)).toEqual([
      proposal.purchase_order_id,
    ]);
  });
});

describe('settling from the send outcome', () => {
  it.each([
    ['accepted', 'accepted'],
    ['rejected', 'rejected'],
    ['counterproposal', 'countered'],
  ])('an %s acknowledgement settles as %s', async (kind, state) => {
    const proposal = order();
    const answer = ack(kind, proposal);
    const result = await submit(proposal, { kind: 'acknowledged', acknowledgement: answer });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.record.state).toBe(state);
    expect(result.record.acknowledgement).toEqual(answer);
    // Settled orders leave the unsettled list.
    expect(buyerOrders.listUnsettled()).toEqual([]);
  });

  it('parks an unknown acknowledgement kind rather than guessing a terminal state', async () => {
    // The supplier answered SOMETHING, so the order may well exist. Guessing a
    // terminal state for an answer this build does not understand is how a real
    // commitment gets closed by mistake.
    const result = await submit(order(), { kind: 'acknowledged', acknowledgement: ack('teapot') });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.record.state).toBe('outcome_unknown');
    expect(result.record.resubmissionAuthorized).toBe(false);
  });

  it('treats a refused send as never_received, and only then authorizes a resend', async () => {
    // `not_sent` is a PROMISE that nothing crossed the boundary. That is the
    // one fact which safely authorizes sending again.
    const result = await submit(order(), { kind: 'not_sent', reason: 'egress gate closed' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.record.state).toBe('never_received');
    expect(result.record.resubmissionAuthorized).toBe(true);
  });

  it('treats an ambiguous send as unresolved, never as processing', async () => {
    // `received_processing` means the decision has not reached the external
    // boundary — something this node cannot know. The two differ in exactly
    // the direction that matters: only `received_unresolved` never authorizes
    // a resend.
    const result = await submit(order(), { kind: 'ambiguous', reason: 'socket dropped' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.record.state).toBe('outcome_unknown');
    expect(result.record.resubmissionAuthorized).toBe(false);
    expect(result.record.nextPollAtMs).toBe(NOW + FIRST_REPOLL_SECONDS * 1000);
  });

  it('persists what it settled, not just what it returned', async () => {
    // The caller's copy and the durable copy must agree, or a restart shows a
    // different order than the screen did.
    const proposal = order();
    const result = await submit(proposal, { kind: 'ambiguous', reason: 'timeout' });
    if (!result.ok) throw new Error(result.error);
    expect(buyerOrders.get(SUPPLIER_DID, proposal.purchase_order_id)).toEqual(result.record);
  });
});

describe('the binding this executor enforces (§15.2 / FR-P5)', () => {
  it.each([
    ['a swapped install', () => context({ install: { ...INSTALL, installId: 'install-other' } })],
    [
      'a different principal',
      () => context({ principal: { ...PRINCIPAL, principalDid: 'did:plc:someoneelse' } }),
    ],
    ['a re-labelled line', () => context({ displayedLabels: { l1: 'Pine stool' } })],
  ])('refuses to send after %s', async (_label, make) => {
    const proposal = order();
    const approved = approvalFor(proposal);
    const result = await submit(
      proposal,
      { kind: 'acknowledged', acknowledgement: ack('accepted') },
      { approved, context: make() },
    );
    expect(result).toMatchObject({ ok: false, refusal: 'approval_binding_failed' });
    expect(events).toEqual([]);
  });

  it('refuses when the card omitted a §15.2 field', async () => {
    const proposal = order();
    const result = await submit(
      proposal,
      { kind: 'acknowledged', acknowledgement: ack('accepted') },
      { approved: approvalFor(proposal), context: context({ linePrices: {} }) },
    );
    expect(result).toMatchObject({ ok: false, refusal: 'approval_binding_failed' });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error).toContain('linePrices[l1]');
    expect(events).toEqual([]);
  });
});

/**
 * §7.2/§7.3 — nobody without authority commits this business.
 *
 * Checked BEFORE the binding: there is no point proving an order is the one
 * that was approved if nobody who approved it may commit the business, and
 * checking here rather than at the card means an order cannot be sent under an
 * approval whose authority has since expired.
 */
describe('staff authority on the submit path', () => {
  const OWNER = 'did:plc:sanchoowner';
  const chain = (proposal: PurchaseOrderProposal) => ({
    principalDid: OWNER,
    installId: INSTALL.installId,
    actingForBusinessDid: BUYER_DID,
    authorityDomain: 'procurement',
    policyRevision: null,
    supplierDid: proposal.supplier_did,
    serviceRkey: 'self',
    quoteDigest: proposal.quote_digest,
    orderDigest: proposal.order_digest,
  });

  it('sends when an owner grant covers it', async () => {
    const proposal = order();
    const result = await submitApprovedOrder({
      order: proposal,
      approved: approvalFor(proposal),
      context: context(),
      serviceRkey: 'self',
      send: sender({ kind: 'acknowledged', acknowledgement: ack('accepted') }),
      nowMs: NOW,
      authority: {
        chain: chain(proposal),
        approvals: [OWNER],
        grants: [{ kind: 'owner', principalDid: OWNER }],
        quorum: { secondPersonAtOrAboveMinorUnits: null, currency: 'INR' },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('refuses BEFORE the send when nobody holds a live grant', async () => {
    const proposal = order();
    const result = await submitApprovedOrder({
      order: proposal,
      approved: approvalFor(proposal),
      context: context(),
      serviceRkey: 'self',
      send: sender({ kind: 'acknowledged', acknowledgement: ack('accepted') }),
      nowMs: NOW,
      authority: {
        chain: chain(proposal),
        approvals: [OWNER],
        grants: [],
        quorum: { secondPersonAtOrAboveMinorUnits: null, currency: 'INR' },
      },
    });
    expect(result).toMatchObject({ ok: false, refusal: 'not_authorized' });
    expect(events).toEqual([]);
  });

  it('says a second person would permit it, rather than a flat no', async () => {
    // A UI must be able to say "get someone else" rather than "you cannot do
    // this" — the two send an operator to completely different places.
    const proposal = order();
    const result = await submitApprovedOrder({
      order: proposal,
      approved: approvalFor(proposal),
      context: context(),
      serviceRkey: 'self',
      send: sender({ kind: 'acknowledged', acknowledgement: ack('accepted') }),
      nowMs: NOW,
      authority: {
        chain: chain(proposal),
        approvals: [OWNER],
        grants: [{ kind: 'owner', principalDid: OWNER }],
        quorum: {
          secondPersonAtOrAboveMinorUnits: '1',
          currency: proposal.approved_total.currency,
        },
      },
    });
    expect(result).toMatchObject({ ok: false, refusal: 'not_authorized' });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error).toContain('a second person would permit it');
    expect(events).toEqual([]);
  });

  it('leaves a node with no staff model exactly as it was', async () => {
    // Passing nothing must not start requiring authority — but passing a chain
    // must never skip the check.
    const proposal = order();
    const result = await submit(proposal, {
      kind: 'acknowledged',
      acknowledgement: ack('accepted'),
    });
    expect(result.ok).toBe(true);
  });
});
