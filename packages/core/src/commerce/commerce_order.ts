/**
 * CommerceOrder — the supplier-side order aggregate (§9.9, §15.5, §12.8).
 *
 * WHY THIS EXISTS. Order state rules were spread across whoever held the
 * repository: "is this order still open", "may it be decided", "may it be
 * timed out", "what does a replay answer". Fourteen call sites asked "does
 * this order exist" and each decided for itself what the answer meant.
 *
 * What the order owns:
 *   - its own lifecycle (reserved -> decided; pre_effect -> effect_started);
 *   - whether a given transition is legal RIGHT NOW;
 *   - what a replay of the same keys should answer.
 *
 * What it deliberately does NOT own:
 *   - uniqueness across `(buyer_did, purchase_order_id)` and
 *     `(buyer_did, idempotency_key)`. One order cannot enforce a rule about
 *     ALL orders; that is a database invariant and stays in the repository,
 *     where the unique indexes live.
 *   - anything about the quote. Deciding an order AND settling its capacity
 *     hold spans two aggregates, so it belongs to `AdmissionService`, not
 *     here. Pushing quote knowledge into the order is how the two got
 *     tangled the first time.
 *
 * REFUSALS VS CORRUPTION, as everywhere in this layer: business outcomes are
 * typed values; impossible state throws `CommerceIntegrityError` so the
 * surrounding transaction rolls back rather than committing half a decision.
 */

import { CommerceIntegrityError } from './quote_family';

import type {
  CommerceOrderRef,
  CommerceOrderRefRepository,
  DecideOptions,
  NewCommerceOrderRef,
} from './order_refs';

export type OrderRefusal =
  | 'not_found'
  | 'already_decided'
  | 'effect_already_started'
  | 'effect_started_cannot_time_out'
  | 'decision_cas_lost'
  | 'not_awaiting_reconciliation'
  | 'order_digest_mismatch'
  | 'reconcile_cas_lost';

export type OrderOutcome<T = void> =
  | { ok: true; value: T }
  | { ok: false; refusal: OrderRefusal; detail?: string };

const refuse = (refusal: OrderRefusal, detail?: string): OrderOutcome<never> =>
  detail === undefined ? { ok: false, refusal } : { ok: false, refusal, detail };
const allow = <T>(value: T): OrderOutcome<T> => ({ ok: true, value });

export interface CommerceOrderDeps {
  refs: CommerceOrderRefRepository;
  now: () => number;
}

/**
 * An instance is a SNAPSHOT of the reference row, valid for the transaction
 * that loaded it. Reload after any operation that moves the order.
 */
export class CommerceOrder {
  private constructor(
    private readonly row: CommerceOrderRef,
    private readonly deps: CommerceOrderDeps,
  ) {}

  static load(
    deps: CommerceOrderDeps,
    buyerDid: string,
    purchaseOrderId: string,
  ): CommerceOrder | null {
    const row = deps.refs.getByOrderId(buyerDid, purchaseOrderId);
    return row === null ? null : new CommerceOrder(row, deps);
  }

  get ref(): CommerceOrderRef {
    return this.row;
  }
  get isDecided(): boolean {
    return this.row.state === 'decided';
  }
  get effectStarted(): boolean {
    return this.row.effectPhase === 'effect_started';
  }
  /** The recorded acknowledgement for a decided order (§15.5 replay). */
  get acknowledgementJson(): string {
    if (this.row.acknowledgementJson === null) {
      throw new CommerceIntegrityError(
        `decided order ${this.row.purchaseOrderId} has no recorded acknowledgement`,
      );
    }
    return this.row.acknowledgementJson;
  }

  /**
   * §9.9 — mark the external boundary as crossed BEFORE attempting it, so
   * crash recovery can never time out (and refund) a reservation whose
   * external order may exist.
   */
  markEffectStarted(): OrderOutcome {
    if (this.row.state === 'decided') return refuse('already_decided');
    const moved = this.deps.refs.markEffectStarted(this.row.buyerDid, this.row.purchaseOrderId);
    return moved ? allow(undefined) : refuse('effect_already_started');
  }

