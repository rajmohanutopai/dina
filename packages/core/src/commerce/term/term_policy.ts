/**
 * The seller's term policy (SHELF_SPACE_NEGOTIATION §5.4) — what a store
 * offers, the floors it never goes past, and the holding rules — plus the
 * pure arithmetic Core applies to every offer: the holding premium and the
 * per-term clamp.
 *
 * OWNER-ONLY AND CORE-ENFORCED. The policy is set through a presence-gated
 * owner route and is off every integration allowlist, so no connector or
 * plugin can move a floor. A runner proposes terms; this module decides what
 * Core may sign. No refusal or answer ever names a floor.
 *
 * DIRECTION AND ARITHMETIC ARE THE KERNEL'S. Each term is a part of the
 * Slot Pack's vocabulary (`SLOT_PACK_PARTS`), and its direction comes from
 * who pays it (COMMITMENT_KERNEL §6). The premium and the clamp are the
 * kernel's per-part limits (`commitment/limits.ts`); this module names the
 * store as the holder and keeps the shelf-specific rules around them.
 */

import {
  isCurrencyCode,
  MAX_BPS,
  MAX_EXIT_NOTICE_DAYS,
  MAX_MONEY_MINOR_UNIT_DIGITS,
  MAX_STOCK_DUTY,
  TERM_NAMES,
  MAX_TERM_ALTERNATIVES,
  TERM_PERIODS,
  validateCanonicalInteger,
  validateTermPromise,
  validateId,
  validateIsoUtc,
  type CashHandler,
  type TermName,
  type TermPeriod,
  type TermPromise,
} from '@dina/commerce-protocol';

import { applyPremium, atLeastFor, type NumberPartSpec, type PartBounds } from '../../commitment';
import { SLOT_PACK_PARTS, SLOT_PACK_PROMISES } from '../slot_pack_manifests';

const PARTS = new Map<string, NumberPartSpec>(SLOT_PACK_PARTS.map((part) => [part.name, part]));

/** The terms as the Slot Pack's parts, in table order (boundary-tested). */
export const TERM_PARTS: readonly NumberPartSpec[] = SLOT_PACK_PARTS;

/** The Slot Pack's part for a term. Every table term is one (boundary-tested). */
export function termPart(name: TermName): NumberPartSpec {
  const part = PARTS.get(name);
  if (part === undefined) throw new Error(`term ${name} is not a part of the Slot Pack`);
  return part;
}

