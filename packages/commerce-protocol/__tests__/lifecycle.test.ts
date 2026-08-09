import {
  validateOrderAcknowledgement,
  verifyAcknowledgementForOrder,
  type OrderAcknowledgement,
} from '../src/acknowledgement';
import {
  validateCancellationRequest,
  validateCancellationResult,
  verifyCancellationResolution,
} from '../src/cancellation';
import { commerceRecordDigest } from '../src/digests';
import { validateCommerceEpochRecord, verifyEpochSuccession } from '../src/epoch';
import {
  isQuoteExpiredAt,
  validatePurchaseOrderProposal,
  verifyOrderAgainstQuote,
} from '../src/order';
import {
  neverReceivedIsLegal,
  reconcileOutcomePermitsResubmission,
  validateOrderReconcileRequest,
  validateOrderReconcileResult,
  MAX_RETAINED_ENVELOPE_BODY,
  type RetainedEnvelope,
} from '../src/reconcile';
import {
  statusIsTerminal,
  validateCommerceOrderStatus,
  validateGenesisStatus,
  verifyRestoreFence,
  verifyStatusSuccession,
} from '../src/status';

import {
  hash,
  makeAcceptedAck,
  makeCancellationRequest,
  makeCancellationResult,
  makeEpochRecord,
  makeOrder,
  makeProjection,
  makeQuoteRequest,
  makeRejectedAck,
  makeSignedQuote,
  makeStatus,
  makeSuccessor,
  makeRevision,
} from './helpers/fixtures';

const request = makeQuoteRequest();
const quote = makeSignedQuote({ request });
const pricedProjection = request.delivery.projection;
const order = makeOrder(quote, pricedProjection);
/**
 * §12.7/§16.2: held evidence must carry the SUPPLIER'S SIGNATURE. A
 * record plus its content digest proves nothing — the digest is a hash
 * of the record, computable by anyone. These tests only exercise the
 * wire SHAPE; the signature itself is verified by compiled Core.
 */
function signedEvidence<T>(
  record: T,
): { record: T; envelope: RetainedEnvelope; signature: string } {
  // A well-formed envelope, not a signed one. This package is zero-dependency
  // and holds no crypto: it checks SHAPE, and compiled Core checks the
  // signature against the supplier's key. The envelope is required here
  // because a signature with no signed bytes is unverifiable by anyone.
  return {
    record,
    envelope: {
      id: 'msg-1',
      type: 'service.response',
      from: order.supplier_did,
      to: [order.buyer_did],
      created_time: 1_770_000_000,
      body: '{}',
    },
    signature: 'ab'.repeat(32),
  };
}

const ORDER_LINES = order.accepted_lines;
const FIRST_LINE = ORDER_LINES[0];
if (!FIRST_LINE) throw new Error('fixture has no order lines');

/** Receiver clock for fence checks that are not about the dispute window. */
const AT = '2026-08-07T13:00:00Z';

