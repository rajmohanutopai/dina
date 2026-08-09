import { LEGAL_TRANSITIONS, type OrderState } from '@dina/commerce-protocol';

/**
 * External fulfilment reconciled to the status chain (§12.7, §9.11 — WS-9.5).
 *
 * A supplier's real state lives in their warehouse system: picked, packed,
 * dispatched, delivered. The buyer's copy lives in a signed status chain. This
 * module is the seam between them, and it exists because the naive version of
 * that seam is dangerous in a specific way.
 *
 * THE NAIVE VERSION: read the external status, sign it. That makes the
 * external system an authority over a chain buyers rely on — a warehouse tool
 * that briefly reports `delivered` for a mis-scan would produce a SIGNED claim
 * of delivery, and §9.11 has no way back from a signed state. So nothing here
 * signs. It PROPOSES, against the §9.11 transition graph, and refuses every
 * proposal the graph refuses.
 *
 * THREE RULES, and each one is a real failure this prevents:
 *
 *   1. NEVER BACKWARDS. External systems report out of order — a `preparing`
 *      webhook can land after a `dispatched` one. Replaying it would move a
 *      dispatched order back to preparing and the buyer would watch their
 *      delivery un-happen.
 *   2. NEVER SKIP WHAT THE GRAPH FORBIDS. §9.11 says which successors are
 *      legal; a jump the graph rejects means the two systems disagree about
 *      what happened, and the honest answer is to say so rather than to invent
 *      the missing step.
 *   3. UNCHANGED IS NOT AN UPDATE. Polling returns the same state constantly.
 *      Signing each one would fill the chain with records that say nothing and
 *      cost a signature apiece.
 *
 * WHAT A REFUSAL MEANS. Not "ignore it" — `needs_attention`. A backwards or
 * illegal report is evidence the two systems disagree, which is exactly the
 * §12.7 case an operator has to see. Dropping it silently would make the
 * disagreement invisible until a buyer complained.
 */

/** What the external system says about an order right now. */
export interface ExternalFulfilment {
  /** The external order reference the effect returned. */
  externalRef: string;
  /** Mapped into the §9.11 vocabulary by the connector, not guessed here. */
  state: OrderState;
  /** Per-line fulfilled quantities, when the state carries them (§9.11). */
  lines?: { line_id: string; fulfilled_quantity: { unit_code: string; value: string } }[];
  /** When the external system says this became true. */
  observedAtIso: string;
}

export type FulfilmentDecision =
  /** Advance the chain to this state. The caller signs; this does not. */
  | { kind: 'advance'; to: OrderState; lines?: ExternalFulfilment['lines'] }
  /** Nothing changed. No record, no signature. */
  | { kind: 'unchanged' }
  /**
   * The two systems disagree. The order needs a human, and §12.7 owns it.
   * `reason` is the operator's explanation, never a code.
   */
  | { kind: 'needs_attention'; refusal: FulfilmentRefusal; reason: string };

export type FulfilmentRefusal =
  | 'moves_backwards'
  | 'illegal_transition'
  | 'chain_already_terminal'
  | 'lines_missing'
  | 'unknown_external_ref';

/**
 * States that carry per-line quantities (§9.11).
 *
 * A `dispatched` with no lines is a claim that something shipped without
 * saying what, which a buyer cannot check against their order.
 */
const LINES_REQUIRED: ReadonlySet<OrderState> = new Set(['partially_fulfilled', 'dispatched']);

/**
 * States a chain never leaves.
 *
 * `delivered` is absent on purpose and for the same reason it is absent from
 * the in-flight count: it is terminal only once its dispute window elapses,
 * and `delivered → disputed` is a legal transition the graph still allows.
 */
const TERMINAL: ReadonlySet<OrderState> = new Set(['rejected', 'cancelled', 'disputed']);

/**
 * Decide what an external report means for the chain.
 *
 * `current` is the chain's head state, or null when no chain exists yet — an
 * order that was never accepted has nothing to advance, and a fulfilment
 * report against it is a disagreement rather than a starting point.
 */