/** The buyer's side of a term: is `a` at least as good for the buyer as `b`? */
export function buyerAtLeast(name: TermName, a: bigint, b: bigint): boolean {
  return atLeastFor(termPart(name), 'buyer', a, b);
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface TermFloor {
  /** Never signed past, ever. */
  hard: string;
  /** The furthest Core signs alone; between auto and hard needs the owner. */
  auto?: string;
}

/**
 * The conditions a store sets on its offers for a resource (the §5.2
 * general block minus what the buyer asks for). Not named in the spec's
 * policy shape; a store has to say them somewhere, and the offer fixes them.
 */
export interface TermOfferConditions {
  period: TermPeriod;
  cash_handler: CashHandler;
  trial?: { days: number; fee_minor: string };
  exit_notice_days: number;
  stock_duties?: { min_skus?: number; restock_days?: number };
}

export interface TermResourcePolicy {
  resource_ref: string;
  currency: string;
  /** Private: where offers start. Never published. */
  asking: Record<TermName, string>;
  floors: Record<TermName, TermFloor>;
  available: { from: string; to: string };
  conditions: TermOfferConditions;
  /**
   * Other versions the owner offers beside the asking terms (COMMITMENT_KERNEL
   * §6, "Alternatives"), entered here, on the presence-gated form: a change to
   * the rent, and the promise it asks for ("₹200 less rent if your run comes
   * on Tuesday"). Each offer carries them, moved with its rent.
   */
  alternatives?: TermPolicyAlternative[];
}

export interface TermPolicyAlternative {
  alternative_id: string;
  /** Added to the offer's rent, minor units; negative lowers it. */
  fee_delta: string;
  promises: TermPromise[];
}

/** Is a promise one the Slot Pack's vocabulary declares, in full? */
export function promiseProblem(promise: TermPromise, field: string): string | null {
  const declared = SLOT_PACK_PROMISES[promise.name];
  if (declared === undefined) return `${field}.name: not a promise of this pack`;
  if (promise.by !== declared.by) return `${field}.by: the pack says ${declared.by} keeps it`;
  const dims = Object.keys(declared.dimensions);
  const given = Object.keys(promise.dimensions);
  if (given.length !== dims.length || dims.some((d) => !(d in promise.dimensions)))
    return `${field}.dimensions: exactly ${dims.join(', ')}`;
  for (const [d, spec] of Object.entries(declared.dimensions)) {
    const v = promise.dimensions[d] as string;
    if (spec.order === 'exact' ? !spec.values.includes(v) : !/^[1-9]\d{0,5}$/.test(v))
      return `${field}.dimensions.${d}: ${spec.order === 'exact' ? spec.values.join(' | ') : 'a whole number'}`;
  }
  return null;
}

export interface TermHoldingRule {
  tag: string;
  max_count?: number;
  premium_bps_per_count: number;
}

export interface TermManualHolding {
  holding_id: string;
  tag: string;
  resource_ref?: string;
  start: string;
  end: string;
}

export interface TermPolicy {
  enabled: boolean;
  resources: TermResourcePolicy[];
  holding_rules: TermHoldingRule[];
  manual_holdings: TermManualHolding[];
  maxRounds: number;
  /** How long a chain stays open to counters, from its first offer. */
  windowSeconds: number;
  maxCountersPerBuyerPerDay: number;
}

/**
 * Who may ask about one listing (§6.2), kept privately on the listing's row
 * here and never in the public record: a contact always may; a stranger needs
 * the owner's card (`contacts_or_card`, the default) or not (`anyone`).
 */
export type TermListingAccess = 'contacts_or_card' | 'anyone';

export const TERM_LISTING_ACCESS: readonly TermListingAccess[] = ['contacts_or_card', 'anyone'];

export const TERM_POLICY_LIMITS = {
  maxRounds: [1, 10],
  // §9 — up to 7 days, so a store whose phone sleeps still answers.
  windowSeconds: [60, 7 * 24 * 60 * 60],
  maxCountersPerBuyerPerDay: [1, 200],
  premiumBps: [0, MAX_BPS],
  maxCount: [1, 1000],
  trialDays: [1, 365],
  resources: [0, 200],
  holdings: [0, 1000],
} as const;

/** §9 — the brand's loop runs at most seven days. */
export const BRAND_DEADLINE_MAX_SECONDS = 7 * 24 * 60 * 60;

export const DEFAULT_TERM_POLICY: TermPolicy = {
  enabled: false,
  resources: [],
  holding_rules: [],
  manual_holdings: [],
  maxRounds: 3,
  windowSeconds: 7 * 24 * 60 * 60,
  maxCountersPerBuyerPerDay: 20,
};

function intIn(
  value: unknown,
  [min, max]: readonly [number, number],
  field: string,
): string | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? null
    : `${field}: must be an integer in [${String(min)}, ${String(max)}]`;
}

function termValue(name: TermName, value: unknown, field: string): string | null {
  if (typeof value !== 'string') return `${field}: must be a canonical integer string`;
  if (termPart(name).kind === 'money') {
    const err = validateCanonicalInteger(value, MAX_MONEY_MINOR_UNIT_DIGITS);
    return err === null ? null : `${field}: ${err}`;
  }
  const err = validateCanonicalInteger(value, 5);
  if (err !== null) return `${field}: ${err}`;
  return BigInt(value) <= BigInt(MAX_BPS) ? null : `${field}: at most ${String(MAX_BPS)}`;
}

/** The seller's side of a term: is `a` at least as good for the seller as `b`? */
export function sellerAtLeast(name: TermName, a: bigint, b: bigint): boolean {
  return atLeastFor(termPart(name), 'seller', a, b);
}

