/**
 * Debug control channel hardening — loopback gate + optional shared-secret
 * token. Pins the security contract for `/v1/debug/dispatch`:
 *   - non-loopback peers are refused (even though the route bypasses auth)
 *   - when DINA_DEBUG_TOKEN is set, a matching `x-debug-token` is REQUIRED
 *     (closes the reverse-proxy-looks-loopback gap)
 *   - when no token is configured, loopback requests pass (back-compat for
 *     the test harnesses)
 *
 * The release-mode boot refusal is pinned in boot.test.ts.
 */

import { pino } from 'pino';

import type { CoreRouter } from '@dina/core';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { registerDebugDispatch } from '../src/server/debug_dispatch';
import type { Logger } from '../src/logger';

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<void> | void;

function makeReply(): { reply: FastifyReply; result: { status: number; body: unknown } } {
  const result = { status: 0, body: undefined as unknown };
  const reply = {
    code(c: number) {
      result.status = c;
      return reply;
    },
    send(b: unknown) {
      result.body = b;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, result };
}

function register(opts: { token?: string } = {}): { handler: Handler; coreHandle: jest.Mock } {
  if (opts.token !== undefined) process.env['DINA_DEBUG_TOKEN'] = opts.token;
  else delete process.env['DINA_DEBUG_TOKEN'];

  let captured: Handler | undefined;
  const app = {
    post: (_path: string, h: Handler): unknown => {
      captured = h;
      return undefined;
    },
  };
  const coreHandle = jest.fn().mockResolvedValue({ status: 200, body: { ok: true } });
  const coreRouter = { handle: coreHandle } as unknown as CoreRouter;
  registerDebugDispatch(app, coreRouter, pino({ level: 'silent' }) as unknown as Logger);
  if (captured === undefined) throw new Error('handler not registered');
  return { handler: captured, coreHandle };
}

function dispatchReq(
  over: Partial<{ ip: string; headers: Record<string, unknown>; body: unknown }> = {},
): FastifyRequest {
  return {
    ip: '127.0.0.1',
    headers: {},
    body: { method: 'GET', path: '/v1/health' },
    ...over,
  } as unknown as FastifyRequest;
}

afterEach(() => {
  delete process.env['DINA_DEBUG_TOKEN'];
  jest.restoreAllMocks();
});

describe('/v1/debug/dispatch loopback gate', () => {
  it('refuses non-loopback peers with 403 (never dispatches)', async () => {
    const { handler, coreHandle } = register();
    const { reply, result } = makeReply();
    await handler(dispatchReq({ ip: '203.0.113.7' }), reply);
    expect(result.status).toBe(403);
    expect(coreHandle).not.toHaveBeenCalled();
  });

  it('allows a loopback request when no token is configured', async () => {
    const { handler, coreHandle } = register();
    const { reply, result } = makeReply();
    await handler(dispatchReq(), reply);
    expect(result.status).toBe(200);
    expect(coreHandle).toHaveBeenCalledTimes(1);
  });
});

describe('/v1/debug/dispatch token gate (DINA_DEBUG_TOKEN set)', () => {
  it('refuses a loopback request with NO token header', async () => {
    const { handler, coreHandle } = register({ token: 's3cret' });
    const { reply, result } = makeReply();
    await handler(dispatchReq(), reply);
    expect(result.status).toBe(403);
    expect(coreHandle).not.toHaveBeenCalled();
  });

  it('refuses a loopback request with a WRONG token header', async () => {
    const { handler, coreHandle } = register({ token: 's3cret' });
    const { reply, result } = makeReply();
    await handler(dispatchReq({ headers: { 'x-debug-token': 'nope' } }), reply);
    expect(result.status).toBe(403);
    expect(coreHandle).not.toHaveBeenCalled();
  });

  it('allows a loopback request with the RIGHT token header', async () => {
    const { handler, coreHandle } = register({ token: 's3cret' });
    const { reply, result } = makeReply();
    await handler(dispatchReq({ headers: { 'x-debug-token': 's3cret' } }), reply);
    expect(result.status).toBe(200);
    expect(coreHandle).toHaveBeenCalledTimes(1);
  });

  it('still enforces loopback even with a valid token (non-loopback + right token = 403)', async () => {
    const { handler, coreHandle } = register({ token: 's3cret' });
    const { reply, result } = makeReply();
    await handler(dispatchReq({ ip: '203.0.113.7', headers: { 'x-debug-token': 's3cret' } }), reply);
    expect(result.status).toBe(403);
    expect(coreHandle).not.toHaveBeenCalled();
  });
});
