/**
 * Following an order (UCP plan §3.14, U3.2): every way Get Order can answer,
 * the merge across answers, the reconciler's lease, the schedule and the
 * closed rule. A fake merchant connection answers; the store is real SQL.
 */

import { parseMessages, readOrder } from '@dina/ucp';

import {
  orderAnswer,
  orderFrom,
  orderUnauthorized,
  type MockOrder,
} from '../../../../test-harness/src/ucp_merchant/orders';
import { UcpOrderStore, storedNotices, type OrderRow } from '../../../src/commerce/ucp/order_store';
import { ucpOrderView } from '../../../src/commerce/ucp/order_view';
import {
  nextOrderPollAt,
  ORDER_LEASE_MS,
  ORDER_MAX_AGE_MS,
  SETTLED_QUIET_MS,
  readOrderSummary,
  UcpOrderService,
  type OrderSummary,
} from '../../../src/commerce/ucp/orders';

import { freshDatabase } from './mock_harness';

import type { CheckoutRow } from '../../../src/commerce/ucp/checkout_store';
import type { CallResult } from '../../../src/commerce/ucp/merchant_client';

const ORIGIN = 'https://shop.test';
const KEY = { merchant_origin: ORIGIN, order_id: 'ord_1' };
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

let database: ReturnType<typeof freshDatabase>;
let store: UcpOrderStore;
let clock: number;
let order: MockOrder;
/** What the merchant answers next; the order itself by default. */
let answer: () => CallResult | Promise<CallResult>;
let calls: number;
let webhooks: boolean;
let opened: boolean;
/** Whether the merchant's negotiated profile lists the order capability. */
let offersOrders: boolean;

const shared = (): CallResult => ({
  ok: true,
  value: orderAnswer(order, ORIGIN) as never,
  messages: { messages: [], unreadable: 0 },
});
const errorResponse = (value: Record<string, unknown>): CallResult => ({
  ok: false,
  kind: 'error_response',
  messages: parseMessages(value.messages),
});
const transport = (httpStatus: number, code: string, retryAfter?: number): CallResult => ({
  ok: false,
  kind: 'transport',
  error: {
    status: httpStatus,
    httpStatus,
    code,
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  },
});

function service(
  over: {
    holder?: string;
    canLink?: (o: string, s: readonly string[]) => Promise<'yes' | 'later' | 'never'>;
    linkView?: (o: string) => { state: string; updated_at: number } | null;
  } = {},
): UcpOrderService {
  return new UcpOrderService({
    store,
    client: {
      notReady: () => null,
      open: async () => {
        if (!opened) return { ok: false, reason: 'unreachable' } as never;
        return {
          ok: true,
          connection: {
            merchant: {
              negotiated: new Map(offersOrders ? [['dev.ucp.shopping.order', {}]] : []),
            },
            call: async (operation: string, input: { id?: string }) => {
              calls++;
              expect(operation).toBe('get_order');
              expect(input.id).toBe('ord_1');
              return answer();
            },
          },
        } as never;
      },
    },
    nowMs: () => clock,
    holder: over.holder ?? 'me',
    takesWebhooks: () => webhooks,
    random: () => 0.5,
    ...(over.canLink !== undefined ? { canLink: over.canLink } : {}),
    ...(over.linkView !== undefined ? { linkView: over.linkView } : {}),
  });
}

const session = {
  session_id: 's1',
  merchant_origin: ORIGIN,
  merchant_checkout_id: 'co_1',
  leaf_profile_url: `${ORIGIN}/.well-known/ucp`,
  version: '2026-08-25',
  transport: 'rest',
  order_id: 'ord_1',
  order_permalink_url: `${ORIGIN}/orders/ord_1`,
} as CheckoutRow;

/** The order's row; a test that finds none fails here. */
function held(): OrderRow {
  const r = store.get(KEY);
  if (r === null) throw new Error('no order row');
  return r;
}
const row = () => store.get(KEY);
const summary = () => JSON.parse(row()?.summary_json ?? 'null') as OrderSummary | null;
const notices = () =>
  JSON.parse(row()?.notices_json ?? '[]') as { type: string; reason?: string }[];