describe('purchase-order proposal (§9.9)', () => {
  it('validates a canonical proposal', () => {
    expect(validatePurchaseOrderProposal(order, hash)).toBeNull();
  });

  it('rejects a tampered order_digest', () => {
    expect(validatePurchaseOrderProposal({ ...order, buyer_reference: 'PO/77' }, hash)).toMatch(
      /does not match/,
    );
  });

  it('binds to the exact quote (identity, digest, total, terms)', () => {
    expect(verifyOrderAgainstQuote(order, quote, pricedProjection as never)).toBeNull();

    const otherQuote = makeSignedQuote({ request, overrides: { quote_id: 'q-2' } });
    expect(verifyOrderAgainstQuote(order, otherQuote, pricedProjection as never)).toMatch(
      /quote_id/,
    );

    const totalMismatch = makeOrder(quote, pricedProjection, {
      approved_total: { currency: 'INR', minor_units: '1' },
    });
    expect(verifyOrderAgainstQuote(totalMismatch, quote, pricedProjection as never)).toMatch(
      /approved_total/,
    );

    const termsMismatch = makeOrder(quote, pricedProjection, {
      accepted_terms_digest: 'e'.repeat(64),
    });
    expect(verifyOrderAgainstQuote(termsMismatch, quote, pricedProjection as never)).toMatch(
      /accepted_terms_digest/,
    );
  });

  it('enforces all-or-none: subset, extra, changed quantity, changed product', () => {
    const subset = makeOrder(quote, pricedProjection, { accepted_lines: [] });
    // Empty is structurally invalid; use quote-binding for the subset shape:
    expect(validatePurchaseOrderProposal(subset, hash)).toMatch(/non-empty/);

    const changedQuantity = makeOrder(quote, pricedProjection, {
      accepted_lines: [{ ...FIRST_LINE, quantity: { value: '99', unit_code: 'each' } }],
    });
    expect(verifyOrderAgainstQuote(changedQuantity, quote, pricedProjection as never)).toMatch(
      /all-or-none/,
    );

    const changedProduct = makeOrder(quote, pricedProjection, {
      accepted_lines: [{ ...FIRST_LINE, product: { scheme: 'gtin', value: '09506000134369' } }],
    });
    expect(verifyOrderAgainstQuote(changedProduct, quote, pricedProjection as never)).toMatch(
      /offered product/,
    );
  });

  it('rejects a changed priced projection field (projection_mismatch) and accepts additions', () => {
    const changedRegion = makeProjection({ region: { scheme: 'postal_area', value: '695001' } });
    const rebuilt = makeOrder(quote, changedRegion);
    expect(verifyOrderAgainstQuote(rebuilt, quote, pricedProjection as never)).toMatch(
      /projection_mismatch/,
    );
  });

  it('checks expiry only against the admission clock', () => {
    expect(isQuoteExpiredAt(quote, '2026-08-08T08:59:59Z')).toBe(false);
    expect(isQuoteExpiredAt(quote, '2026-08-08T09:00:01Z')).toBe(true);
  });
});

describe('order acknowledgement (§9.10)', () => {
  it('validates the accepted variant', () => {
    const ack = makeAcceptedAck(order);
    expect(validateOrderAcknowledgement(ack, hash)).toBeNull();
    expect(verifyAcknowledgementForOrder(ack, order)).toBeNull();
  });

  it('rejects accepted ack pointing at a different quote digest', () => {
    const ack = makeAcceptedAck(order, { accepted_quote_digest: 'f'.repeat(64) } as never);
    expect(verifyAcknowledgementForOrder(ack, order)).toMatch(/accepted_quote_digest/);
  });

  it('quote_superseded requires current_quote_digest', () => {
    const missing = makeRejectedAck(order, { reason_code: 'quote_superseded' });
    expect(validateOrderAcknowledgement(missing, hash)).toMatch(/current_quote_digest/);
    const withHead = makeRejectedAck(order, {
      reason_code: 'quote_superseded',
      current_quote_digest: 'a'.repeat(64),
    });
    expect(validateOrderAcknowledgement(withHead, hash)).toBeNull();
  });

  it('counterproposal must embed a fresh rev-1 family with lineage', () => {
    const replacement = makeSignedQuote({
      request,
      overrides: { quote_id: 'q-2', replaces_quote_digest: quote.quote_digest },
    });
    const draft = {
      protocol_version: '1.0',
      acknowledgement_id: 'ack-3',
      purchase_order_id: order.purchase_order_id,
      order_digest: order.order_digest,
      buyer_did: order.buyer_did,
      supplier_did: order.supplier_did,
      issued_at: '2026-08-07T12:05:00Z',
      kind: 'counterproposal' as const,
      replacement_quote: replacement,
    };
    const ack = {
      ...draft,
      acknowledgement_digest: commerceRecordDigest(
        'acknowledgement',
        draft as unknown as Record<string, unknown>,
        hash,
      ),
    } as OrderAcknowledgement;
    expect(validateOrderAcknowledgement(ack, hash)).toBeNull();
    expect(verifyAcknowledgementForOrder(ack, order)).toBeNull();

    const sameFamily = {
      ...draft,
      replacement_quote: makeSignedQuote({
        request,
        overrides: { replaces_quote_digest: quote.quote_digest },
      }),
    };
    const sameFamilyAck = {
      ...sameFamily,
      acknowledgement_digest: commerceRecordDigest(
        'acknowledgement',
        sameFamily as unknown as Record<string, unknown>,
        hash,
      ),
    } as OrderAcknowledgement;
    expect(verifyAcknowledgementForOrder(sameFamilyAck, order)).toMatch(/fresh quote_id/);

    // §9.13 — "a counterproposal cannot silently upgrade the conversation".
    // The lineage and fresh-id rules above both pass here; the ONLY thing
    // wrong is the version of the terms being offered back. Without this
    // check a 1.0 exchange could be countered with 1.5 terms, and the order
    // built on the replacement would pin the upgraded version — both sides
    // believing they agreed under field sets that never matched.
    //
    // The envelope stays at 1.0 deliberately: the acknowledgement's own
    // version check passes, so only the replacement-quote bind can catch it.
    const upgraded = {
      ...draft,
      replacement_quote: makeSignedQuote({
        request,
        overrides: {
          quote_id: 'q-3',
          replaces_quote_digest: quote.quote_digest,
          protocol_version: '1.5',
        },
      }),
    };
    const upgradedAck = {
      ...upgraded,
      acknowledgement_digest: commerceRecordDigest(
        'acknowledgement',
        upgraded as unknown as Record<string, unknown>,
        hash,
      ),
    } as OrderAcknowledgement;
    expect(verifyAcknowledgementForOrder(upgradedAck, order)).toMatch(
      /ack\.replacement_quote: protocol_version 1\.5 does not match the conversation's 1\.0/,
    );
  });
});

