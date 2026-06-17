/**
 * `/api/v1/identity` Fastify route — thin proxy over the CoreClient the
 * SPA uses to discover this node's identity (mobile reads
 * `getNodeIdentity()` in-process instead). Driven with a MockCoreClient
 * so a handler/path/shape regression fails here without standing up
 * core-server.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { MockCoreClient } from '@dina/test-harness';

import { registerIdentityApiRoutes } from '../src/routes/identity';

function makeApp(core: MockCoreClient): FastifyInstance {
  const app = Fastify({ logger: false });
  registerIdentityApiRoutes(app, { core });
  return app;
}

describe('Brain server — /api/v1/identity HTTP wiring', () => {
  it('proxies CoreClient.identity() and returns { did, handle }', async () => {
    const core = new MockCoreClient();
    core.identityResult = {
      did: 'did:plc:alonso123',
      handle: 'alonso.test-pds.dinakernel.com',
    };
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/identity' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        did: 'did:plc:alonso123',
        handle: 'alonso.test-pds.dinakernel.com',
      });
      // Exactly one CoreClient.identity() call — no fan-out.
      expect(core.callCountOf('identity')).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('passes a null handle through unchanged (did:key node)', async () => {
    const core = new MockCoreClient();
    core.identityResult = { did: 'did:key:z6Mklocal', handle: null };
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/identity' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ did: 'did:key:z6Mklocal', handle: null });
    } finally {
      await app.close();
    }
  });

  it('maps a CoreClient failure to 502 (core unreachable)', async () => {
    const core = new MockCoreClient();
    core.throwOn.identity = new Error('core unreachable');
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/identity' });
      expect(res.statusCode).toBe(502);
      expect((res.json() as { error: string }).error).toMatch(/core unreachable/);
    } finally {
      await app.close();
    }
  });
});
