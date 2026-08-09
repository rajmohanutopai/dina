/**
 * Closing the order round trip (§9.9, WS-3.9).
 *
 * The claim: a buyer never receives the runner's JSON. They receive what Core
 * signed. Everything here is a variation on that — an accepted order, a
 * rejected one, and the several ways a runner can answer something Core
 * refuses to turn into a commitment.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  commerceRecordDigest,
  validateCommerceOrderStatus,
  type CommerceOrderStatus,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import {
  installCommerceRuntime,
  settleInboundOrderDecision,
  transformInboundOrderResult,
  type CommerceRuntime,
} from '../../src/commerce';
import { buildSupplierApprovalPayload } from '../../src/commerce/approval_payload';
import { InMemoryPendingSupplierDecisionRepository } from '../../src/commerce/pending_decisions';
import { InMemoryCommerceSettingsRepository } from '../../src/commerce/settings_store';

const BUYER = 'did:plc:sancho';
const PO = 'po-1';
const SUPPLIER = 'did:plc:chairmaker';
const statusHash: Sha256Fn = (data) => sha256(data);

/** A stand-in admission engine that records what it was asked to decide. */
function runtimeWith(
  decide: (
    buyer: string,
    po: string,
    decision: unknown,
  ) => { acknowledgement: unknown } | { error: string },
  seen: unknown[] = [],
  settings?: InMemoryCommerceSettingsRepository,
  pendingDecisions?: InMemoryPendingSupplierDecisionRepository,
): void {
  installCommerceRuntime({
    admission: {
      decideOrder: (buyer: string, po: string, decision: unknown) => {
        seen.push({ buyer, po, decision });
        return decide(buyer, po, decision);
      },
    },
    // The REAL settings store, empty. §15.2b is now read on the acceptance
    // path, and a stub that answered the policy question itself would be a
    // test of the stub — this is the store production uses, holding nothing,
    // which is the "not configured" case the rule has to handle.
    settings: settings ?? new InMemoryCommerceSettingsRepository(),
    // §15.2b's card store. Present by default so the seam's `put` is a real
    // call rather than an optional-chain no-op that would hide a regression.
    pendingDecisions: pendingDecisions ?? new InMemoryPendingSupplierDecisionRepository(),
  } as unknown as CommerceRuntime);
}

afterEach(() => installCommerceRuntime(null));