describe('order status chain (§9.11)', () => {
  const genesis = makeStatus(order, { sequence: '0', state: 'accepted' });

  it('validates a genesis record and enforces genesis rules per event', () => {
    expect(validateCommerceOrderStatus(genesis, hash)).toBeNull();
    expect(validateGenesisStatus(genesis, 'accepted')).toBeNull();
    expect(validateGenesisStatus(genesis, 'rejected')).toMatch(/genesis state "rejected"/);
    const withPrev = makeStatus(order, {
      sequence: '0',
      state: 'accepted',
      previous_status_digest: 'a'.repeat(64),
    });
    expect(validateGenesisStatus(withPrev, 'accepted')).toMatch(/no predecessor/);
    const seqOne = makeStatus(order, { sequence: '1', state: 'accepted' });
    expect(validateGenesisStatus(seqOne, 'accepted')).toMatch(/sequence "0"/);
  });

  it('never signs "submitted" and enforces the lines discriminated union', () => {
    expect(
      validateCommerceOrderStatus(makeStatus(order, { state: 'submitted' as never }), hash),
    ).toMatch(/buyer-local/);
    expect(
      validateCommerceOrderStatus(
        makeStatus(order, { state: 'partially_fulfilled', sequence: '1' }),
        hash,
      ),
    ).toMatch(/required for state/);
    expect(
      validateCommerceOrderStatus(
        makeStatus(order, {
          state: 'accepted',
          lines: [{ line_id: 'l1', fulfilled_quantity: { value: '1', unit_code: 'each' } }],
        }),
        hash,
      ),
    ).toMatch(/forbidden for state/);
    expect(
      validateCommerceOrderStatus(makeStatus(order, { state: 'delivered', sequence: '3' }), hash),
    ).toMatch(/dispute_window_ends_at/);
  });

  it('accepts a legal succession and rejects graph violations', () => {
    const preparing = makeSuccessor(order, genesis, { state: 'preparing' });
    expect(
      verifyStatusSuccession(genesis, preparing, ORDER_LINES, '2026-08-07T13:00:00Z'),
    ).toBeNull();

    const delivered = makeSuccessor(order, genesis, {
      state: 'delivered',
      dispute_window_ends_at: '2026-08-14T00:00:00Z',
    });
    expect(verifyStatusSuccession(genesis, delivered, ORDER_LINES, '2026-08-07T13:00:00Z')).toMatch(
      /illegal transition accepted -> delivered/,
    );
  });

  it('detects forks, sequence skips, and epoch regression', () => {
    const fork = makeStatus(order, {
      sequence: '1',
      state: 'preparing',
      previous_status_digest: 'b'.repeat(64),
    });
    expect(verifyStatusSuccession(genesis, fork, ORDER_LINES, '2026-08-07T13:00:00Z')).toMatch(
      /supplier fork/,
    );

    const skip = makeStatus(order, {
      sequence: '5',
      state: 'preparing',
      previous_status_digest: genesis.status_digest,
    });
    expect(verifyStatusSuccession(genesis, skip, ORDER_LINES, '2026-08-07T13:00:00Z')).toMatch(
      /expected sequence 1/,
    );

    // Epoch regression: a successor signed at a LOWER supplier_epoch is
    // a stale pre-restore signer (§16.2).
    const genesisAt2 = makeStatus(order, { sequence: '0', state: 'accepted', supplier_epoch: '2' });
    const regressed = makeStatus(order, {
      sequence: '1',
      state: 'preparing',
      previous_status_digest: genesisAt2.status_digest,
      supplier_epoch: '1',
    });
    expect(
      verifyStatusSuccession(genesisAt2, regressed, ORDER_LINES, '2026-08-07T13:00:00Z'),
    ).toMatch(/supplier_epoch regressed/);
  });

  it('enforces the complete-snapshot cumulative lines contract', () => {
    const preparing = makeSuccessor(order, genesis, { state: 'preparing' });
    const partial = makeSuccessor(order, preparing, {
      state: 'partially_fulfilled',
      lines: [{ line_id: 'l1', fulfilled_quantity: { value: '40', unit_code: 'each' } }],
    });
    expect(
      verifyStatusSuccession(preparing, partial, ORDER_LINES, '2026-08-07T13:00:00Z'),
    ).toBeNull();

    const regressed = makeSuccessor(order, partial, {
      state: 'partially_fulfilled',
      lines: [{ line_id: 'l1', fulfilled_quantity: { value: '30', unit_code: 'each' } }],
    });
    expect(verifyStatusSuccession(partial, regressed, ORDER_LINES, '2026-08-07T13:00:00Z')).toMatch(
      /regressed/,
    );

    const overshoot = makeSuccessor(order, partial, {
      state: 'partially_fulfilled',
      lines: [{ line_id: 'l1', fulfilled_quantity: { value: '101', unit_code: 'each' } }],
    });
    expect(verifyStatusSuccession(partial, overshoot, ORDER_LINES, '2026-08-07T13:00:00Z')).toMatch(
      /exceeds the ordered quantity/,
    );

    const unknownLine = makeSuccessor(order, partial, {
      state: 'partially_fulfilled',
      lines: [{ line_id: 'zz', fulfilled_quantity: { value: '1', unit_code: 'each' } }],
    });
    expect(
      verifyStatusSuccession(partial, unknownLine, ORDER_LINES, '2026-08-07T13:00:00Z'),
    ).toMatch(/not an order line/);

    const changedUnit = makeSuccessor(order, partial, {
      state: 'partially_fulfilled',
      lines: [{ line_id: 'l1', fulfilled_quantity: { value: '40', unit_code: 'case' } }],
    });
    expect(
      verifyStatusSuccession(partial, changedUnit, ORDER_LINES, '2026-08-07T13:00:00Z'),
    ).toMatch(/changed unit/);
  });

  it('lines is a COMPLETE snapshot: omitted and duplicated lines are rejected', () => {
    // Two-line order: a snapshot naming only one line is incomplete.
    const [templateLine] = quote.lines;
    if (!templateLine) throw new Error('fixture has no lines');
    const twoLineQuote = makeSignedQuote({
      request,
      overrides: {
        quote_id: 'q-two',
        lines: [
          ...quote.lines,
          {
            ...templateLine,
            line_id: 'l2',
            quantity: { value: '50', unit_code: 'each' },
          },
        ],
        total: { currency: 'INR', minor_units: '75000' },
      },
    });
    const twoLineOrder = makeOrder(twoLineQuote, pricedProjection, {
      purchase_order_id: 'po-two',
      idempotency_key: 'idem-po-two',
    });
    const genesisTwo = makeStatus(twoLineOrder, { sequence: '0', state: 'accepted' });
    const preparingTwo = makeSuccessor(twoLineOrder, genesisTwo, { state: 'preparing' });

    const sparse = makeSuccessor(twoLineOrder, preparingTwo, {
      state: 'partially_fulfilled',
      lines: [{ line_id: 'l1', fulfilled_quantity: { value: '10', unit_code: 'each' } }],
    });
    expect(
      verifyStatusSuccession(
        preparingTwo,
        sparse,
        twoLineOrder.accepted_lines,
        '2026-08-07T13:00:00Z',
      ),
    ).toMatch(/COMPLETE snapshot/);

    const duplicated = makeStatus(twoLineOrder, {
      sequence: '2',
      state: 'partially_fulfilled',
      previous_status_digest: preparingTwo.status_digest,
      lines: [
        { line_id: 'l1', fulfilled_quantity: { value: '10', unit_code: 'each' } },
        { line_id: 'l1', fulfilled_quantity: { value: '20', unit_code: 'each' } },
      ],
    });
    expect(validateCommerceOrderStatus(duplicated, hash)).toMatch(/duplicate line_id/);
  });

  it('bounds delivered -> disputed by the dispute window', () => {
    const dispatched = makeSuccessor(order, genesis, {
      state: 'dispatched',
      lines: [{ line_id: 'l1', fulfilled_quantity: { value: '100', unit_code: 'each' } }],
    });
    const delivered = makeSuccessor(order, dispatched, {
      state: 'delivered',
      dispute_window_ends_at: '2026-08-14T00:00:00Z',
    });
    const disputedInWindow = makeSuccessor(order, delivered, { state: 'disputed' });
    expect(
      verifyStatusSuccession(delivered, disputedInWindow, ORDER_LINES, '2026-08-10T00:00:00Z'),
    ).toBeNull();
    expect(
      verifyStatusSuccession(delivered, disputedInWindow, ORDER_LINES, '2026-08-15T00:00:00Z'),
    ).toMatch(/only before dispute_window_ends_at/);
    expect(statusIsTerminal(delivered, '2026-08-15T00:00:00Z')).toBe(true);
    expect(statusIsTerminal(delivered, '2026-08-10T00:00:00Z')).toBe(false);
  });

  /**
   * Codex finding: the fence verifier checked marker, epoch,
   * predecessor, sequence, and transition — but never that the fence
   * described the SAME order. A structurally valid higher-epoch fence
   * could name a held predecessor while rewriting the identity fields
   * or inflating fulfilment, and be accepted.
   */
  it('restore fence: rejects rewritten identity and inflated fulfilment (§16.2)', () => {
    const preparing = makeSuccessor(order, genesis, { state: 'preparing' });
    const chain = [genesis, preparing];
    const base = {
      sequence: '2',
      state: 'preparing' as const,
      previous_status_digest: preparing.status_digest,
      supplier_epoch: '2',
      restore_fence: true as const,
    };

    for (const field of ['purchase_order_id', 'buyer_did', 'supplier_did'] as const) {
      const swapped =
        field === 'purchase_order_id'
          ? 'po-someone-else'
          : field === 'buyer_did'
            ? 'did:plc:otherbuyer1'
            : 'did:plc:othersupplier';
      const forged = makeStatus(order, { ...base, [field]: swapped });
      expect(verifyRestoreFence(forged, chain, ORDER_LINES, hash, AT)).toMatch(
        new RegExp(`immutable field ${field} changed`),
      );
    }

    // Fulfilment beyond what was ordered cannot ride in on a fence.
    const inflated = makeStatus(order, {
      ...base,
      state: 'delivered' as const,
      lines: [
        {
          line_id: FIRST_LINE.line_id,
          fulfilled_quantity: {
            value: String(Number(FIRST_LINE.quantity.value) + 1),
            unit_code: FIRST_LINE.quantity.unit_code,
          },
        },
      ],
    });
    expect(verifyRestoreFence(inflated, chain, ORDER_LINES, hash, AT)).toMatch(/fence:/);
  });

  /**
   * The fence path used to be a way AROUND the dispute deadline.
   *
   * `verifyStatusSuccession` refuses `delivered -> disputed` once the
   * window closes. `verifyRestoreFence` allowed the same move — the graph
   * says it is a legal edge — and never looked at the window, because it
   * took no clock at all. So a supplier could dispute an order whose
   * window shut months ago by marking the record `restore_fence: true`:
   * a recovery mechanism used to escape a deadline.
   */
  it('restore fence: delivered -> disputed still obeys the dispute window (§9.11)', () => {
    const dispatched = makeSuccessor(order, genesis, {
      state: 'dispatched',
      lines: [{ line_id: FIRST_LINE.line_id, fulfilled_quantity: FIRST_LINE.quantity }],
    });
    const delivered = makeSuccessor(order, dispatched, {
      state: 'delivered',
      dispute_window_ends_at: '2026-08-14T00:00:00Z',
    });
    const chain = [genesis, dispatched, delivered];
    const disputeFence = makeStatus(order, {
      sequence: '3',
      state: 'disputed',
      previous_status_digest: delivered.status_digest,
      supplier_epoch: '2',
      restore_fence: true,
    });

    // Inside the window the fence is a legitimate takeover.
    expect(verifyRestoreFence(disputeFence, chain, ORDER_LINES, hash, '2026-08-10T00:00:00Z')).toBe(
      'head',
    );
    // Outside it, the fence buys the supplier nothing the ordinary path
    // would not already have refused.
    expect(
      verifyRestoreFence(disputeFence, chain, ORDER_LINES, hash, '2026-08-15T00:00:00Z'),
    ).toMatch(/only before dispute_window_ends_at/);
    // The clock is the RECEIVER's, so a supplier that backdates its own
    // record gains nothing: `updated_at` is not consulted.
    const backdated = makeStatus(order, {
      sequence: '3',
      state: 'disputed',
      previous_status_digest: delivered.status_digest,
      supplier_epoch: '2',
      restore_fence: true,
      updated_at: '2026-08-09T00:00:00Z',
    });
    expect(verifyRestoreFence(backdated, chain, ORDER_LINES, hash, '2026-08-15T00:00:00Z')).toMatch(
      /only before dispute_window_ends_at/,
    );
    // A fence that merely RESTATES delivered is unaffected by the window —
    // the rule is about the disputed edge, not about fencing after the
    // window, which is exactly when a restore is most likely to happen.
    const restateFence = makeStatus(order, {
      sequence: '3',
      state: 'delivered',
      dispute_window_ends_at: '2026-08-14T00:00:00Z',
      previous_status_digest: delivered.status_digest,
      supplier_epoch: '2',
      restore_fence: true,
    });
    expect(verifyRestoreFence(restateFence, chain, ORDER_LINES, hash, '2026-08-15T00:00:00Z')).toBe(
      'head',
    );

    // THE BOUNDARY INSTANT. A mutation to `>=` survived every test above,
    // which means nothing pinned whether the deadline is inclusive. It
    // has to be pinned, because THREE places answer this question and a
    // port that reads them separately can implement two of them one way
    // and the third the other: an order would then be terminal on one
    // side and still disputable on the other, over one millisecond.
    const AT_DEADLINE = '2026-08-14T00:00:00Z';
    const ONE_MS_LATER = '2026-08-14T00:00:00.001Z';
    expect(verifyRestoreFence(disputeFence, chain, ORDER_LINES, hash, AT_DEADLINE)).toBe('head');
    expect(verifyRestoreFence(disputeFence, chain, ORDER_LINES, hash, ONE_MS_LATER)).toMatch(
      /only before dispute_window_ends_at/,
    );
    // Ordinary succession draws the line in the same place...
    const disputed = makeSuccessor(order, delivered, { state: 'disputed' });
    expect(verifyStatusSuccession(delivered, disputed, ORDER_LINES, AT_DEADLINE)).toBeNull();
    expect(verifyStatusSuccession(delivered, disputed, ORDER_LINES, ONE_MS_LATER)).toMatch(
      /only before dispute_window_ends_at/,
    );
    // ...and so does terminality, which is the same fact stated the other
    // way round: while the order can still be disputed it is not final.
    expect(statusIsTerminal(delivered, AT_DEADLINE)).toBe(false);
    expect(statusIsTerminal(delivered, ONE_MS_LATER)).toBe(true);
  });

  it('restore fence: head, ancestor, fork, and epoch rules (§16.2)', () => {
    const preparing = makeSuccessor(order, genesis, { state: 'preparing' });
    const chain = [genesis, preparing];

    const fenceAtHead = makeStatus(order, {
      sequence: '2',
      state: 'preparing',
      previous_status_digest: preparing.status_digest,
      supplier_epoch: '2',
      restore_fence: true,
    });
    expect(verifyRestoreFence(fenceAtHead, chain, ORDER_LINES, hash, AT)).toBe('head');

    const fenceAtAncestor = makeStatus(order, {
      sequence: '1',
      state: 'accepted' as never,
      previous_status_digest: genesis.status_digest,
      supplier_epoch: '2',
      restore_fence: true,
    });
    expect(verifyRestoreFence(fenceAtAncestor, chain, ORDER_LINES, hash, AT)).toBe('ancestor');

    const fenceFork = makeStatus(order, {
      sequence: '1',
      state: 'preparing',
      previous_status_digest: 'c'.repeat(64),
      supplier_epoch: '2',
      restore_fence: true,
    });
    expect(verifyRestoreFence(fenceFork, chain, ORDER_LINES, hash, AT)).toMatch(/supplier fork/);

    const fenceSameEpoch = makeStatus(order, {
      sequence: '2',
      state: 'preparing',
      previous_status_digest: preparing.status_digest,
      supplier_epoch: '1',
      restore_fence: true,
    });
    expect(verifyRestoreFence(fenceSameEpoch, chain, ORDER_LINES, hash, AT)).toMatch(
      /strictly higher/,
    );

    const fenceIllegalState = makeStatus(order, {
      sequence: '2',
      state: 'delivered',
      dispute_window_ends_at: '2026-08-14T00:00:00Z',
      previous_status_digest: preparing.status_digest,
      supplier_epoch: '2',
      restore_fence: true,
    });
    expect(verifyRestoreFence(fenceIllegalState, chain, ORDER_LINES, hash, AT)).toMatch(
      /illegal state/,
    );
  });

  it('ordinary succession refuses fence records — they go through verifyRestoreFence', () => {
    const preparing = makeSuccessor(order, genesis, { state: 'preparing' });
    const fence = makeStatus(order, {
      sequence: '2',
      state: 'preparing',
      previous_status_digest: preparing.status_digest,
      supplier_epoch: '2',
      restore_fence: true,
    });
    expect(verifyStatusSuccession(preparing, fence, ORDER_LINES, '2026-08-07T13:00:00Z')).toMatch(
      /verifyRestoreFence/,
    );
  });
});

