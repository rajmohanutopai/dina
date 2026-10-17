/**
 * Brain bargains a goods tender's counters for the buyer (COMMITMENT_KERNEL
 * §15 step 11).
 *
 * The fixed style always counters at the owner's target. With Brain chosen
 * for `goods.buyer`, each round's counter waits a few seconds for Brain's
 * target, then goes at the owner's target if Brain has not answered: a
 * tender's window is short (90 seconds by default), and a slow Brain never
 * holds it up. Core raises Brain's target to the owner's target when it is
 * lower; one over the budget ceiling, or at or over the quote, lets the
 * owner's target go instead, so no counter ever carries the ceiling. Neither
 * figure is in the brief. A counter binds nobody: the supplier still answers, and the owner
 * still awards.
 */

import { projectModel } from '../commitment/strategy';

import type { SentCounter, TenderNegotiation } from './buyer_negotiation_store';
import type { StrategySettings } from '../commitment/strategy_store';
import type { NegotiationSubmitter } from '../commitment/strategy_submit';
import type { StrategyTurnStore } from '../commitment/strategy_turns';
import type { ValueModel } from '../commitment/value_model';
import type { SignedQuote } from '@dina/commerce-protocol';

export const GOODS_BUYER = 'goods.buyer';

/** The longest a round waits for Brain's target. */
export const GOODS_COUNTER_WAIT_MS = 15_000;

/** A round with less time than this before the deadline goes at the owner's target at once. */
const LEAST_TIME_LEFT_MS = 25_000;

export interface GoodsCounterStrategy {
  settings: () => StrategySettings;
  canSpend: (negotiationId: string, nowMs: number, thresholdVersion: number) => boolean;
  charge: (negotiationId: string, nowMs: number, thresholdVersion: number) => boolean;
  turns: StrategyTurnStore;
  submit: NegotiationSubmitter;
  brainModel: () => ValueModel | null;
  /** The clock a commit charges the budget at (a composition default). */
  nowMs: () => number;
}

let strategy: GoodsCounterStrategy | null = null;

/** Wired at boot; null (tests, a node with no store): the owner's target always. */
export function installGoodsCounterStrategy(next: GoodsCounterStrategy | null): void {
  strategy = next;
}

/** One tender member's negotiation, as the turn store names it. */
export function goodsNegotiationId(tenderId: string, quoteId: string): string {
  return `${tenderId}|${quoteId}`;
}

const MINOR = /^(0|[1-9][0-9]{0,17})$/;

/**
 * The target this round's counter carries: Brain's, the owner's, or `wait`
 * while Brain is deciding. Never throws: a failure is the owner's target.
 */
export function goodsCounterTarget(args: {
  tender: TenderNegotiation;
  head: SignedQuote;
  counters: readonly SentCounter[];
  nowMs: number;
}): string | 'wait' {
  const own = args.tender.targetTotalMinor;
  const s = strategy;
  if (s === null) return own;
  try {
    const negotiationId = goodsNegotiationId(args.tender.tenderId, args.head.quote_id);
    const round = args.counters.filter((c) => c.tenderId === args.tender.tenderId).length + 1;
    const turn = s.turns.get(GOODS_BUYER, negotiationId, round);
    if (turn !== null) {
      if (turn.state === 'applied') return bounded(String(turn.result.target ?? ''), args) ?? own;
      if (turn.state === 'fallen_back') return own;
      if (args.nowMs - turn.createdAt < GOODS_COUNTER_WAIT_MS) return 'wait';
      s.turns.close(GOODS_BUYER, negotiationId, round, 'fallen_back');
      return own;
    }
    if (s.settings().strategy !== 'brain') return own;
    if (args.tender.deadlineAt - args.nowMs < LEAST_TIME_LEFT_MS) return own;
    const model = s.brainModel();
    const version = model?.version ?? 0;
    if (!s.canSpend(negotiationId, args.nowMs, version)) return own;
    const submitted = s.submit({
      kind: GOODS_BUYER,
      ref: { negotiationId, turn: round },
      side: 'buyer',
      parts: [{ name: 'total', kind: 'money', payer: 'buyer', payee: 'seller' }],
      table: {
        terms: [{ name: 'total', value: args.head.total.minor_units }],
        currency: args.head.total.currency,
        ...(args.head.estimated_delivery_at !== undefined
          ? { delivery_at: args.head.estimated_delivery_at }
          : {}),
      },
      history: args.counters
        .filter((c) => c.tenderId === args.tender.tenderId)
        .map((c) => ({ by: 'us', round: c.round, answer: c.state })),
      model:
        model === null
          ? { constrained: [] }
          : { ...projectModel(model, { valuesOn: s.settings().valuesOn, firstOfferOut: true }) },
      roundsLeft: Math.max(0, args.tender.maxRounds - round + 1),
      deadlineAt: new Date(args.tender.deadlineAt).toISOString(),
      rules: [
        'You speak for a buyer. A supplier quoted this total; a counter asks it to come down.',
        'Propose the total to counter with, in minor units, one version; Core keeps it within the owner’s limits.',
        'Never set a price for anyone outside the deal.',
      ],
    });
    if (submitted === null) return own;
    s.turns.put({
      kind: GOODS_BUYER,
      negotiationId,
      turn: round,
      taskId: submitted.taskId,
      result: {},
      createdAt: args.nowMs,
    });
    return 'wait';
  } catch {
    return own;
  }
}