describe('settleInboundOrderDecision (§9.9)', () => {
  it('records an acceptance and returns the SIGNED acknowledgement', () => {
    const seen: unknown[] = [];
    runtimeWith(() => ({ acknowledgement: { kind: 'accepted', signature: 'sig' } }), seen);

    const result = settleInboundOrderDecision({
      buyerDid: BUYER,
      purchaseOrderId: PO,
      runnerResultJson: JSON.stringify({ kind: 'accepted', supplier_order_id: 'CM-1' }),
    });

    expect(result).toEqual({
      ok: true,
      acknowledgementJson: JSON.stringify({ kind: 'accepted', signature: 'sig' }),
    });
    // The decision reached the engine with the supplier's order id intact.
    expect(seen).toEqual([
      { buyer: BUYER, po: PO, decision: { kind: 'accepted', supplierOrderId: 'CM-1' } },
    ]);
  });

  it('accepts the camelCase spelling a TypeScript runner would emit', () => {
    const seen: unknown[] = [];
    runtimeWith(() => ({ acknowledgement: { kind: 'accepted' } }), seen);

    settleInboundOrderDecision({
      buyerDid: BUYER,
      purchaseOrderId: PO,
      runnerResultJson: JSON.stringify({ kind: 'accepted', supplierOrderId: 'CM-2' }),
    });

    expect(seen).toEqual([
      { buyer: BUYER, po: PO, decision: { kind: 'accepted', supplierOrderId: 'CM-2' } },
    ]);
  });

  it('treats a rejection as a commercial outcome, still signed', () => {
    runtimeWith(() => ({ acknowledgement: { kind: 'rejected', reason_code: 'out_of_stock' } }));

    const result = settleInboundOrderDecision({
      buyerDid: BUYER,
      purchaseOrderId: PO,
      runnerResultJson: JSON.stringify({ kind: 'rejected', reason_code: 'out_of_stock' }),
    });

    // A refusal is something the buyer can show, not an error.
    expect(result.ok).toBe(true);
  });

  it.each([
    ['not JSON', 'this is not json', 'result_unreadable'],
    ['an unknown kind', JSON.stringify({ kind: 'maybe' }), 'decision_unrecognized'],
    [
      'accepted with no supplier order id',
      JSON.stringify({ kind: 'accepted' }),
      'decision_unrecognized',
    ],
    ['rejected with no reason', JSON.stringify({ kind: 'rejected' }), 'decision_unrecognized'],
    ['a bare string', JSON.stringify('accepted'), 'decision_unrecognized'],
    [
      'a counterproposal with no replacement quote',
      JSON.stringify({ kind: 'counterproposal' }),
      'decision_unrecognized',
    ],
    [
      'a counterproposal whose replacement is not an object',
      JSON.stringify({ kind: 'counterproposal', replacement_quote: 'nope' }),
      'decision_unrecognized',
    ],
  ])('refuses %s WITHOUT deciding the order', (_label, json, refusal) => {
    const seen: unknown[] = [];
    runtimeWith(() => ({ acknowledgement: {} }), seen);

    const result = settleInboundOrderDecision({
      buyerDid: BUYER,
      purchaseOrderId: PO,
      runnerResultJson: json,
    });

    expect(result).toEqual({ ok: false, refusal, error: expect.any(String) });
    // The point of the refusal: an answer Core cannot read must leave the
    // order UNDECIDED for the sweeper, never guess at the supplier's intent.
    expect(seen).toEqual([]);
  });

  it('carries a counterproposal through to the engine, which owns its checks', () => {
    const seen: unknown[] = [];
    runtimeWith(() => ({ acknowledgement: { kind: 'countered' } }), seen);
    const replacement = { quote_id: 'q-2', replaces_quote_digest: 'd'.repeat(64) };

    const result = settleInboundOrderDecision({
      buyerDid: BUYER,
      purchaseOrderId: PO,
      runnerResultJson: JSON.stringify({ kind: 'counterproposal', replacement_quote: replacement }),
    });

    expect(result.ok).toBe(true);
    // Passed through intact: lineage (§9.9) and registration through the quote
    // family (§9.8 audience binding) are `decideOrder`'s to enforce, and a
    // second opinion here could only disagree with the one that counts.
    expect(seen).toEqual([
      {
        buyer: BUYER,
        po: PO,
        decision: { kind: 'counterproposal', replacementQuote: replacement },
      },
    ]);
  });

  it('surfaces the engine refusing a bad counter lineage', () => {
    runtimeWith(() => ({
      error: 'admission: counter lineage must point at the countered quote (§9.9)',
    }));

    const result = settleInboundOrderDecision({
      buyerDid: BUYER,
      purchaseOrderId: PO,
      runnerResultJson: JSON.stringify({ kind: 'counterproposal', replacement_quote: { a: 1 } }),
    });

    expect(!result.ok && result.refusal).toBe('decision_refused');
  });

  it('fails closed with no commerce runtime', () => {
    const result = settleInboundOrderDecision({
      buyerDid: BUYER,
      purchaseOrderId: PO,
      runnerResultJson: JSON.stringify({ kind: 'accepted', supplier_order_id: 'CM-1' }),
    });
    expect(!result.ok && result.refusal).toBe('commerce_unavailable');
  });

  it('surfaces an engine refusal rather than claiming success', () => {
    runtimeWith(() => ({ error: 'admission: unknown order' }));

    const result = settleInboundOrderDecision({
      buyerDid: BUYER,
      purchaseOrderId: PO,
      runnerResultJson: JSON.stringify({ kind: 'accepted', supplier_order_id: 'CM-1' }),
    });

    expect(result).toEqual({
      ok: false,
      refusal: 'decision_refused',
      error: 'admission: unknown order',
    });
  });
});

