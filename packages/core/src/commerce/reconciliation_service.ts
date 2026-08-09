import type {
  CancellationPolicy,
  CommerceLifecycleEngine,
  StatusUpdateFields,
} from './lifecycle_engine';
import type { CommerceTransaction } from './transaction';
import type {
  CancellationResult,
  CancellationResultKind,
  CommerceOrderStatus,
  HeldEvidence,
  OrderReconcileResult,
} from '@dina/commerce-protocol';

/**
 * The lifecycle and reconciliation application service (ARCH-0c — WS-0.3b).
 *
 * The twin of `CommerceAdmissionService`, for the same reason and against the
 * same defect: `CommerceLifecycleEngine` used to open SEVEN transactions of
 * its own, scattered through fourteen hundred lines. Where a transaction began
 * was a property of whichever method you happened to be reading.
 *
 * WHY THIS ONE MATTERS MORE. Admission decides whether to accept an order;
 * this decides what a buyer is told HAPPENED — the signed status chain, the
 * cancellation race, and the §16.2 restore fence. §9.11 gives a conforming
 * supplier one rule it may never break: it cannot emit two valid successors of
 * one status. That rule is a compare-and-swap inside a transaction, and a
 * transaction boundary in the wrong place turns it into two writes that can
 * interleave.
 *
 * EVIDENCE BEFORE THE CHAIN MOVES. The WBS row asks for exactly that, and it
 * is why `signRestoreFence` and `reconcileRestoredOrder` are here rather than
 * anywhere a caller could reach the head first: the held evidence is verified
 * INSIDE the same transaction that advances the chain, so a verifier that
 * passes and a chain that moves cannot be separated by a crash.
 *
 * `createAcceptedGenesisInTx` IS ABSENT FROM THIS SURFACE, deliberately. §12.8
 * requires acceptance and its status genesis to commit together, so admission
 * calls the ENGINE's method from inside the transaction it already opened.
 * Exposing a service wrapper for it would offer a second, non-atomic way to do
 * the one thing that must be atomic.
 */
export class CommerceReconciliationService {
  constructor(
    private readonly deps: {
      transaction: CommerceTransaction;
      engine: CommerceLifecycleEngine;
    },
  ) {}

  /** §9.11 — open the chain for an accepted order. */
  signGenesis(buyerDid: string, purchaseOrderId: string): CommerceOrderStatus | { error: string } {
    return this.deps.transaction.atomically('signGenesis', () =>
      this.deps.engine.signGenesisInTx(buyerDid, purchaseOrderId),
    );
  }

  /**
   * §9.11 — advance the chain. The head CAS and the receipt are one
   * transaction, which is what stops two valid successors of one status.
   */
  signStatusUpdate(
    buyerDid: string,
    purchaseOrderId: string,
    fields: StatusUpdateFields,
  ): CommerceOrderStatus | { error: string } {
    return this.deps.transaction.atomically('signStatusUpdate', () =>
      this.deps.engine.signStatusUpdateInTx(buyerDid, purchaseOrderId, fields),
    );
  }

  /**
   * §16.2 — the restore fence, with the held evidence verified inside the
   * SAME transaction that raises it. A verifier that passed and a fence that
   * did not land is the state a restore must never leave behind.
   */
  signRestoreFence(
    buyerDid: string,
    purchaseOrderId: string,
    heldStatusReceipts: readonly HeldEvidence<CommerceOrderStatus>[],
  ): CommerceOrderStatus | { error: string } {
    return this.deps.transaction.atomically('signRestoreFence', () =>
      this.deps.engine.signRestoreFenceInTx(buyerDid, purchaseOrderId, heldStatusReceipts),
    );
  }

  /**
   * §12.5 — the cancellation race. One transaction decides whether the
   * cancellation or the dispatch won; two would let both believe they did.
   */
  resolveCancellation(
    request: unknown,
    authenticatedBuyerDid: string,
    policy: CancellationPolicy,
  ): CancellationResult | { error: string } {
    return this.deps.transaction.atomically('resolveCancellation', () =>
      this.deps.engine.resolveCancellationInTx(request, authenticatedBuyerDid, policy),
    );
  }

  /** §12.7 — answer a buyer's reconcile request from the durable record. */
  reconcile(
    input: unknown,
    authenticatedBuyerDid: string,
  ): OrderReconcileResult | { error: string } {
    return this.deps.transaction.atomically('reconcile', () =>
      this.deps.engine.reconcileInTx(input, authenticatedBuyerDid),
    );
  }

  /** §16.2 — the per-order ceremony that clears `reconciliation_required`. */
  reconcileRestoredOrder(
    proposal: unknown,
    authenticatedBuyerDid: string,
  ): { ok: true } | { error: string } {
    return this.deps.transaction.atomically('reconcileRestoredOrder', () =>
      this.deps.engine.reconcileRestoredOrderInTx(proposal, authenticatedBuyerDid),
    );
  }

  /**
   * §12.5 — cancellations on this order that are waiting on a person.
   *
   * A READ, and it still goes through the transaction boundary: it walks the
   * same receipts a concurrent finalization is writing, and a scan that saw
   * half of that write would offer an operator a decision that no longer
   * exists.
   */
  listPendingReviewCancellations(buyerDid: string, purchaseOrderId: string): CancellationResult[] {
    return this.deps.transaction.atomically('listPendingReviewCancellations', () =>
      this.deps.engine.listPendingReviewCancellationsInTx(buyerDid, purchaseOrderId),
    );
  }

  /** §12.5 — settle a cancellation an operator had to decide. */
  finalizePendingCancellation(
    authenticatedBuyerDid: string,
    purchaseOrderId: string,
    cancellationId: string,
    result: Exclude<CancellationResultKind, 'pending_review'>,
  ): CancellationResult | { error: string } {
    return this.deps.transaction.atomically('finalizePendingCancellation', () =>
      this.deps.engine.finalizePendingCancellationInTx(
        authenticatedBuyerDid,
        purchaseOrderId,
        cancellationId,
        result,
      ),
    );
  }

  /**
   * §12.8 — the genesis seam admission calls from inside its own transaction.
   *
   * Exposed as the ENGINE method rather than wrapped, because wrapping it
   * would offer a second, non-atomic way to do the one thing §12.8 requires
   * to be atomic with acceptance.
   */
  get engine(): CommerceLifecycleEngine {
    return this.deps.engine;
  }
}
