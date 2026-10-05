/**
 * The UCP dispatcher and its journal (UCP plan §3.7, §3.10; T-U2-2, T-U2-3):
 * one mutation at a time per owner, journaled with its exact bytes before it
 * leaves, resent with the same bytes and key until a definite answer or its
 * deadline, an earlier request resumed under its own gate, a late answer
 * from a holder whose slot was taken never written, and every abandoned row
 * handed back to its owner.
 */

import { UCP_FETCH_LIMITS } from '@dina/net-policy';

import { REQUEST_RETENTION_MS, UcpCheckoutStore } from '../../../src/commerce/ucp/checkout_store';
import {
  CONFLICT_LIMIT,
  SLOT_LEASE_MS,
  UcpDispatcher,
  type AbandonReason,
  type Gate,
  type Mutation,
} from '../../../src/commerce/ucp/dispatch';

import { freshDatabase } from './mock_harness';

import type { RequestRow } from '../../../src/commerce/ucp/checkout_store';
import type { CallResult, MerchantConnection } from '../../../src/commerce/ucp/merchant_client';
import type { PreparedCall } from '../../../src/commerce/ucp/transport';

const SHOP = 'https://shop.example';
const CART = 'ucp-cart-1';

let database: ReturnType<typeof freshDatabase>;
let store: UcpCheckoutStore;
let clock: number;
let keys: number;

/** A connection whose answers a test scripts; every send is recorded, with the journal as it stood. */
function connection(answers: (CallResult | (() => Promise<CallResult>))[]) {
  const sent: { call: PreparedCall; journal: RequestRow | null }[] = [];
  let rpc = 0;
  const conn = {
    merchant: { origin: SHOP },
    profileUrl: () => 'https://abc.ucp.dinakernel.com/.well-known/ucp',
    prepare: (
      operation: string,
      input: { payload?: unknown; idempotencyKey?: string; id?: string },
    ) => ({
      ok: true as const,
      call: {
        transport: 'mcp' as const,
        endpoint: `${SHOP}/mcp`,
        profileUrl: 'https://abc.ucp.dinakernel.com/.well-known/ucp',
        operation,
        ...(input.id !== undefined ? { id: input.id } : {}),
        idempotencyKey: input.idempotencyKey,
        rpcId: `rpc-${++rpc}`,
        bytes: new TextEncoder().encode(
          JSON.stringify({
            jsonrpc: '2.0',
            id: `rpc-${rpc}`,
            method: 'tools/call',
            params: { name: operation, arguments: input.payload ?? {} },
          }),
        ),
      },
    }),
    send: async (call: PreparedCall) => {
      sent.push({ call, journal: store.getRequest(call.idempotencyKey ?? '') });
      const next = answers.shift();
      if (next === undefined) throw new Error('no scripted answer');
      return typeof next === 'function' ? next() : next;
    },
  };
  return { conn: conn as unknown as MerchantConnection, sent };
}

const OK = {
  ok: true,
  value: { id: 'mc-1' },
  messages: { messages: [], unreadable: 0 },
} as unknown as CallResult;
const LOST: CallResult = { ok: false, kind: 'network', error: 'timeout', sent: true };
const NEVER_LEFT: CallResult = { ok: false, kind: 'network', error: 'connect_failed', sent: false };
const refusal = (
  status: number,
  code: string,
  retryAfter?: number,
  httpStatus?: number,
): CallResult =>
  ({
    ok: false,
    kind: 'transport',
    error: {
      code,
      status,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    },
  }) as CallResult;

/** A gate that admits everything and records what it applied and abandoned. */
function gate(over: Partial<Gate> = {}) {
  const applied: CallResult[] = [];
  const abandoned: { reason: AbandonReason; sent: boolean }[] = [];
  const g: Gate = {
    admitFirst: () => true,
    admitResend: () => true,
    apply: (_row, result) => {
      applied.push(result);
    },
    abandon: (_row, reason, sent) => {
      abandoned.push({ reason, sent });
    },
    ...over,
  };
  return { g, applied, abandoned };
}

const dispatcher = (holder = 'h1') =>
  new UcpDispatcher({ store, nowMs: () => clock, newKey: () => `key-${++keys}`, holder });

