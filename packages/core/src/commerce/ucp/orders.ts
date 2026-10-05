/**
 * Following an order after the purchase (UCP plan §3.14, U3.2).
 *
 * A completed checkout names its order; from then Dina reads it with Get
 * Order on a schedule (every 15 minutes on the first day, hourly in the
 * first week, every 6 hours after, with jitter; daily on a node that takes
 * webhooks) until its closed rule.
 *
 * One reconciler per order: a poll (and, from U3.3, a webhook's prompt)
 * takes the order's lease, reads, and writes the snapshot, summary, kept
 * record and notices in one transaction under the lease's generation. A
 * holder whose lease was taken over writes nothing. Each part of an answer
 * merges on its own (`absorbOrder`): events are a union by id, adjustments
 * merge by id with the later status, lines and totals take the latest
 * answer. Event counts never judge an answer stale: a merchant may leave
 * events out or redact them.
 *
 * Closed rule (Dina's own): every line fulfilled or removed, no adjustment
 * pending, and nothing changed for 30 days; or the merchant answers
 * `not_found`; or it does not share the order, on a node that takes no
 * webhooks (on one that does, the order becomes webhook-only, U3.3); or 180
 * days have passed. A closed order drops its snapshot and keeps its summary.
 *
 * "Does not share": a business-level `unauthorized`, a Get Order answered
 * `capabilities_incompatible`, a merchant whose profile no longer offers
 * orders, or any 401 or 403. Until U4 builds account linking Dina holds no
 * token, so a Bearer challenge (`invalid_token`, `insufficient_scope`,
 * `identity_required`) has nothing to refresh or link, and counts the same.
 */

import { isPlainObject, parseStrictJson } from '@dina/a2a';
import {
  absorbOrder,
  decimalFromSteps,
  EACH,
  emptyOrderRecord,
  linesSettled,
  orderRecordFromJson,
  orderRecordToJson,
  readOrder,
  type AdjustmentStatus,
  type Interruption,
  type Order,
  type OrderRecord,
} from '@dina/ucp';

import { linkAnswers } from './merchant_client';
import {
  readPendingPush,
  type OrderKey,
  type OrderRow,
  type OrderWrite,
  type UcpOrderStore,
} from './order_store';

import type { CheckoutRow } from './checkout_store';
import type { CallResult, UcpMerchantClient } from './merchant_client';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long a reconciler holds an order before another may take it over. */
export const ORDER_LEASE_MS = 2 * MINUTE;
/** Settled and quiet this long: closed. */
export const SETTLED_QUIET_MS = 30 * DAY;
/** Closed whatever its state this long after it was first followed. */
export const ORDER_MAX_AGE_MS = 180 * DAY;
/** Orders read per sweep: a backlog drains over several sweeps. */
const SWEEP_LIMIT = 20;

/** What My Orders shows of an order; kept after close. Amounts are minor units, as strings. */
export interface OrderSummary {
  label?: string;
  currency: string;
  total: string | null;
  /**
   * `quantity` as a decimal in the line's unit ("1.5"); `unit` is the unit's
   * display text for anything not sold each ("kg"), absent for each.
   */
  lines: { title: string; quantity: string; unit?: string; status: string }[];
  /** The latest fulfillment event Dina has seen (kept when a later answer leaves it out). */
  latest_event: { type: string; occurred_at: number } | null;
  /** Every adjustment Dina has seen, with its latest status. */
  adjustments: { id: string; type: string; status: string }[];
  /** Every line fulfilled or removed and no adjustment pending. */
  settled: boolean;
  /**
   * A webhook-only order (§3.13): lines and totals are as the merchant last
   * sent them, may be out of date, and never close the order.
   */
  as_sent?: true;
}

/** An interruption waiting for the owner's surfaces (U3.4). */
export type OrderNotice = Interruption & { at: number };