describe('§15.2b — an order held for a human, and the card that holds it', () => {
  const RUNNER_ANSWER = JSON.stringify({ kind: 'accepted', supplier_order_id: 'CM-7' });

  /**
   * A supplier whose policy is `review`, through the REAL settings store.
   *
   * Not a stub answering the policy question itself — that would test the
   * stub. `review` is a saveable value again now that the lane exists, which
   * is the whole point of this describe.
   */
  function reviewingSettings(): InMemoryCommerceSettingsRepository {
    const store = new InMemoryCommerceSettingsRepository();
    const written = store.writeSupplier({
      actingBusinessDid: 'did:plc:chairmaker99',
      catalogSource: { kind: 'inline', lastHealthyAtIso: '2026-08-08T09:00:00.000Z' },
      publicRegions: [],
      publishIndicativePrice: true,
      quoteAccess: 'anyone',
      responsePolicy: {},
      customerPricingSource: null,
      orderAcceptance: 'review',
      listingState: 'live',
      connectors: [],
    } as never);
    if (!written.ok) throw new Error('fixture: review must be saveable now');
    return store;
  }
  it('RECORDS a pending decision when acceptance needs approval, then withholds', () => {
    // The half that was missing. `approval_required` used to withhold and
    // leave nothing behind, so the owner was never told an order was waiting
    // and it lapsed at its deadline. It is the one refusal that names a
    // PERSON rather than a fault, so it gets a durable card.
    const pending = new InMemoryPendingSupplierDecisionRepository();
    runtimeWith(() => ({ acknowledgement: {} }), [], reviewingSettings(), pending);

    const out = transformInboundOrderResult({
      capability: 'submit_order',
      fromDid: BUYER,
      params: { purchase_order_id: PO },
      resultJSON: RUNNER_ANSWER,
    });

    expect(out).toEqual({ kind: 'withhold', reason: 'approval_required' });
    const held = pending.get(BUYER, PO);
    // THE RUNNER'S BYTES, VERBATIM. Settlement replays exactly these, so a
    // pack that revises its proposal after the card was raised cannot have
    // the new answer signed under the old consent.
    expect(held?.runnerResultJson).toBe(RUNNER_ANSWER);
    expect(held?.reason).toBe('approval_required');
  });

  it('records ONE card however many times the runner answers', () => {
    // A retry must not produce a second card, and the FIRST answer is the one
    // held: a second is a pack revising a proposal the owner may already be
    // looking at.
    const pending = new InMemoryPendingSupplierDecisionRepository();
    runtimeWith(() => ({ acknowledgement: {} }), [], reviewingSettings(), pending);
    const call = (result: string) =>
      transformInboundOrderResult({
        capability: 'submit_order',
        fromDid: BUYER,
        params: { purchase_order_id: PO },
        resultJSON: result,
      });

    call(RUNNER_ANSWER);
    call(JSON.stringify({ kind: 'accepted', supplier_order_id: 'CM-REVISED' }));

    expect(pending.list()).toHaveLength(1);
    expect(pending.get(BUYER, PO)?.runnerResultJson).toBe(RUNNER_ANSWER);
  });

  it('records NO card for a refusal that names a fault rather than a person', () => {
    // `result_unreadable` and friends mean Core could not record the decision
    // at all. There is nothing for an owner to agree to, and a card would ask
    // them to approve a runner answer nobody could parse.
    const pending = new InMemoryPendingSupplierDecisionRepository();
    runtimeWith(() => ({ acknowledgement: {} }), [], reviewingSettings(), pending);

    transformInboundOrderResult({
      capability: 'submit_order',
      fromDid: BUYER,
      params: { purchase_order_id: PO },
      resultJSON: 'not json',
    });

    expect(pending.list()).toEqual([]);
  });
});

describe('cancellation goes through Core, not the runner (§12.5, §12.8)', () => {
  const REQUEST = { cancellation_id: 'c-1', purchase_order_id: PO };

  function runtimeWithCancellation(
    resolve: (req: unknown, buyer: string, policy: () => string) => unknown,
    seen: unknown[] = [],
  ): void {
    installCommerceRuntime({
      lifecycle: {
        resolveCancellation: (req: unknown, buyer: string, policy: () => string) => {
          seen.push({ req, buyer, policy: policy() });
          return resolve(req, buyer, policy);
        },
      },
    } as unknown as CommerceRuntime);
  }

  it('replaces the runner verdict with the CancellationResult Core persisted', () => {
    const seen: unknown[] = [];
    runtimeWithCancellation(() => ({ kind: 'cancelled', cancellation_id: 'c-1' }), seen);

    const out = transformInboundOrderResult({
      capability: 'cancel_order',
      fromDid: BUYER,
      params: REQUEST,
      resultJSON: JSON.stringify({ verdict: 'cancelled' }),
    });

    expect(out).toEqual({
      kind: 'replace',
      json: JSON.stringify({ kind: 'cancelled', cancellation_id: 'c-1' }),
    });
  });

  it('passes the runner verdict as POLICY, and the AUTHENTICATED buyer as identity', () => {
    // The runner says what this business wants; Core decides whether dispatch
    // already won. And the buyer is the authenticated sender, never a field
    // inside the request — otherwise anyone could cancel anyone's order.
    const seen: unknown[] = [];
    runtimeWithCancellation(() => ({ kind: 'refused_policy' }), seen);

    transformInboundOrderResult({
      capability: 'cancel_order',
      fromDid: BUYER,
      params: { ...REQUEST, buyer_did: 'did:plc:attacker' },
      resultJSON: JSON.stringify({ verdict: 'refused_policy' }),
    });

    expect(seen).toEqual([
      { req: { ...REQUEST, buyer_did: 'did:plc:attacker' }, buyer: BUYER, policy: 'refused_policy' },
    ]);
  });

  it('treats an unreadable runner answer as NO opinion, not as a refusal', () => {
    // "I cannot tell what this business wants" is not "they said no". Holding
    // it for a human is the only reading that neither cancels nor refuses on
    // the owner's behalf.
    const seen: unknown[] = [];
    runtimeWithCancellation(() => ({ kind: 'pending_review' }), seen);

    transformInboundOrderResult({
      capability: 'cancel_order',
      fromDid: BUYER,
      params: REQUEST,
      resultJSON: 'not json at all',
    });

    expect((seen[0] as { policy: string }).policy).toBe('pending_review');
  });

  it('WITHHOLDS when Core cannot record the cancellation', () => {
    runtimeWithCancellation(() => ({ error: 'cancellation: order digest does not bind' }));

    expect(
      transformInboundOrderResult({
        capability: 'com.dinakernel.commerce.cancel-order',
        capabilityId: 'com.dinakernel.commerce.cancel-order',
        fromDid: BUYER,
        params: REQUEST,
        resultJSON: JSON.stringify({ verdict: 'cancelled' }),
      }),
    ).toEqual({ kind: 'withhold', reason: expect.stringContaining('does not bind') });
  });
});

