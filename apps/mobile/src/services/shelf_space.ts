/**
 * Shelf space on the phone (docs/SHELF_SPACE_NEGOTIATION.md) — the plain
 * logic behind the four screens, kept out of them so it is testable alone:
 *
 *   - AppView reads: find open slots and fetch one listing by URI (the deep
 *     link from a directory's app, §6.3). The records carry no price.
 *   - The store's terms form ↔ Core's `TermPolicy`: the owner types rupees
 *     and percentages; Core stores minor units and basis points. Every number
 *     the owner types goes to their OWN node and nowhere else (§6.3).
 *   - The brand's request form → the policy its negotiation runs under.
 *   - Labels for terms, states and cards.
 */

import {
  AppViewClient,
  type SearchTermListingsParams,
  type TermListingCandidate,
} from '@dina/brain';
import { currencyExponent, formatMoney, type TermBuyerPolicy, type TermPolicy } from '@dina/core';

import { appViewBase, appViewFetch } from '../peerlens/appview_base';

import { toMinorUnits } from './quote_request_form';
import { categoryLabel, SHELF_CATEGORIES, SLOT_PACK_ID } from './shelf_labels';

// ---------------------------------------------------------------------------
// AppView
// ---------------------------------------------------------------------------

async function appView(): Promise<AppViewClient> {
  return new AppViewClient({ appViewURL: await appViewBase(), fetch: appViewFetch });
}

export async function findSlots(params: SearchTermListingsParams): Promise<TermListingCandidate[]> {
  return (await appView()).searchTermListings({ pack_id: SLOT_PACK_ID, ...params });
}

export async function fetchSlotListing(uri: string): Promise<TermListingCandidate | null> {
  return (await appView()).getTermListing(uri);
}

const LISTING_URI =
  /^at:\/\/did:[a-z0-9]+:[A-Za-z0-9._:%-]+\/com\.dinakernel\.commerce\.termListing\/[A-Za-z0-9._:~-]+$/;

/** A listing URI handed in by a deep link, or null — nothing else is accepted (§6.3). */
export function readListingUri(value: unknown): string | null {
  return typeof value === 'string' && LISTING_URI.test(value) ? value : null;
}

// ---------------------------------------------------------------------------
// The store's terms form ↔ TermPolicy
// ---------------------------------------------------------------------------

export interface SlotForm {
  resourceRef: string;
  currency: string;
  /** What the owner types: decimal rupees, percentages. */
  askingRent: string;
  askingSharePercent: string;
  floorRent: string;
  autoRent: string;
  floorSharePercent: string;
  availableFrom: string;
  availableTo: string;
  period: 'monthly' | 'weekly';
  /** Who keeps the takings until each settlement. */
  cashHandler: 'host' | 'vendor';
  trialDays: string;
  trialRent: string;
  exitNoticeDays: string;
}

export interface RuleForm {
  tag: string;
  premiumPercent: string;
  maxBrands: string;
}

/**
 * A brand placed outside Dina (§5.4 manual holdings). It counts toward its
 * category's rule; naming one of the store's slots also keeps that slot taken
 * for its dates.
 */
export interface HoldingForm {
  /** Kept from the stored holding; empty for a new one (named on save). */
  holdingId: string;
  tag: string;
  /** One of the store's slots, or '' for a holding that takes no slot. */
  resourceRef: string;
  startDay: string;
  endDay: string;
}

export interface TermsForm {
  enabled: boolean;
  access: 'contacts_or_card' | 'anyone';
  slots: SlotForm[];
  rules: RuleForm[];
  holdings: HoldingForm[];
  maxRounds: string;
}

export function emptyHolding(tag = ''): HoldingForm {
  return { holdingId: '', tag, resourceRef: '', startDay: '', endDay: '' };
}

export function emptySlot(currency = 'INR'): SlotForm {
  return {
    resourceRef: '',
    currency,
    askingRent: '',
    askingSharePercent: '0',
    floorRent: '',
    autoRent: '',
    floorSharePercent: '0',
    availableFrom: '',
    availableTo: '',
    period: 'monthly',
    cashHandler: 'vendor',
    trialDays: '',
    trialRent: '',
    exitNoticeDays: '30',
  };
}

