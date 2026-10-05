/**
 * Orders (order.json; order/index.md), and the record Dina keeps of them
 * (§3.13, §3.14).
 *
 *  - `readOrder`: the fields Dina shows and acts on.
 *  - `absorbOrder`: merges an answer (polled or webhook) into the kept record:
 *    fulfillment events are a union by id, never dropped because a later answer
 *    leaves one out or redacts it; adjustments merge by id, a later status
 *    replacing an earlier one; ids seen are kept for good. It names the
 *    interruptions the answer causes, each at most once.
 *  - `linesSettled`: the line part of Dina's closed rule.
 */

import { isPlainObject } from '@dina/a2a';

import { parseMessages, type MessagesParse } from './messages';
import {
  isCurrencyCode,
  parseSignedAmount,
  parseTotalEntries,
  parseTotals,
  type TotalEntry,
} from './money';
import { fail, ok, optString, readHttpsUrl, readTimestamp, type Read } from './resource';
import { EACH, parseQuantityUnit, parseSteps, type QuantityUnit } from './units';

export const LINE_STATUSES = ['processing', 'partial', 'fulfilled', 'removed'] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];
export const ADJUSTMENT_STATUSES = ['pending', 'completed', 'failed'] as const;
export type AdjustmentStatus = (typeof ADJUSTMENT_STATUSES)[number];

/** Fulfillment event types that interrupt the person (§3.13). */
export const INTERRUPTING_EVENT_TYPES: ReadonlySet<string> = new Set([
  'failed_attempt',
  'canceled',
  'undeliverable',
  'returned_to_sender',
]);
/** Adjustment types that interrupt on first sight and on first settling (§3.13). */
export const INTERRUPTING_ADJUSTMENT_TYPES: ReadonlySet<string> = new Set([
  'dispute',
  'cancellation',
]);

export interface OrderLine {
  id: string;
  itemId: string;
  title: string;
  unit: QuantityUnit;
  quantity: { original?: bigint; total: bigint; fulfilled: bigint };
  status: LineStatus;
  totals: TotalEntry[];
}

export interface FulfillmentEvent {
  id: string;
  occurredAt: number;
  type: string;
  lineItems: { id: string; quantity: bigint }[];
  trackingNumber?: string;
  trackingUrl?: string;
  carrier?: string;
  description?: string;
}

export interface Adjustment {
  id: string;
  type: string;
  occurredAt: number;
  status: AdjustmentStatus;
  description?: string;
  totals: TotalEntry[];
}

export interface Order {
  id: string;
  checkoutId: string;
  permalinkUrl: string;
  label?: string;
  currency: string;
  lines: OrderLine[];
  events: FulfillmentEvent[];
  adjustments: Adjustment[];
  totals: TotalEntry[];
  messages: MessagesParse;
}

function readLine(value: unknown): Read<OrderLine> {
  if (!isPlainObject(value) || typeof value.id !== 'string') return fail('line');
  const item = value.item;
  if (!isPlainObject(item) || typeof item.id !== 'string' || typeof item.title !== 'string')
    return fail('line_item');
  let unit = EACH;
  if (item.quantity_unit !== undefined) {
    const u = parseQuantityUnit(item.quantity_unit);
    if (u === null) return fail('line_unit');
    unit = u;
  }
  const q = value.quantity;
  if (!isPlainObject(q)) return fail('line_quantity');
  const total = parseSteps(q.total, { allowZero: true });
  const fulfilled = parseSteps(q.fulfilled, { allowZero: true });
  const original =
    q.original === undefined ? undefined : parseSteps(q.original, { allowZero: true });
  if (total === null || fulfilled === null || original === null) return fail('line_quantity');
  if (
    typeof value.status !== 'string' ||
    !(LINE_STATUSES as readonly string[]).includes(value.status)
  )
    return fail('line_status');
  const totals = parseTotalEntries(value.totals);
  if (!totals.ok) return fail(`line_${totals.reason}`);
  return ok({
    id: value.id,
    itemId: item.id,
    title: item.title,
    unit,
    quantity: { total, fulfilled, ...(original !== undefined ? { original } : {}) },
    status: value.status as LineStatus,
    totals: totals.totals,
  });
}