describe('transformInboundOrderResult — the workflow seam', () => {
  const RUNNER_ANSWER = JSON.stringify({ kind: 'accepted', supplier_order_id: 'CM-7' });

  it('replaces the runner answer with the signed acknowledgement', () => {
    runtimeWith(() => ({ acknowledgement: { kind: 'accepted', signature: 'sig' } }));

    const out = transformInboundOrderResult({
      capability: 'submit_order',
      fromDid: BUYER,
      params: { purchase_order_id: PO },
      resultJSON: RUNNER_ANSWER,
    });

    expect(out).toEqual({
      kind: 'replace',
      json: JSON.stringify({ kind: 'accepted', signature: 'sig' }),
    });
  });

  it.each([
    // The id the supplier REFERENCE MANIFEST actually publishes. The ingress
    // gate canonicalizes hyphens and admitted this all along; the seam
    // compared the raw wire label and did not, so an order that reserved quote
    // capacity came back as `passthrough` and the buyer received the runner's
    // unsigned decision as though Core had signed it.
    ['com.dinakernel.commerce.submit-order', 'com.dinakernel.commerce.submit-order'],
    // A LOCAL LISTING ALIAS: the wire label is whatever the listing calls it,
    // and only the BOUND manifest capability names a commerce capability.
    ['chairmaker.orders.place', 'com.dinakernel.commerce.submit-order'],
    // Underscore NSID and bare form still work.
    ['com.dinakernel.commerce.submit_order', 'com.dinakernel.commerce.submit_order'],
    ['submit_order', ''],
  ])('recognises the order lane for wire %p bound to %p', (capability, capabilityId) => {
    runtimeWith(() => ({ acknowledgement: { kind: 'accepted', signature: 'sig' } }));
    const out = transformInboundOrderResult({
      capability,
      ...(capabilityId === '' ? {} : { capabilityId }),
      fromDid: BUYER,
      params: { purchase_order_id: PO },
      resultJSON: RUNNER_ANSWER,
    });
    // Replaced with Core's acknowledgement — NOT passed through.
    expect(out).toEqual({
      kind: 'replace',
      json: JSON.stringify({ kind: 'accepted', signature: 'sig' }),
    });
  });

  it('withholds rather than passing through when a hyphenated order cannot be recorded', () => {
    // The same bypass, on the failure path: before the canonicalizer the
    // hyphenated id fell to `passthrough`, which is exactly the leak the
    // withhold rule exists to stop.
    runtimeWith(() => ({ error: 'admission: unknown order' }));
    expect(
      transformInboundOrderResult({
        capability: 'com.dinakernel.commerce.submit-order',
        capabilityId: 'com.dinakernel.commerce.submit-order',
        fromDid: BUYER,
        params: { purchase_order_id: PO },
        resultJSON: RUNNER_ANSWER,
      }),
    ).toEqual({ kind: 'withhold', reason: expect.any(String) });
  });

  it('binds the decision to the AUTHENTICATED sender, not a runner-chosen field', () => {
    const seen: unknown[] = [];
    runtimeWith(() => ({ acknowledgement: {} }), seen);

    transformInboundOrderResult({
      capability: 'com.dinakernel.commerce.submit_order',
      fromDid: BUYER,
      // A hostile runner naming someone else's buyer must not redirect this.
      params: { purchase_order_id: PO, buyer_did: 'did:plc:attacker' },
      resultJSON: RUNNER_ANSWER,
    });

    expect((seen[0] as { buyer: string }).buyer).toBe(BUYER);
  });

  /**
   * `order_status` used to be in this list. WS-2.10 moved it out: the seam now
   * owns TWO capabilities with different treatments — `submit_order` is
   * replaced with Core's signed acknowledgement, `order_status` has its
   * `state` corrected against Core's chain. Everything else is still none of
   * its business, and that is what this asserts.
   */
  // `cancel_order` USED TO BE IN THIS LIST, and that was the defect: it fell
  // through to passthrough, so a runner could report a cancellation that
  // changed no order, no status head and no hold, and the buyer believed it.
  // The whole atomic cancellation engine was unreachable. Its own tests are
  // below.
  it.each(['request_quote', 'availability'])(
    'leaves %s untouched',
    (capability) => {
      const seen: unknown[] = [];
      runtimeWith(() => ({ acknowledgement: {} }), seen);

      expect(
        transformInboundOrderResult({
          capability,
          fromDid: BUYER,
          params: { purchase_order_id: PO },
          resultJSON: RUNNER_ANSWER,
        }),
      ).toEqual({ kind: 'passthrough' });
      expect(seen).toEqual([]);
    },
  );

  it('WITHHOLDS the runner answer when the decision cannot be recorded', () => {
    runtimeWith(() => ({ error: 'admission: unknown order' }));

    // THIS ASSERTION IS INVERTED FROM WHAT IT USED TO SAY, and the old one was
    // wrong. It read: "Null means 'send what the runner said' — the response
    // must not vanish just because Core could not turn it into a commitment."
    //
    // But `submit_order` asks one question — did you accept my order — and the
    // runner's payload is unsigned and unrecorded. Sending it tells the buyer
    // their order was decided when no decision exists anywhere. The response
    // SHOULD vanish: an unanswered submission is a state §12.7's buyer
    // reconcile is built to resolve, and it is the only honest one available.
    expect(
      transformInboundOrderResult({
        capability: 'submit_order',
        fromDid: BUYER,
        params: { purchase_order_id: PO },
        resultJSON: RUNNER_ANSWER,
      }),
    ).toEqual({ kind: 'withhold', reason: expect.any(String) });
  });

  it('leaves it in place when the params name no order', () => {
    const seen: unknown[] = [];
    runtimeWith(() => ({ acknowledgement: {} }), seen);

    expect(
      transformInboundOrderResult({
        capability: 'submit_order',
        fromDid: BUYER,
        params: {},
        resultJSON: RUNNER_ANSWER,
      }),
      // Passthrough, not withhold: with no order named this is not a decision
      // the seam ever claimed, so there is nothing for it to suppress.
    ).toEqual({ kind: 'passthrough' });
    expect(seen).toEqual([]);
  });
});

