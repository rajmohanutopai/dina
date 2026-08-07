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
function signedEvidence<T>(record: T): { record: T; signature: string } {
  return { record, signature: 'ab'.repeat(32) };
}

const ORDER_LINES = order.accepted_lines;
const FIRST_LINE = ORDER_LINES[0];
if (!FIRST_LINE) throw new Error('fixture has no order lines');

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
      expect(verifyRestoreFence(forged, chain, ORDER_LINES, hash)).toMatch(
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
    expect(verifyRestoreFence(inflated, chain, ORDER_LINES, hash)).toMatch(/fence:/);
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
    expect(verifyRestoreFence(fenceAtHead, chain, ORDER_LINES, hash)).toBe('head');

    const fenceAtAncestor = makeStatus(order, {
      sequence: '1',
      state: 'accepted' as never,
      previous_status_digest: genesis.status_digest,
      supplier_epoch: '2',
      restore_fence: true,
    });
    expect(verifyRestoreFence(fenceAtAncestor, chain, ORDER_LINES, hash)).toBe('ancestor');

    const fenceFork = makeStatus(order, {
      sequence: '1',
      state: 'preparing',
      previous_status_digest: 'c'.repeat(64),
      supplier_epoch: '2',
      restore_fence: true,
    });
    expect(verifyRestoreFence(fenceFork, chain, ORDER_LINES, hash)).toMatch(/supplier fork/);

    const fenceSameEpoch = makeStatus(order, {
      sequence: '2',
      state: 'preparing',
      previous_status_digest: preparing.status_digest,
      supplier_epoch: '1',
      restore_fence: true,
    });
    expect(verifyRestoreFence(fenceSameEpoch, chain, ORDER_LINES, hash)).toMatch(/strictly higher/);

    const fenceIllegalState = makeStatus(order, {
      sequence: '2',
      state: 'delivered',
      dispute_window_ends_at: '2026-08-14T00:00:00Z',
      previous_status_digest: preparing.status_digest,
      supplier_epoch: '2',
      restore_fence: true,
    });
    expect(verifyRestoreFence(fenceIllegalState, chain, ORDER_LINES, hash)).toMatch(/illegal state/);
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
      validateOrderReconcileResult({ outcome: 'received_processing', retry_after_seconds: 30 }, hash),
    ).toBeNull();
    expect(
      validateOrderReconcileResult({ outcome: 'received_unresolved', retry_after_seconds: 0 }, hash),
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
