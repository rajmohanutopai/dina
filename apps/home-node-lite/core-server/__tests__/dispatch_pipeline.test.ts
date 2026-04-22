/**
 * Task 4.46 — CoreRouter dispatch pipeline tests.
 *
 * Verifies that a tunnelled CoreRPCRequest flows through the FULL
 * Fastify middleware chain (rate limit, body limit, content-type
 * enforcement, route handler) rather than bypassing it.
 */

import { pino } from 'pino';
import {
  RPC_REQUEST_TYPE,
  RPC_RESPONSE_TYPE,
  type CoreRPCRequest,
} from '@dina/protocol';
import { createServer } from '../src/server';
import type { CoreServerConfig } from '../src/config';
import { dispatchTunneledRequest } from '../src/msgbox/dispatch_pipeline';

function baseConfig(overrides: Partial<CoreServerConfig> = {}): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'silent', rateLimitPerMinute: 10_000, prettyLogs: false },
    msgbox: {},
    cors: {},
    ...overrides,
  };
}

function silentLogger() {
  return pino({ level: 'silent' });
}

function buildRpcRequest(partial: Partial<CoreRPCRequest> = {}): CoreRPCRequest {
  return {
    type: RPC_REQUEST_TYPE,
    request_id: 'req-1',
    from: 'did:plc:alice',
    method: 'GET',
    path: '/healthz',
    query: '',
    headers: {},
    body: '',
    ...partial,
  };
}

const CORE_DID = 'did:plc:homenode';

describe('dispatchTunneledRequest (task 4.46)', () => {
  describe('basic round-trip', () => {
    it('routes a GET through Fastify and returns the response', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      const res = await dispatchTunneledRequest({
        app,
        request: buildRpcRequest(),
        coreDid: CORE_DID,
      });
      expect(res.type).toBe(RPC_RESPONSE_TYPE);
      expect(res.request_id).toBe('req-1');
      expect(res.from).toBe(CORE_DID);
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body) as { status: string };
      expect(parsed.status).toBe('ok');
      expect(res.signature).toBe(''); // sign happens in task 4.47, not here
      await app.close();
    });

    it('404 path flows through Fastify → 404 status + error envelope body', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      const res = await dispatchTunneledRequest({
        app,
        request: buildRpcRequest({ path: '/no-such-route' }),
        coreDid: CORE_DID,
      });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'not found' });
      await app.close();
    });
  });

  describe('full chain engagement', () => {
    it('rate limit applies to tunnelled requests', async () => {
      const app = await createServer({
        config: baseConfig({
          runtime: { logLevel: 'silent', rateLimitPerMinute: 2, prettyLogs: false },
        }),
        logger: silentLogger(),
      });
      app.get('/tunnel-test', async () => ({ ok: true }));
      const request = buildRpcRequest({
        path: '/tunnel-test',
        headers: { 'x-did': 'did:plc:loud' },
      });

      // First 2 requests succeed (budget).
      for (let i = 0; i < 2; i++) {
        const res = await dispatchTunneledRequest({ app, request, coreDid: CORE_DID });
        expect(res.status).toBe(200);
      }
      // 3rd → 429 via rate-limit middleware (chain engaged).
      const third = await dispatchTunneledRequest({
        app,
        request,
        coreDid: CORE_DID,
      });
      expect(third.status).toBe(429);
      await app.close();
    });

    it('content-type enforcement 415 applies to tunnelled POST', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.post('/needs-json', async (r) => r.body as object);
      const res = await dispatchTunneledRequest({
        app,
        request: buildRpcRequest({
          method: 'POST',
          path: '/needs-json',
          headers: { 'content-type': 'text/plain' },
          body: 'not json',
        }),
        coreDid: CORE_DID,
      });
      expect(res.status).toBe(415);
      expect(JSON.parse(res.body)).toEqual({ error: 'unsupported media type' });
      await app.close();
    });

    it('body-too-large 413 applies', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.post('/echo', async (r) => r.body as object);
      const big = 'x'.repeat(3 * 1024 * 1024); // >2 MiB body limit
      const res = await dispatchTunneledRequest({
        app,
        request: buildRpcRequest({
          method: 'POST',
          path: '/echo',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: big }),
        }),
        coreDid: CORE_DID,
      });
      expect(res.status).toBe(413);
      await app.close();
    });
  });

  describe('headers + query forwarding', () => {
    it('forwards query string to Fastify (router re-parses)', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.get('/q-echo', async (r) => ({ q: r.query }));
      const res = await dispatchTunneledRequest({
        app,
        request: buildRpcRequest({
          path: '/q-echo',
          query: 'a=1&b=two',
        }),
        coreDid: CORE_DID,
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ q: { a: '1', b: 'two' } });
      await app.close();
    });

    it('forwards signed-request headers verbatim for auth middleware', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.get('/h-echo', async (r) => ({
        xDid: r.headers['x-did'],
        xSig: r.headers['x-signature'],
      }));
      const res = await dispatchTunneledRequest({
        app,
        request: buildRpcRequest({
          path: '/h-echo',
          headers: {
            'x-did': 'did:plc:alice',
            'x-signature': 'deadbeef',
          },
        }),
        coreDid: CORE_DID,
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        xDid: 'did:plc:alice',
        xSig: 'deadbeef',
      });
      await app.close();
    });

    it('response headers (x-request-id echo) are forwarded back', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      const res = await dispatchTunneledRequest({
        app,
        request: buildRpcRequest({
          path: '/healthz',
          headers: { 'x-request-id': 'trace-from-tunnel' },
        }),
        coreDid: CORE_DID,
      });
      expect(res.headers['x-request-id']).toBe('trace-from-tunnel');
      await app.close();
    });
  });

  describe('request-id round-trip', () => {
    it('response.request_id echoes the request.request_id for correlation', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      const res = await dispatchTunneledRequest({
        app,
        request: buildRpcRequest({ request_id: 'abc-xyz-42' }),
        coreDid: CORE_DID,
      });
      expect(res.request_id).toBe('abc-xyz-42');
      await app.close();
    });
  });

  describe('body handling', () => {
    it('empty body produces no payload (no content-type spoof)', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.get('/body-check', async (r) => ({ hasBody: r.body !== undefined }));
      const res = await dispatchTunneledRequest({
        app,
        request: buildRpcRequest({ path: '/body-check' }),
        coreDid: CORE_DID,
      });
      expect(res.status).toBe(200);
      await app.close();
    });

    it('string body is passed through as payload', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.post('/echo-body', async (r) => r.body as object);
      const body = JSON.stringify({ hello: 'world' });
      const res = await dispatchTunneledRequest({
        app,
        request: buildRpcRequest({
          method: 'POST',
          path: '/echo-body',
          headers: { 'content-type': 'application/json' },
          body,
        }),
        coreDid: CORE_DID,
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ hello: 'world' });
      await app.close();
    });
  });

  describe('validation', () => {
    it('throws when coreDid is empty', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      await expect(
        dispatchTunneledRequest({
          app,
          request: buildRpcRequest(),
          coreDid: '',
        }),
      ).rejects.toThrow(/coreDid is required/);
      await app.close();
    });
  });
});