/** Brain's target, raised to the owner's target, under the ceiling and the quote; null: none. */
function bounded(
  value: string,
  args: { tender: TenderNegotiation; head: SignedQuote },
): string | null {
  const { targetTotalMinor, budgetCeilingMinor } = args.tender;
  if (!MINOR.test(value) || !MINOR.test(targetTotalMinor) || !MINOR.test(budgetCeilingMinor))
    return null;
  let target = BigInt(value);
  const low = BigInt(targetTotalMinor);
  const high = BigInt(budgetCeilingMinor);
  if (target < low) target = low;
  // Over the ceiling the owner's target goes, never the ceiling itself: a
  // counter at the hard limit would tell the supplier where it is (§7).
  if (target > high) return null;
  // A counter at or over the quote asks for nothing: the owner's target goes.
  if (target >= BigInt(args.head.total.minor_units)) return null;
  return target.toString(10);
}

/**
 * The commit bridge's door for Brain's target (§15 step 11). The ids come
 * from Core's own input; one verdict is charged; anything but a total, or a
 * spent budget, lets the owner's target go. The next tick sends the counter.
 */
export function commitGoodsCounterMove(input: { input: unknown; result: unknown }): {
  state: 'committed';
  receipt: Record<string, unknown>;
} {
  const s = strategy;
  if (s === null) throw new Error('goods counter strategy unavailable');
  const ref = (input.input as { ref?: { negotiationId?: unknown; turn?: unknown } } | null)?.ref;
  const negotiationId = ref?.negotiationId;
  const round = ref?.turn;
  if (typeof negotiationId !== 'string' || typeof round !== 'number')
    throw new Error('goods counter move: no ref');
  const turn = s.turns.get(GOODS_BUYER, negotiationId, round);
  if (turn === null || turn.state !== 'pending')
    return { state: 'committed', receipt: { outcome: 'already_applied' } };
  const move = (input.result as { move?: { kind?: unknown; versions?: unknown } } | null)?.move;
  const versions = Array.isArray(move?.versions) ? (move.versions as { terms?: unknown }[]) : [];
  const terms = Array.isArray(versions[0]?.terms)
    ? (versions[0].terms as { name?: unknown; value?: unknown }[])
    : [];
  const target = terms.find((t) => t.name === 'total')?.value;
  const nowMs = s.nowMs();
  const version = s.brainModel()?.version ?? 0;
  if (
    move?.kind === 'propose' &&
    typeof target === 'string' &&
    MINOR.test(target) &&
    s.settings().strategy === 'brain' &&
    s.charge(negotiationId, nowMs, version) &&
    s.turns.close(GOODS_BUYER, negotiationId, round, 'applied', { target })
  )
    return { state: 'committed', receipt: { outcome: 'answered' } };
  s.turns.close(GOODS_BUYER, negotiationId, round, 'fallen_back');
  return { state: 'committed', receipt: { outcome: 'fixed_style' } };
}