beforeEach(() => {
  database = freshDatabase('orders');
  store = new UcpOrderStore(database.db);
  clock = Date.parse('2026-10-05T10:00:00Z');
  order = orderFrom('ord_1', 'co_1', 'EUR', [
    { id: 'li_1', variantId: 'v1', title: 'Sencha 100 g', price: 900, quantity: 2 },
  ]);
  answer = shared;
  calls = 0;
  webhooks = false;
  opened = true;
  offersOrders = true;
  service().track(session, clock);
});

afterEach(() => database.close());

describe('tracking and the first read', () => {
  it('a tracked order is due at once; the read records the summary, snapshot and next poll', async () => {
    expect(row()).toMatchObject({ state: 'open', next_poll_at: clock, polls: 0 });
    // Tracked twice (a repeated completion): one row.
    service().track(session, clock + 1);
    expect(store.recent(10)).toHaveLength(1);
    await service().sweep();
    expect(calls).toBe(1);
    expect(summary()).toEqual({
      currency: 'EUR',
      total: '1800',
      lines: [{ title: 'Sencha 100 g', quantity: '2', status: 'processing' }],
      latest_event: null,
      adjustments: [],
      settled: false,
    });
    expect(row()).toMatchObject({
      polls: 1,
      next_poll_at: clock + 15 * MIN,
      last_change_at: clock,
    });
    expect(row()?.snapshot_json).toContain('"ord_1"');
    expect(row()?.lease_holder).toBeNull();
    // Not due again until then.
    await service().sweep();
    expect(calls).toBe(1);
  });

  it('a line sold by weight keeps its unit: 1.5 kg, never 1500 steps', async () => {
    order.lines.push({
      id: 'li_2',
      variantId: 'v2',
      title: 'Rice',
      price: 4,
      quantity: 1500,
      unit: { unit: 'KGM', scale: 3, display_text: 'kg', increment: 500 },
      fulfilled: 0,
      status: 'processing',
    });
    await service().reconcile(KEY);
    expect(summary()?.lines).toEqual([
      { title: 'Sencha 100 g', quantity: '2', status: 'processing' },
      { title: 'Rice', quantity: '1.5', unit: 'kg', status: 'processing' },
    ]);
  });

  it('a session without an order names nothing to follow', () => {
    service().track({ ...session, session_id: 's2', order_id: null } as CheckoutRow, clock);
    expect(store.recent(10)).toHaveLength(1);
  });
});

describe('merging answers (§3.14)', () => {
  it('a stored shipment survives an answer with events: [] and a new pending dispute, which interrupts once', async () => {
    order.events.push({
      id: 'e1',
      type: 'shipped',
      occurredAt: clock - 60 * MIN,
      lineItems: [{ id: 'li_1', quantity: 2 }],
    });
    await service().reconcile(KEY);
    expect(summary()?.latest_event).toEqual({ type: 'shipped', occurred_at: clock - 60 * MIN });
    expect(notices()).toEqual([]);
    // The merchant redacts its events and opens a dispute.
    order.events = [];
    order.adjustments.push({ id: 'a1', type: 'dispute', occurredAt: clock, status: 'pending' });
    clock += 15 * MIN;
    await service().reconcile(KEY);
    expect(summary()?.latest_event).toEqual({ type: 'shipped', occurred_at: clock - 75 * MIN });
    expect(Object.keys(JSON.parse(row()?.record_json ?? '{}').events)).toEqual(['e1']);
    expect(notices()).toMatchObject([{ kind: 'adjustment', type: 'dispute', reason: 'new' }]);
    // The same answer again interrupts nothing more.
    clock += 15 * MIN;
    await service().reconcile(KEY);
    expect(notices()).toHaveLength(1);
    // The dispute settles: one more interruption.
    (order.adjustments[0] as { status: string }).status = 'completed';
    await service().reconcile(KEY);
    expect(notices()).toHaveLength(2);
    expect(summary()?.adjustments).toEqual([{ id: 'a1', type: 'dispute', status: 'completed' }]);
  });

  it('only failures, cancellations and disputes interrupt: a shipment and a refund are recorded quietly', async () => {
    order.events.push({ id: 'e1', type: 'shipped', occurredAt: clock, lineItems: [] });
    order.adjustments.push({ id: 'r1', type: 'refund', occurredAt: clock, status: 'completed' });
    await service().reconcile(KEY);
    expect(notices()).toEqual([]);
    order.events.push({ id: 'e2', type: 'failed_attempt', occurredAt: clock + 1, lineItems: [] });
    await service().reconcile(KEY);
    expect(notices()).toMatchObject([{ kind: 'event', type: 'failed_attempt' }]);
  });

  it('an answer about another order is not applied; polling goes on', async () => {
    answer = () => ({
      ok: true,
      value: orderAnswer({ ...order, id: 'ord_2' }, ORIGIN) as never,
      messages: { messages: [], unreadable: 0 },
    });
    await service().reconcile(KEY);
    expect(row()).toMatchObject({
      summary_json: null,
      state: 'open',
      next_poll_at: clock + 15 * MIN,
    });
  });

  it('the mock’s answer is a valid order', () => {
    expect(readOrder(orderAnswer(order, ORIGIN)).ok).toBe(true);
  });
});