function readEvent(value: unknown): Read<FulfillmentEvent> {
  if (!isPlainObject(value) || typeof value.id !== 'string' || typeof value.type !== 'string')
    return fail('event');
  const occurredAt = readTimestamp(value.occurred_at);
  if (occurredAt === null) return fail('event_occurred_at');
  if (!Array.isArray(value.line_items)) return fail('event_line_items');
  const lineItems: { id: string; quantity: bigint }[] = [];
  for (const l of value.line_items) {
    const quantity = isPlainObject(l) ? parseSteps(l.quantity) : null;
    if (!isPlainObject(l) || typeof l.id !== 'string' || quantity === null)
      return fail('event_line_item');
    lineItems.push({ id: l.id, quantity });
  }
  const trackingUrl = readHttpsUrl(value.tracking_url);
  const trackingNumber = optString(value.tracking_number);
  const carrier = optString(value.carrier);
  const description = optString(value.description);
  return ok({
    id: value.id,
    occurredAt,
    type: value.type,
    lineItems,
    ...(trackingNumber !== undefined ? { trackingNumber } : {}),
    ...(trackingUrl !== null ? { trackingUrl } : {}),
    ...(carrier !== undefined ? { carrier } : {}),
    ...(description !== undefined ? { description } : {}),
  });
}

function readAdjustment(value: unknown): Read<Adjustment> {
  if (!isPlainObject(value) || typeof value.id !== 'string' || typeof value.type !== 'string')
    return fail('adjustment');
  const occurredAt = readTimestamp(value.occurred_at);
  if (occurredAt === null) return fail('adjustment_occurred_at');
  if (
    typeof value.status !== 'string' ||
    !(ADJUSTMENT_STATUSES as readonly string[]).includes(value.status)
  )
    return fail('adjustment_status');
  let totals: TotalEntry[] = [];
  if (value.totals !== undefined) {
    const t = parseTotalEntries(value.totals);
    if (!t.ok) return fail(`adjustment_${t.reason}`);
    totals = t.totals;
  }
  if (Array.isArray(value.line_items)) {
    for (const l of value.line_items) {
      if (!isPlainObject(l) || typeof l.id !== 'string' || parseSignedAmount(l.quantity) === null)
        return fail('adjustment_line_item');
    }
  }
  const description = optString(value.description);
  return ok({
    id: value.id,
    type: value.type,
    occurredAt,
    status: value.status as AdjustmentStatus,
    totals,
    ...(description !== undefined ? { description } : {}),
  });
}

function readAll<T>(value: unknown, read: (v: unknown) => Read<T>, what: string): Read<T[]> {
  if (value === undefined) return ok([]);
  if (!Array.isArray(value)) return fail(what);
  const out: T[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    const r = read(raw);
    if (!r.ok) return r;
    const id = (r.value as { id: string }).id;
    if (ids.has(id)) return fail(`${what}_duplicate_id`);
    ids.add(id);
    out.push(r.value);
  }
  return ok(out);
}

export function readOrder(value: unknown): Read<Order> {
  if (!isPlainObject(value)) return fail('not_object');
  if (typeof value.id !== 'string' || value.id === '') return fail('id');
  if (typeof value.checkout_id !== 'string') return fail('checkout_id');
  const permalinkUrl = readHttpsUrl(value.permalink_url);
  if (permalinkUrl === null) return fail('permalink_url');
  if (!isCurrencyCode(value.currency)) return fail('currency');
  const lines = readAll(value.line_items, readLine, 'line_items');
  if (!lines.ok) return lines;
  if (value.line_items === undefined) return fail('line_items');
  if (!isPlainObject(value.fulfillment)) return fail('fulfillment');
  const events = readAll(value.fulfillment.events, readEvent, 'events');
  if (!events.ok) return events;
  const adjustments = readAll(value.adjustments, readAdjustment, 'adjustments');
  if (!adjustments.ok) return adjustments;
  const totals = parseTotals(value.totals);
  if (!totals.ok) return fail(totals.reason);
  return ok({
    id: value.id,
    checkoutId: value.checkout_id,
    permalinkUrl,
    currency: value.currency,
    lines: lines.value,
    events: events.value,
    adjustments: adjustments.value,
    totals: totals.totals,
    messages: parseMessages(value.messages),
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
  });
}

// ------------------------------------------------------------ the kept record

/** What Dina keeps of one adjustment for as long as the order record exists. */
export interface KeptAdjustment {
  /** The type first seen; a later answer cannot re-type it. */
  type: string;
  /** The latest status. */
  status: AdjustmentStatus;
  seenCompleted: boolean;
  seenFailed: boolean;
}

/**
 * What Dina keeps of an order for as long as the record exists (§3.13 "seen
 * ids, kept for good"): each fulfillment event's type, and each adjustment's
 * kept state. Tracking numbers, URLs and descriptions stay in the open order's
 * snapshot, which is dropped at close (§3.14, S14).
 *
 * The maps are keyed by merchant-chosen ids, so they are null-prototype
 * objects read through `own`: an id named `__proto__` or `toString` is an
 * ordinary key.
 */
export interface OrderRecord {
  events: Readonly<Record<string, { type: string }>>;
  adjustments: Readonly<Record<string, KeptAdjustment>>;
}