export function reconcileFulfilment(args: {
  current: OrderState | null;
  external: ExternalFulfilment;
  /** The reference the effect recorded. Guards against a crossed report. */
  expectedExternalRef: string;
}): FulfilmentDecision {
  if (args.external.externalRef !== args.expectedExternalRef) {
    // A report about somebody else's order. Refused rather than applied,
    // because the alternative is advancing THIS buyer's chain on another
    // buyer's shipment.
    return {
      kind: 'needs_attention',
      refusal: 'unknown_external_ref',
      reason: 'this update names an external order that is not the one recorded for this purchase',
    };
  }

  const current = args.current;
  if (current === null) {
    return {
      kind: 'needs_attention',
      refusal: 'unknown_external_ref',
      reason: 'the external system reports progress on an order this node never accepted',
    };
  }

  if (current === args.external.state) return { kind: 'unchanged' };

  if (TERMINAL.has(current)) {
    return {
      kind: 'needs_attention',
      refusal: 'chain_already_terminal',
      reason: `this order is already ${current}, and the external system reports ${args.external.state}`,
    };
  }

  const legal = LEGAL_TRANSITIONS[current];
  if (!legal.includes(args.external.state)) {
    // BACKWARDS is called out separately from merely illegal, because the two
    // mean different things to an operator: one is a late webhook, the other
    // is a genuine disagreement about what happened.
    const backwards = LEGAL_TRANSITIONS[args.external.state].includes(current);
    return backwards
      ? {
          kind: 'needs_attention',
          refusal: 'moves_backwards',
          reason: `the external system reports ${args.external.state}, which this order already passed on its way to ${current}`,
        }
      : {
          kind: 'needs_attention',
          refusal: 'illegal_transition',
          reason: `${current} cannot become ${args.external.state}`,
        };
  }

  if (LINES_REQUIRED.has(args.external.state)) {
    const lines = args.external.lines;
    if (lines === undefined || lines.length === 0) {
      return {
        kind: 'needs_attention',
        refusal: 'lines_missing',
        reason: `a ${args.external.state} update must say which lines and how much`,
      };
    }
    return { kind: 'advance', to: args.external.state, lines };
  }

  return { kind: 'advance', to: args.external.state };
}

/**
 * Poll every open order's external state and decide what each one means.
 *
 * A SWEEP, not a subscription. A webhook from the external system would be an
 * inbound path with no authentication this node controls; polling through the
 * broker reuses the one outbound lane that already carries the credential
 * rules. It is slower and it is the only version whose trust boundary is
 * stated.
 */
export interface FulfilmentSweepItem {
  buyerDid: string;
  purchaseOrderId: string;
  externalRef: string;
  current: OrderState | null;
}

export interface FulfilmentSweepResult {
  buyerDid: string;
  purchaseOrderId: string;
  decision: FulfilmentDecision;
}

export async function sweepFulfilment(args: {
  open: FulfilmentSweepItem[];
  /** Reads one order's external state, or null when the read failed. */
  readExternal: (item: FulfilmentSweepItem) => Promise<ExternalFulfilment | null>;
}): Promise<FulfilmentSweepResult[]> {
  const results: FulfilmentSweepResult[] = [];
  for (const item of args.open) {
    const external = await args.readExternal(item);
    if (external === null) {
      // A FAILED READ IS NOT A DECISION. The order keeps its current state and
      // the sweep says nothing about it — treating an unreachable connector as
      // "no change" would be indistinguishable from a working one that
      // reported no change, and only one of those is reassuring.
      continue;
    }
    results.push({
      buyerDid: item.buyerDid,
      purchaseOrderId: item.purchaseOrderId,
      decision: reconcileFulfilment({
        current: item.current,
        external,
        expectedExternalRef: item.externalRef,
      }),
    });
  }
  return results;
}
