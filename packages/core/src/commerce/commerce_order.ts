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

import type { CommerceOrderRef, CommerceOrderRefRepository, DecideOptions } from './order_refs';

export type OrderRefusal =
  | 'not_found'
  | 'already_decided'
  | 'effect_already_started'
  | 'effect_started_cannot_time_out'
  | 'decision_cas_lost';

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
  createReserved(
    ref: Omit<
      CommerceOrderRef,
      'state' | 'effectPhase' | 'acknowledgementJson' | 'externalRef' | 'decidedAt'
    >,
  ): boolean {
    return this.deps.refs.createReserved(ref);
  }

  /** §9.9 step 3 — pre_effect reservations past their decision deadline. */
  listExpiredPreEffect(nowMs: number): CommerceOrderRef[] {
    return this.deps.refs.listExpiredPreEffect(nowMs);
  }

  /** §9.13 drain release — non-terminal count for a pinned major. */
  countReservedByMajor(major: string): number {
    return this.deps.refs.countReservedByMajor(major);
  }
}