  /**
   * Record the terminal answer. `requirePreEffect` is the recovery path's
   * extra condition: a decision_timeout may NEVER decide an effect_started
   * row, because the external effect may have happened.
   */
  decide(options: DecideOptions): OrderOutcome {
    if (this.row.state === 'decided') return refuse('already_decided');
    if (options.requirePreEffect === true && this.row.effectPhase === 'effect_started') {
      return refuse('effect_started_cannot_time_out');
    }
    const decided = this.deps.refs.decide(this.row.buyerDid, this.row.purchaseOrderId, options);
    // A lost CAS means a concurrent writer decided first — ordinary, not
    // corruption. The caller replays the recorded answer.
    return decided ? allow(undefined) : refuse('decision_cas_lost');
  }

  /**
   * §16.2 (WS-4.3) — the per-order reconciliation ceremony.
   *
   * A re-adopted order is rebuilt from the counterparty's held
   * acknowledgement, which proves WHAT WAS DECIDED but carries none of the
   * order's own content. Such an order cannot sign a genesis (it cannot
   * describe its lines) and cannot be cancelled (this node does not know
   * what it decided). Until now nothing could clear that: `reconciliation
   * _required` was set by re-adoption and never unset anywhere, so a
   * re-adopted order was frozen for good — a one-way door.
   *
   * The ceremony's bar is the ORDER PROPOSAL, presented by the buyer. That
   * is the exact state this node lost, and the stored `orderDigest` — which
   * came from the supplier's own signed acknowledgement — proves the
   * presented proposal is the right one. A buyer cannot substitute a
   * different order: the digest would not match.
   *
   * DELIBERATELY NOT an operator judgement call. The alternative design
   * asked the owner "did we ship this?" before clearing. But a re-adopted
   * order has no status chain at all, so there is no fulfilment to
   * reconcile — the first status it can sign is the genesis, which states
   * what the acknowledgement already says. Asking a human to confirm
   * something the records already establish trains them to click through.
   */
  reconcile(options: { presentedDigest: string; atEpoch: string }): OrderOutcome {
    // Layered with the repository's `reconciliation_required = 1` CAS on
    // purpose, and the pair is load-bearing: this one gives the caller a
    // precise refusal for an order that was never re-adopted, the CAS makes
    // two concurrent ceremonies resolve to one winner. Removing either alone
    // leaves the other covering the single-threaded case; removing both lets
    // a second ceremony re-stamp `admitted_epoch` to a later epoch and
    // un-fence an order a restore deliberately fenced.
    if (!this.row.reconciliationRequired) return refuse('not_awaiting_reconciliation');
    // The digest is the whole proof. Without this check the ceremony would
    // accept any document the buyer chose to call "the order", and the node
    // would then sign a genesis describing lines nobody agreed to.
    if (options.presentedDigest !== this.row.orderDigest) return refuse('order_digest_mismatch');
    const done = this.deps.refs.reconcile(this.row.buyerDid, this.row.purchaseOrderId, {
      atEpoch: options.atEpoch,
    });
    return done ? allow(undefined) : refuse('reconcile_cas_lost');
  }
}

/**
 * The only production entry point to order-reference state. Handing out
 * aggregates rather than the repository is what stops a future call site
 * deciding an order without crossing its rules.
 *
 * Lookups that answer questions ABOUT THE SET of orders (idempotency-key
 * aliasing, recovery sweeps, drain counts) stay here rather than on the
 * aggregate: they are not facts a single order can know.
 */
export class CommerceOrderStore {
  constructor(private readonly deps: CommerceOrderDeps) {}

  load(buyerDid: string, purchaseOrderId: string): CommerceOrder | null {
    return CommerceOrder.load(this.deps, buyerDid, purchaseOrderId);
  }

  /** §15.5 — the other unique key. Keys cannot alias. */
  byIdempotencyKey(buyerDid: string, idempotencyKey: string): CommerceOrderRef | null {
    return this.deps.refs.getByIdempotencyKey(buyerDid, idempotencyKey);
  }