function percentToBps(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole = '0', frac = ''] = trimmed.split('.');
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return bps <= 10_000 ? String(bps) : null;
}

function bpsToPercent(bps: string): string {
  return String(Number(bps) / 100);
}

function minorToDecimal(minor: string, currency: string): string {
  return formatMoney({ currency, minor_units: minor }).replace(`${currency} `, '');
}

/** A date the owner types (YYYY-MM-DD) as a UTC instant. */
function dayToInstant(day: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(day.trim()) &&
    !Number.isNaN(Date.parse(`${day.trim()}T00:00:00Z`))
    ? `${day.trim()}T00:00:00Z`
    : null;
}

export function policyToForm(policy: TermPolicy): TermsForm {
  return {
    enabled: policy.enabled,
    access: policy.access,
    maxRounds: String(policy.maxRounds),
    slots: policy.resources.map((r) => ({
      resourceRef: r.resource_ref,
      currency: r.currency,
      askingRent: minorToDecimal(r.asking.fee, r.currency),
      askingSharePercent: bpsToPercent(r.asking.share_bps),
      floorRent: minorToDecimal(r.floors.fee.hard, r.currency),
      autoRent:
        r.floors.fee.auto === undefined ? '' : minorToDecimal(r.floors.fee.auto, r.currency),
      floorSharePercent: bpsToPercent(r.floors.share_bps.hard),
      availableFrom: r.available.from.slice(0, 10),
      availableTo: r.available.to.slice(0, 10),
      period: r.conditions.period,
      cashHandler: r.conditions.cash_handler,
      trialDays: r.conditions.trial === undefined ? '' : String(r.conditions.trial.days),
      trialRent:
        r.conditions.trial === undefined
          ? ''
          : minorToDecimal(r.conditions.trial.fee_minor, r.currency),
      exitNoticeDays: String(r.conditions.exit_notice_days),
    })),
    rules: policy.holding_rules.map((rule) => ({
      tag: rule.tag,
      premiumPercent: bpsToPercent(String(rule.premium_bps_per_count)),
      maxBrands: rule.max_count === undefined ? '' : String(rule.max_count),
    })),
    holdings: policy.manual_holdings.map((h) => ({
      holdingId: h.holding_id,
      tag: h.tag,
      resourceRef: h.resource_ref ?? '',
      startDay: h.start.slice(0, 10),
      endDay: h.end.slice(0, 10),
    })),
  };
}

/**
 * The form as Core's policy, or the first problem in the owner's words. Core
 * validates again; this exists so a typo is caught beside the field rather
 * than as a refusal after a presence prompt.
 */