describe('one reconciler per order: the lease', () => {
  it('a running lease keeps others out; one past its end is taken over and the old holder writes nothing', async () => {
    const theirs = store.takeLease(KEY, 'other', clock, ORDER_LEASE_MS);
    expect(theirs).toBe(1);
    expect(await service().reconcile(KEY)).toBe(false);
    expect(calls).toBe(0);
    // The other holder crashed: after its lease, this one takes over.
    clock += ORDER_LEASE_MS;
    expect(await service().reconcile(KEY)).toBe(true);
    expect(row()).toMatchObject({ generation: 2, polls: 1, lease_holder: null });
    // The crashed holder's late answer is dropped whole.
    expect(store.apply(KEY, 'other', 1, { summary_json: '{}' }, clock)).toBe(false);
    expect(summary()?.total).toBe('1800');
  });

  it('a read in flight holds the lease: a second reconcile waits its turn', async () => {
    let release!: () => void;
    answer = () =>
      new Promise((resolve) => {
        release = () => resolve(shared());
      });
    const first = service().reconcile(KEY);
    await new Promise((r) => setImmediate(r));
    expect(await service({ holder: 'two' }).reconcile(KEY)).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(row()?.polls).toBe(1);
  });
});

describe('answers in reverse order (T-U3-6)', () => {
  it('a read whose lease lapsed mid-flight cannot overwrite the newer answer a later holder applied', async () => {
    // The first reader asks while the order is still processing, and its answer is slow.
    const older = shared();
    let release!: () => void;
    answer = () =>
      new Promise((resolve) => {
        release = () => resolve(older);
      });
    const slow = service({ holder: 'slow' }).reconcile(KEY);
    await new Promise((r) => setImmediate(r));
    // Its lease lapses; the merchant ships; another holder reads and applies the newer answer.
    clock += ORDER_LEASE_MS;
    order.events.push({ id: 'e1', type: 'shipped', occurredAt: clock, lineItems: [] });
    (order.lines[0] as { status: string }).status = 'fulfilled';
    answer = shared;
    expect(await service({ holder: 'fast' }).reconcile(KEY)).toBe(true);
    // The older answer arrives last, and is dropped whole.
    release();
    await slow;
    expect(summary()).toMatchObject({
      lines: [{ status: 'fulfilled' }],
      latest_event: { type: 'shipped' },
      settled: true,
    });
    expect(row()).toMatchObject({ polls: 1, generation: 2, lease_holder: null });
  });
});

describe('privacy: what outlives the snapshot', () => {
  it('a tracking number stays in the snapshot only, and is gone once the order closes', async () => {
    order.events.push({
      id: 'e1',
      type: 'shipped',
      occurredAt: clock,
      lineItems: [],
      trackingNumber: 'TRK-SECRET-1',
    });
    await service().reconcile(KEY);
    const kept = () => {
      const r = row();
      return [r?.summary_json, r?.record_json, r?.notices_json].join('|');
    };
    expect(row()?.snapshot_json).toContain('TRK-SECRET-1');
    expect(kept()).not.toContain('TRK-SECRET-1');
    answer = () =>
      errorResponse({
        messages: [
          { type: 'error', code: 'not_found', content: 'gone', severity: 'unrecoverable' },
        ],
      });
    await service().reconcile(KEY);
    expect(row()?.state).toBe('closed');
    expect(JSON.stringify(row())).not.toContain('TRK-SECRET-1');
  });
});

