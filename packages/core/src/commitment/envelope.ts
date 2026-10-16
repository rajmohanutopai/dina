/**
 * The envelope (COMMITMENT_KERNEL §8): one deterministic check in Core
 * before anything is signed, and again at binding. No model takes part; its
 * inputs are the confirmed value model, the structured deal and the owner's
 * live commitments. Conversation and anything an agent says never reach it.
 *
 * Steps, in order (numbers as in §8):
 *   0  size: past the kernel's caps → refused whole;
 *   1  never: a ruled-out part or combination, a price to a non-party, or a
 *      number past its hard limit → refused;
 *   2  unvalued: a part with neither a value nor limits → the owner's card;
 *      in a model with no walk-away point, a part with a value but no limits
 *      too, since nothing weighs it against the rest;
 *   3  alternatives: each version is checked on its own (`checkOffer`);
 *   6  worth: below the walk-away point → refused; a part past its automatic
 *      limit (and not authorised by the owner) → card; at or above the
 *      auto-sign worth → Core may sign; otherwise → card;
 *   8  totals: past what Dina may commit alone in the period → card;
 *   9  capacity: the deal must fit beside live agreements → refused if not
 *      (the caller runs it again in the transaction that binds);
 *   and a deal touching an entry of a closed or locked persona → card.
 *
 * Steps 4 (conditions), 5 (dependent deals) and 7 (disclosure) are added by
 * the phases that bring those structures (§15).
 *
 * AT BINDING after the owner approved in person (a kind subject to a card),
 * only the hard checks run: never-rules, hard limits, the walk-away point,
 * capacity, and closed or locked entries (§8, "A yes that fails at binding").
 *
 * The verdict's reasons are for the owner's card; the other side only ever
 * gets the uniform refusal.
 *
 * PURE: no I/O, no clock.
 */

import { atLeastFor, type PartyRole } from './parts';
import {
  isLimitOnly,
  monthlyCommitment,
  partWorth,
  type DealPart,
  type DealVersion,
  type ModelVocabulary,
  type NeverCondition,
  type ValueModel,
} from './value_model';

/** The kernel's caps on a deal's shape (§8 step 0). */
export const ENVELOPE_CAPS = { versions: 8, parts: 32, promiseDimensions: 12 } as const;

export type EnvelopeReason =
  | 'too_large'
  | 'never_rule'
  | 'price_to_non_party'
  | 'unknown_part'
  | 'past_hard_limit'
  | 'below_walk_away'
  | 'no_room'
  | 'unvalued_part'
  /** A part has a value but no limits and the model no walk-away point: nothing weighs it (§7). */
  | 'needs_walk_away'
  | 'past_auto_limit'
  | 'below_auto_sign'
  | 'past_total'
  | 'persona_closed';

export type EnvelopeVerdict =
  /** No card can make this bind. */
  | {
      outcome: 'refused';
      reason: EnvelopeReason;
      /** For the owner's card only: may hold the owner's own words. */
      detail: string;
      /** The parts a never-rule constrains: all a strategy may be told (§11). */
      parts?: string[];
    }
  /** The owner decides. `reasons` lists every soft cause, for the card. */
  | { outcome: 'card'; reasons: EnvelopeReason[]; worth: bigint | null }
  /** Core may sign alone. */
  | { outcome: 'sign'; worth: bigint | null };

export interface EnvelopeInput {
  model: ValueModel;
  vocabulary: ModelVocabulary;
  /** The party the model belongs to. */
  holder: PartyRole;
  version: DealVersion;
  /** Values the owner authorised on earlier cards (limit-only models). */
  authorised?: ReadonlyMap<string, bigint>;
  /** Rupees a month Dina already committed alone this period: overall, and with this counterparty. */
  committed?: { overall: bigint; withCounterparty: bigint };
  /** Does the deal fit beside live agreements, holds and promised capacity? */
  fits?: () => boolean;
  /** Personas holding entries this deal touches that are closed or locked now. */
  closedPersonas?: readonly string[];
  /** The owner approved in person: only the hard checks run. */
  approvedInPerson?: boolean;
}

function holds(condition: NeverCondition, part: DealPart | undefined): boolean {
  if (part === undefined) return false;
  if ('present' in condition) return true;
  if ('flag' in condition) return part.kind === 'flag' && part.set === condition.flag;
  if ('choice' in condition) return part.kind === 'choice' && part.option === condition.choice;
  if (part.kind !== 'number') return false;
  return 'below' in condition ? part.value < condition.below : part.value > condition.above;
}

function refused(reason: EnvelopeReason, detail: string): EnvelopeVerdict {
  return { outcome: 'refused', reason, detail };
}