export interface OrderServiceDeps {
  store: UcpOrderStore;
  client: Pick<UcpMerchantClient, 'open' | 'notReady'>;
  nowMs: () => number;
  /** This process's reconciler name. */
  holder: string;
  /** Whether this node takes real webhooks (U3.3); none until then. */
  takesWebhooks: () => boolean;
  /** A number in [0, 1) for the poll jitter. */
  random?: () => number;
  /**
   * Whether the owner could link an account at this merchant for these
   * scopes (`UcpLinkService.canLink`); none: never, and a challenge reads
   * as "does not share".
   */
  canLink?: (origin: string, scopes: readonly string[]) => Promise<'yes' | 'later' | 'never'>;
  /** The owner's link at this merchant, when there is one (`UcpLinkService.view`). */
  linkView?: (origin: string) => { state: string; updated_at: number } | null;
}

/** When the next poll falls: by the order's age, with ±10% jitter. */
export function nextOrderPollAt(
  createdAt: number,
  now: number,
  webhooks: boolean,
  random: () => number,
): number {
  const age = now - createdAt;
  const every = webhooks ? DAY : age < DAY ? 15 * MINUTE : age < 7 * DAY ? HOUR : 6 * HOUR;
  return now + Math.round(every * (0.9 + 0.2 * random()));
}

type Outcome =
  | { kind: 'order'; order: Order; value: unknown }
  | { kind: 'not_found' }
  | { kind: 'not_shared' }
  /**
   * The merchant asks for a linked account (a Bearer challenge: `identity_required`,
   * `insufficient_scope`): polling waits for the owner to link, then resumes.
   */
  | { kind: 'needs_link'; scopes: string[]; error?: string }
  /** Nothing usable: try again at the next poll (after `retryAfterMs` when the merchant asked). */
  | { kind: 'retry'; retryAfterMs?: number };

const errorCodes = (answer: CallResult): string[] =>
  !answer.ok && answer.kind === 'error_response'
    ? answer.messages.messages.filter((m) => m.type === 'error').map((m) => m.code ?? '')
    : [];

const NOT_SHARED_CODES = new Set(['unauthorized', 'capabilities_incompatible']);
const CAP_ORDER = 'dev.ucp.shopping.order';

/**
 * A 401 about Dina's own request signature (signatures.md:922-924): a stale
 * profile copy at the merchant or a key rotation, which passes; never a
 * refusal to share.
 */
const SIGNATURE_CODES = new Set(['signature_missing', 'signature_invalid', 'key_not_found']);

/**
 * Read one Get Order answer into what the reconciler does with it.
 * `offersOrders`: whether the merchant's negotiated profile lists the order
 * capability; Get Order can be unavailable while it does (its schema could
 * not be fetched just now), which passes.
 */
function outcomeOf(answer: CallResult, orderId: string, offersOrders: boolean): Outcome {
  if (answer.ok) {
    const read = readOrder(answer.value);
    // An answer about another order is not this one's.
    if (!read.ok || read.value.id !== orderId) return { kind: 'retry' };
    return { kind: 'order', order: read.value, value: answer.value };
  }
  const codes = errorCodes(answer);
  if (codes.includes('not_found')) return { kind: 'not_found' };
  if (codes.some((c) => NOT_SHARED_CODES.has(c))) return { kind: 'not_shared' };
  if (answer.kind === 'not_sent' && answer.reason === 'unavailable')
    return offersOrders ? { kind: 'retry' } : { kind: 'not_shared' };
  if (answer.kind === 'transport') {
    const { error } = answer;
    const http = error.httpStatus ?? error.status;
    if (error.code === 'not_found') return { kind: 'not_found' };
    if (SIGNATURE_CODES.has(error.code)) return { kind: 'retry' };
    // A Bearer challenge a link answers (identity-linking §identity_required,
    // §insufficient_scope): no token yet, a missing scope, or a token the merchant
    // client could not renew. Whether this merchant can be linked is the caller's check.
    const challenge = error.challenge;
    if ((http === 401 || http === 403) && challenge !== undefined && linkAnswers(challenge))
      return {
        kind: 'needs_link',
        scopes: challenge.scopes ?? [],
        ...(challenge.error !== undefined ? { error: challenge.error } : {}),
      };
    if (http === 401 || http === 403 || NOT_SHARED_CODES.has(error.code))
      return { kind: 'not_shared' };
    return {
      kind: 'retry',
      ...(error.retryAfter !== undefined ? { retryAfterMs: error.retryAfter * 1000 } : {}),
    };
  }
  return { kind: 'retry' };
}

