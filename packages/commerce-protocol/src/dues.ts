/**
 * Derived due dates (TRADE_FIRST_STRATEGY §4.5).
 *
 * Due dates DERIVE from documents both sides hold — never asserted,
 * exactly the fold's discipline. The split-delivery case is pinned:
 * `from_delivery` matures credit PER RECEIPTED PORTION (each receipt's
 * `received_at` starts its own clock for the value that receipt
 * accepted, so an order fulfilled in two dispatches carries two dues);
 * `from_acceptance` runs ONE clock from the acknowledgement's
 * `accepted_at` for the whole order. Both sides compute identical dues
 * from the same documents.
 *
 * PURE ARITHMETIC on validated inputs; anything unpriceable or
 * undatable is an error, never a guess — a wrong due date is a wrong
 * claim about money.
 */

import { validateIsoUtc } from './common';
import { validateMoney, type Money } from './money';

import type { DueBasis } from './quote';

export interface DerivedDue {
  /** ISO UTC instant the credit matures. */
  due_at: string;
  amount: Money;
  /** What started this clock: an acceptance, or one receipt. */
  basis: DueBasis;
}

export type DeriveDuesResult = { value: DerivedDue[]; error: null } | { value: null; error: string };

const DAY_MS = 24 * 60 * 60 * 1000;

function matured(startIso: string, creditDays: number): string {
  return new Date(Date.parse(startIso) + creditDays * DAY_MS).toISOString();
}

export function deriveDues(input: {
  currency: string;
  credit_days: number;
  due_basis: DueBasis;
  /** The acknowledgement's `accepted_at` — required for `from_acceptance`. */
  accepted_at?: string;
  /** The whole order's value — required for `from_acceptance`. */
  order_total_minor?: string;
  /** Per-receipt accepted value, priced from the bound quote. */
  receipted?: { received_at: string; value_minor: string }[];
}): DeriveDuesResult {
  if (
    typeof input.credit_days !== 'number' ||
    !Number.isInteger(input.credit_days) ||
    input.credit_days < 0 ||
    input.credit_days > 3650
  ) {
    return { value: null, error: 'dues: credit_days must be an integer in [0, 3650]' };
  }

  if (input.due_basis === 'from_acceptance') {
    if (input.accepted_at === undefined || input.order_total_minor === undefined) {
      return { value: null, error: 'dues: from_acceptance needs accepted_at and order_total_minor' };
    }
    const dateError = validateIsoUtc(input.accepted_at, 'dues.accepted_at');
    if (dateError) return { value: null, error: dateError };
    const amount: Money = { currency: input.currency, minor_units: input.order_total_minor };
    const moneyError = validateMoney(amount);
    if (moneyError) return { value: null, error: `dues: ${moneyError}` };
    return {
      value: [
        { due_at: matured(input.accepted_at, input.credit_days), amount, basis: 'from_acceptance' },
      ],
      error: null,
    };
  }

  const receipts = input.receipted ?? [];
  const dues: DerivedDue[] = [];
  for (const [i, receipt] of receipts.entries()) {
    const dateError = validateIsoUtc(receipt.received_at, `dues.receipted[${String(i)}].received_at`);
    if (dateError) return { value: null, error: dateError };
    const amount: Money = { currency: input.currency, minor_units: receipt.value_minor };
    const moneyError = validateMoney(amount);
    if (moneyError) return { value: null, error: `dues.receipted[${String(i)}]: ${moneyError}` };
    // A zero-value receipt (everything refused) starts no clock: there is
    // nothing owed on it, and a ₹0 due line is noise on a statement.
    if (amount.minor_units === '0') continue;
    dues.push({
      due_at: matured(receipt.received_at, input.credit_days),
      amount,
      basis: 'from_delivery',
    });
  }
  return { value: dues, error: null };
}