describe('a merchant that will not share the order', () => {
  it.each<[string, () => CallResult]>([
    ['a business-level unauthorized', () => errorResponse(orderUnauthorized())],
    [
      'a 401 identity_required (no linked account before U4)',
      () => transport(401, 'identity_required'),
    ],
    ['a 403 with no challenge', () => transport(403, 'unknown')],
    [
      'capabilities_incompatible',
      () =>
        errorResponse({
          messages: [
            {
              type: 'error',
              code: 'capabilities_incompatible',
              content: 'x',
              severity: 'unrecoverable',
            },
          ],
        }),
    ],
  ])('%s closes it on a node with no webhooks, and keeps the permalink', async (_n, refusal) => {
    answer = refusal;
    await service().reconcile(KEY);
    expect(row()).toMatchObject({
      state: 'closed',
      close_reason: 'not_shared',
      next_poll_at: null,
      permalink_url: `${ORIGIN}/orders/ord_1`,
    });
  });

  it('a profile that no longer offers orders closes it too', async () => {
    offersOrders = false;
    answer = () => ({ ok: false, kind: 'not_sent', reason: 'unavailable' });
    await service().reconcile(KEY);
    expect(row()).toMatchObject({ state: 'closed', close_reason: 'not_shared' });
  });

  it.each<[string, () => CallResult]>([
    [
      'Get Order unavailable while the profile offers orders (its schema not fetched just now)',
      () => ({ ok: false, kind: 'not_sent', reason: 'unavailable' }),
    ],
    [
      'a 401 about Dina’s own signature (signature_invalid)',
      () => transport(401, 'signature_invalid'),
    ],
    [
      'a 401 key_not_found (a rotation the merchant has not read yet)',
      () => transport(401, 'key_not_found'),
    ],
    ['a 401 signature_missing', () => transport(401, 'signature_missing')],
  ])('%s passes: the order stays open and is asked again', async (_n, refusal) => {
    answer = refusal;
    await service().reconcile(KEY);
    expect(row()).toMatchObject({ state: 'open', next_poll_at: clock + 15 * MIN });
  });

  it('on a node that takes webhooks it is kept, fed by them alone', async () => {
    webhooks = true;
    answer = () => errorResponse(orderUnauthorized());
    await service().reconcile(KEY);
    const created = row()?.created_at as number;
    // Never polled again; woken only to close at 180 days.
    expect(row()).toMatchObject({
      state: 'not_shared',
      next_poll_at: created + ORDER_MAX_AGE_MS,
      closed_at: null,
    });
    clock += DAY;
    await service().sweep();
    expect(calls).toBe(1);
    clock = created + ORDER_MAX_AGE_MS;
    await service().sweep();
    expect(calls).toBe(1);
    expect(row()).toMatchObject({ state: 'closed', close_reason: 'aged' });
  });
});

