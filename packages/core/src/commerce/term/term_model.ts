/**
 * Shelf deals through the kernel's envelope (COMMITMENT_KERNEL §7, §8; §15
 * step 2). Shelf floors and the brand's ceilings stay where the owner enters
 * them — per resource on the store's shelf policy, per negotiation on the
 * brand's — and become the per-part limits of a limit-only model. The kind's
 * own model (`shelf_space.host` / `shelf_space.vendor`) adds what the shelf
 * forms have no place for: never-rules, and entries kept in personas.
 *
 * With no entries for the kind, the envelope's verdict matches today's
 * checks exactly: within the automatic limits Core signs; past the hard
 * limit nothing signs; the owner's in-person yes runs only the hard checks.
 */

import {
  partsOnOffer,
  TERM_MESSAGE_KINDS,
  TERM_NAMES,
  termValues,
  type Term,
  type TermMessage,
  type TermOffer,
  type TermGeneral,
  type TermName,
  type TermPromise,
} from '@dina/commerce-protocol';

import {
  bindingCard,
  checkVersion,
  type BindingCard,
  type DealPart,
  type EnvelopeVerdict,
  type PartBounds,
  type PartyRole,
  type StrategyMove,
  type ValueModel,
} from '../../commitment';
import { SHELF_VOCABULARY } from '../deal_kinds';
import { SLOT_PACK_PROMISES } from '../slot_pack_manifests';

import type { TermContext } from './term_context';

export const SHELF_HOST_KIND = 'shelf_space.host';
export const SHELF_VENDOR_KIND = 'shelf_space.vendor';

/** Whole months the deal runs, at least one: for spreading one-off amounts. */
function wholeMonths(general: TermGeneral): number {
  const days = (Date.parse(general.end) - Date.parse(general.start)) / 86_400_000;
  return Math.max(1, Math.floor(days / 30));
}

/** A promise as the kernel's part: ordered dimensions as numbers, the rest as words. */
export function promisePart(promise: TermPromise): DealPart {
  const declared = SLOT_PACK_PROMISES[promise.name]?.dimensions ?? {};
  const dimensions: Record<string, string | bigint> = {};
  for (const [d, v] of Object.entries(promise.dimensions))
    dimensions[d] = declared[d]?.order === 'exact' || !/^\d+$/.test(v) ? v : BigInt(v);
  return { kind: 'promise', name: promise.name, dimensions, by: promise.by };
}

/** The shelf terms, and any promises of the version, as the kernel's deal parts. */
export function shelfParts(
  terms: readonly Term[],
  general: TermGeneral,
  promises: readonly TermPromise[] = [],
): DealPart[] {
  const values = termValues(terms);
  const numbers = TERM_NAMES.map(
    (name): DealPart =>
      name === 'fee'
        ? {
            kind: 'number',
            name,
            value: values[name],
            currency: general.currency,
            per: general.period === 'weekly' ? 'week' : 'month',
          }
        : { kind: 'number', name, value: values[name] },
  );
  return [...numbers, ...promises.map(promisePart)];
}

/** Who keeps each promise of a version, for the binding card. */
export function promisers(promises: readonly TermPromise[]): Record<string, PartyRole> {
  return Object.fromEntries(promises.map((p) => [p.name, p.by]));
}

/**
 * Core's sections of a binding shelf card (§9): what binds, where the risk
 * is, and what changed since the version the owner last saw.
 */
export function shelfBindingCard(args: {
  holder: PartyRole;
  terms: readonly Term[];
  promises?: readonly TermPromise[];
  general: TermGeneral;
  previous?: { terms: readonly Term[]; promises?: readonly TermPromise[] };
  /** From the owner's model, when it has values: owner's copy only (§9, §11). */
  worth?: bigint;
  walkAway?: bigint;
  worthUnknown?: true;
}): BindingCard {
  const promises = args.promises ?? [];
  const months = wholeMonths(args.general);
  const notice = args.general.exit_notice_days;
  return bindingCard({
    vocabulary: SHELF_VOCABULARY,
    labels: {},
    holder: args.holder,
    other: args.holder === 'seller' ? 'the brand' : 'the store',
    version: { parts: shelfParts(args.terms, args.general, promises), months },
    promisers: promisers(promises),
    ...(args.previous !== undefined
      ? {
          previous: {
            parts: shelfParts(args.previous.terms, args.general, args.previous.promises ?? []),
            months,
          },
        }
      : {}),
    ending: `Either side may end it with ${String(notice)} days’ notice; it ends on ${args.general.end.slice(0, 10)}.`,
    ...(args.worth !== undefined ? { worth: args.worth } : {}),
    ...(args.walkAway !== undefined ? { walkAway: args.walkAway } : {}),
    ...(args.worthUnknown === true ? { worthUnknown: true } : {}),
  });
}

/**
 * Run the envelope on shelf terms for one side. `approvedInPerson` is the
 * owner's yes on a card: then only the hard checks run.
 */