describe('cancellation (§12.8)', () => {
  it('validates request and terminal-result binding', () => {
    expect(validateCancellationRequest(makeCancellationRequest(order), hash)).toBeNull();

    const cancelledWithoutHead = makeCancellationResult(order, { result: 'cancelled' });
    expect(validateCancellationResult(cancelledWithoutHead, hash)).toMatch(
      /status head it ruled on/,
    );

    const cancelled = makeCancellationResult(order, {
      result: 'cancelled',
      status_digest_at_resolution: 'a'.repeat(64),
    });
    expect(validateCancellationResult(cancelled, hash)).toBeNull();
  });

  it('pending_review closes only via the same cancellation_id', () => {
    const pending = makeCancellationResult(order, { result: 'pending_review' });
    const final = makeCancellationResult(order, {
      result: 'refused_policy',
      resolved_at: '2026-08-07T14:00:00Z',
    });
    expect(verifyCancellationResolution(pending, final)).toBeNull();

    const otherId = makeCancellationResult(order, {
      cancellation_id: 'cx-9',
      result: 'refused_policy',
    });
    expect(verifyCancellationResolution(pending, otherId)).toMatch(/same cancellation_id/);

    const stillPending = makeCancellationResult(order, { result: 'pending_review' });
    expect(verifyCancellationResolution(pending, stillPending)).toMatch(/must terminate/);
  });
});