function validateResource(r: unknown, i: number): string | null {
  const f = `resources[${String(i)}]`;
  if (r === null || typeof r !== 'object') return `${f}: must be an object`;
  const res = r as Partial<TermResourcePolicy>;
  const shape =
    validateId(res.resource_ref, `${f}.resource_ref`) ??
    (isCurrencyCode(res.currency)
      ? null
      : `${f}.currency: must be a three-letter uppercase code`) ??
    validateIsoUtc(res.available?.from, `${f}.available.from`) ??
    validateIsoUtc(res.available?.to, `${f}.available.to`);
  if (shape !== null || res.available === undefined) return shape ?? `${f}.available: required`;
  if (Date.parse(res.available.to) <= Date.parse(res.available.from))
    return `${f}.available.to: must follow from`;
  if (res.asking === undefined || res.floors === undefined)
    return `${f}: needs asking terms and floors`;
  for (const name of TERM_NAMES) {
    const ask = termValue(name, res.asking[name], `${f}.asking.${name}`);
    if (ask !== null) return ask;
    const floor = res.floors[name];
    if (floor === undefined) return `${f}.floors.${name}: required`;
    const hard = termValue(name, floor.hard, `${f}.floors.${name}.hard`);
    if (hard !== null) return hard;
    if (floor.auto !== undefined) {
      const auto = termValue(name, floor.auto, `${f}.floors.${name}.auto`);
      if (auto !== null) return auto;
      if (!sellerAtLeast(name, BigInt(floor.auto), BigInt(floor.hard))) {
        return `${f}.floors.${name}: the automatic limit sits between the asking terms and the hard floor`;
      }
    }
  }
  for (const key of Object.keys(res.asking)) {
    if (!(TERM_NAMES as readonly string[]).includes(key)) return `${f}.asking.${key}: not a term`;
  }
  for (const key of Object.keys(res.floors)) {
    if (!(TERM_NAMES as readonly string[]).includes(key)) return `${f}.floors.${key}: not a term`;
  }
  const c = res.conditions;
  if (c === undefined || c === null) return `${f}.conditions: required`;
  const conditions =
    ((TERM_PERIODS as readonly string[]).includes(c.period)
      ? null
      : `${f}.conditions.period: monthly or weekly`) ??
    (c.cash_handler === 'host' || c.cash_handler === 'vendor'
      ? null
      : `${f}.conditions.cash_handler: host or vendor`) ??
    intIn(c.exit_notice_days, [0, MAX_EXIT_NOTICE_DAYS], `${f}.conditions.exit_notice_days`) ??
    (c.trial === undefined
      ? null
      : (intIn(c.trial.days, TERM_POLICY_LIMITS.trialDays, `${f}.conditions.trial.days`) ??
        (validateCanonicalInteger(c.trial.fee_minor, MAX_MONEY_MINOR_UNIT_DIGITS) === null
          ? null
          : `${f}.conditions.trial.fee_minor: must be a canonical integer string`))) ??
    (c.stock_duties === undefined
      ? null
      : ((c.stock_duties.min_skus === undefined
          ? null
          : intIn(
              c.stock_duties.min_skus,
              [1, MAX_STOCK_DUTY],
              `${f}.conditions.stock_duties.min_skus`,
            )) ??
        (c.stock_duties.restock_days === undefined
          ? null
          : intIn(
              c.stock_duties.restock_days,
              [1, MAX_STOCK_DUTY],
              `${f}.conditions.stock_duties.restock_days`,
            ))));
  if (conditions !== null) return conditions;
  if (BigInt(res.asking.fee) === 0n && BigInt(res.asking.share_bps) === 0n) {
    return `${f}.asking: rent and share cannot both be zero`;
  }
  // A rent-only resource (asking share 0, floor share 0) must let the brand hold the takings (§5.6).
  if (BigInt(res.asking.share_bps) === 0n && c.cash_handler !== 'vendor') {
    return `${f}.conditions.cash_handler: a rent-only resource has the vendor hold the takings`;
  }
  if (res.alternatives !== undefined) {
    if (!Array.isArray(res.alternatives) || res.alternatives.length > MAX_TERM_ALTERNATIVES)
      return `${f}.alternatives: at most ${String(MAX_TERM_ALTERNATIVES)}`;
    let last = '';
    for (const [i, alt] of res.alternatives.entries()) {
      const g = `${f}.alternatives[${String(i)}]`;
      const bad =
        validateId(alt?.alternative_id, `${g}.alternative_id`) ??
        (/^(0|-?[1-9]\d{0,14})$/.test(String(alt.fee_delta)) ? null : `${g}.fee_delta: a whole number of minor units`);
      if (bad !== null) return bad;
      if (alt.alternative_id <= last) return `${f}.alternatives: sorted by id, unique`;
      last = alt.alternative_id;
      if (!Array.isArray(alt.promises) || alt.promises.length === 0 || alt.promises.length > 8)
        return `${g}.promises: 1 to 8`;
      for (const [j, promise] of alt.promises.entries()) {
        const h = `${g}.promises[${String(j)}]`;
        const problem = validateTermPromise(promise, h) ?? promiseProblem(promise, h);
        if (problem !== null) return problem;
      }
    }
  }
  return null;
}