/** The summary of an answer merged into what was kept. */
export function summarise(
  order: Order,
  record: OrderRecord,
  before: OrderSummary | null,
): OrderSummary {
  let latest = before?.latest_event ?? null;
  for (const e of order.events)
    if (latest === null || e.occurredAt > latest.occurred_at)
      latest = { type: e.type, occurred_at: e.occurredAt };
  const total = order.totals.find((t) => t.type === 'total');
  return {
    ...(order.label !== undefined ? { label: order.label } : {}),
    currency: order.currency,
    total: total === undefined ? null : total.amount.toString(),
    lines: order.lines.map((l) => ({
      title: l.title,
      quantity: decimalFromSteps(l.quantity.total, l.unit.scale),
      ...(l.unit.unit !== EACH.unit ? { unit: l.unit.displayText } : {}),
      status: l.status,
    })),
    latest_event: latest,
    adjustments: Object.keys(record.adjustments).map((id) => {
      const a = record.adjustments[id] as { type: string; status: string };
      return { id, type: a.type, status: a.status };
    }),
    settled: linesSettled(order, record),
  };
}

/** When an order closes by age (§3.14). */
const agedAt = (row: OrderRow): number => row.created_at + ORDER_MAX_AGE_MS;

const isStr = (v: unknown): v is string => typeof v === 'string';

/**
 * A stored summary read back field by field; null when it is not one (it
 * is then rebuilt from the next answer, never half-believed).
 */
export function readOrderSummary(text: string | null): OrderSummary | null {
  if (text === null) return null;
  const parsed = parseStrictJson(text);
  if (!parsed.ok || !isPlainObject(parsed.value)) return null;
  const v = parsed.value;
  if (!isStr(v.currency) || !(v.total === null || isStr(v.total))) return null;
  if (typeof v.settled !== 'boolean') return null;
  if (v.label !== undefined && !isStr(v.label)) return null;
  if (v.as_sent !== undefined && v.as_sent !== true) return null;
  if (!Array.isArray(v.lines) || !Array.isArray(v.adjustments)) return null;
  const lines: OrderSummary['lines'] = [];
  for (const l of v.lines as unknown[]) {
    if (!isPlainObject(l) || !isStr(l.title) || !isStr(l.quantity) || !isStr(l.status)) return null;
    if (l.unit !== undefined && !isStr(l.unit)) return null;
    lines.push({
      title: l.title,
      quantity: l.quantity,
      ...(isStr(l.unit) ? { unit: l.unit } : {}),
      status: l.status,
    });
  }
  const adjustments: OrderSummary['adjustments'] = [];
  for (const a of v.adjustments as unknown[]) {
    if (!isPlainObject(a) || !isStr(a.id) || !isStr(a.type) || !isStr(a.status)) return null;
    adjustments.push({ id: a.id, type: a.type, status: a.status });
  }
  const e: unknown = v.latest_event;
  let latest: OrderSummary['latest_event'] = null;
  if (e !== null) {
    if (!isPlainObject(e) || !isStr(e.type) || !Number.isSafeInteger(e.occurred_at)) return null;
    latest = { type: e.type, occurred_at: e.occurred_at as number };
  }
  return {
    ...(isStr(v.label) ? { label: v.label } : {}),
    currency: v.currency,
    total: v.total,
    lines,
    latest_event: latest,
    adjustments,
    settled: v.settled,
    ...(v.as_sent === true ? { as_sent: true as const } : {}),
  };
}

export class UcpOrderService {
  private readonly random: () => number;

  constructor(private readonly deps: OrderServiceDeps) {
    this.random = deps.random ?? Math.random;
  }