/** Check one version of a deal. */
export function checkVersion(input: EnvelopeInput): EnvelopeVerdict {
  const { model, vocabulary, holder, version } = input;
  const authorised = input.authorised ?? new Map<string, bigint>();

  // 0 — size.
  if (version.parts.length > ENVELOPE_CAPS.parts) return refused('too_large', 'too many parts');
  for (const part of version.parts) {
    if (
      part.kind === 'promise' &&
      Object.keys(part.dimensions).length > ENVELOPE_CAPS.promiseDimensions
    )
      return refused('too_large', `${part.name}: too many dimensions`);
  }
  const byName = new Map<string, DealPart>();
  for (const part of version.parts) {
    if (byName.has(part.name)) return refused('unknown_part', `${part.name}: named twice`);
    byName.set(part.name, part);
  }

  // 1 — never.
  for (const part of version.parts) {
    if (part.kind === 'price_to_non_party')
      return refused('price_to_non_party', `${part.name}: a price for someone outside the deal`);
    if (part.kind === 'choice') {
      const allowed = vocabulary.choices[part.name];
      if (allowed === undefined || !allowed.includes(part.option))
        return refused('unknown_part', `${part.name}: not an allowed option`);
    }
    if (part.kind === 'flag' && !vocabulary.flags.includes(part.name))
      return refused('unknown_part', `${part.name}: not a flag this vocabulary has`);
    if (part.kind === 'number') {
      const spec = vocabulary.numbers.find((s) => s.name === part.name);
      if (spec === undefined)
        return refused('unknown_part', `${part.name}: not a part this vocabulary has`);
      const bounds = model.limits[part.name];
      if (bounds !== undefined && !atLeastFor(spec, holder, part.value, bounds.hard))
        return refused('past_hard_limit', `${part.name}: past its hard limit`);
    }
  }
  for (const rule of model.never) {
    if (rule.all.length > 0 && rule.all.every((c) => holds(c, byName.get(c.part))))
      return {
        outcome: 'refused',
        reason: 'never_rule',
        detail: rule.label,
        parts: [...new Set(rule.all.map((c) => c.part))],
      };
  }

  // Worth, from the parts the model values.
  let worth = 0n;
  const unvalued: string[] = [];
  const unweighed: string[] = [];
  const pastAuto: string[] = [];
  const limitOnly = isLimitOnly(model);
  for (const part of version.parts) {
    const { worth: w, limitGoverned } = partWorth(model, vocabulary, holder, part, version.months);
    if (part.kind === 'number' && limitGoverned) {
      const spec = vocabulary.numbers.find((s) => s.name === part.name);
      const bounds = model.limits[part.name];
      if (
        spec !== undefined &&
        bounds !== undefined &&
        !atLeastFor(spec, holder, part.value, bounds.auto)
      ) {
        const ok = authorised.get(part.name);
        // An owner-authorised value covers this part if the deal is no worse.
        if (ok === undefined || !atLeastFor(spec, holder, part.value, ok)) pastAuto.push(part.name);
      }
    }
    if (w === null || (limitOnly && !limitGoverned)) {
      // A limit-only model has no values: a part with no limits is unvalued.
      // In a model with values, money with no rupee value (another currency)
      // is unvalued even with limits: worth would leave it out (§7). A ratio
      // stays a per-part limit (a store has no sales figure to value it).
      const noRupees =
        !limitOnly &&
        part.kind === 'number' &&
        vocabulary.numbers.find((s) => s.name === part.name)?.kind === 'money';
      if (!limitGoverned || noRupees) unvalued.push(part.name);
      continue;
    }
    // In a model with no walk-away point, a valued part with no limits has
    // nothing to weigh it against: the owner decides (§7).
    if (model.walkAway === undefined && !limitGoverned && part.kind !== 'number')
      unweighed.push(part.name);
    worth += w;
  }

  // 6 (hard half) — the walk-away point. Not on a partial worth: a deal with
  // an unvalued part goes to the owner whole (§7, §8 step 2).
  if (model.walkAway !== undefined && unvalued.length === 0 && worth < model.walkAway)
    return refused('below_walk_away', 'worth below the walk-away point');

  // 9 — capacity.
  if (input.fits !== undefined && !input.fits())
    return refused('no_room', 'does not fit beside live deals');

  const closed = input.closedPersonas ?? [];
  if (input.approvedInPerson === true) {
    // The owner approved in person: a still-closed entry is a hard failure.
    if (closed.length > 0) return refused('persona_closed', `closed: ${closed.join(', ')}`);
    return { outcome: 'sign', worth: limitOnly ? null : worth };
  }

  const reasons: EnvelopeReason[] = [];
  if (closed.length > 0) reasons.push('persona_closed');
  // 2 — unvalued.
  if (unvalued.length > 0) reasons.push('unvalued_part');
  if (unweighed.length > 0) reasons.push('needs_walk_away');
  // 6 (soft half).
  if (pastAuto.length > 0) reasons.push('past_auto_limit');
  if (!limitOnly && (model.autoSign === undefined || worth < model.autoSign))
    reasons.push('below_auto_sign');
  // 8 — totals.
  const committed = input.committed;
  if (committed !== undefined) {
    const adds = monthlyCommitment(vocabulary, holder, version);
    const { overall, perCounterparty } = model.totals;
    if (
      (overall !== undefined && committed.overall + adds > overall) ||
      (perCounterparty !== undefined && committed.withCounterparty + adds > perCounterparty)
    )
      reasons.push('past_total');
  }
  const shown = limitOnly ? null : worth;
  return reasons.length > 0
    ? { outcome: 'card', reasons, worth: shown }
    : { outcome: 'sign', worth: shown };
}

/**
 * Check an offer with alternatives (§8 step 3): each version on its own.
 * Past the version cap the whole offer is refused, never cut down.
 */
export function checkOffer(
  input: Omit<EnvelopeInput, 'version'> & { versions: readonly DealVersion[] },
): EnvelopeVerdict[] | { outcome: 'refused'; reason: 'too_large'; detail: string } {
  if (input.versions.length === 0 || input.versions.length > ENVELOPE_CAPS.versions)
    return { outcome: 'refused', reason: 'too_large', detail: 'versions outside the cap' };
  return input.versions.map((version) => checkVersion({ ...input, version }));
}
