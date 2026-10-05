/**
 * The fulfillment extension of checkout (fulfillment.json,
 * types/fulfillment_method.json, fulfillment_group.json, fulfillment_option.json),
 * response side: the methods, destinations, groups and options the merchant
 * offers, so Dina can show them and choose among them by id (§3.7).
 *
 * Destinations are read as ids and types only. A shipping destination is the
 * buyer's own address; Dina shows the merchant's own business locations by
 * their name.
 */

import { isPlainObject } from '@dina/a2a';

import { parseTotalEntries, type TotalEntry } from './money';
import {
  fail,
  listOrEmpty,
  ok,
  optString,
  readDescription,
  type Description,
  type Read,
} from './resource';

export interface FulfillmentOption {
  id: string;
  title: string;
  description?: Description;
  carrier?: string;
  earliestFulfillmentTime?: string;
  latestFulfillmentTime?: string;
  totals: TotalEntry[];
}

export interface FulfillmentGroup {
  id: string;
  lineItemIds: string[];
  options: FulfillmentOption[];
  selectedOptionId: string | null;
}

export interface FulfillmentDestination {
  id: string;
  type: string;
  /** A business location's name, when the merchant gives one. */
  name?: string;
  /**
   * A shipping address's string fields as the merchant echoes them: the
   * buyer's own address, held in memory to match against the approved one,
   * never logged.
   */
  address?: Record<string, string>;
}

export interface FulfillmentMethod {
  id: string;
  type: string;
  lineItemIds: string[];
  destinations: FulfillmentDestination[];
  selectedDestinationId: string | null;
  groups: FulfillmentGroup[];
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((x) => typeof x === 'string')
    ? (value as string[])
    : null;
}

function stringFields(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value))
    if (k !== 'id' && k !== 'type' && typeof v === 'string') out[k] = v;
  return out;
}

function readOption(value: unknown): Read<FulfillmentOption> {
  if (!isPlainObject(value) || typeof value.id !== 'string' || typeof value.title !== 'string')
    return fail('option');
  const totals = parseTotalEntries(value.totals);
  if (!totals.ok) return fail(`option_${totals.reason}`);
  const description = readDescription(value.description);
  const carrier = optString(value.carrier);
  const earliest = optString(value.earliest_fulfillment_time);
  const latest = optString(value.latest_fulfillment_time);
  return ok({
    id: value.id,
    title: value.title,
    totals: totals.totals,
    ...(description !== undefined ? { description } : {}),
    ...(carrier !== undefined ? { carrier } : {}),
    ...(earliest !== undefined ? { earliestFulfillmentTime: earliest } : {}),
    ...(latest !== undefined ? { latestFulfillmentTime: latest } : {}),
  });
}

function readGroup(value: unknown): Read<FulfillmentGroup> {
  if (!isPlainObject(value) || typeof value.id !== 'string') return fail('group');
  const lineItemIds = stringArray(value.line_item_ids);
  if (lineItemIds === null) return fail('group_line_item_ids');
  const options: FulfillmentOption[] = [];
  const optionsList = listOrEmpty(value.options);
  if (optionsList === null) return fail('group_options');
  for (const raw of optionsList) {
    const r = readOption(raw);
    if (!r.ok) return r;
    options.push(r.value);
  }
  const selected = value.selected_option_id;
  if (selected !== undefined && selected !== null && typeof selected !== 'string')
    return fail('group_selected');
  return ok({
    id: value.id,
    lineItemIds,
    options,
    selectedOptionId: typeof selected === 'string' ? selected : null,
  });
}

function readMethod(value: unknown): Read<FulfillmentMethod> {
  if (!isPlainObject(value) || typeof value.id !== 'string' || typeof value.type !== 'string')
    return fail('method');
  const lineItemIds = stringArray(value.line_item_ids);
  if (lineItemIds === null) return fail('method_line_item_ids');
  const destinations: FulfillmentDestination[] = [];
  const destinationsList = listOrEmpty(value.destinations);
  if (destinationsList === null) return fail('method_destinations');
  for (const raw of destinationsList) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || typeof raw.type !== 'string')
      return fail('destination');
    const name = raw.type === 'business_location' ? optString(raw.name) : undefined;
    const address = raw.type === 'shipping_address' ? stringFields(raw) : undefined;
    destinations.push({
      id: raw.id,
      type: raw.type,
      ...(name !== undefined ? { name } : {}),
      ...(address !== undefined ? { address } : {}),
    });
  }
  const groups: FulfillmentGroup[] = [];
  const groupsList = listOrEmpty(value.groups);
  if (groupsList === null) return fail('method_groups');
  for (const raw of groupsList) {
    const r = readGroup(raw);
    if (!r.ok) return r;
    groups.push(r.value);
  }
  const selected = value.selected_destination_id;
  if (selected !== undefined && selected !== null && typeof selected !== 'string')
    return fail('method_selected');
  return ok({
    id: value.id,
    type: value.type,
    lineItemIds,
    destinations,
    selectedDestinationId: typeof selected === 'string' ? selected : null,
    groups,
  });
}

/** `checkout.fulfillment` (response side); absent reads as no methods. */
export function readFulfillment(value: unknown): Read<FulfillmentMethod[]> {
  if (value === undefined) return ok([]);
  if (!isPlainObject(value)) return fail('fulfillment');
  if (value.methods === undefined) return ok([]);
  if (!Array.isArray(value.methods)) return fail('fulfillment_methods');
  const out: FulfillmentMethod[] = [];
  for (const raw of value.methods) {
    const r = readMethod(raw);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return ok(out);
}