  /**
   * Follow the order a completed checkout named. Called in the transaction
   * that records the completion, so a completed session never lacks its
   * order row. The first poll is due at once.
   */
  track(session: CheckoutRow, now: number): void {
    if (
      session.order_id === null ||
      session.order_permalink_url === null ||
      session.merchant_checkout_id === null
    )
      return;
    this.deps.store.insert({
      merchant_origin: session.merchant_origin,
      order_id: session.order_id,
      checkout_id: session.merchant_checkout_id,
      session_id: session.session_id,
      leaf_profile_url: session.leaf_profile_url,
      permalink_url: session.order_permalink_url,
      version: session.version,
      transport: session.transport,
      record_json: orderRecordToJson(emptyOrderRecord()),
      next_poll_at: now,
      created_at: now,
    });
  }

  /** Poll every open order that is due. */
  async sweep(): Promise<void> {
    if (this.deps.client.notReady() !== null) return;
    // Webhook-only orders are fed by webhooks alone: with none coming any more, they close.
    if (!this.deps.takesWebhooks()) this.deps.store.wakeNotShared(this.deps.nowMs());
    for (const row of this.deps.store.due(this.deps.nowMs(), SWEEP_LIMIT)) {
      try {
        await this.reconcile(row);
      } catch {
        /* one order's fault never holds up the others */
      }
    }
  }

  /** Read one order under its lease and apply the answer; false when another reconciler holds it. */
  async reconcile(key: OrderKey): Promise<boolean> {
    const { store, holder } = this.deps;
    const generation = store.takeLease(key, holder, this.deps.nowMs(), ORDER_LEASE_MS);
    if (generation === null) return false;
    try {
      const row = store.get(key);
      if (row === null || row.state === 'closed') return true;
      // Aged out: closed without asking.
      if (this.deps.nowMs() >= row.created_at + ORDER_MAX_AGE_MS) {
        store.apply(key, holder, generation, this.closing('aged'), this.deps.nowMs());
        return true;
      }
      // Webhook-only: never polled; woken to close at 180 days, or once webhooks stop. What
      // webhooks said meanwhile (a pending push) is merged in the same write.
      if (row.state === 'not_shared') {
        const now = this.deps.nowMs();
        const write = this.deps.takesWebhooks()
          ? { next_poll_at: agedAt(row) }
          : this.closing('not_shared');
        store.apply(key, holder, generation, this.withPending(row, write, now), now);
        return true;
      }
      const startedAt = this.deps.nowMs();
      const outcome = await this.read(row, startedAt);
      const now = this.deps.nowMs();
      // Read again with no wait before the write: a webhook may have come during the read.
      const fresh = store.get(key) ?? row;
      let write = this.writeFor(row, outcome);
      if (outcome.kind === 'not_shared') {
        // Not shared: what webhooks said is all Dina has (§3.13), merged in this same write.
        write = this.withPending(fresh, write, now);
      } else if (outcome.kind !== 'retry' && outcome.kind !== 'needs_link') {
        // Get Order answered: what webhooks said before this read began is in its answer; a
        // body that came during it is kept for the next read.
        const pending = readPendingPush(fresh.pushed_json);
        if (pending !== null && pending.latest.at <= startedAt)
          write = { ...write, pushed_json: null };
      }
      store.apply(key, holder, generation, write, now, {
        startedAt,
        ok: outcome.kind !== 'retry',
        ...(outcome.kind === 'retry' && outcome.retryAfterMs !== undefined
          ? { notBefore: Math.min(now + outcome.retryAfterMs, agedAt(row)) }
          : {}),
      });
      return true;
    } finally {
      store.releaseLease(key, holder, generation);
    }
  }

  /**
   * `write`, with what webhooks said while the order was open merged in
   * (§3.13): their events and adjustments joined to the order's record, a
   * card for each the record did not have yet, and the latest body "as
   * sent"; the pending push then goes. Unchanged when there is none.
   */
  private withPending(row: OrderRow, write: OrderWrite, now: number): OrderWrite {
    const pending = readPendingPush(row.pushed_json);
    if (pending === null) return write;
    const kept = orderRecordFromJson(row.record_json) ?? emptyOrderRecord();
    const latest = readOrder(pending.latest.body);
    const ours = latest.ok && latest.value.id === row.order_id;
    const { record, interruptions } = foldPending(kept, pending.record);
    const recordJson = orderRecordToJson(record);
    const summaryJson = ours
      ? JSON.stringify({
          ...summarise(latest.value, record, readOrderSummary(row.summary_json)),
          as_sent: true,
        })
      : row.summary_json;
    const changed = recordJson !== row.record_json || summaryJson !== row.summary_json;
    return {
      record_json: recordJson,
      summary_json: summaryJson,
      snapshot_json: ours ? JSON.stringify(pending.latest.body) : row.snapshot_json,
      last_change_at: changed ? now : row.last_change_at,
      notices: interruptions.map((i) => ({ ...i, at: now })),
      // The write's own fields win (a closing drops the snapshot); the pending push always goes.
      ...write,
      pushed_json: null,
    };
  }