/** Validate an owner-submitted policy. Returns the first problem, or null. */
export function validateTermPolicy(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return 'term policy: must be an object';
  const p = value as Partial<TermPolicy>;
  if (typeof p.enabled !== 'boolean') return 'enabled: must be a boolean';
  // Who may ask is set per listing (§6.2), not here.
  if ('access' in p) return 'access: who may ask is set on each listing, not on the policy';
  const limits =
    intIn(p.maxRounds, TERM_POLICY_LIMITS.maxRounds, 'maxRounds') ??
    intIn(p.windowSeconds, TERM_POLICY_LIMITS.windowSeconds, 'windowSeconds') ??
    intIn(
      p.maxCountersPerBuyerPerDay,
      TERM_POLICY_LIMITS.maxCountersPerBuyerPerDay,
      'maxCountersPerBuyerPerDay',
    );
  if (limits !== null) return limits;
  if (!Array.isArray(p.resources) || p.resources.length > TERM_POLICY_LIMITS.resources[1]) {
    return `resources: an array of at most ${String(TERM_POLICY_LIMITS.resources[1])}`;
  }
  const seen = new Set<string>();
  for (const [i, r] of p.resources.entries()) {
    const bad = validateResource(r, i);
    if (bad !== null) return bad;
    if (seen.has(r.resource_ref)) return `resources[${String(i)}].resource_ref: listed twice`;
    seen.add(r.resource_ref);
  }
  if (!Array.isArray(p.holding_rules)) return 'holding_rules: must be an array';
  const tags = new Set<string>();
  for (const [i, rule] of p.holding_rules.entries()) {
    const f = `holding_rules[${String(i)}]`;
    const bad =
      validateId(rule?.tag, `${f}.tag`) ??
      intIn(
        rule.premium_bps_per_count,
        TERM_POLICY_LIMITS.premiumBps,
        `${f}.premium_bps_per_count`,
      ) ??
      (rule.max_count === undefined
        ? null
        : intIn(rule.max_count, TERM_POLICY_LIMITS.maxCount, `${f}.max_count`));
    if (bad !== null) return bad;
    if (tags.has(rule.tag)) return `${f}.tag: one rule per tag`;
    tags.add(rule.tag);
  }
  if (
    !Array.isArray(p.manual_holdings) ||
    p.manual_holdings.length > TERM_POLICY_LIMITS.holdings[1]
  ) {
    return `manual_holdings: an array of at most ${String(TERM_POLICY_LIMITS.holdings[1])}`;
  }
  const ids = new Set<string>();
  for (const [i, h] of p.manual_holdings.entries()) {
    const f = `manual_holdings[${String(i)}]`;
    const bad =
      validateId(h?.holding_id, `${f}.holding_id`) ??
      validateId(h.tag, `${f}.tag`) ??
      (h.resource_ref === undefined ? null : validateId(h.resource_ref, `${f}.resource_ref`)) ??
      validateIsoUtc(h.start, `${f}.start`) ??
      validateIsoUtc(h.end, `${f}.end`);
    if (bad !== null) return bad;
    if (Date.parse(h.end) <= Date.parse(h.start)) return `${f}.end: must follow start`;
    // §5.4 — a manual holding that occupies a resource must name one of this store's own.
    if (h.resource_ref !== undefined && !seen.has(h.resource_ref)) {
      return `${f}.resource_ref: not one of this store's resources`;
    }
    if (ids.has(h.holding_id)) return `${f}.holding_id: listed twice`;
    ids.add(h.holding_id);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/**
 * Move a value in the SELLER's favour by `count × premiumBps`, rounding once
 * in the seller's favour; bps terms are capped at 10,000 (§5.4).
 */
export function applyHoldingPremium(
  name: TermName,
  value: bigint,
  count: number,
  premiumBps: number,
): bigint {
  return applyPremium(termPart(name), 'seller', value, count, premiumBps);
}

/** One term's floors after the holding premium. */
export type TermBounds = PartBounds;

export function termBounds(
  resource: TermResourcePolicy,
  name: TermName,
  heldCount: number,
  premiumBps: number,
): TermBounds {
  const floor = resource.floors[name];
  const hard = applyHoldingPremium(name, BigInt(floor.hard), heldCount, premiumBps);
  const auto = applyHoldingPremium(name, BigInt(floor.auto ?? floor.hard), heldCount, premiumBps);
  return { hard, auto };
}

// ---------------------------------------------------------------------------
// The brand's policy (§8)
// ---------------------------------------------------------------------------

export interface TermBuyerPolicy {
  currency: string;
  targets: Record<TermName, string>;
  ceilings: Record<TermName, string>;
  /** Expected gross sales per period, minor units — enables ranking (§8). */
  expected_sales_minor?: string;
  /**
   * The period the money above is per: `targets.fee`, `ceilings.fee` and
   * `expected_sales_minor`. Monthly when absent. A store may offer weekly
   * rent; the loop restates these in the offer's period (`buyerMoneyIn`)
   * before comparing, so a weekly rent is never held against a monthly limit.
   */
  period?: TermPeriod;
  max_rounds: number;
  deadline_seconds: number;
  /** The agreement this negotiation renews, if any (§5.5). */
  renews?: string;
}

/**
 * A per-period amount from the brand's policy, restated in another period.
 * A year is 12 months or 52 weeks; the result rounds down, which for a limit
 * is the brand's safe side — its Dina never accepts more than the owner said.
 */
export function buyerMoneyIn(amount: bigint, from: TermPeriod, to: TermPeriod): bigint {
  if (from === to) return amount;
  return from === 'monthly' ? (amount * 12n) / 52n : (amount * 52n) / 12n;
}

/** The brand's targets or ceilings in an offer's period: money converted, shares as they are. */
export function buyerLimitsIn(
  policy: TermBuyerPolicy,
  which: 'targets' | 'ceilings',
  period: TermPeriod,
): Record<TermName, bigint> {
  const out = {} as Record<TermName, bigint>;
  for (const name of TERM_NAMES) {
    const value = BigInt(policy[which][name]);
    out[name] =
      termPart(name).kind === 'money'
        ? buyerMoneyIn(value, policy.period ?? 'monthly', period)
        : value;
  }
  return out;
}

export function validateTermBuyerPolicy(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return 'policy: must be an object';
  const p = value as Partial<TermBuyerPolicy>;
  if (!isCurrencyCode(p.currency)) return 'currency: must be a three-letter uppercase code';
  if (p.targets === undefined || p.ceilings === undefined) return 'targets and ceilings: required';
  for (const name of TERM_NAMES) {
    const bad =
      termValue(name, p.targets[name], `targets.${name}`) ??
      termValue(name, p.ceilings[name], `ceilings.${name}`);
    if (bad !== null) return bad;
    // A target the ceiling does not allow could never be met.
    if (!buyerAtLeast(name, BigInt(p.targets[name]), BigInt(p.ceilings[name]))) {
      return `targets.${name}: must be within the ceiling`;
    }
  }
  if (
    p.expected_sales_minor !== undefined &&
    validateCanonicalInteger(p.expected_sales_minor, MAX_MONEY_MINOR_UNIT_DIGITS) !== null
  ) {
    return 'expected_sales_minor: must be a canonical integer string';
  }
  if (
    typeof p.max_rounds !== 'number' ||
    !Number.isInteger(p.max_rounds) ||
    p.max_rounds < 0 ||
    p.max_rounds > 10
  ) {
    return 'max_rounds: an integer in [0, 10]';
  }
  const maxSeconds = BRAND_DEADLINE_MAX_SECONDS;
  if (
    typeof p.deadline_seconds !== 'number' ||
    !Number.isInteger(p.deadline_seconds) ||
    p.deadline_seconds < 60 ||
    p.deadline_seconds > maxSeconds
  ) {
    return `deadline_seconds: an integer in [60, ${String(maxSeconds)}]`;
  }
  if (p.renews !== undefined && !/^[0-9a-f]{64}$/.test(p.renews))
    return 'renews: must be an agreement digest';
  if (p.period !== undefined && p.period !== 'monthly' && p.period !== 'weekly')
    return 'period: monthly | weekly';
  return null;
}
