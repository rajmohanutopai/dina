/**
 * The strategy slot (COMMITMENT_KERNEL §11): what a strategy may return, what
 * Core answers, what Brain may see, and what goes out on its own.
 *
 *   - MOVES: a proposal (one or more versions, and a note explaining it); a
 *     question for the other side; a question for the owner; or "stop".
 *   - VERDICTS are acts, never dry runs: `sign` (Core signs and sends),
 *     `needs_owner` (a card is raised and the strategy waits), `refused`
 *     (naming the part only when a never-rule caused it; "not enough" when
 *     worth or a per-part limit did).
 *   - THE ONE PROJECTION: everything Brain sees about a commitment leaves out
 *     the walk-away point, the comfort zone, per-part limits, totals and,
 *     before the first offer, asking terms; and values and costs when the
 *     owner switched them off for the kind or they sit in a persona Brain may
 *     not read now.
 *   - WHAT GOES OUT ON ITS OWN: messages Core renders from a fixed set of
 *     kinds, filled only with parts already on the table. A strategy's own
 *     words go out only after the owner reads them and says yes.
 *
 * PURE: no I/O, no clock.
 */

import type { EnvelopeVerdict } from './envelope';
import type { DealPart, DealVersion, ValueModel } from './value_model';

// ---------------------------------------------------------------------------
// Moves and verdicts
// ---------------------------------------------------------------------------

/** The fixed kinds of message Core renders and may send on its own. */
export type MessageKind =
  | 'ask_about_part'
  | 'explain_change'
  | 'offer_version'
  | 'decline'
  | 'stop';

export type StrategyMove =
  | { kind: 'propose'; versions: readonly DealVersion[]; note?: string }
  | { kind: 'ask_other'; message: MessageKind; part?: string }
  | { kind: 'ask_owner'; question: string }
  | { kind: 'stop' };

export type StrategyVerdict =
  | { outcome: 'sign' }
  | { outcome: 'needs_owner' }
  /** The parts only, for a never-rule (never the owner's wording); otherwise "not enough". */
  | { outcome: 'refused'; reason: 'never_rule'; parts: string[] }
  | { outcome: 'refused'; reason: 'not_enough' };

/**
 * What the strategy is told about one version's envelope verdict. It learns
 * which side of a threshold the version fell, and nothing more: the
 * threshold's value, the walk-away point and the limits stay in Core.
 */
export function strategyVerdict(verdict: EnvelopeVerdict): StrategyVerdict {
  if (verdict.outcome === 'sign') return { outcome: 'sign' };
  if (verdict.outcome === 'card') return { outcome: 'needs_owner' };
  return verdict.reason === 'never_rule'
    ? { outcome: 'refused', reason: 'never_rule', parts: verdict.parts ?? [] }
    : { outcome: 'refused', reason: 'not_enough' };
}

// ---------------------------------------------------------------------------
// Messages Core renders
// ---------------------------------------------------------------------------

/**
 * Render a message from a fixed kind, filled only with parts already on the
 * table. Null when the message names a part that is not on it: Core sends no
 * text it cannot vouch for.
 */
export function renderMessage(
  kind: MessageKind,
  table: readonly DealPart[],
  part?: string,
  versionId?: string,
): string | null {
  const onTable = part === undefined || table.some((p) => p.name === part);
  if (!onTable) return null;
  switch (kind) {
    case 'ask_about_part':
      return part === undefined ? null : `Could you move on ${part}?`;
    case 'explain_change':
      return part === undefined ? null : `This version changes ${part}.`;
    case 'offer_version':
      return versionId === undefined ? null : `Here is another version: ${versionId}.`;
    case 'decline':
      return 'This does not work for us.';
    case 'stop':
      return 'We will stop here.';
  }
}

/** A strategy's own words: they go out only after the owner reads them and says yes. */
export function needsOwnerYes(move: StrategyMove): boolean {
  if (move.kind === 'ask_owner') return false; // to the owner, not out
  if (move.kind === 'propose') return move.note !== undefined && move.note.length > 0;
  return false;
}

// ---------------------------------------------------------------------------
// Verdict budgets
// ---------------------------------------------------------------------------

/**
 * Budgets on the verdicts a strategy's own proposals draw (§11): a small
 * number per negotiation, and one per owner for each threshold that no new
 * negotiation or counterparty resets. The owner's refills at a set rate each
 * month, and again when the owner changes the threshold.
 */
export interface BudgetRules {
  perNegotiation: number;
  perOwnerMonthly: number;
}

export const DEFAULT_BUDGET_RULES: BudgetRules = { perNegotiation: 12, perOwnerMonthly: 60 };