  private async read(row: OrderRow, startedAt: number): Promise<Outcome> {
    const opened = await this.deps.client.open(row.merchant_origin);
    if (!opened.ok) return { kind: 'retry' };
    const { connection } = opened;
    const outcome = outcomeOf(
      await connection.call('get_order', { id: row.order_id }),
      row.order_id,
      connection.merchant.negotiated.has(CAP_ORDER),
    );
    // A link Dina can never make is a merchant that does not share (§3.14); one it cannot make
    // just now (the sign-in out of reach, no phone paired yet) is asked about again next poll.
    if (outcome.kind === 'needs_link') {
      // With a live link, only a missing scope is the owner's to answer; anything else is a
      // passing fault (a token being renewed), and a link that changed while this read was
      // out (one just made or extended) is used on the next read rather than paused for.
      const link = this.deps.linkView?.(row.merchant_origin) ?? null;
      if (
        link !== null &&
        link.state === 'active' &&
        (outcome.error !== 'insufficient_scope' || link.updated_at >= startedAt)
      )
        return { kind: 'retry' };
      const linkable = (await this.deps.canLink?.(row.merchant_origin, outcome.scopes)) ?? 'never';
      if (linkable === 'never') return { kind: 'not_shared' };
      if (linkable === 'later') return { kind: 'retry' };
    }
    return outcome;
  }

  /** What one outcome writes, by the closed rule. */
  private writeFor(row: OrderRow, outcome: Outcome): OrderWrite {
    const now = this.deps.nowMs();
    const webhooks = this.deps.takesWebhooks();
    switch (outcome.kind) {
      case 'not_found':
        return this.closing('not_found');
      case 'not_shared':
        // A node that takes webhooks keeps the order, fed by them alone (§3.13), until 180 days.
        return webhooks
          ? { state: 'not_shared', next_poll_at: agedAt(row) }
          : this.closing('not_shared');
      case 'needs_link':
        // Polling waits for the owner; a completed link resumes it (`resumeAfterLink`).
        // Unlinked, the order still closes by age.
        return { next_poll_at: agedAt(row), link_scopes: JSON.stringify(outcome.scopes) };
      case 'retry': {
        const next = nextOrderPollAt(row.created_at, now, webhooks, this.random);
        // The merchant's wait is honoured, but never past the day the order closes by age.
        return {
          next_poll_at: Math.min(Math.max(next, now + (outcome.retryAfterMs ?? 0)), agedAt(row)),
        };
      }
      case 'order':
        return this.absorb(row, outcome.order, outcome.value, now, webhooks);
    }
  }

  private absorb(
    row: OrderRow,
    order: Order,
    value: unknown,
    now: number,
    webhooks: boolean,
  ): OrderWrite {
    const kept = orderRecordFromJson(row.record_json) ?? emptyOrderRecord();
    const { record, interruptions } = absorbOrder(kept, order);
    const recordJson = orderRecordToJson(record);
    const before = readOrderSummary(row.summary_json);
    const summary = summarise(order, record, before);
    const summaryJson = JSON.stringify(summary);
    const changed = recordJson !== row.record_json || summaryJson !== row.summary_json;
    const lastChange = changed ? now : row.last_change_at;
    const write: OrderWrite = {
      // Read: whatever link it waited for is there now.
      link_scopes: null,
      record_json: recordJson,
      summary_json: summaryJson,
      snapshot_json: JSON.stringify(value),
      last_change_at: lastChange,
      notices: interruptions.map((i) => ({ ...i, at: now })),
    };
    if (summary.settled && now - lastChange >= SETTLED_QUIET_MS)
      return { ...write, ...this.closing('settled') };
    return {
      ...write,
      next_poll_at: Math.min(
        nextOrderPollAt(row.created_at, now, webhooks, this.random),
        agedAt(row),
      ),
    };
  }