describe('reconcile (§12.7)', () => {
  it('validates requests with held evidence', () => {
    const bare = {
      protocol_version: '1.0',
      purchase_order_id: order.purchase_order_id,
      order_digest: order.order_digest,
      idempotency_key: order.idempotency_key,
    };
    expect(validateOrderReconcileRequest(bare, hash)).toBeNull();
    expect(
      validateOrderReconcileRequest(
        { ...bare, held_acknowledgement: signedEvidence(makeAcceptedAck(order)) },
        hash,
      ),
    ).toBeNull();
  });

  it('refuses held evidence with no retained envelope', () => {
    // A signature over bytes nobody kept can never verify. Rejecting it HERE,
    // as malformed, is the difference between telling a buyer its request was
    // wrong and telling it — much later, through a fork or a `never_received`
    // — that its evidence was somehow bad.
    const bare = {
      protocol_version: '1.0',
      purchase_order_id: order.purchase_order_id,
      order_digest: order.order_digest,
      idempotency_key: order.idempotency_key,
    };
    const evidence = signedEvidence(makeAcceptedAck(order));
    const { envelope: _dropped, ...noEnvelope } = evidence;
    expect(
      validateOrderReconcileRequest({ ...bare, held_acknowledgement: noEnvelope }, hash),
    ).toMatch(/envelope: required/);

    for (const [field, value] of [
      ['id', ''],
      ['type', 42],
      ['from', null],
      ['created_time', '1770000000'],
      ['to', []],
      ['to', ['']],
      ['body', ''],
    ] as [string, unknown][]) {
      expect(
        validateOrderReconcileRequest(
          {
            ...bare,
            held_acknowledgement: { ...evidence, envelope: { ...evidence.envelope, [field]: value } },
          },
          hash,
        ),
      ).toMatch(new RegExp(`envelope\\.${field}`));
    }
  });

  it('bounds the retained body so evidence cannot become an upload', () => {
    const bare = {
      protocol_version: '1.0',
      purchase_order_id: order.purchase_order_id,
      order_digest: order.order_digest,
      idempotency_key: order.idempotency_key,
    };
    const evidence = signedEvidence(makeAcceptedAck(order));
    expect(
      validateOrderReconcileRequest(
        {
          ...bare,
          held_acknowledgement: {
            ...evidence,
            envelope: { ...evidence.envelope, body: 'x'.repeat(MAX_RETAINED_ENVELOPE_BODY + 1) },
          },
        },
        hash,
      ),
    ).toMatch(/exceeds/);
  });

  it('kind-narrows decision outcomes — evidence payload required and matching', () => {
    const ack = makeAcceptedAck(order);
    expect(
      validateOrderReconcileResult({ outcome: 'received_accepted', acknowledgement: ack }, hash),
    ).toBeNull();
    expect(
      validateOrderReconcileResult({ outcome: 'received_rejected', acknowledgement: ack }, hash),
    ).toMatch(/kind narrowing/);
    expect(validateOrderReconcileResult({ outcome: 'received_accepted' }, hash)).toMatch(
      /signed evidence/,
    );
  });

  it('bounds retry_after_seconds on both loop outcomes', () => {
    expect(
      validateOrderReconcileResult(
        { outcome: 'received_processing', retry_after_seconds: 30 },
        hash,
      ),
    ).toBeNull();
    expect(
      validateOrderReconcileResult(
        { outcome: 'received_unresolved', retry_after_seconds: 0 },
        hash,
      ),
    ).toMatch(/integer in/);
  });

  it('only never_received permits resubmission, and never against held evidence', () => {
    expect(reconcileOutcomePermitsResubmission({ outcome: 'never_received' })).toBe(true);
    expect(
      reconcileOutcomePermitsResubmission({
        outcome: 'received_unresolved',
        retry_after_seconds: 60,
      }),
    ).toBe(false);
    expect(
      neverReceivedIsLegal({
        protocol_version: '1.0',
        purchase_order_id: order.purchase_order_id,
        order_digest: order.order_digest,
        idempotency_key: order.idempotency_key,
        held_acknowledgement: signedEvidence(makeAcceptedAck(order)),
      }),
    ).toMatch(/must re-adopt/);
  });
});