let mutation: Mutation;
const owner = { kind: 'cart' as const, id: CART };
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  database = freshDatabase('dispatch');
  store = new UcpCheckoutStore(database.db);
  clock = 1_000_000;
  keys = 0;
  store.insertCart({
    cart_id: CART,
    conversation: 'chat:main',
    merchant_origin: SHOP,
    version: '2026-08-25',
    transport: 'mcp',
    endpoint: `${SHOP}/mcp`,
    state: 'creating',
    created_at: clock,
  });
  mutation = {
    operation: 'create_cart',
    build: () => ({ payload: { line_items: [] } }),
    retryDeadline: clock + 23 * 60 * 60_000,
  };
});

afterEach(() => database.close());

describe('the journal', () => {
  it('the row, exact bytes and all, is written and marked "may have left" before the first byte goes; a definite answer settles it and is applied', async () => {
    const { conn, sent } = connection([OK]);
    const { g, applied } = gate();
    expect(await dispatcher().mutate(owner, conn, mutation, g)).toMatchObject({
      kind: 'answered',
    });
    expect(sent[0]?.journal).toMatchObject({
      state: 'in_doubt',
      operation: 'create_cart',
      owner_id: CART,
      first_sent_at: clock,
    });
    expect(
      Buffer.from(sent[0]?.journal?.request_bytes ?? []).equals(
        Buffer.from(sent[0]?.call.bytes ?? []),
      ),
    ).toBe(true);
    expect(store.requests('cart', CART)).toEqual([
      expect.objectContaining({ state: 'settled', outcome_json: '{"kind":"ok"}' }),
    ]);
    expect(applied).toEqual([OK]);
    expect(store.getCart(CART)).toMatchObject({ slot_holder: null });
  });

  it('the body is built under the slot; a build that finds the owner moved on sends nothing', async () => {
    const { conn, sent } = connection([]);
    let builtWhileHeld = false;
    expect(
      await dispatcher().mutate(
        owner,
        conn,
        {
          ...mutation,
          build: () => {
            builtWhileHeld = store.getCart(CART)?.slot_holder === 'h1';
            return null;
          },
        },
        gate().g,
      ),
    ).toEqual({ kind: 'not_admitted' });
    expect(builtWhileHeld).toBe(true);
    expect(sent).toEqual([]);
    expect(store.requests('cart', CART)).toEqual([]);
  });

  it('a gate that refuses a first send writes nothing and sends nothing', async () => {
    const { conn, sent } = connection([]);
    expect(
      await dispatcher().mutate(owner, conn, mutation, gate({ admitFirst: () => false }).g),
    ).toEqual({ kind: 'not_admitted' });
    expect(sent).toEqual([]);
    expect(store.requests('cart', CART)).toEqual([]);
  });

  it('an earlier request still open: nothing new goes; resumed under its own gate, the same bytes and key', async () => {
    const { conn, sent } = connection([LOST, OK]);
    await dispatcher().mutate(owner, conn, mutation, gate().g);
    const next = await dispatcher().mutate(
      owner,
      conn,
      { ...mutation, operation: 'cancel_cart', build: () => ({ id: 'x' }) },
      gate().g,
    );
    expect(next).toMatchObject({ kind: 'earlier', request: { operation: 'create_cart' } });
    expect(sent).toHaveLength(1);
    const own = gate();
    expect(await dispatcher().resume(owner, conn, own.g)).toMatchObject({ kind: 'answered' });
    expect(sent.map((s) => [s.call.idempotencyKey, s.call.rpcId])).toEqual([
      ['key-1', 'rpc-1'],
      ['key-1', 'rpc-1'],
    ]);
    expect(
      Buffer.from(sent[1]?.call.bytes ?? []).equals(Buffer.from(sent[0]?.call.bytes ?? [])),
    ).toBe(true);
    expect(own.applied).toEqual([OK]);
  });

  it('after a restart (a new dispatcher on the same database) the request in doubt is resent and settles', async () => {
    await dispatcher('h1').mutate(owner, connection([LOST]).conn, mutation, gate().g);
    const later = connection([OK]);
    const { g, applied } = gate();
    expect(await dispatcher('h2').resume(owner, later.conn, g)).toMatchObject({
      kind: 'answered',
    });
    expect(later.sent[0]?.call.idempotencyKey).toBe('key-1');
    expect(applied).toHaveLength(1);
    expect(await dispatcher('h2').resume(owner, later.conn, g)).toBeNull();
  });

  it('nothing left the node: back to "prepared"; a closed gate then abandons it as never sent', async () => {
    const { conn, sent } = connection([NEVER_LEFT]);
    expect(await dispatcher().mutate(owner, conn, mutation, gate().g)).toMatchObject({
      kind: 'not_left',
    });
    // Never sent: its first-sent time is still unset.
    expect(store.requests('cart', CART)[0]).toMatchObject({
      state: 'prepared',
      first_sent_at: null,
    });
    const { g, abandoned } = gate({ admitResend: () => false });
    expect(await dispatcher().resume(owner, conn, g)).toMatchObject({
      kind: 'abandoned',
      sent: false,
    });
    expect(abandoned).toEqual([{ reason: 'gate_closed', sent: false }]);
    expect(sent).toHaveLength(1);
  });

  it('a holder that dies after sending (its answer never written) leaves a row that reads "may have been sent"', async () => {
    // The send never settles, as a crash after the bytes left.
    const stalled = connection([() => new Promise<CallResult>(() => undefined)]);
    void dispatcher('h1').mutate(owner, stalled.conn, mutation, gate().g);
    await settle();
    expect(stalled.sent).toHaveLength(1);
    clock += SLOT_LEASE_MS + 1;
    const { g, abandoned } = gate({ admitResend: () => false });
    expect(await dispatcher('h2').resume(owner, connection([]).conn, g)).toMatchObject({
      kind: 'abandoned',
      reason: 'gate_closed',
      sent: true,
    });
    expect(abandoned).toEqual([{ reason: 'gate_closed', sent: true }]);
  });

  it('past its retry deadline it is abandoned, the owner told, and never sent again', async () => {
    const { conn, sent } = connection([LOST]);
    await dispatcher().mutate(owner, conn, mutation, gate().g);
    clock = mutation.retryDeadline;
    const { g, abandoned } = gate();
    expect(await dispatcher().resume(owner, conn, g)).toMatchObject({
      kind: 'abandoned',
      reason: 'deadline',
      sent: true,
      request: { state: 'abandoned' },
    });
    expect(abandoned).toEqual([{ reason: 'deadline', sent: true }]);
    expect(sent).toHaveLength(1);
    expect(store.openRequest('cart', CART)).toBeNull();
  });

  it('abandonOpen waits for a live holder, and after a stalled holder’s lease ends, its late answer is not applied', async () => {
    let lateAnswer: (r: CallResult) => void = () => undefined;
    const stalled = connection([() => new Promise<CallResult>((r) => (lateAnswer = r))]);
    const first = gate();
    const running = dispatcher('h1').mutate(owner, stalled.conn, mutation, first.g);
    await settle();
    const ending = gate();
    expect(dispatcher('h2').abandonOpen(owner, ending.g, 'gate_closed')).toEqual({ kind: 'busy' });
    clock += SLOT_LEASE_MS + 1;
    expect(dispatcher('h2').abandonOpen(owner, ending.g, 'gate_closed')).toMatchObject({
      kind: 'abandoned',
      sent: true,
    });
    lateAnswer(OK);
    expect(await running).toEqual({ kind: 'lost' });
    expect(first.applied).toEqual([]);
    expect(store.requests('cart', CART)[0]).toMatchObject({ state: 'abandoned' });
  });

  it('abandonOpen ends an open request without sending it, the owner told in the same step', async () => {
    const { conn, sent } = connection([LOST]);
    await dispatcher().mutate(owner, conn, mutation, gate().g);
    const { g, abandoned } = gate();
    expect(dispatcher().abandonOpen(owner, g, 'gate_closed')).toMatchObject({
      kind: 'abandoned',
      sent: true,
    });
    expect(abandoned).toEqual([{ reason: 'gate_closed', sent: true }]);
    expect(dispatcher().abandonOpen(owner, g, 'gate_closed')).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('a 409 naming another code (a session the merchant ended) is the merchant’s refusal, never a key conflict', async () => {
    const { conn, sent } = connection([refusal(409, 'invalid_state')]);
    const { g, applied, abandoned } = gate();
    expect(await dispatcher().mutate(owner, conn, mutation, g)).toMatchObject({
      kind: 'answered',
    });
    expect(applied).toHaveLength(1);
    expect(abandoned).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it('a 409 to bytes never sent before is a defect: abandoned at once, never resent', async () => {
    const { conn, sent } = connection([refusal(409, 'idempotency_conflict')]);
    const { g, abandoned } = gate();
    expect(await dispatcher().mutate(owner, conn, mutation, g)).toMatchObject({
      kind: 'abandoned',
      reason: 'conflict_defect',
    });
    expect(abandoned[0]?.reason).toBe('conflict_defect');
    expect(await dispatcher().resume(owner, conn, g)).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('a 409 to bytes whose only earlier attempt never left is still a defect', async () => {
    const { conn, sent } = connection([NEVER_LEFT, refusal(409, 'idempotency_conflict')]);
    await dispatcher().mutate(owner, conn, mutation, gate().g);
    const { g, abandoned } = gate();
    expect(await dispatcher().resume(owner, conn, g)).toMatchObject({
      kind: 'abandoned',
      reason: 'conflict_defect',
      sent: true,
    });
    expect(abandoned).toEqual([{ reason: 'conflict_defect', sent: true }]);
    expect(sent).toHaveLength(2);
  });

  it('a resend refused before the merchant reads the key (its profile unreachable, a signature) settles nothing: it waits and is sent again', async () => {
    const { conn, sent } = connection([
      LOST,
      refusal(424, 'profile_unreachable'),
      refusal(401, 'signature_invalid', 5),
      OK,
    ]);
    await dispatcher().mutate(owner, conn, mutation, gate().g);
    const first = gate();
    expect(await dispatcher().resume(owner, conn, first.g)).toMatchObject({
      kind: 'in_doubt',
      why: 'retry_later',
      retryAfterMs: 60_000,
    });
    expect(first.applied).toEqual([]);
    expect(store.openRequest('cart', CART)).toMatchObject({ state: 'in_doubt' });
    clock += 60_000;
    expect(await dispatcher().resume(owner, conn, gate().g)).toMatchObject({
      kind: 'in_doubt',
      retryAfterMs: 5_000,
    });
    clock += 5_000;
    const last = gate();
    expect(await dispatcher().resume(owner, conn, last.g)).toMatchObject({ kind: 'answered' });
    expect(last.applied).toEqual([OK]);
    expect(sent).toHaveLength(4);
  });

  it('the same refusal to a first send is definite: nothing ran before it', async () => {
    const { conn } = connection([refusal(424, 'profile_unreachable')]);
    const { g, applied } = gate();
    expect(await dispatcher().mutate(owner, conn, mutation, g)).toMatchObject({
      kind: 'answered',
    });
    expect(applied).toHaveLength(1);
  });

  it('a 409 to resent bytes is waited out (Retry-After, else 30 s) at most three times, then given up', async () => {
    const { conn, sent } = connection([
      LOST,
      refusal(409, 'idempotency_conflict', 5),
      refusal(409, 'idempotency_conflict'),
      refusal(409, 'idempotency_conflict'),
      refusal(409, 'idempotency_conflict'),
    ]);
    await dispatcher().mutate(owner, conn, mutation, gate().g);
    expect(await dispatcher().resume(owner, conn, gate().g)).toMatchObject({
      kind: 'in_doubt',
      why: 'conflict',
      retryAfterMs: 5_000,
    });
    // Before the wait is over nothing is sent.
    expect(await dispatcher().resume(owner, conn, gate().g)).toMatchObject({ kind: 'wait' });
    expect(sent).toHaveLength(2);
    for (let i = 2; i <= CONFLICT_LIMIT; i++) {
      clock += 30_000;
      expect(await dispatcher().resume(owner, conn, gate().g)).toMatchObject({
        kind: 'in_doubt',
        why: 'conflict',
        retryAfterMs: 30_000,
      });
    }
    clock += 30_000;
    const { g, abandoned } = gate();
    expect(await dispatcher().resume(owner, conn, g)).toMatchObject({
      kind: 'abandoned',
      reason: 'conflict_limit',
    });
    expect(abandoned).toEqual([{ reason: 'conflict_limit', sent: true }]);
    expect(sent).toHaveLength(2 + CONFLICT_LIMIT);
  });

  it('429 and 5xx are resent after their Retry-After; a 4xx refusal to a first send is definite', async () => {
    const first = connection([refusal(400, 'invalid_request')]);
    expect(await dispatcher().mutate(owner, first.conn, mutation, gate().g)).toMatchObject({
      kind: 'answered',
    });
    store.insertCart({
      cart_id: 'ucp-cart-2',
      conversation: 'chat:main',
      merchant_origin: SHOP,
      version: '2026-08-25',
      transport: 'mcp',
      endpoint: `${SHOP}/mcp`,
      state: 'creating',
      created_at: clock,
    });
    const other = { kind: 'cart' as const, id: 'ucp-cart-2' };
    const { conn, sent } = connection([
      refusal(429, 'rate_limited', 30),
      refusal(503, 'unavailable'),
      OK,
    ]);
    expect(await dispatcher().mutate(other, conn, mutation, gate().g)).toMatchObject({
      kind: 'in_doubt',
      why: 'retry_later',
      retryAfterMs: 30_000,
    });
    expect(await dispatcher().resume(other, conn, gate().g)).toMatchObject({
      kind: 'wait',
      retryAfterMs: 30_000,
    });
    clock += 30_000;
    expect(await dispatcher().resume(other, conn, gate().g)).toMatchObject({
      kind: 'in_doubt',
      why: 'retry_later',
    });
    expect(await dispatcher().resume(other, conn, gate().g)).toMatchObject({ kind: 'answered' });
    expect(sent).toHaveLength(3);
  });

  it('an MCP error sent with HTTP 200: an internal error or one naming a retry is resent; a named refusal to a first send is definite', async () => {
    store.insertCart({
      cart_id: 'ucp-cart-x',
      conversation: 'chat:main',
      merchant_origin: SHOP,
      version: '2026-08-25',
      transport: 'mcp',
      endpoint: `${SHOP}/mcp`,
      state: 'creating',
      created_at: clock,
    });
    const named = connection([refusal(-32602, 'invalid_params', undefined, 200)]);
    const { g, applied } = gate();
    expect(
      await dispatcher().mutate({ kind: 'cart', id: 'ucp-cart-x' }, named.conn, mutation, g),
    ).toMatchObject({ kind: 'answered' });
    expect(applied).toHaveLength(1);
    const { conn } = connection([
      refusal(-32603, 'unknown', undefined, 200),
      refusal(-32000, 'unknown', 10, 200),
      OK,
    ]);
    expect(await dispatcher().mutate(owner, conn, mutation, gate().g)).toMatchObject({
      kind: 'in_doubt',
      why: 'retry_later',
    });
    expect(await dispatcher().resume(owner, conn, gate().g)).toMatchObject({
      kind: 'in_doubt',
      retryAfterMs: 10_000,
    });
    clock += 10_000;
    expect(await dispatcher().resume(owner, conn, gate().g)).toMatchObject({ kind: 'answered' });
  });

  it('rows that ended 48 hours ago go on the next use', async () => {
    await dispatcher().mutate(owner, connection([OK]).conn, mutation, gate().g);
    clock += 24 * 60 * 60_000;
    expect(await dispatcher().resume(owner, connection([]).conn, gate().g)).toBeNull();
    expect(store.requests('cart', CART)).toHaveLength(1);
    clock += REQUEST_RETENTION_MS;
    expect(await dispatcher().resume(owner, connection([]).conn, gate().g)).toBeNull();
    expect(store.requests('cart', CART)).toEqual([]);
  });
});

describe('the slot', () => {
  it('its lease covers the transport’s worst case (two sessions begun and two calls, and a profile refresh)', () => {
    const { profile, checkout } = UCP_FETCH_LIMITS;
    expect(SLOT_LEASE_MS).toBeGreaterThan(
      2 * (2 * profile.timeoutMs + checkout.timeoutMs) + profile.timeoutMs,
    );
  });

  it('one holder at a time: a second mutation while one is sending is busy', async () => {
    let finish: (r: CallResult) => void = () => undefined;
    const { conn } = connection([() => new Promise<CallResult>((r) => (finish = r))]);
    const running = dispatcher('h1').mutate(owner, conn, mutation, gate().g);
    await settle();
    expect(await dispatcher('h2').mutate(owner, conn, mutation, gate().g)).toEqual({
      kind: 'busy',
    });
    finish(OK);
    expect(await running).toMatchObject({ kind: 'answered' });
  });

  it('a holder that stalls past its lease is taken over; the recovery resends the same request, and the stalled holder’s late answer is not written', async () => {
    let lateAnswer: (r: CallResult) => void = () => undefined;
    const stalled = connection([() => new Promise<CallResult>((r) => (lateAnswer = r))]);
    const first = gate();
    const running = dispatcher('h1').mutate(owner, stalled.conn, mutation, first.g);
    await settle();
    clock += SLOT_LEASE_MS + 1;
    const recovery = connection([OK]);
    const second = gate();
    expect(await dispatcher('h2').resume(owner, recovery.conn, second.g)).toMatchObject({
      kind: 'answered',
    });
    expect(recovery.sent[0]?.call.idempotencyKey).toBe('key-1');
    lateAnswer(refusal(400, 'invalid_request'));
    expect(await running).toEqual({ kind: 'lost' });
    expect(first.applied).toEqual([]);
    expect(second.applied).toEqual([OK]);
    expect(store.requests('cart', CART)[0]).toMatchObject({
      state: 'settled',
      outcome_json: '{"kind":"ok"}',
    });
    expect(store.getCart(CART)?.slot_generation).toBe(2);
  });
});
