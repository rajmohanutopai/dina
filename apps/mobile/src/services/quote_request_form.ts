/**
 * The "Ask for quotes" form (ASK_FOR_QUOTES_PLAN §2): what the buyer typed,
 * checked the way Core checks it, and turned into the tender request.
 *
 * Pure: the screen renders the problems and sends what `buildTenderRequest`
 * returns. The negotiation limits are checked by Core's own
 * `tenderPolicyError`, so the screen can never accept limits Core refuses.
 * Amounts are typed in the currency's main unit with at most two decimals
 * (the same two-decimal display the Tender screen uses).
 */

import { DEFAULT_TENDER_FANOUT, tenderPolicyError, type CreateTenderRequest } from '@dina/core';

/** Units a line may be counted in (the closed §9.2 vocabulary), with their decimals. */
export const LINE_UNITS: readonly { code: string; label: string; scale: number }[] = [
  { code: 'each', label: 'each', scale: 0 },
  { code: 'kg', label: 'kg', scale: 3 },
  { code: 'g', label: 'g', scale: 0 },
  { code: 'l', label: 'litre', scale: 3 },
  { code: 'ml', label: 'ml', scale: 0 },
  { code: 'case', label: 'case', scale: 0 },
];

/** A described need is at most this long on the wire (protocol §4.6). */
export const MAX_LINE_TEXT = 200;

/** How long each negotiation round waits for a supplier, as offered choices. */
export const DEADLINE_CHOICES: readonly { seconds: number; label: string }[] = [
  { seconds: 15 * 60, label: '15 min' },
  { seconds: 60 * 60, label: '1 hour' },
  { seconds: 4 * 60 * 60, label: '4 hours' },
  { seconds: 24 * 60 * 60, label: '24 hours' },
];

export interface LineDraft {
  text: string;
  quantity: string;
  unitCode: string;
}

export interface LimitsDraft {
  /** Main units, e.g. "2500" or "2500.50". Empty when not set. */
  target: string;
  ceiling: string;
  /** Empty for Core's default. */
  maxRounds: string;
  deadlineSeconds: number | null;
}

export interface QuoteRequestDraft {
  lines: LineDraft[];
  suppliers: { supplierDid: string; serviceRkey: string }[];
  region: { scheme: 'postal_area'; value: string } | null;
  currency: string;
  limits: LimitsDraft;
}

export const EMPTY_LIMITS: LimitsDraft = {
  target: '',
  ceiling: '',
  maxRounds: '',
  deadlineSeconds: null,
};

export function emptyLine(): LineDraft {
  return { text: '', quantity: '1', unitCode: 'each' };
}

/** "2500.5" → "250050"; null when it is not an amount with at most two decimals. */
export function toMinorUnits(amount: string): string | null {
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (m === null) return null;
  const minor = `${m[1] ?? ''}${(m[2] ?? '').padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
  return minor;
}

function quantityProblem(line: LineDraft): string | null {
  const unit = LINE_UNITS.find((u) => u.code === line.unitCode);
  if (unit === undefined) return 'Pick a unit.';
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(line.quantity.trim());
  if (m === null) return 'Enter a quantity, like 1 or 2.5.';
  if ((m[2] ?? '').length > unit.scale) {
    return unit.scale === 0
      ? `Count ${unit.label} in whole numbers.`
      : `At most ${String(unit.scale)} decimals for ${unit.label}.`;
  }
  if (/^0+(\.0*)?$/.test(line.quantity.trim())) return 'The quantity must be more than zero.';
  return null;
}

export type BuildOutcome =
  | { ok: true; request: CreateTenderRequest }
  | { ok: false; problems: string[] };

/** Check the form; the request to send, or every problem in words. */
export function buildTenderRequest(draft: QuoteRequestDraft): BuildOutcome {
  const problems: string[] = [];
  const lines = draft.lines.filter((l) => l.text.trim() !== '');
  if (lines.length === 0) problems.push('Describe at least one thing you want.');
  lines.forEach((line, i) => {
    const which = lines.length > 1 ? `Item ${String(i + 1)}: ` : '';
    if (line.text.trim().length > MAX_LINE_TEXT) {
      problems.push(`${which}keep the description under ${String(MAX_LINE_TEXT)} characters.`);
    }
    const q = quantityProblem(line);
    if (q !== null) problems.push(`${which}${q}`);
  });
  if (draft.suppliers.length === 0) problems.push('Pick at least one supplier to ask.');
  if (draft.suppliers.length > DEFAULT_TENDER_FANOUT) {
    problems.push(`Ask at most ${String(DEFAULT_TENDER_FANOUT)} suppliers at a time.`);
  }
  if (draft.region === null || draft.region.value.trim() === '') {
    problems.push('Say where to deliver (a postal code).');
  }
  if (!/^[A-Z]{3}$/.test(draft.currency))
    problems.push('The currency must be a three-letter code.');

  let limits: CreateTenderRequest['limits'];
  const { target, ceiling, maxRounds, deadlineSeconds } = draft.limits;
  const anyLimit =
    target.trim() !== '' ||
    ceiling.trim() !== '' ||
    maxRounds.trim() !== '' ||
    deadlineSeconds !== null;
  if (anyLimit) {
    const targetMinor = toMinorUnits(target);
    const ceilingMinor = toMinorUnits(ceiling);
    const rounds = maxRounds.trim() === '' ? undefined : Number(maxRounds);
    if (targetMinor === null || ceilingMinor === null) {
      problems.push('To negotiate, give both a target and a ceiling, like 2500 or 2500.50.');
    } else {
      const policyError = tenderPolicyError({
        currency: draft.currency,
        targetTotalMinor: targetMinor,
        budgetCeilingMinor: ceilingMinor,
        ...(rounds === undefined ? {} : { maxRounds: rounds }),
        ...(deadlineSeconds === null ? {} : { deadlineSeconds }),
      });
      if (policyError !== null) problems.push(policyText(policyError));
      else {
        limits = {
          targetMinorUnits: targetMinor,
          ceilingMinorUnits: ceilingMinor,
          ...(rounds === undefined ? {} : { maxRounds: rounds }),
          ...(deadlineSeconds === null ? {} : { deadlineSeconds }),
        };
      }
    }
  }

  if (problems.length > 0 || draft.region === null) return { ok: false, problems };
  return {
    ok: true,
    request: {
      suppliers: draft.suppliers,
      lines: lines.map((line, i) => ({
        lineId: `l${String(i + 1)}`,
        text: line.text.trim(),
        quantity: line.quantity.trim(),
        unitCode: line.unitCode,
      })),
      region: { scheme: 'postal_area', value: draft.region.value.trim() },
      currency: draft.currency,
      ...(limits === undefined ? {} : { limits }),
    },
  };
}

/** Core's policy refusal, in the screen's words. */
function policyText(error: string): string {
  if (error.startsWith('budget_ceiling cannot be below'))
    return 'The ceiling cannot be below the target.';
  if (error.startsWith('target_total')) return 'The target must be more than zero.';
  if (error.startsWith('max_rounds')) return 'Rounds must be 1 to 10.';
  if (error.startsWith('deadline_seconds')) return 'Pick how long each round may wait.';
  if (error.startsWith('currency')) return 'The currency must be a three-letter code.';
  return error;
}
