/**
 * A drafted quote request, as the chat card hands it to the "Ask for quotes"
 * screen (ASK_FOR_QUOTES_PLAN §2). Brain drafts it from what the owner said;
 * the screen shows it prefilled and sends nothing until the owner taps Send.
 *
 * The draft travels as a route parameter (JSON), so it is parsed as
 * untrusted: anything malformed is dropped field by field, never thrown.
 */

import {
  EMPTY_LIMITS,
  LINE_UNITS,
  MAX_LINE_TEXT,
  type LimitsDraft,
  type LineDraft,
} from './quote_request_form';

import type { QuoteRequestDraftWire } from '@dina/brain/chat';

export interface QuoteRequestPrefill {
  lines: LineDraft[];
  /** What to search suppliers for, e.g. "cakes". */
  supplierQuery?: string;
  limits: LimitsDraft;
}

const UNIT_CODES = new Set(LINE_UNITS.map((u) => u.code));

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Minor units → the main-unit text the form edits ("250000" → "2500"). */
function mainUnits(minor: unknown): string {
  if (typeof minor !== 'string' || !/^\d+$/.test(minor)) return '';
  const padded = minor.padStart(3, '0');
  const whole = padded.slice(0, -2).replace(/^0+(?=\d)/, '');
  const cents = padded.slice(-2);
  return cents === '00' ? whole : `${whole}.${cents}`;
}

export function parseQuoteRequestDraftParam(raw: unknown): QuoteRequestPrefill | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const draft = parsed as Partial<QuoteRequestDraftWire>;
  const lines: LineDraft[] = (Array.isArray(draft.lines) ? draft.lines : [])
    .map((line): LineDraft | null => {
      const text =
        str((line as { text?: unknown }).text)
          ?.trim()
          .slice(0, MAX_LINE_TEXT) ?? '';
      if (text === '') return null;
      const quantity = str((line as { quantity?: unknown }).quantity) ?? '1';
      const unit = str((line as { unit_code?: unknown }).unit_code) ?? 'each';
      return {
        text,
        quantity: /^\d+(\.\d+)?$/.test(quantity) ? quantity : '1',
        unitCode: UNIT_CODES.has(unit) ? unit : 'each',
      };
    })
    .filter((l): l is LineDraft => l !== null)
    .slice(0, 10);
  const limits = draft.limits;
  const rounds = limits?.max_rounds;
  const deadline = limits?.deadline_seconds;
  const query = str(draft.supplier_query)?.trim();
  return {
    lines,
    ...(query !== undefined && query !== '' ? { supplierQuery: query.slice(0, 100) } : {}),
    limits:
      limits === undefined || limits === null
        ? EMPTY_LIMITS
        : {
            target: mainUnits(limits.target_minor),
            ceiling: mainUnits(limits.ceiling_minor),
            maxRounds: typeof rounds === 'number' && Number.isInteger(rounds) ? String(rounds) : '',
            deadlineSeconds:
              typeof deadline === 'number' && Number.isInteger(deadline) ? deadline : null,
          },
  };
}
