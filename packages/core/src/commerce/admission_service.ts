import type {
  AdmissionOutcome,
  AdmissionRecoverySweep,
  CommerceAdmissionEngine,
  SupplierDecision,
} from './admission';
import type { CommerceTransaction } from './transaction';
import type { OrderAcknowledgement, SignedQuote } from '@dina/commerce-protocol';

/**
 * The admission application service (ARCH-0b — WS-0.2b).
 *
 * WHAT MOVED, AND WHY IT MATTERS. `CommerceAdmissionEngine` used to open five
 * transactions of its own. Each was correct; together they meant the answer to
 * "what is atomic here?" lived in five places inside a thousand-line domain
 * class, and nothing stopped a sixth from being added wrong. The engine now
 * exposes only `…InTx` methods and holds no transaction runner at all; this
 * service decides where a transaction begins.
 *
 * THAT IS NOT A LAYER FOR ITS OWN SAKE. It buys three things:
 *
 *   1. The boundary is READABLE. Five lines below say exactly what commits
 *      together, and a reviewer checking §9.9's atomicity claims reads them
 *      rather than grepping a domain class.
 *   2. Nesting becomes IMPOSSIBLE TO DO SILENTLY. The coordinator refuses a
 *      nested `atomically` by name on every platform — previously, a domain
 *      method that opened one inside another failed on mobile only (op-sqlite
 *      cannot nest a raw BEGIN) while the reentrant server test runner passed.
 *      Two hand-written comments used to warn callers about that, which is the
 *      shape of a rule with no enforcement.
 *   3. Two operations CAN be composed atomically, which was impossible when
 *      each opened its own.
 *
 * THE METHOD NAMES ARE THE ENGINE'S OLD ONES, deliberately. Every caller —
 * routes, the ingress bridge, the decision path, the tests — already speaks
 * this vocabulary, and renaming them would have made a transaction refactor
 * look like a behaviour change in the diff.
 *
 * `admitOrder` IS THE ONE ASYMMETRY WORTH NOTING. Its shape checks (wire
 * validation, sender binding, protocol version) touch no storage and stay
 * OUTSIDE the transaction, in the engine, ahead of the atomic part. Opening a
 * transaction to reject a malformed document would take the write lock for a
 * request that was never going to write.
 */
export class CommerceAdmissionService {
  constructor(
    private readonly deps: {
      transaction: CommerceTransaction;
      engine: CommerceAdmissionEngine;
    },
  ) {}

  /**
   * Sign and register a quote this supplier composed (§9.8).
   *
   * The buyer is read from the quote itself here, which is a no-op TODAY and
   * the seam where the request-receipt binding will supply a real expectation.
   * A caller that has a third party to compare against reaches the engine's
   * `registerSignedQuoteInTx` from inside an enclosing transaction instead.
   */
  registerSignedQuote(quote: SignedQuote): string | null {
    return this.deps.transaction.atomically('registerSignedQuote', () =>
      this.deps.engine.registerSignedQuoteForOwnBuyer(quote),
    );
  }

  /**
   * §9.9 admission: quote binding, capacity hold and the reserved
   * order-reference record commit together, or none of them do.
   */
  admitOrder(
    proposal: unknown,
    authenticatedBuyerDid: string,
    context?: { servingManifestCid?: string; servingInstallId?: string },
  ): AdmissionOutcome {
    return this.deps.transaction.atomically('admitOrder', () =>
      this.deps.engine.admitOrderInTx(proposal, authenticatedBuyerDid, context),
    );
  }

  /** §9.9 step 3 — durably record that the external boundary is about to be touched. */
  markEffectStarted(buyerDid: string, purchaseOrderId: string): boolean {
    return this.deps.transaction.atomically('markEffectStarted', () =>
      this.deps.engine.markEffectStartedInTx(buyerDid, purchaseOrderId),
    );
  }

  /**
   * §12.8 — the acknowledgement, the decided state, the hold settlement and
   * (on acceptance) the status genesis are ONE transaction. A crash can never
   * separate the answer from its capacity effect.
   */
  decideOrder(
    buyerDid: string,
    purchaseOrderId: string,
    decision: SupplierDecision,
  ): { acknowledgement: OrderAcknowledgement } | { error: string } {
    return this.deps.transaction.atomically('decideOrder', () =>
      this.deps.engine.decideOrderInTx(buyerDid, purchaseOrderId, decision),
    );
  }

  /**
   * §9.9 step 3 recovery, as ONE transaction over the whole sweep.
   *
   * All of it, not one per order: a sweep that committed per row could leave
   * half the timed-out reservations refunded and half not after a crash, and
   * the half-refunded state is indistinguishable from a sweep that has not run.
   */
  recoverAdmissions(): AdmissionRecoverySweep {
    return this.deps.transaction.atomically('recoverAdmissions', () =>
      this.deps.engine.recoverAdmissionsInTx(),
    );
  }
}
