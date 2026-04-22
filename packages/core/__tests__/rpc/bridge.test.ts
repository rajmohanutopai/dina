/**
 * CORE-P0-002 — RPCBridge integration tests.
 * Also covers CORE-P0-T01 / T02 / T03 at the wire level.
 */

import { RPCBridge } from '../../src/rpc/bridge';
import type { RPCInnerRequest, RPCInnerResponse } from '../../src/rpc/types';
import { MAX_INNER_BODY_SIZE } from '../../src/rpc/types';

function decode(body: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(body));
}

function req(
  path: string,
  headers: Record<string, string> = {},
  body: Uint8Array = new Uint8Array(0),
  method = 'GET',
): RPCInnerRequest {
  return { method, path, headers, body };
}

const DID = 'did:plc:example';

describe('RPCBridge — construction', () => {
  it('rejects missing handler', () => {
    expect(
      () =>
        new RPCBridge({
          handler: undefined as unknown as (req: RPCInnerRequest) => Promise<RPCInnerResponse>,
        }),
    ).toThrow(/handler/);
  });
});

describe('RPCBridge — CORE-P0-T01 happy path (dispatches through handler)', () => {
  it('routes GET /v1/identity through handler → 200', async () => {
    const bridge = new RPCBridge({
      handler: async (r) => {
        expect(r.path).toBe('/v1/identity');
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: new TextEncoder().encode('{"did":"did:plc:example"}'),
        };
      },
    });
    const res = await bridge.handleInnerRequest({
      envelopeDid: DID,
      requestId: 'r1',
      request: req('/v1/identity', { 'X-DID': DID }),
    });
    expect(res.status).toBe(200);
    expect(decode(res.body)).toEqual({ did: DID });
  });
});

describe('RPCBridge — CORE-P0-T02 oversize body rejected with 413', () => {
  it('returns 413 + body_too_large error before invoking handler', async () => {
    const handlerCalls: number[] = [];
    const bridge = new RPCBridge({
      handler: async () => {
        handlerCalls.push(1);
        return { status: 200, headers: {}, body: new Uint8Array(0) };
      },
    });
    const tooBig = new Uint8Array(MAX_INNER_BODY_SIZE + 1);
    const res = await bridge.handleInnerRequest({
      envelopeDid: DID,
      requestId: 'r1',
      request: req('/v1/echo', { 'X-DID': DID }, tooBig, 'POST'),
    });
    expect(res.status).toBe(413);
    expect(decode(res.body).error).toBe('body_too_large');
    expect(handlerCalls).toHaveLength(0); // handler never invoked
  });
});

describe('RPCBridge — CORE-P0-T03 identity binding enforced at bridge', () => {
  it('returns 401 when envelope.from_did != inner X-DID', async () => {
    const handlerCalls: number[] = [];
    const bridge = new RPCBridge({
      handler: async () => {
        handlerCalls.push(1);
        return { status: 200, headers: {}, body: new Uint8Array(0) };
      },
    });
    const res = await bridge.handleInnerRequest({
      envelopeDid: 'did:plc:outer',
      requestId: 'r1',
      request: req('/v1/identity', { 'X-DID': 'did:plc:inner' }),
    });
    expect(res.status).toBe(401);
    expect(decode(res.body).error).toBe('identity_binding_failed');
    expect(handlerCalls).toHaveLength(0);
  });
});

describe('RPCBridge — idempotency', () => {
  it('retries with the same (envelopeDid, requestId) return the cached response', async () => {
    let calls = 0;
    const bridge = new RPCBridge({
      handler: async () => {
        calls++;
        return {
          status: 200,
          headers: {},
          body: new TextEncoder().encode(`{"n":${calls}}`),
        };
      },
    });
    const res1 = await bridge.handleInnerRequest({
      envelopeDid: DID,
      requestId: 'r1',
      request: req('/v1/identity', { 'X-DID': DID }),
    });
    const res2 = await bridge.handleInnerRequest({
      envelopeDid: DID,
      requestId: 'r1',
      request: req('/v1/identity', { 'X-DID': DID }),
    });
    expect(calls).toBe(1); // handler only ran once
    expect(decode(res1.body)).toEqual({ n: 1 });
    expect(decode(res2.body)).toEqual({ n: 1 });
  });

  it('different requestIds execute independently', async () => {
    let calls = 0;
    const bridge = new RPCBridge({
      handler: async () => {
        calls++;
        return {
          status: 200,
          headers: {},
          body: new Uint8Array(0),
        };
      },
    });
    await bridge.handleInnerRequest({
      envelopeDid: DID,
      requestId: 'r1',
      request: req('/v1/identity', { 'X-DID': DID }),
    });
    await bridge.handleInnerRequest({
      envelopeDid: DID,
      requestId: 'r2',
      request: req('/v1/identity', { 'X-DID': DID }),
    });
    expect(calls).toBe(2);
  });
});

describe('RPCBridge — panic recovery', () => {
  it('handler throw → 500 inner response', async () => {
    const bridge = new RPCBridge({
      handler: async () => {
        throw new Error('handler exploded');
      },
    });
    const res = await bridge.handleInnerRequest({
      envelopeDid: DID,
      requestId: 'r1',
      request: req('/v1/x', { 'X-DID': DID }),
    });
    expect(res.status).toBe(500);
    expect(decode(res.body).error).toBe('internal_error');
    expect(decode(res.body).detail).toBe('handler exploded');
  });
});
