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
 *
 * §15 step 14: Brain may instead ask the owner a yes-or-no question
 * (`owner_questions.ts`). The round waits on its guests anyway, so there is
 * always time: the card stays open a day. A yes or a no goes back to Brain on
 * the same round; a lapse leaves the pick to the owner. A question about a
 * round the plan has left is withdrawn.
 */

import {
  answersSeenIn,
  askOwnerOnCard,
  getOwnerQuestions,
  installQuestionPort,
  moveAgainstAnswers,
  ownerAnswersIn,
  uninstallQuestionPort,
  withdrawOwnerQuestions,
} from '../commitment/owner_questions';
import { QUESTION_WAIT_MS } from '../commitment/strategy_questions';

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
  if (next === null) {
    uninstallQuestionPort(GROUP_ORGANIZER);
    return;
  }
  installQuestionPort({
    kind: GROUP_ORGANIZER,
    subject: 'a group booking',
    // A lapse leaves the pick to the owner, in the answer's own write.
    answered: (q, answer) => {
      if (answer === 'lapsed') next.turns.close(GROUP_ORGANIZER, q.negotiationId, q.turn, 'fallen_back');
    },
    after: (q, answer, nowMs) => {
      if (answer !== 'lapsed') askAgain(q.negotiationId, q.turn, nowMs);
    },
  });
}

export function getGroupSlotStrategy(): GroupSlotStrategy | null {
  return strategy;
}

/** Can Brain pick for this plan now? A folded plan, every required guest in, slots agreed. */
function pickable(plan: GroupPlan): MeetingSlot[] | null {
  if (plan.state !== 'folded' || plan.fold === null || plan.fold.state === 'waiting') return null;
  return plan.fold.agreed.length > 0 ? plan.fold.agreed : null;
}

/** The brief for one round's pick: the plan's intent, the agreed slots, the owner's answers so far. */
function slotBrief(
  planId: string,
  round: number,
  intent: string,
  agreed: readonly MeetingSlot[],
): Parameters<NegotiationSubmitter>[0] {
  return {
    kind: GROUP_ORGANIZER,
    ref: { negotiationId: planId, turn: round },
    side: 'buyer',
    parts: [{ name: 'slot', kind: 'choice' }],
    table: {
      intent,
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
      'The guests wait on this pick, so there is time to ask your owner one yes-or-no question if only they can settle it.',
    ],
    ...ownerAnswersIn(GROUP_ORGANIZER, planId),
  };
}

/**
 * Ask Brain to pick, once per round, when the owner chose it; withdraw any
 * question about a round the plan has left, and hand back a round whose
 * question the owner answered. Never throws.
 */
export function askBrainForSlot(plan: GroupPlan, nowMs: number): void {
  const s = strategy;
  if (s === null) return;
  try {
    const agreed = pickable(plan);
    const brain = s.settings().strategy === 'brain';
    // §15 step 14: only a question about this round, while Brain still picks, stands.
    withdrawOwnerQuestions(
      GROUP_ORGANIZER,
      plan.planId,
      nowMs,
      agreed !== null && brain ? plan.round : undefined,
    );
    if (agreed === null || !brain) return;
    const turn = s.turns.get(GROUP_ORGANIZER, plan.planId, plan.round);
    if (turn !== null) {
      // An answer a crash kept from going back to Brain goes now.
      if (turn.state === 'pending') askAgain(plan.planId, plan.round, nowMs);
      return;
    }
    if (!s.canSpend(plan.planId, nowMs)) return;
    const submitted = s.submit(slotBrief(plan.planId, plan.round, plan.intent, agreed));
    if (submitted === null) return;
    s.turns.put({
      kind: GROUP_ORGANIZER,
      negotiationId: plan.planId,
      turn: plan.round,
      taskId: submitted.taskId,
      // The list Brain saw: its index is read against this, never a later fold.
      result: { agreed, intent: plan.intent },
      createdAt: nowMs,
    });
  } catch {
    // The owner picks: asking Brain never stands in the way of a read.
  }
}

/**
 * Brain asked the owner a question on this round (§15 step 14). Put on a
 * card while the plan still waits on this round's pick; the turn stays
 * pending until the answer. False: the turn closes and the owner picks.
 */
export function askOwnerAboutSlot(
  plan: GroupPlan | null,
  args: { planId: string; turn: number; question: string; input: unknown; nowMs: number },
): 'asked' | 'waiting' | 'stale' | 'owner_picks' {
  const s = strategy;
  if (s === null) return 'owner_picks';
  const turn = s.turns.get(GROUP_ORGANIZER, args.planId, args.turn);
  if (turn === null || turn.state !== 'pending') return 'owner_picks';
  const standing = moveAgainstAnswers(GROUP_ORGANIZER, args.planId, args.turn, answersSeenIn(args.input));
  if (standing !== 'current') return standing;
  const agreed = plan === null || plan.round !== args.turn ? null : pickable(plan);
  if (
    agreed !== null &&
    s.settings().strategy === 'brain' &&
    askOwnerOnCard({
      kind: GROUP_ORGANIZER,
      negotiationId: args.planId,
      turn: args.turn,
      question: args.question,
      decideByMs: args.nowMs + QUESTION_WAIT_MS,
      nowMs: args.nowMs,
      hide: [args.planId], // Brain holds it from its brief; the card never shows it
    })
  )
    return 'asked';
  s.turns.close(GROUP_ORGANIZER, args.planId, args.turn, 'fallen_back');
  return 'owner_picks';
}

/**
 * Hand a round back to Brain with the owner's answers, once per answer: a
 * pending turn with no question open whose last brief carried fewer answers
 * than the owner has given. With Brain no longer chosen, no budget, or no
 * door, the turn closes and the owner picks.
 */
function askAgain(planId: string, round: number, nowMs: number): void {
  const s = strategy;
  const questions = getOwnerQuestions();
  if (s === null || questions === null) return;
  const turn = s.turns.get(GROUP_ORGANIZER, planId, round);
  if (turn === null || turn.state !== 'pending') return;
  if (questions.openFor(GROUP_ORGANIZER, planId, round) !== null) return;
  const answers = questions.answered(GROUP_ORGANIZER, planId).length;
  const seen = typeof turn.result.answers_seen === 'number' ? turn.result.answers_seen : 0;
  if (answers <= seen) return;
  const agreed = Array.isArray(turn.result.agreed) ? (turn.result.agreed as MeetingSlot[]) : [];
  const intent = typeof turn.result.intent === 'string' ? turn.result.intent : '';
  const submitted =
    s.settings().strategy === 'brain' && agreed.length > 0 && s.canSpend(planId, nowMs)
      ? s.submit(slotBrief(planId, round, intent, agreed))
      : null;
  if (submitted === null) {
    s.turns.close(GROUP_ORGANIZER, planId, round, 'fallen_back');
    return;
  }
  s.turns.restart(GROUP_ORGANIZER, planId, round, {
    taskId: submitted.taskId,
    result: { ...turn.result, answers_seen: answers },
    nowMs,
  });
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
  args: { planId: string; turn: number; result: unknown; input?: unknown; nowMs: number },
): MeetingSlot | null {
  const s = strategy;
  if (s === null) return null;
  const turn = s.turns.get(GROUP_ORGANIZER, args.planId, args.turn);
  if (turn === null || turn.state !== 'pending') return null;
  // §15 step 14: a turn waiting on the owner takes no move, and a move from a
  // brief before the owner's latest answer is stale; either leaves the turn be.
  if (moveAgainstAnswers(GROUP_ORGANIZER, args.planId, args.turn, answersSeenIn(args.input)) !== 'current')
    return null;
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