export function formToPolicy(
  form: TermsForm,
  base: TermPolicy,
): { ok: true; policy: TermPolicy } | { ok: false; problem: string } {
  const rounds = Number(form.maxRounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10)
    return { ok: false, problem: 'Rounds of bargaining: a whole number from 1 to 10.' };
  const resources: TermPolicy['resources'] = [];
  const seen = new Set<string>();
  for (const [i, slot] of form.slots.entries()) {
    const n = `Slot ${String(i + 1)}`;
    const ref = slot.resourceRef.trim();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(ref))
      return {
        ok: false,
        problem: `${n}: give it a short name, letters, numbers and dashes only.`,
      };
    if (seen.has(ref)) return { ok: false, problem: `${n}: two slots share the name ${ref}.` };
    seen.add(ref);
    if (!/^[A-Z]{3}$/.test(slot.currency))
      return { ok: false, problem: `${n}: a currency is a three-letter code, like INR.` };
    const exponent = currencyExponent(slot.currency);
    const asking = toMinorUnits(slot.askingRent || '0', exponent);
    const floor = toMinorUnits(slot.floorRent || '0', exponent);
    const auto = slot.autoRent.trim() === '' ? null : toMinorUnits(slot.autoRent, exponent);
    const askingShare = percentToBps(slot.askingSharePercent || '0');
    const floorShare = percentToBps(slot.floorSharePercent || '0');
    if (asking === null || floor === null || (slot.autoRent.trim() !== '' && auto === null)) {
      return { ok: false, problem: `${n}: rents are amounts, like 1500 or 1500.50.` };
    }
    if (askingShare === null || floorShare === null)
      return { ok: false, problem: `${n}: shares are percentages from 0 to 100.` };
    if (asking === '0' && askingShare === '0')
      return { ok: false, problem: `${n}: ask for rent, a share of sales, or both.` };
    if (askingShare === '0' && slot.cashHandler === 'host') {
      return { ok: false, problem: `${n}: with rent only, the brand keeps its own takings.` };
    }
    if (auto !== null && BigInt(auto) < BigInt(floor)) {
      return { ok: false, problem: `${n}: the automatic limit cannot be below your lowest rent.` };
    }
    const from = dayToInstant(slot.availableFrom);
    const to = dayToInstant(slot.availableTo);
    if (from === null || to === null || Date.parse(to) <= Date.parse(from)) {
      return {
        ok: false,
        problem: `${n}: give the dates it is free, as YYYY-MM-DD, the end after the start.`,
      };
    }
    const notice = Number(slot.exitNoticeDays);
    if (!Number.isInteger(notice) || notice < 0 || notice > 365)
      return { ok: false, problem: `${n}: notice is a number of days, 0 to 365.` };
    let trial: { days: number; fee_minor: string } | undefined;
    if (slot.trialDays.trim() !== '') {
      const days = Number(slot.trialDays);
      const fee = toMinorUnits(slot.trialRent || '0', exponent);
      if (!Number.isInteger(days) || days < 1 || days > 365 || fee === null) {
        return {
          ok: false,
          problem: `${n}: a trial is 1 to 365 days, with its rent as an amount.`,
        };
      }
      trial = { days, fee_minor: fee };
    }
    resources.push({
      resource_ref: ref,
      currency: slot.currency,
      asking: { fee: asking, share_bps: askingShare },
      floors: {
        fee: auto === null ? { hard: floor } : { hard: floor, auto },
        share_bps: { hard: floorShare },
      },
      available: { from, to },
      conditions: {
        period: slot.period,
        cash_handler: slot.cashHandler,
        exit_notice_days: notice,
        ...(trial !== undefined ? { trial } : {}),
      },
    });
  }
  const holdingRules: TermPolicy['holding_rules'] = [];
  for (const rule of form.rules) {
    const premium = percentToBps(rule.premiumPercent || '0');
    if (premium === null)
      return {
        ok: false,
        problem: `${categoryLabel(rule.tag)}: the extra per brand is a percentage.`,
      };
    const max = rule.maxBrands.trim() === '' ? undefined : Number(rule.maxBrands);
    if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > 1000)) {
      return {
        ok: false,
        problem: `${categoryLabel(rule.tag)}: the most brands is a whole number.`,
      };
    }
    holdingRules.push({
      tag: rule.tag,
      premium_bps_per_count: Number(premium),
      ...(max !== undefined ? { max_count: max } : {}),
    });
  }
  const manualHoldings: TermPolicy['manual_holdings'] = [];
  const takenIds = new Set(form.holdings.map((h) => h.holdingId).filter((id) => id !== ''));
  let nextId = 1;
  for (const [i, holding] of form.holdings.entries()) {
    const n = `Holding ${String(i + 1)}`;
    if (!SHELF_CATEGORIES.some((c) => c.tag === holding.tag)) {
      return { ok: false, problem: `${n}: pick its category.` };
    }
    if (
      holding.resourceRef !== '' &&
      !resources.some((r) => r.resource_ref === holding.resourceRef)
    ) {
      return { ok: false, problem: `${n}: ${holding.resourceRef} is not one of your slots.` };
    }
    const start = dayToInstant(holding.startDay);
    const end = dayToInstant(holding.endDay);
    if (start === null || end === null) {
      return { ok: false, problem: `${n}: dates are written YYYY-MM-DD.` };
    }
    if (Date.parse(end) <= Date.parse(start)) {
      return { ok: false, problem: `${n}: the end must come after the start.` };
    }
    let holdingId = holding.holdingId;
    if (holdingId === '') {
      while (takenIds.has(`holding-${String(nextId)}`)) nextId += 1;
      holdingId = `holding-${String(nextId)}`;
      takenIds.add(holdingId);
    }
    manualHoldings.push({
      holding_id: holdingId,
      tag: holding.tag,
      ...(holding.resourceRef !== '' ? { resource_ref: holding.resourceRef } : {}),
      start,
      end,
    });
  }
  return {
    ok: true,
    policy: {
      ...base,
      enabled: form.enabled,
      access: form.access,
      maxRounds: rounds,
      resources,
      holding_rules: holdingRules,
      manual_holdings: manualHoldings,
    },
  };
}

