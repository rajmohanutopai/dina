/**
 * When a shelf deal touches a rule kept in a closed or locked persona
 * (COMMITMENT_KERNEL §7, §8 "Closed and locked personas"): the owner's card
 * asks to open it, naming the persona, and the deal waits — never signed
 * alone, never refused for it — until the persona is open or the card lapses
 * after 24 hours.
 *
 * One card per step that waits:
 *   - `first_offer`: the store has a request and signs no offer alone;
 *   - `counter`: the store would revise its head and signs nothing alone;
 *     once open, the counter is answered if it still answers the head;
 *   - `concession`: the owner said yes to a floor card; the concession is
 *     signed once the persona is open;
 *   - `decision`: the store's owner said yes, and the yes cannot bind while a
 *     rule it must check is sealed; once the persona is open the decision card
 *     is raised again, with its own decide-by;
 *   - `proposal`: the brand's Dina has a head it would put to its owner.
 *
 * The sweep tries each pending card again; the owner's yes on it tries at
 * once. Opening the persona is the owner's own act, through the persona's
 * usual door (a confirmation, or the passphrase); this card only says why.
 */

import { HOUR_MS, type TermContext } from './term_context';
import { SHELF_HOST_KIND, SHELF_VENDOR_KIND } from './term_model';
import { readTermCardPayloadJson } from './term_rehydrate';

import type { TermCardRow } from './term_store';

export const TERM_PERSONA_CARD = 'term_open_persona';

export type PersonaStep = 'first_offer' | 'counter' | 'concession' | 'decision' | 'proposal';

const KIND_FOR: Readonly<Record<PersonaStep, string>> = {
  first_offer: SHELF_HOST_KIND,
  counter: SHELF_HOST_KIND,
  concession: SHELF_HOST_KIND,
  decision: SHELF_HOST_KIND,
  proposal: SHELF_VENDOR_KIND,
};

/** Personas, closed now, holding a rule a shelf deal of this kind must check. */
export function closedPersonasFor(ctx: TermContext, kind: string): string[] {
  return ctx.deps.valueModels?.(kind, ['fee', 'share_bps'])?.closedPersonas ?? [];
}

/**
 * Raise the card for a step that waits. One card per waiting spell: while one
 * is pending for this step and document, raising again does nothing; once it
 * was answered or lapsed, the next closing raises a fresh one.
 */
export function raisePersonaCard(
  ctx: TermContext,
  args: { step: PersonaStep; requestId: string; refDigest: string; personas: string[] },
): void {
  const base = `term-persona-${args.step}-${args.refDigest.slice(0, 32)}`;
  const earlier = ctx.store
    .cardsForRequest(args.requestId, TERM_PERSONA_CARD)
    .filter((c) => c.cardId === base || c.cardId.startsWith(`${base}-`));
  if (earlier.some((c) => c.state === 'pending')) return;
  const cardId = earlier.length === 0 ? base : `${base}-${String(earlier.length + 1)}`;
  const names = args.personas.join(', ');
  ctx.raiseCard({
    cardId,
    type: TERM_PERSONA_CARD,
    requestId: args.requestId,
    refDigest: args.refDigest,
    description: `A shelf-space deal needs a rule you keep in your ${names} persona. Open it, then say yes to go on.`,
    payload: {
      type: TERM_PERSONA_CARD,
      card_id: cardId,
      request_id: args.requestId,
      step: args.step,
      personas: args.personas,
    },
    decideBy: ctx.now() + 24 * HOUR_MS,
  });
}

function stepOf(card: TermCardRow): PersonaStep | null {
  const step = readTermCardPayloadJson(card.payloadJson)?.step;
  return typeof step === 'string' && step in KIND_FOR ? (step as PersonaStep) : null;
}

/** What a step does once its persona is open; supplied by the seller and buyer halves. */
export interface PersonaResumers {
  first_offer: (ctx: TermContext, requestDigest: string) => void;
  counter: (ctx: TermContext, counterDigest: string) => void;
  concession: (ctx: TermContext, requestId: string) => void;
  decision: (ctx: TermContext, proposalDigest: string) => void;
  proposal: (ctx: TermContext, requestId: string) => void;
  /**
   * The wait ended without the persona opening (declined, or 24 hours
   * passed): a store's decision sends the uniform rejection, a brand's
   * negotiation closes. Other steps simply stay where they were.
   */
  endDecision: (ctx: TermContext, proposalDigest: string) => void;
  endProposal: (ctx: TermContext, requestId: string) => void;
}

/**
 * Try a waiting step again. True when the persona is open and the step went
 * on (the card is then closed); false while it is still closed.
 */
export function resumePersonaCard(
  ctx: TermContext,
  card: TermCardRow,
  resumers: PersonaResumers,
): boolean {
  const step = stepOf(card);
  if (step === null) return false;
  // Past its decide-by the card can no longer start anything (§8).
  if (card.state !== 'pending' || card.decideBy <= ctx.now()) return false;
  if (closedPersonasFor(ctx, KIND_FOR[step]).length > 0) return false;
  ctx.atomically('persona_open', () => {
    if (!ctx.store.decideCard(card.cardId, 'approved', ctx.now())) return;
    if (step === 'first_offer') resumers.first_offer(ctx, card.refDigest);
    else if (step === 'counter') resumers.counter(ctx, card.refDigest);
    else if (step === 'concession') resumers.concession(ctx, card.requestId);
    else if (step === 'decision') resumers.decision(ctx, card.refDigest);
    else resumers.proposal(ctx, card.requestId);
  });
  ctx.closeCard(card.cardId, 'persona opened');
  return true;
}

/** The owner declined, or the card lapsed: end the waiting step. */
export function endPersonaWait(
  ctx: TermContext,
  card: TermCardRow,
  state: 'declined' | 'lapsed',
  resumers: PersonaResumers,
): boolean {
  const step = stepOf(card);
  return ctx.atomically('persona_wait_ended', () => {
    if (!ctx.store.decideCard(card.cardId, state, ctx.now())) return false;
    if (step === 'decision') resumers.endDecision(ctx, card.refDigest);
    else if (step === 'proposal') resumers.endProposal(ctx, card.requestId);
    return true;
  });
}