/**
 * WS-2.10 — a runner may enrich a status, but not invent one (§9.11).
 *
 * This came out of the REVERTED WS-2.7. Moving `order_status` into Core was
 * wrong — the published result shape is the SUPPLIER's, and only they know
 * the carrier reference — but the concern underneath was real: nothing
 * stopped a runner reporting a state Core never signed, and a buyer had no
 * way to tell.
 */
describe('a reported status is corrected against Core’s own chain (§9.11)', () => {
  /**
   * A REAL signed status for the head, not a `{state}` stand-in.
   *
   * Core now attaches the record it signed, read back from the receipt at the
   * head digest — so a double whose head is a bare state string tests a path
   * production never takes. The digest comes from the protocol's own digester
   * for the same reason it does everywhere else.
   */
  function signedHead(state: string): CommerceOrderStatus {
    const base = {
      protocol_version: '1.0',
      purchase_order_id: PO,
      buyer_did: BUYER,
      supplier_did: SUPPLIER,
      sequence: '0',
      state,
      supplier_epoch: '1',
      updated_at: '2026-08-01T09:00:00.000Z',
    } as Omit<CommerceOrderStatus, 'status_digest'>;
    return {
      ...base,
      status_digest: commerceRecordDigest(
        'status',
        base as unknown as Record<string, unknown>,
        statusHash,
      ),
    };
  }

  /** A runtime whose chain head is whatever this test says it signed. */
  function runtimeWithChain(head: string | null, options?: { receiptMissing?: boolean }): void {
    const record = head === null ? null : signedHead(head);
    installCommerceRuntime({
      chains: {
        load: () =>
          record === null
            ? {
                exists: false,
                get head(): never {
                  throw new Error('no head');
                },
              }
            : { exists: true, head: { state: record.state, headDigest: record.status_digest } },
      },
      receipts: {
        get: (digest: string) =>
          record === null || options?.receiptMissing === true || digest !== record.status_digest
            ? null
            : { recordDigest: digest, recordJson: JSON.stringify(record) },
      },
    } as unknown as CommerceRuntime);
  }

  // Unwraps to the pre-`IngressResultDecision` shape so the status-lane
  // assertions below keep saying what they said: a string is the corrected
  // report, null is "nothing to correct, send the runner's own answer". The
  // status lane never withholds — that is the decision lane's answer — so a
  // `withhold` here is a real failure and is surfaced rather than folded
  // into null.
  const report = (resultJSON: string, capability = 'order_status'): string | null => {
    const decision = transformInboundOrderResult({
      capability,
      fromDid: BUYER,
      params: { purchase_order_id: PO },
      resultJSON,
    });
    if (decision.kind === 'withhold') {
      throw new Error(`status lane withheld (${decision.reason}); it must never withhold`);
    }
    return decision.kind === 'replace' ? decision.json : null;
  };

  it('overwrites a state the chain does not hold, keeping the enrichment', () => {
    runtimeWithChain('accepted');
    const corrected = report(
      JSON.stringify({
        state: 'delivered',
        carrier_reference: 'BLUEDART-9910',
        note: 'left with reception',
      }),
    );
    expect(corrected).not.toBeNull();
    const answer = JSON.parse(corrected ?? '{}') as Record<string, unknown>;
    // Core signed `accepted`; the runner said `delivered`. The buyer is told
    // what this business has actually CLAIMED.
    expect(answer.state).toBe('accepted');
    // …and still gets what only the supplier knows. Refusing outright would
    // have cost them the carrier reference too, and the runner may simply be
    // ahead of the chain rather than lying.
    expect(answer.carrier_reference).toBe('BLUEDART-9910');
    expect(answer.note).toBe('left with reception');
  });

  it('ATTACHES the signed chain even when the state already agrees', () => {
    // This used to assert the answer was left completely alone. Correcting the
    // state makes a report TRUE; it does not make it CHECKABLE, and §9.11 puts
    // fork detection on the RECEIVER — which needs the sequence, the
    // predecessor digest and the epoch, none of which a bare state carries.
    runtimeWithChain('accepted');
    const corrected = report(JSON.stringify({ state: 'accepted', note: 'on schedule' }));
    expect(corrected).not.toBeNull();
    const answer = JSON.parse(corrected ?? '{}') as Record<string, unknown>;
    expect(answer.note).toBe('on schedule');
    const attached = answer.signed_status_chain as CommerceOrderStatus[];
    expect(attached).toHaveLength(1);
    expect(attached[0]?.state).toBe('accepted');
    expect(attached[0]?.sequence).toBe('0');
    expect(validateCommerceOrderStatus(attached[0], statusHash)).toBeNull();
  });

  it('REPLACES a signed_status_chain the runner put there itself', () => {
    // The field is Core's. A runner supplying its own must never survive, or
    // the attachment proves nothing at all.
    runtimeWithChain('accepted');
    const corrected = report(
      JSON.stringify({
        state: 'accepted',
        signed_status_chain: [{ state: 'delivered', forged: true }],
      }),
    );
    const answer = JSON.parse(corrected ?? '{}') as Record<string, unknown>;
    const attached = answer.signed_status_chain as Record<string, unknown>[];
    expect(attached).toHaveLength(1);
    expect(attached[0]?.forged).toBeUndefined();
    expect(attached[0]?.state).toBe('accepted');
  });

  it('STRIPS a forged chain when there is no chain at all', () => {
    // The gap that would otherwise remain: with no chain the old code returned
    // null and passed the runner's answer through untouched, so "no signed
    // state to contradict" was exactly where a forged one got a free ride.
    runtimeWithChain(null);
    const corrected = report(
      JSON.stringify({ state: 'dispatched', signed_status_chain: [{ state: 'delivered' }] }),
    );
    expect(corrected).not.toBeNull();
    const answer = JSON.parse(corrected ?? '{}') as Record<string, unknown>;
    expect('signed_status_chain' in answer).toBe(false);
    // The display state is still the runner's — with no chain, Core has
    // nothing to correct it with.
    expect(answer.state).toBe('dispatched');
  });

  it('corrects the state but attaches nothing when the receipt is missing', () => {
    // A store-integrity failure on this side. The honest answer is the state
    // Core signed with no evidence attached — never a fabricated record.
    runtimeWithChain('accepted', { receiptMissing: true });
    const corrected = report(JSON.stringify({ state: 'delivered' }));
    const answer = JSON.parse(corrected ?? '{}') as Record<string, unknown>;
    expect(answer.state).toBe('accepted');
    expect('signed_status_chain' in answer).toBe(false);
  });

  it('leaves the answer alone when there is no chain to contradict it', () => {
    // An order with no genesis has no signed state. Substituting one here
    // would be Core making the same kind of claim it is stopping the runner
    // from making.
    runtimeWithChain(null);
    expect(report(JSON.stringify({ state: 'delivered' }))).toBeNull();
  });

  it('adds the signed state when a runner omits it entirely', () => {
    // Omission is not agreement. A card rendering `state: undefined` beside a
    // carrier reference reads as "no idea", when Core knows exactly.
    runtimeWithChain('dispatched');
    const answer = JSON.parse(report(JSON.stringify({ note: 'in transit' })) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(answer.state).toBe('dispatched');
    expect(answer.note).toBe('in transit');
  });

  it('does not touch capabilities it does not own', () => {
    runtimeWithChain('accepted');
    expect(report(JSON.stringify({ state: 'delivered' }), 'request_quote')).toBeNull();
  });

  it('passes an unreadable answer through rather than swallowing it', () => {
    // The bridge's schema check owns that failure; this seam has nothing to
    // correct and must not make the response vanish.
    runtimeWithChain('accepted');
    expect(report('{ not json')).toBeNull();
  });
});

/**
 * §15.2b / FR-P5 — the acknowledgement Core signs is the one that was
 * approved.
 *
 * The runner is the untrusted half of this exchange. It answers, and Core
 * signs. Without a binding, a runner that answers `accepted` where the
 * supplier's human approved `rejected` produces a signed acceptance and every
 * other check passes, because each one validates the decision it was given.
 */
describe('approval binding on the supplier decision (§15.2b)', () => {
  const INSTALL = {
    installId: 'install-1',
    capabilityId: 'com.dinakernel.commerce.submit-order',
    manifestCid: 'bafyreisupplier',
    installScopeHash: 's'.repeat(64),
    configRevision: '2',
  };
  const PRINCIPAL = {
    principalDid: 'did:plc:supplierowner',
    authorityDomain: 'sales',
    policyRevision: null,
  };
  const ORDER_DIGEST = 'a'.repeat(64);
  const QUOTE_DIGEST = 'b'.repeat(64);

  /** A runtime that also answers `orders.load`, which the binding needs. */
  function runtimeWithOrder(
    seen: unknown[] = [],
    settings: InMemoryCommerceSettingsRepository = new InMemoryCommerceSettingsRepository(),
  ): void {
    installCommerceRuntime({
      admission: {
        decideOrder: (buyer: string, po: string, decision: unknown) => {
          seen.push({ buyer, po, decision });
          return { acknowledgement: { kind: 'accepted' } };
        },
      },
      orders: {
        load: () => ({ ref: { orderDigest: ORDER_DIGEST, quoteDigest: QUOTE_DIGEST } }),
      },
      // The REAL store. §15.2b is read here now, and a stub answering the
      // policy question itself would be a test of the stub.
      settings,
    } as unknown as CommerceRuntime);
  }

  function approvalFor(kind: string) {
    return {
      approved: buildSupplierApprovalPayload({
        actingBusinessDid: 'did:plc:chairmaker99',
        principal: PRINCIPAL,
        buyerDid: BUYER,
        purchaseOrderId: PO,
        orderDigest: ORDER_DIGEST,
        quoteDigest: QUOTE_DIGEST,
        acknowledgementKind: kind,
        install: INSTALL,
      }),
      actingBusinessDid: 'did:plc:chairmaker99',
      principal: PRINCIPAL,
      install: INSTALL,
    };
  }

  it('signs the acknowledgement the supplier approved', () => {
    const seen: unknown[] = [];
    runtimeWithOrder(seen);
    const result = settleInboundOrderDecision({
      buyerDid: BUYER,
      purchaseOrderId: PO,
      runnerResultJson: JSON.stringify({ kind: 'accepted', supplier_order_id: 'CM-1' }),
      approval: approvalFor('accepted'),
    });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('refuses when the runner answers something else', () => {
    // The order was approved for REJECTION and the runner accepted it. The
    // state machine would happily record that; a human did not agree to it.
    const seen: unknown[] = [];
    runtimeWithOrder(seen);
    const result = settleInboundOrderDecision({
      buyerDid: BUYER,
      purchaseOrderId: PO,
      runnerResultJson: JSON.stringify({ kind: 'accepted', supplier_order_id: 'CM-1' }),
      approval: approvalFor('rejected'),
    });
    expect(result).toMatchObject({ ok: false, refusal: 'approval_binding_failed' });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error).toContain('acknowledgementKind');
    // NOTHING was decided. Checking after the fact would leave the chain moved
    // on something the supplier never approved.
    expect(seen).toEqual([]);
  });

  it('refuses when the acting install changed between approval and execution', () => {
    const seen: unknown[] = [];
    runtimeWithOrder(seen);
    const approval = approvalFor('accepted');
    const result = settleInboundOrderDecision({
      buyerDid: BUYER,
      purchaseOrderId: PO,
      runnerResultJson: JSON.stringify({ kind: 'accepted', supplier_order_id: 'CM-1' }),
      approval: { ...approval, install: { ...INSTALL, manifestCid: 'bafyreiswapped' } },
    });
    expect(result).toMatchObject({ ok: false, refusal: 'approval_binding_failed' });
    expect(seen).toEqual([]);
  });

  it('refuses when there is no order to bind against', () => {
    // Fails CLOSED. An approval that cannot be checked is not an approval that
    // passed.
    installCommerceRuntime({
      admission: { decideOrder: () => ({ acknowledgement: { kind: 'accepted' } }) },
      orders: { load: () => null },
    } as unknown as CommerceRuntime);
    const result = settleInboundOrderDecision({
      buyerDid: BUYER,
      purchaseOrderId: PO,
      runnerResultJson: JSON.stringify({ kind: 'accepted', supplier_order_id: 'CM-1' }),
      approval: approvalFor('accepted'),
    });
    // The MESSAGE, not just the refusal. Substituting empty digests for the
    // missing order would also refuse — by mismatching — and a test that
    // checked only the verdict could not tell the two apart. A payload
    // approved with empty digests would then bind against nothing and pass.
    expect(result).toMatchObject({ ok: false, refusal: 'approval_binding_failed' });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error).toContain('no order to bind the approval to');
  });

  it('leaves a node with no approval discipline exactly as it was', () => {
    // §15.2b applies "when supplier policy requires human approval". Passing
    // nothing must not start requiring one — but passing a payload must never
    // skip the check.
    const seen: unknown[] = [];
    runtimeWithOrder(seen);
    const result = settleInboundOrderDecision({
      buyerDid: BUYER,
      purchaseOrderId: PO,
      runnerResultJson: JSON.stringify({ kind: 'accepted', supplier_order_id: 'CM-1' }),
    });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
  });

  /**
   * §15.2b — "does accepting an order need a human?"
   *
   * `orderAcceptance` was a stored setting NOTHING READ. A supplier who chose
   * `review` still had their runner's `accepted` recorded and signed without
   * anyone seeing it, because the binding check above only runs when an
   * approval is supplied and the inbound plugin lane supplies none.
   */
  describe('the acceptance policy (§15.2b)', () => {
    /** A supplier settings record that VALIDATES; the policy is varied on top. */
    const SUPPLIER_SETTINGS = {
      actingBusinessDid: 'did:plc:chairmaker99',
      catalogSource: { kind: 'inline', lastHealthyAtIso: '2026-08-08T09:00:00.000Z' },
      publicRegions: [],
      publishIndicativePrice: true,
      quoteAccess: 'anyone',
      responsePolicy: { submit_order: 'review' },
      customerPricingSource: null,
      orderAcceptance: 'auto',
      listingState: 'live',
      connectors: [],
    };

    /**
     * A repository that RETURNS a validating `review` row.
     *
     * It cannot go through `writeSupplier` any more: the validator now refuses
     * `orderAcceptance: 'review'` outright, because §15.2b has no approval
     * card and no owner decision route, so the setting would reject every
     * order at the decision deadline without asking anyone. That refusal
     * applies on read too, so a stored review row surfaces as "settings do not
     * validate" — a DIFFERENT branch, covered by its own test below.
     *
     * This double therefore stands in for the two states the store is not the
     * only way to reach: a composition root installing a settings runtime
     * directly, and the future build that drops the validator refusal when the
     * lane ships. The gate must already be there on that day, or the change
     * that enables review turns every such order into a silent acceptance.
     */
    function reviewing(): InMemoryCommerceSettingsRepository {
      return {
        readSupplier: () => ({
          ok: true,
          settings: { ...SUPPLIER_SETTINGS, orderAcceptance: 'review' },
        }),
        readBuyer: () => ({ ok: false, absent: true }),
        writeSupplier: () => ({ ok: true }),
        writeBuyer: () => ({ ok: true }),
      } as unknown as InMemoryCommerceSettingsRepository;
    }

    it('REFUSES an unapproved acceptance when the supplier asked for review', () => {
      const seen: unknown[] = [];
      runtimeWithOrder(seen, reviewing());
      const result = settleInboundOrderDecision({
        buyerDid: BUYER,
        purchaseOrderId: PO,
        runnerResultJson: JSON.stringify({ kind: 'accepted', supplier_order_id: 'CM-1' }),
      });
      expect(result).toMatchObject({ ok: false, refusal: 'approval_required' });
      // NOTHING MOVED. The chain must not advance on a decision nobody made.
      expect(seen).toEqual([]);
    });

    it.each(['rejected', 'counterproposal'])(
      'still allows an unapproved %s — those commit the business to nothing',
      (kind) => {
        // Gating a decline would stop a supplier saying no while their
        // approver is asleep, which is the opposite of protecting them.
        const seen: unknown[] = [];
        runtimeWithOrder(seen, reviewing());
        const result = settleInboundOrderDecision({
          buyerDid: BUYER,
          purchaseOrderId: PO,
          runnerResultJson: JSON.stringify(
            kind === 'rejected'
              ? { kind: 'rejected', reason_code: 'out_of_stock' }
              : { kind: 'counterproposal', replacement_quote: {} },
          ),
        });
        // Reaching the engine at all is the assertion: the policy did not
        // stop it. What the engine then does with the shape is its own test.
        expect(result.ok || result.refusal !== 'approval_required').toBe(true);
      },
    );

    it('allows an unapproved acceptance when the supplier chose auto', () => {
      const store = new InMemoryCommerceSettingsRepository();
      const written = store.writeSupplier({
        ...SUPPLIER_SETTINGS,
        orderAcceptance: 'auto',
      } as never);
      expect(written.ok).toBe(true);
      const seen: unknown[] = [];
      runtimeWithOrder(seen, store);
      const result = settleInboundOrderDecision({
        buyerDid: BUYER,
        purchaseOrderId: PO,
        runnerResultJson: JSON.stringify({ kind: 'accepted', supplier_order_id: 'CM-1' }),
      });
      expect(result.ok).toBe(true);
      expect(seen).toHaveLength(1);
    });

    it('FAILS CLOSED when the stored policy does not validate', () => {
      // "I cannot read your policy" must not read as "you said auto" on the
      // one decision that reserves stock and creates an obligation.
      const broken = {
        readSupplier: () => ({ ok: false, absent: false, findings: ['listingState is required'] }),
      } as unknown as InMemoryCommerceSettingsRepository;
      const seen: unknown[] = [];
      runtimeWithOrder(seen, broken);
      const result = settleInboundOrderDecision({
        buyerDid: BUYER,
        purchaseOrderId: PO,
        runnerResultJson: JSON.stringify({ kind: 'accepted', supplier_order_id: 'CM-1' }),
      });
      expect(result).toMatchObject({ ok: false, refusal: 'approval_required' });
      expect(seen).toEqual([]);
    });
  });
});
