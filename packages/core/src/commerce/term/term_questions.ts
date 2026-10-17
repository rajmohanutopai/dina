/**
 * Brain asks the owner (COMMITMENT_KERNEL §15 step 11) on a shelf deal.
 *
 * A strategy's turn may come back as a yes-or-no question. Core puts it on a
 * card and the turn waits: nothing is sent, nothing binds, and the stale-turn
 * sweep leaves it alone (`TermStore.staleTurns`). A yes or a no is kept and
 * the same turn goes back to Brain with every answer so far in its brief; a
 * card left to lapse lets the fixed style play the turn. The owner sees the
 * question as Brain wrote it, cleaned to one bounded line; the other side
 * never sees it, and no figure of the owner's is added to it.
 */

import {
  MAX_OWNER_QUESTIONS,
  cleanQuestion,
  type OwnerAnswer,
} from '../../commitment/strategy_questions';

import { buyerTurnBrief, STRATEGY_WAIT_MS } from './term_buyer';
import { mintId, type TermContext } from './term_context';
import { SHELF_HOST_KIND, SHELF_VENDOR_KIND } from './term_model';
import { playSellerTurnFixed, sellerTurnBrief } from './term_seller';

export const TERM_STRATEGY_QUESTION_CARD = 'term_strategy_question';

/** The longest a question waits for the owner, whatever the deal's own deadline. */
const QUESTION_WAIT_MS = 24 * 60 * 60 * 1000;

/** Left before the deal's deadline when a question lapses, so the fixed style can still play. */
export const FIXED_STYLE_ROOM_MS = 30 * 60 * 1000;

/** A question the owner would have less than this to answer is not put. */
const LEAST_QUESTION_WAIT_MS = 5 * 60 * 1000;

/** Whose turn this is: the brand's own negotiation, or the store's answer. */
function kindOf(ctx: TermContext, requestId: string): string {
  return ctx.store.getNegotiation(requestId) !== null ? SHELF_VENDOR_KIND : SHELF_HOST_KIND;
}

/**
 * Put the strategy's question to the owner. False (the caller lets the fixed
 * style play) when the question is empty, the deal has asked its share
 * already, or the turn cannot wait long enough for an answer.
 */
export function askOwnerOnTurn(
  ctx: TermContext,
  args: { requestId: string; turn: number; question: string; dealDeadlineMs: number },
): boolean {
  const kind = kindOf(ctx, args.requestId);
  const questions = ctx.store.questions();
  const question = cleanQuestion(args.question);
  if (question === null || questions.countFor(kind, args.requestId) >= MAX_OWNER_QUESTIONS)
    return false;
  const nowMs = ctx.now();
  // The card lapses early enough for the fixed style to still play the turn
  // before the deal's own deadline; with no such room the question is not put.
  const decideBy = Math.min(nowMs + QUESTION_WAIT_MS, args.dealDeadlineMs - FIXED_STYLE_ROOM_MS);
  if (decideBy - nowMs < LEAST_QUESTION_WAIT_MS) return false;
  const cardId = mintId('tq');
  return ctx.atomically('strategy_question', () => {
    if (
      !questions.ask({
        kind,
        negotiationId: args.requestId,
        turn: args.turn,
        question,
        cardId,
        askedAt: nowMs,
      })
    )
      return false;
    ctx.raiseCard({
      cardId,
      type: TERM_STRATEGY_QUESTION_CARD,
      requestId: args.requestId,
      refDigest: args.requestId,
      description: `Brain asks: ${question}`,
      payload: {
        type: TERM_STRATEGY_QUESTION_CARD,
        card_id: cardId,
        request_id: args.requestId,
        question,
      },
      decideBy,
    });
    // The brand's sweep looks again when the answer can no longer come.
    if (kind === SHELF_VENDOR_KIND) ctx.store.setNextAction(args.requestId, decideBy, nowMs);
    return true;
  });
}

/**
 * The owner answered (or the card lapsed). A yes or a no goes back to Brain
 * on the same turn; a lapse, or a turn that has moved on, ends it. False when
 * the card was settled already.
 */
export function answerStrategyQuestion(
  ctx: TermContext,
  cardId: string,
  answer: OwnerAnswer,
): boolean {
  return ctx.atomically('strategy_answer', () => {
    const questions = ctx.store.questions();
    const asked = questions.byCard(cardId);
    const nowMs = ctx.now();
    if (asked === null || !questions.answer(cardId, answer, nowMs)) return false;
    ctx.store.decideCard(
      cardId,
      answer === 'yes' ? 'approved' : answer === 'no' ? 'declined' : 'lapsed',
      nowMs,
    );
    const turn = ctx.store.getTurn(asked.negotiationId, asked.turn);
    if (turn === null || turn.state !== 'pending') return true;
    if (answer === 'lapsed') {
      playTurnFixed(ctx, asked.negotiationId, asked.turn);
      return true;
    }
    const buyer = asked.kind === SHELF_VENDOR_KIND;
    const brief = buyer
      ? buyerTurnBrief(ctx, asked.negotiationId, asked.turn)
      : sellerTurnBrief(ctx, asked.negotiationId, asked.turn);
    if (brief === null) {
      ctx.store.closeTurn(asked.negotiationId, asked.turn, 'applied');
      return true;
    }
    const submitted = ctx.deps.strategy?.submit(brief) ?? null;
    if (submitted === null) {
      playTurnFixed(ctx, asked.negotiationId, asked.turn);
      return true;
    }
    ctx.store.restartTurn(asked.negotiationId, asked.turn, submitted.taskId, nowMs);
    if (buyer) {
      const deadline = ctx.store.getNegotiation(asked.negotiationId)?.deadlineAt ?? nowMs;
      ctx.store.setNextAction(
        asked.negotiationId,
        Math.min(nowMs + STRATEGY_WAIT_MS, deadline),
        nowMs,
      );
    }
    return true;
  });
}

/** The fixed style plays a turn Brain will not finish. */
function playTurnFixed(ctx: TermContext, requestId: string, turn: number): void {
  if (ctx.store.getNegotiation(requestId) !== null) {
    if (ctx.store.closeTurn(requestId, turn, 'fallen_back'))
      ctx.store.setNextAction(requestId, ctx.now(), ctx.now());
    return;
  }
  playSellerTurnFixed(ctx, requestId, turn);
}