export interface BudgetState {
  /** Verdicts drawn in this negotiation. */
  negotiation: number;
  /** Verdicts left for the owner on this threshold, and when it last refilled. */
  ownerLeft: number;
  ownerRefilledAtMs: number;
  /** The model version the owner's budget was last refilled for. */
  thresholdVersion: number;
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** Refill the owner's budget for elapsed months, or at once for a changed threshold. */
export function refill(
  state: BudgetState,
  rules: BudgetRules,
  nowMs: number,
  thresholdVersion: number,
): BudgetState {
  if (thresholdVersion !== state.thresholdVersion)
    return {
      ...state,
      ownerLeft: rules.perOwnerMonthly,
      ownerRefilledAtMs: nowMs,
      thresholdVersion,
    };
  const months = Math.floor((nowMs - state.ownerRefilledAtMs) / MONTH_MS);
  if (months <= 0) return state;
  return {
    ...state,
    ownerLeft: Math.min(rules.perOwnerMonthly, state.ownerLeft + months * rules.perOwnerMonthly),
    ownerRefilledAtMs: state.ownerRefilledAtMs + months * MONTH_MS,
  };
}

/**
 * Charge `count` verdicts (each version of an offer counts as one). Refused
 * when either budget cannot cover it: the strategy is then replaced by the
 * pack's fixed style, and the owner told.
 */
export function charge(
  state: BudgetState,
  rules: BudgetRules,
  count: number,
): { ok: true; state: BudgetState } | { ok: false; spent: 'negotiation' | 'owner' } {
  if (state.negotiation + count > rules.perNegotiation) return { ok: false, spent: 'negotiation' };
  if (state.ownerLeft < count) return { ok: false, spent: 'owner' };
  return {
    ok: true,
    state: { ...state, negotiation: state.negotiation + count, ownerLeft: state.ownerLeft - count },
  };
}

// ---------------------------------------------------------------------------
// The one projection
// ---------------------------------------------------------------------------

export interface BriefSettings {
  /** The owner's switch for this kind of deal (§16 item 3): values and costs in Brain's brief. */
  valuesOn: boolean;
  /** Has the deal's first offer gone out? Before it, asking terms stay in Core. */
  firstOfferOut: boolean;
}

/**
 * The part of the owner's model a strategy may see: values for choices,
 * flags and promises (only when the owner switched values on), and which
 * parts the owner's never-rules constrain — the part names only, never the
 * owner's wording, which may state a figure ("no rent under ₹2,000" is a hard
 * limit in words). Never the walk-away point, the auto-sign worth, per-part
 * limits or totals. The caller passes a model holding only entries Brain may
 * read now (untagged, and default or standard personas that are open).
 */
export interface ModelBrief {
  values?: {
    choices: Readonly<Record<string, Readonly<Record<string, string>>>>;
    flags: Readonly<Record<string, { set: string; unset: string }>>;
    promises: Readonly<
      Record<string, readonly { dimensions: Readonly<Record<string, string>>; rupees: string }[]>
    >;
  };
  constrained: readonly string[];
}

const str = (v: bigint): string => v.toString(10);

export function projectModel(model: ValueModel, settings: BriefSettings): ModelBrief {
  const constrained = [...new Set(model.never.flatMap((r) => r.all.map((c) => c.part)))].sort();
  const brief: ModelBrief = { constrained };
  if (!settings.valuesOn) return brief;
  const choices: Record<string, Record<string, string>> = {};
  for (const [part, options] of Object.entries(model.choiceValues))
    choices[part] = Object.fromEntries(Object.entries(options).map(([o, v]) => [o, str(v)]));
  const flags: Record<string, { set: string; unset: string }> = {};
  for (const [part, v] of Object.entries(model.flagValues))
    flags[part] = { set: str(v.set), unset: str(v.unset) };
  const promises: Record<string, { dimensions: Record<string, string>; rupees: string }[]> = {};
  for (const [part, values] of Object.entries(model.promiseValues))
    promises[part] = values.map((v) => ({
      dimensions: Object.fromEntries(Object.entries(v.dimensions).map(([d, x]) => [d, String(x)])),
      rupees: str(v.rupees),
    }));
  return { ...brief, values: { choices, flags, promises } };
}

/** Field names that must never appear in anything projected to Brain. */
export const NEVER_PROJECTED = [
  'walkAway',
  'walk_away',
  'autoSign',
  'auto_sign',
  'limits',
  'totals',
  'asking',
] as const;

/** Does a projected object carry any withheld field, at any depth? (For tests and a last guard.) */
export function carriesWithheld(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(carriesWithheld);
  for (const [k, v] of Object.entries(value)) {
    if ((NEVER_PROJECTED as readonly string[]).includes(k)) return true;
    if (carriesWithheld(v)) return true;
  }
  return false;
}