describe('a merchant that asks for a linked account (U4, §3.14)', () => {
  const challenged =
    (status: number, challenge: Record<string, unknown>, code = 'identity_required') =>
    (): CallResult => ({
      ok: false,
      kind: 'transport',
      error: { status, httpStatus: status, code, challenge } as never,
    });
  const MISSING = challenged(
    403,
    { error: 'insufficient_scope', scopes: ['dev.ucp.shopping.order:read'] },
    'insufficient_scope',
  );
  const asked: { origin: string; scopes: readonly string[] }[] = [];
  const linkable = async (origin: string, scopes: readonly string[]) => {
    asked.push({ origin, scopes });
    return 'yes' as const;
  };
  beforeEach(() => (asked.length = 0));

  it('a challenge the owner can answer pauses polling and keeps the order open; a completed link resumes it', async () => {
    answer = MISSING;
    await service({ canLink: linkable }).reconcile(KEY);
    expect(asked).toEqual([{ origin: ORIGIN, scopes: ['dev.ucp.shopping.order:read'] }]);
    expect(row()).toMatchObject({
      state: 'open',
      // Unlinked, the order is woken only to close by age.
      next_poll_at: held().created_at + 180 * DAY,
      link_scopes: '["dev.ucp.shopping.order:read"]',
    });
    expect(ucpOrderView(held()).headline).toBe(
      'Link your account at shop.test to follow this order',
    );
    // Not polled while it waits.
    clock += 7 * DAY;
    await service({ canLink: linkable }).sweep();
    expect(calls).toBe(1);
    // The owner links: polling goes on.
    expect(store.resumeAfterLink(ORIGIN, clock)).toBe(1);
    answer = shared;
    await service({ canLink: linkable }).sweep();
    expect(row()).toMatchObject({ link_scopes: null, polls: 2 });
    expect(summary()?.total).toBe('1800');
  });

  it('never linked, the paused order still closes at 180 days', async () => {
    answer = MISSING;
    await service({ canLink: linkable }).reconcile(KEY);
    clock = held().created_at + 180 * DAY;
    await service({ canLink: linkable }).sweep();
    expect(row()).toMatchObject({ state: 'closed', close_reason: 'aged' });
    expect(calls).toBe(1);
  });

  it.each([
    ['no token yet (identity_required)', challenged(401, {})],
    ['a token the merchant client could not renew', challenged(401, { error: 'invalid_token' })],
  ])('%s pauses too, asking for the scopes Dina uses', async (_name, a) => {
    answer = a;
    await service({ canLink: linkable }).reconcile(KEY);
    expect(row()).toMatchObject({ state: 'open', link_scopes: '[]' });
  });

  it.each([
    ['a merchant Dina can never link with', MISSING, async () => 'never' as const],
    ['a node with no link service', MISSING, undefined],
    [
      'a challenge a link does not answer (invalid_request)',
      challenged(401, { error: 'invalid_request' }),
      linkable,
    ],
  ])('%s: the merchant does not share the order', async (_name, a, canLink) => {
    answer = a;
    await service(canLink === undefined ? {} : { canLink }).reconcile(KEY);
    expect(row()).toMatchObject({ state: 'closed', close_reason: 'not_shared', link_scopes: null });
  });

  it('a link Dina cannot make just now (the sign-in out of reach, no phone yet): the order stays open and is asked again', async () => {
    answer = MISSING;
    await service({ canLink: async () => 'later' }).reconcile(KEY);
    expect(row()).toMatchObject({ state: 'open', link_scopes: null, close_reason: null });
    expect(row()?.next_poll_at).toBeGreaterThan(clock);
    // Next poll, the sign-in answers: now it waits for the owner.
    clock = row()?.next_poll_at ?? clock;
    await service({ canLink: linkable }).sweep();
    expect(row()).toMatchObject({ state: 'open', link_scopes: '["dev.ucp.shopping.order:read"]' });
  });

  it('with a live link, only a missing scope pauses: anything else is a token being renewed, and the order keeps polling', async () => {
    const live = () => ({ state: 'active', updated_at: clock - DAY });
    answer = challenged(401, {});
    await service({ canLink: linkable, linkView: live }).reconcile(KEY);
    expect(row()).toMatchObject({ state: 'open', link_scopes: null });
    expect(row()?.next_poll_at).toBeLessThan(held().created_at + 180 * DAY);
    answer = challenged(401, { error: 'invalid_token' });
    clock = row()?.next_poll_at ?? clock;
    await service({ canLink: linkable, linkView: live }).reconcile(KEY);
    expect(row()).toMatchObject({ link_scopes: null });
    // A missing scope on a link made long before: the owner's to answer.
    answer = MISSING;
    clock = row()?.next_poll_at ?? clock;
    await service({ canLink: linkable, linkView: live }).reconcile(KEY);
    expect(row()?.link_scopes).toBe('["dev.ucp.shopping.order:read"]');
    expect(asked).toHaveLength(1);
  });

  it('a link made or extended while the read was out: the late challenge is not paused for; the next read uses the link', async () => {
    let updated = clock - DAY;
    answer = () => {
      // The owner finishes a step-up while this read is at the merchant.
      updated = clock;
      return MISSING();
    };
    await service({
      canLink: linkable,
      linkView: () => ({ state: 'active', updated_at: updated }),
    }).reconcile(KEY);
    expect(row()).toMatchObject({ state: 'open', link_scopes: null });
    expect(asked).toEqual([]);
  });

  it('a read clears what the order waited for', async () => {
    answer = MISSING;
    await service({ canLink: linkable }).reconcile(KEY);
    expect(row()?.link_scopes).not.toBeNull();
    answer = shared;
    await service({ canLink: linkable }).reconcile(KEY);
    expect(row()).toMatchObject({ link_scopes: null, polls: 2 });
    expect(ucpOrderView(held()).link_scopes).toBeNull();
  });

  it('a 401 with no challenge still means the merchant does not share it', async () => {
    answer = () => transport(401, 'unknown');
    await service({ canLink: linkable }).reconcile(KEY);
    expect(row()).toMatchObject({ state: 'closed', close_reason: 'not_shared' });
    expect(asked).toEqual([]);
  });
});