  /**
   * Create the reserved reference. Uniqueness across both keys is enforced
   * by the repository's indexes — a database invariant, not an aggregate
   * rule, because no single order can know about all orders.
   */
  createReserved(ref: NewCommerceOrderRef): boolean {
    return this.deps.refs.createReserved(ref);
  }

  /**
   * §12.7 (WS-9.5) — orders a fulfilment sweep can ask the external system
   * about. A set-level question, so it belongs here rather than on the
   * aggregate: no single order knows which others are outstanding.
   */
  listWithExternalRef(): CommerceOrderRef[] {
    return this.deps.refs.listWithExternalRef();
  }

  /** §9.9 step 3 — pre_effect reservations past their decision deadline. */
  listExpiredPreEffect(nowMs: number): CommerceOrderRef[] {
    return this.deps.refs.listExpiredPreEffect(nowMs);
  }

  /**
   * §16.2 (WS-4.3) — orders frozen pending the reconciliation ceremony.
   *
   * A READ, and only a read. There is deliberately no bulk `reconcileAll`
   * beside it: the ceremony checks the buyer's held proposal against the
   * digest this supplier signed, and a re-adopted order has nothing local to
   * check against. A sweep would have to invent the terms.
   */
  listAwaitingReconciliation(): CommerceOrderRef[] {
    return this.deps.refs.listAwaitingReconciliation();
  }

  /**
   * §18.6 — the undecided orders themselves, for the supplier inbox.
   *
   * A READ on the aggregate rather than a reach into the repository, which is
   * the whole point of ARCH-0: the inbox genuinely needs the list, and the
   * alternative was a caller going around the aggregate to `refs`, which the
   * boundary guard forbids for good reason. Exposing a read costs nothing the
   * aggregate was protecting — the state-changing mutators stay hidden.
   */
  listReserved(): CommerceOrderRef[] {
    return this.deps.refs.listReserved();
  }

  /** §9.13 drain release — non-terminal count for a pinned major. */
  /** §16.4 — undecided orders: answers this supplier still owes. */
  countReserved(): number {
    return this.deps.refs.listReserved().length;
  }

  countReservedByMajor(major: string): number {
    return this.deps.refs.countReservedByMajor(major);
  }

  /**
   * §16.4 — undecided orders served by ONE install.
   *
   * Keyed on the install rather than the serving manifest CID because a
   * plugin update moves the CID and keeps the install: counting by CID would
   * stop counting the orders an updated install opened under its previous
   * manifest, which are exactly the ones it still owes an answer for.
   */
  countReservedByServingInstall(installId: string): number {
    return this.deps.refs.countReservedByServingInstall(installId);
  }

  /**
   * §9.13 — undecided orders served by one MANIFEST CID.
   *
   * The counterpart of the one above, and the two are not interchangeable. That
   * one asks "does this INSTALL still owe an answer", which survives an update.
   * This one asks "is this MANIFEST's prior-major lifecycle lane still needed",
   * which is a question about the CID precisely because the lane is pinned to
   * the CID — releasing it while an order it served is open would strand that
   * buyer mid-order.
   */
  /**
   * §9.13 — orders this manifest still has WORK for.
   *
   * `countReserved…` answers "is anything waiting to be DECIDED", which is a
   * different question and the wrong one for releasing continuity: an accepted
   * order is decided immediately and its status chain runs on for days.
   */
  countUnfinishedByServingManifest(servingManifestCid: string, nowMs: number): number {
    return this.deps.refs.countUnfinishedByServingManifest(servingManifestCid, nowMs);
  }

  /** §9.13 — is this one order still work the continuity lane must serve? */
  isUnfinished(buyerDid: string, purchaseOrderId: string, nowMs: number): boolean {
    return this.deps.refs.isUnfinished(buyerDid, purchaseOrderId, nowMs);
  }

  countReservedByServingManifest(servingManifestCid: string): number {
    return this.deps.refs.countReservedByServingManifest(servingManifestCid);
  }
}