// ---------------------------------------------------------------------------
// The brand's request form → TermBuyerPolicy
// ---------------------------------------------------------------------------

export interface RequestForm {
  tag: string;
  products: string;
  skus: string;
  startDay: string;
  endDay: string;
  currency: string;
  targetRent: string;
  targetSharePercent: string;
  maxRent: string;
  maxSharePercent: string;
  expectedSales: string;
  /** The period the rents and the expected sales above are per. */
  period: 'monthly' | 'weekly';
  rounds: string;
  days: string;
}

export function requestToNegotiation(form: RequestForm):
  | {
      ok: true;
      start: string;
      end: string;
      attributes: Record<string, string | number>;
      policy: TermBuyerPolicy;
    }
  | { ok: false; problem: string } {
  const start = dayToInstant(form.startDay);
  const end = dayToInstant(form.endDay);
  if (start === null || end === null || Date.parse(end) <= Date.parse(start)) {
    return {
      ok: false,
      problem: 'Give the dates you want the slot, as YYYY-MM-DD, the end after the start.',
    };
  }
  if (!/^[A-Z]{3}$/.test(form.currency))
    return { ok: false, problem: 'A currency is a three-letter code, like INR.' };
  const exponent = currencyExponent(form.currency);
  const targetFee = toMinorUnits(form.targetRent || '0', exponent);
  const maxFee = toMinorUnits(form.maxRent || '0', exponent);
  const targetShare = percentToBps(form.targetSharePercent || '0');
  const maxShare = percentToBps(form.maxSharePercent || '0');
  if (targetFee === null || maxFee === null)
    return { ok: false, problem: 'Rents are amounts, like 1500.' };
  if (targetShare === null || maxShare === null)
    return { ok: false, problem: 'Shares are percentages from 0 to 100.' };
  if (BigInt(targetFee) > BigInt(maxFee) || Number(targetShare) > Number(maxShare)) {
    return { ok: false, problem: 'What you hope for must be within the most you will pay.' };
  }
  const rounds = Number(form.rounds);
  const days = Number(form.days);
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > 10)
    return { ok: false, problem: 'Rounds: a whole number from 0 to 10.' };
  if (!Number.isInteger(days) || days < 1 || days > 7)
    return { ok: false, problem: 'Bargain for 1 to 7 days.' };
  const expected =
    form.expectedSales.trim() === '' ? null : toMinorUnits(form.expectedSales, exponent);
  if (form.expectedSales.trim() !== '' && expected === null)
    return { ok: false, problem: 'Expected sales is an amount.' };
  const attributes: Record<string, string | number> = {};
  if (form.products.trim() !== '') attributes.products = form.products.trim().slice(0, 200);
  if (form.skus.trim() !== '') {
    const skus = Number(form.skus);
    if (!Number.isInteger(skus) || skus < 1 || skus > 500)
      return { ok: false, problem: 'Products to stock: a whole number from 1 to 500.' };
    attributes.skus = skus;
  }
  return {
    ok: true,
    start,
    end,
    attributes,
    policy: {
      currency: form.currency,
      targets: { fee: targetFee, share_bps: targetShare },
      ceilings: { fee: maxFee, share_bps: maxShare },
      ...(expected !== null ? { expected_sales_minor: expected } : {}),
      // A store may offer weekly rent; Core restates these in its period.
      period: form.period,
      max_rounds: rounds,
      deadline_seconds: days * 24 * 60 * 60,
    },
  };
}

export * from './shelf_labels';