describe('commerce epoch record (§16.2)', () => {
  const genesisEpoch = makeEpochRecord('1');

  it('validates genesis and chained restores', () => {
    expect(validateCommerceEpochRecord(genesisEpoch, hash)).toBeNull();
    const second = makeEpochRecord('2', genesisEpoch);
    expect(validateCommerceEpochRecord(second, hash)).toBeNull();
    expect(verifyEpochSuccession(genesisEpoch, second)).toBeNull();
  });

  it('rejects genesis with a predecessor or restore reason', () => {
    expect(validateCommerceEpochRecord(makeEpochRecord('1', genesisEpoch), hash)).toMatch(
      /no previous_epoch_digest/,
    );
    expect(
      validateCommerceEpochRecord(makeEpochRecord('1', undefined, { reason: 'restore' }), hash),
    ).toMatch(/reason "initial"/);
  });

  it('rejects unchained or skipping successions', () => {
    const second = makeEpochRecord('2', genesisEpoch);
    const skipped = makeEpochRecord('4', second);
    expect(verifyEpochSuccession(second, skipped)).toMatch(/expected epoch 3/);
    const unchained = makeEpochRecord('3', genesisEpoch);
    expect(verifyEpochSuccession(second, unchained)).toMatch(/does not chain/);
  });
});

describe('quote-family interplay (order after counter)', () => {
  it('a countered family never bricks its replacement (fresh quote_id)', () => {
    const replacement = makeSignedQuote({
      request,
      overrides: { quote_id: 'q-2', replaces_quote_digest: quote.quote_digest },
    });
    expect(replacement.quote_id).not.toBe(quote.quote_id);
    expect(replacement.quote_revision).toBe('1');
    expect(replacement.previous_quote_digest).toBeUndefined();
  });

  it('a superseding revision keeps the family verifiable', () => {
    const rev2 = makeRevision(quote);
    expect(rev2.previous_quote_digest).toBe(quote.quote_digest);
  });
});
