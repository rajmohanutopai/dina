/**
 * Brain picks a group booking's slot (COMMITMENT_KERNEL §15 step 11).
 *
 * When the owner chose Brain for `group.organizer` and a plan folds with
 * slots every required guest accepted, Core asks Brain once per round to
 * pick one. Brain sees the plan's intent and the agreed slots, nothing about
 * the guests. Core accepts only a slot in the fold's agreed list (the same
 * `choose` the owner's pick goes through) and opens the confirming round, so
 * nothing binds before the guests confirm. With no answer the plan stays
 * folded and the owner picks, as before.
 */

import type { MeetingSlot } from './group_fold';
import type { GroupPlan } from './group_plan';
import type { StrategySettings } from '../commitment/strategy_store';
import type { NegotiationSubmitter } from '../commitment/strategy_submit';
import type { StrategyTurnStore } from '../commitment/strategy_turns';

export const GROUP_ORGANIZER = 'group.organizer';

export interface GroupSlotStrategy {
  settings: () => StrategySettings;
  canSpend: (negotiationId: string, nowMs: number) => boolean;
  charge: (negotiationId: string, nowMs: number) => boolean;
  turns: StrategyTurnStore;
  submit: NegotiationSubmitter;
  /** Run writes as one transaction on the store the budget and turns share. */
  atomically: (fn: () => void) => void;
}

let strategy: GroupSlotStrategy | null = null;

/** Wired at boot; null (tests, a node with no store): the owner always picks. */
export function installGroupSlotStrategy(next: GroupSlotStrategy | null): void {
  strategy = next;
}

export function getGroupSlotStrategy(): GroupSlotStrategy | null {
  return strategy;
}

/** Can Brain pick for this plan now? A folded plan, every required guest in, slots agreed. */
function pickable(plan: GroupPlan): MeetingSlot[] | null {
  if (plan.state !== 'folded' || plan.fold === null || plan.fold.state === 'waiting') return null;
  return plan.fold.agreed.length > 0 ? plan.fold.agreed : null;
}

/** Ask Brain to pick, once per round, when the owner chose it. Never throws. */
export function askBrainForSlot(plan: GroupPlan, nowMs: number): void {
  const s = strategy;
  if (s === null) return;
  try {
    const agreed = pickable(plan);
    if (agreed === null || s.settings().strategy !== 'brain') return;
    if (s.turns.get(GROUP_ORGANIZER, plan.planId, plan.round) !== null) return;
    if (!s.canSpend(plan.planId, nowMs)) return;
    const submitted = s.submit({
      kind: GROUP_ORGANIZER,
      ref: { negotiationId: plan.planId, turn: plan.round },
      side: 'buyer',
      parts: [{ name: 'slot', kind: 'choice' }],
      table: {
        intent: plan.intent,
        agreed: agreed.map((slot, index) => ({
          index,
          start: slot.start,
          ...(slot.end !== undefined ? { end: slot.end } : {}),
        })),
      },
      history: [],
      // The organiser holds no figures: no values, no rules to project.
      model: { constrained: [] },
      roundsLeft: 0,
      rules: [
        'You speak for the organiser of a group booking. Every required guest accepted each slot in `agreed`.',
        'Pick one: propose one version whose term `slot` is its index (0 for the first).',
        'The guests confirm the slot you pick before anything is booked.',
      ],
    });
    if (submitted === null) return;
    s.turns.put({
      kind: GROUP_ORGANIZER,
      negotiationId: plan.planId,
      turn: plan.round,
      taskId: submitted.taskId,
      // The list Brain saw: its index is read against this, never a later fold.
      result: { agreed },
      createdAt: nowMs,
    });
  } catch {
    // The owner picks: asking Brain never stands in the way of a read.
  }
}

/**
 * Brain's pick, checked before anything changes: the turn is pending, the
 * index names a slot in the list Brain was shown, and that slot is still one
 * the fold agrees on in this plan's round. The verdict is charged here,
 * before the slot is chosen, and kept with the turn so a replay never
 * charges twice. Null (the turn closed, the owner picks) otherwise. The
 * caller chooses the slot, then settles the turn (`settleSlotTurn`); a crash
 * between the two is finished by the replay, which finds the slot chosen.
 */
export function slotFromMove(
  plan: GroupPlan | null,
  args: { planId: string; turn: number; result: unknown; nowMs: number },
): MeetingSlot | null {
  const s = strategy;
  if (s === null) return null;
  const turn = s.turns.get(GROUP_ORGANIZER, args.planId, args.turn);
  if (turn === null || turn.state !== 'pending') return null;
  const shown = Array.isArray(turn.result.agreed) ? (turn.result.agreed as MeetingSlot[]) : [];
  const same = (a: MeetingSlot, b: MeetingSlot): boolean =>
    a.start === b.start && (a.end ?? '') === (b.end ?? '');
  // Chosen already (a crash after the choice, before its turn was settled).
  if (
    plan !== null &&
    plan.round > args.turn &&
    plan.chosen !== null &&
    turn.result.charged === true
  ) {
    const chosen = plan.chosen;
    s.turns.close(
      GROUP_ORGANIZER,
      args.planId,
      args.turn,
      shown.some((x) => same(x, chosen)) ? 'applied' : 'fallen_back',
    );
    return null;
  }
  const fallBack = (): null => {
    s.turns.close(GROUP_ORGANIZER, args.planId, args.turn, 'fallen_back');
    return null;
  };
  const agreed = plan === null || plan.round !== args.turn ? null : pickable(plan);
  if (agreed === null || s.settings().strategy !== 'brain') return fallBack();
  const move = (args.result as { move?: { kind?: unknown; versions?: unknown } } | null)?.move;
  const versions = Array.isArray(move?.versions) ? (move.versions as { terms?: unknown }[]) : [];
  const terms = Array.isArray(versions[0]?.terms)
    ? (versions[0].terms as { name?: unknown; value?: unknown }[])
    : [];
  const value = terms.find((t) => t.name === 'slot')?.value;
  const index = typeof value === 'string' && /^(0|[1-9][0-9]?)$/.test(value) ? Number(value) : -1;
  const picked = move?.kind === 'propose' ? shown[index] : undefined;
  const slot = picked === undefined ? undefined : agreed.find((a) => same(a, picked));
  if (slot === undefined) return fallBack();
  if (turn.result.charged !== true) {
    // The verdict and its mark on the turn land together: a crash cannot
    // leave one without the other, so a replay never charges twice.
    let charged = false;
    s.atomically(() => {
      charged = s.charge(args.planId, args.nowMs);
      if (charged)
        s.turns.note(GROUP_ORGANIZER, args.planId, args.turn, { ...turn.result, charged: true });
    });
    if (!charged) return fallBack();
  }
  return slot;
}

/** After the pick was chosen (or refused): close the turn. */
export function settleSlotTurn(planId: string, turn: number, chosen: boolean): void {
  const s = strategy;
  if (s === null) return;
  s.turns.close(GROUP_ORGANIZER, planId, turn, chosen ? 'applied' : 'fallen_back');
}