export function emptyOrderRecord(): OrderRecord {
  return {
    events: Object.create(null) as Record<string, never>,
    adjustments: Object.create(null) as Record<string, never>,
  };
}

function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function copy<T>(map: Readonly<Record<string, T>>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const key of Object.keys(map)) out[key] = map[key] as T;
  return out;
}

export type Interruption =
  | { kind: 'event'; id: string; type: string }
  | { kind: 'adjustment'; id: string; type: string; reason: 'new' | 'settled' | 'failed' };

/**
 * Merge an order answer into the kept record (§3.13, §3.14). Nothing ever
 * leaves the record, so a replayed, older or redacted body adds no unseen id
 * and interrupts nothing. Interruptions come only from what is new to the
 * record: an event of an interrupting type; a dispute or cancellation first
 * seen, or first seen settled; or any adjustment first seen `failed`, in
 * whatever order the answers arrive. Each adjustment interrupts at most once
 * per answer.
 */
export function absorbOrder(
  record: OrderRecord,
  order: Order,
): { record: OrderRecord; interruptions: Interruption[] } {
  const events = copy(record.events);
  const adjustments = copy(record.adjustments);
  const interruptions: Interruption[] = [];

  for (const e of order.events) {
    if (own(events, e.id) !== undefined) continue;
    events[e.id] = { type: e.type };
    if (INTERRUPTING_EVENT_TYPES.has(e.type))
      interruptions.push({ kind: 'event', id: e.id, type: e.type });
  }

  for (const a of order.adjustments) {
    const before = own(adjustments, a.id);
    const type = before?.type ?? a.type;
    const kept: KeptAdjustment = {
      type,
      status: a.status,
      seenCompleted: (before?.seenCompleted ?? false) || a.status === 'completed',
      seenFailed: (before?.seenFailed ?? false) || a.status === 'failed',
    };
    adjustments[a.id] = kept;

    const wasSettled = before !== undefined && (before.seenCompleted || before.seenFailed);
    const firstSettled = !wasSettled && a.status !== 'pending';
    const firstFailed = !(before?.seenFailed ?? false) && a.status === 'failed';
    const interrupting = INTERRUPTING_ADJUSTMENT_TYPES.has(type);
    // First seen: a dispute or cancellation interrupts once, named by the status it arrives
    // with (one first seen already settled or failed is that, never "opened").
    if (interrupting && before === undefined)
      interruptions.push({
        kind: 'adjustment',
        id: a.id,
        type,
        reason: a.status === 'failed' ? 'failed' : a.status === 'completed' ? 'settled' : 'new',
      });
    else if (firstFailed)
      interruptions.push({ kind: 'adjustment', id: a.id, type, reason: 'failed' });
    else if (interrupting && firstSettled)
      interruptions.push({ kind: 'adjustment', id: a.id, type, reason: 'settled' });
  }
  return { record: { events, adjustments }, interruptions };
}

/** The line part of Dina's closed rule (§3.14): every line fulfilled or removed, no adjustment pending. */
export function linesSettled(order: Order, record: OrderRecord): boolean {
  if (!order.lines.every((l) => l.status === 'fulfilled' || l.status === 'removed')) return false;
  return Object.keys(record.adjustments).every(
    (id) => own(record.adjustments, id)?.status !== 'pending',
  );
}

/** The kept record as stored. */
export function orderRecordToJson(record: OrderRecord): string {
  return JSON.stringify({ events: record.events, adjustments: record.adjustments });
}

/**
 * A stored record read back into null-prototype maps; null when it is not
 * one. `JSON.parse` makes a `__proto__` key an own property, so every id
 * round-trips as an ordinary key.
 */
export function orderRecordFromJson(text: string): OrderRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(value) || !isPlainObject(value.events) || !isPlainObject(value.adjustments))
    return null;
  const out = emptyOrderRecord();
  const events = out.events as Record<string, { type: string }>;
  const adjustments = out.adjustments as Record<string, KeptAdjustment>;
  for (const id of Object.keys(value.events)) {
    const e = value.events[id];
    if (!isPlainObject(e) || typeof e.type !== 'string') return null;
    events[id] = { type: e.type };
  }
  for (const id of Object.keys(value.adjustments)) {
    const a = value.adjustments[id];
    if (
      !isPlainObject(a) ||
      typeof a.type !== 'string' ||
      !(ADJUSTMENT_STATUSES as readonly unknown[]).includes(a.status) ||
      typeof a.seenCompleted !== 'boolean' ||
      typeof a.seenFailed !== 'boolean'
    )
      return null;
    adjustments[id] = {
      type: a.type,
      status: a.status as AdjustmentStatus,
      seenCompleted: a.seenCompleted,
      seenFailed: a.seenFailed,
    };
  }
  return out;
}
