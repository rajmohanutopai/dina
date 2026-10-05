/**
 * The discount extension (discount.json), response side: the codes the
 * merchant holds and the discounts it applied. A `provisional` discount is
 * shown as such; Dina never treats it as settled.
 */

import { isPlainObject } from '@dina/a2a';

import { parseAmount } from './money';
import { fail, listOrEmpty, ok, type Read } from './resource';

export interface AppliedDiscount {
  title: string;
  /** Minor units of the resource's currency. */
  amount: bigint;
  code?: string;
  automatic: boolean;
  provisional: boolean;
  method?: 'each' | 'across';
}

export interface Discounts {
  codes: string[];
  applied: AppliedDiscount[];
}

export function readDiscounts(value: unknown): Read<Discounts> {
  if (value === undefined) return ok({ codes: [], applied: [] });
  if (!isPlainObject(value)) return fail('discounts');
  const codes = value.codes === undefined ? [] : value.codes;
  if (!Array.isArray(codes) || !codes.every((c) => typeof c === 'string'))
    return fail('discount_codes');
  const applied: AppliedDiscount[] = [];
  const appliedList = listOrEmpty(value.applied);
  if (appliedList === null) return fail('applied_discounts');
  for (const raw of appliedList) {
    if (!isPlainObject(raw) || typeof raw.title !== 'string') return fail('applied_discount');
    const amount = parseAmount(raw.amount);
    if (amount === null) return fail('applied_discount_amount');
    if (raw.method !== undefined && raw.method !== 'each' && raw.method !== 'across')
      return fail('applied_discount_method');
    applied.push({
      title: raw.title,
      amount,
      automatic: raw.automatic === true,
      provisional: raw.provisional === true,
      ...(typeof raw.code === 'string' ? { code: raw.code } : {}),
      ...(raw.method !== undefined ? { method: raw.method as 'each' | 'across' } : {}),
    });
  }
  return ok({ codes: codes as string[], applied });
}