describe('the closed rule', () => {
  it('not_found closes it, drops the snapshot and keeps the summary', async () => {
    await service().reconcile(KEY);
    answer = () =>
      errorResponse({
        messages: [
          { type: 'error', code: 'not_found', content: 'gone', severity: 'unrecoverable' },
        ],
      });
    clock += 15 * MIN;
    await service().reconcile(KEY);
    expect(row()).toMatchObject({
      state: 'closed',
      close_reason: 'not_found',
      snapshot_json: null,
    });
    expect(summary()?.total).toBe('1800');
    expect(row()?.closed_at).toBe(clock);
  });

  it('a REST 404 naming not_found closes it the same way', async () => {
    answer = () => transport(404, 'not_found');
    await service().reconcile(KEY);
    expect(row()).toMatchObject({ state: 'closed', close_reason: 'not_found' });
  });

  it('settled and quiet for 30 days closes; a change restarts the quiet clock', async () => {
    (order.lines[0] as { status: string }).status = 'fulfilled';
    await service().reconcile(KEY);
    expect(summary()?.settled).toBe(true);
    expect(row()?.state).toBe('open');
    clock += SETTLED_QUIET_MS - DAY;
    order.adjustments.push({ id: 'r1', type: 'refund', occurredAt: clock, status: 'pending' });
    await service().reconcile(KEY);
    // A pending refund: not settled, and the quiet clock restarts.
    expect(row()).toMatchObject({ state: 'open', last_change_at: clock });
    (order.adjustments[0] as { status: string }).status = 'completed';
    clock += DAY;
    await service().reconcile(KEY);
    clock += SETTLED_QUIET_MS - 1;
    await service().reconcile(KEY);
    expect(row()?.state).toBe('open');
    clock += 1;
    await service().reconcile(KEY);
    expect(row()).toMatchObject({ state: 'closed', close_reason: 'settled', snapshot_json: null });
  });

  it('180 days after it was followed it closes without asking', async () => {
    clock += ORDER_MAX_AGE_MS;
    await service().reconcile(KEY);
    expect(calls).toBe(0);
    expect(row()).toMatchObject({ state: 'closed', close_reason: 'aged' });
  });
});

describe('the schedule', () => {
  it('every 15 minutes on the first day, hourly in the first week, every 6 hours after; daily with webhooks; ±10% jitter', () => {
    const mid = () => 0.5;
    expect(nextOrderPollAt(0, DAY - 1, false, mid)).toBe(DAY - 1 + 15 * MIN);
    expect(nextOrderPollAt(0, 2 * DAY, false, mid)).toBe(2 * DAY + 60 * MIN);
    expect(nextOrderPollAt(0, 8 * DAY, false, mid)).toBe(8 * DAY + 6 * 60 * MIN);
    expect(nextOrderPollAt(0, 0, true, mid)).toBe(DAY);
    expect(nextOrderPollAt(0, 0, false, () => 0)).toBe(13.5 * MIN);
    expect(nextOrderPollAt(0, 0, false, () => 0.999999)).toBeLessThanOrEqual(16.5 * MIN);
  });

  it('a Retry-After past the 180-day close is cut to it, so the order still closes', async () => {
    answer = () => transport(503, 'unknown', 400 * 86_400);
    await service().reconcile(KEY);
    expect(row()?.next_poll_at).toBe((row()?.created_at as number) + ORDER_MAX_AGE_MS);
    clock = (row()?.created_at as number) + ORDER_MAX_AGE_MS;
    await service().sweep();
    expect(row()).toMatchObject({ state: 'closed', close_reason: 'aged' });
  });

  it('a prompted read the merchant answers with Retry-After waits that long, not the short prompt retry', async () => {
    store.requestPoll(KEY, clock);
    answer = () => transport(429, 'rate_limited', 1800);
    await service().reconcile(KEY);
    expect(row()).toMatchObject({ prompted_at: clock, next_poll_at: clock + 1800_000 });
  });

  it('a failed read retries on the schedule, after a Retry-After when the merchant asks', async () => {
    answer = () => transport(429, 'rate_limited', 3600);
    await service().reconcile(KEY);
    expect(row()).toMatchObject({ state: 'open', next_poll_at: clock + 3600_000 });
    answer = () => transport(503, 'unknown');
    await service().reconcile(KEY);
    expect(row()?.next_poll_at).toBe(clock + 15 * MIN);
    opened = false;
    await service().reconcile(KEY);
    expect(row()).toMatchObject({ state: 'open', next_poll_at: clock + 15 * MIN });
  });
});