  /**
   * A verified webhook's body for an order Dina does not poll (§3.13): a
   * webhook-only order, or a closed one. Nothing orders these bodies, so
   * only what is new to the kept record counts: unseen ids are added and
   * may interrupt; a webhook-only order shows the body's lines and totals
   * "as sent"; a closed order stays closed. Synchronous, under the order's
   * lease, so the caller can write it with the delivery's dedupe record in
   * one transaction. False while another reconciler holds the order.
   */
  absorbPushed(key: OrderKey, order: Order, value: unknown): boolean {
    const { store, holder } = this.deps;
    const now = this.deps.nowMs();
    const generation = store.takeLease(key, holder, now, ORDER_LEASE_MS);
    if (generation === null) return false;
    try {
      const row = store.get(key);
      if (row === null || row.state === 'open') return true;
      const kept = orderRecordFromJson(row.record_json) ?? emptyOrderRecord();
      const { record, interruptions } = absorbOrder(kept, order);
      const recordJson = orderRecordToJson(record);
      const notices = interruptions.map((i) => ({ ...i, at: now }));
      if (row.state === 'closed') {
        store.apply(key, holder, generation, { record_json: recordJson, notices }, now);
        return true;
      }
      const summary: OrderSummary = {
        ...summarise(order, record, readOrderSummary(row.summary_json)),
        as_sent: true,
      };
      const summaryJson = JSON.stringify(summary);
      const changed = recordJson !== row.record_json || summaryJson !== row.summary_json;
      store.apply(
        key,
        holder,
        generation,
        {
          record_json: recordJson,
          summary_json: summaryJson,
          snapshot_json: JSON.stringify(value),
          last_change_at: changed ? now : row.last_change_at,
          notices,
        },
        now,
      );
      return true;
    } finally {
      store.releaseLease(key, holder, generation);
    }
  }

  private closing(reason: 'settled' | 'not_found' | 'not_shared' | 'aged'): OrderWrite {
    return {
      state: 'closed',
      close_reason: reason,
      // Raw merchant bodies do not outlive the order's tracking (§3.14, S14).
      snapshot_json: null,
      pushed_json: null,
      link_scopes: null,
      next_poll_at: null,
      closed_at: this.deps.nowMs(),
    };
  }
}

/**
 * `extra` (events and adjustments folded from webhook bodies) merged into
 * `kept`, raising each interruption `absorbOrder` would: an adjustment ever
 * failed is fed as failed first, one ever completed as completed, then each
 * at its latest status, so a first-seen dispute, failure or settlement is
 * named as it would have been had each body been absorbed as it came.
 */
export function foldPending(
  kept: OrderRecord,
  extra: OrderRecord,
): { record: OrderRecord; interruptions: Interruption[] } {
  const events = Object.keys(extra.events).map((id) => ({
    id,
    type: (extra.events[id] as { type: string }).type,
  }));
  const adjustments = (pick: (a: OrderRecord['adjustments'][string]) => AdjustmentStatus | null) =>
    Object.keys(extra.adjustments).flatMap((id) => {
      const a = extra.adjustments[id] as OrderRecord['adjustments'][string];
      const status = pick(a);
      return status === null ? [] : [{ id, type: a.type, status }];
    });
  const passes = [
    adjustments((a) => (a.seenFailed ? 'failed' : null)),
    adjustments((a) => (a.seenCompleted ? 'completed' : null)),
    adjustments((a) => a.status),
  ];
  let record = kept;
  const interruptions: Interruption[] = [];
  for (const adj of passes) {
    // Only events and adjustments are read by the fold; the rest of an order is not needed here.
    const out = absorbOrder(record, { events, adjustments: adj } as unknown as Order);
    record = out.record;
    interruptions.push(...out.interruptions);
  }
  return { record, interruptions };
}