export function shelfEnvelope(
  ctx: TermContext,
  args: {
    kind: typeof SHELF_HOST_KIND | typeof SHELF_VENDOR_KIND;
    holder: PartyRole;
    limits: Record<TermName, PartBounds>;
    terms: readonly Term[];
    promises?: readonly TermPromise[];
    general: TermGeneral;
    approvedInPerson: boolean;
    authorised?: ReadonlyMap<string, bigint>;
  },
): EnvelopeVerdict {
  const touches = [...TERM_NAMES, ...(args.promises ?? []).map((p) => p.name)];
  const loaded = ctx.deps.valueModels?.(args.kind, touches) ?? null;
  const base: ValueModel = loaded?.model ?? {
    kind: args.kind,
    version: 0,
    limits: {},
    choiceValues: {},
    flagValues: {},
    promiseValues: {},
    never: [],
    totals: {},
  };
  return checkVersion({
    model: { ...base, limits: args.limits },
    vocabulary: SHELF_VOCABULARY,
    holder: args.holder,
    version: {
      parts: shelfParts(args.terms, args.general, args.promises ?? []),
      months: wholeMonths(args.general),
    },
    approvedInPerson: args.approvedInPerson,
    ...(args.authorised !== undefined ? { authorised: args.authorised } : {}),
    ...(loaded !== null && loaded.closedPersonas.length > 0
      ? { closedPersonas: loaded.closedPersonas }
      : {}),
  });
}

/**
 * What the owner's model makes of a version, for the binding card: its worth
 * and the walk-away point, when the model has values (owner's copy only). A
 * part the model cannot value makes the worth unknown, never a subtotal.
 */
export function shelfWorth(
  ctx: TermContext,
  args: Omit<Parameters<typeof shelfEnvelope>[1], 'approvedInPerson' | 'authorised'>,
): { worth?: bigint; walkAway?: bigint; worthUnknown?: true } {
  const verdict = shelfEnvelope(ctx, { ...args, approvedInPerson: false });
  if (verdict.outcome === 'refused' || verdict.worth === null) return {};
  if (verdict.outcome === 'card' && verdict.reasons.includes('unvalued_part'))
    return { worthUnknown: true };
  const walkAway = ctx.deps.valueModels?.(args.kind, [])?.model.walkAway;
  return { worth: verdict.worth, ...(walkAway !== undefined ? { walkAway } : {}) };
}

/**
 * Does the envelope stop Core signing these terms alone? Any refusal, and any
 * card reason but an automatic limit: those the limit-only clamp already
 * handles, with the floor card (§7, "Limit-only models").
 */
export function shelfSigningBlocked(verdict: EnvelopeVerdict): boolean {
  if (verdict.outcome === 'refused') return true;
  return verdict.outcome === 'card' && verdict.reasons.some((r) => r !== 'past_auto_limit');
}

export const TERM_STRATEGY_CARD = 'term_strategy_fallback';

/** Tell the owner, once per negotiation, that the fixed style took over (§11). */
export function raiseStrategyNotice(
  ctx: TermContext,
  requestId: string,
  spent: 'negotiation' | 'owner',
): void {
  const cardId = `term-strategy-${requestId}`.slice(0, 64);
  ctx.raiseCard({
    cardId,
    type: TERM_STRATEGY_CARD,
    requestId,
    refDigest: requestId,
    description:
      spent === 'owner'
        ? 'Brain has used its turns for shelf deals this month. Dina bargains in its fixed style until they refill.'
        : 'Brain has used its turns for this shelf deal. Dina bargains in its fixed style for the rest of it.',
    payload: { type: TERM_STRATEGY_CARD, card_id: cardId, request_id: requestId, spent },
    decideBy: ctx.now() + 7 * 24 * 60 * 60 * 1000,
  });
}

/**
 * Is there budget for Brain to take this round? When not, the fixed style
 * plays it without Brain being asked, and the owner is told once.
 */
export function strategyBudgetLeft(ctx: TermContext, kind: string, requestId: string): boolean {
  const strategy = ctx.deps.strategy;
  if (strategy === undefined) return false;
  const left = strategy.canSpend({
    kind,
    negotiationId: requestId,
    nowMs: ctx.now(),
    thresholdVersion: ctx.deps.valueModels?.(kind, [])?.model.version ?? 0,
  });
  if (!left.ok) raiseStrategyNotice(ctx, requestId, left.spent);
  return left.ok;
}

/** A strategy's message, if the wire carries it and its part is on the table. */
export function tableMessage(move: StrategyMove, head: TermOffer): TermMessage | null {
  if (move.kind !== 'ask_other' || move.part === undefined) return null;
  if (!(TERM_MESSAGE_KINDS as readonly string[]).includes(move.message)) return null;
  if (!partsOnOffer(head).includes(move.part)) return null;
  return { kind: move.message as TermMessage['kind'], part: move.part };
}