describe('stored records, read back field by field', () => {
  it('a summary round-trips; one that does not read is none, never half-believed', async () => {
    order.events.push({ id: 'e1', type: 'shipped', occurredAt: clock, lineItems: [] });
    await service().reconcile(KEY);
    const text = row()?.summary_json ?? null;
    expect(readOrderSummary(text)).toEqual(summary());
    for (const bad of [
      '{',
      '[]',
      '{"currency":"EUR","total":"1","settled":true,"lines":[{"title":1}],"adjustments":[],"latest_event":null}',
      '{"currency":"EUR","total":"1","settled":"yes","lines":[],"adjustments":[],"latest_event":null}',
      '{"currency":"EUR","total":"1","settled":true,"lines":[],"adjustments":[],"latest_event":{"type":"x"}}',
      '{"currency":"EUR","total":"1","settled":true,"lines":[],"adjustments":[],"latest_event":null,"as_sent":false}',
    ])
      expect(readOrderSummary(bad)).toBeNull();
  });

  it('stored notices keep only entries that read', () => {
    expect(storedNotices('{')).toEqual([]);
    expect(storedNotices('{"kind":"event"}')).toEqual([]);
    expect(
      storedNotices('[{"kind":"event","id":"e1","type":"canceled"},{"kind":1},null,"x"]'),
    ).toEqual([{ kind: 'event', id: 'e1', type: 'canceled' }]);
  });
});

describe('webhook bodies kept while the order is open (dual review round 3)', () => {
  /** A verified webhook body naming a new pending dispute, as the webhook service keeps it. */
  function webhookWithDispute(at: number): void {
    const withDispute: MockOrder = {
      ...order,
      adjustments: [{ id: 'adj_d', type: 'dispute', occurredAt: at, status: 'pending' }],
    };
    const body = orderAnswer(withDispute, ORIGIN);
    const parsed = readOrder(body);
    if (!parsed.ok) throw new Error('order');
    store.holdPushed(KEY, parsed.value, body, at);
  }
  const disputes = () => notices().filter((n) => n.type === 'dispute');

  it('a webhook during a read that then answers is kept; a later refused read still raises its dispute (R3-1)', async () => {
    webhooks = true;
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const older = shared();
    answer = async () => {
      await held;
      return older;
    };
    const reading = service().reconcile(KEY);
    await new Promise((r) => setImmediate(r));
    // The body comes while the read is out: after the read began.
    clock += 1_000;
    webhookWithDispute(clock);
    release();
    await reading;
    // The read answered with an older snapshot: the webhook's information stays for the next read.
    expect(row()?.pushed_json).not.toBeNull();
    expect(disputes()).toEqual([]);
    // That read is refused: the merchant does not share the order.
    answer = () => errorResponse(orderUnauthorized());
    clock += 1_000;
    await service().reconcile(KEY);
    expect(row()?.state).toBe('not_shared');
    expect(disputes()).toHaveLength(1);
    expect(row()?.pushed_json).toBeNull();
  });

  it('a body that came before a read that answered is dropped with it', async () => {
    webhookWithDispute(clock - 1);
    await service().reconcile(KEY);
    expect(row()?.pushed_json).toBeNull();
  });

  it('the switch to not shared and the webhook merge are one write, so no crash can fall between them (R3-2)', async () => {
    webhooks = true;
    webhookWithDispute(clock);
    answer = () => errorResponse(orderUnauthorized());
    const apply = store.apply.bind(store);
    const writes: Record<string, unknown>[] = [];
    store.apply = ((...args: Parameters<typeof store.apply>) => {
      writes.push(args[3] as Record<string, unknown>);
      return apply(...args);
    }) as typeof store.apply;
    await service().reconcile(KEY);
    const switched = writes.filter((w) => w.state === 'not_shared');
    expect(switched).toHaveLength(1);
    expect(switched[0]).toMatchObject({ pushed_json: null });
    expect(switched[0]?.notices).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'dispute' })]),
    );
    expect(disputes()).toHaveLength(1);
    // Run again: the card is not raised twice.
    await service().reconcile(KEY);
    expect(disputes()).toHaveLength(1);
  });
});
