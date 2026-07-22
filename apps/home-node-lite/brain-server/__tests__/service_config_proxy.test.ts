/**
 * `/api/v1/service/config` proxy — the web My-Services publish data layer.
 * Forwards the provider's own listing read/write to Core (signed as brain);
 * surfaces Core's validation rejection as 400 and "not published" as 404.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { registerServiceConfigProxyRoutes } from '../src/routes/service_config_proxy';

import type { CoreClient, ServiceConfig, ServiceListing } from '@dina/core';

interface Calls {
  put: { config: ServiceConfig; rkey?: string }[];
  del: string[];
}

function makeApp(
  calls: Calls,
  stub: Partial<{
    config: ServiceConfig | null;
    listings: ServiceListing[];
    putError: string;
  }> = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  const core = {
    async serviceConfig(_rkey?: string) {
      return stub.config ?? null;
    },
    async listServiceConfigs() {
      return stub.listings ?? [];
    },
    async putServiceConfig(config: ServiceConfig, rkey?: string) {
      if (stub.putError !== undefined) throw new Error(stub.putError);
      calls.put.push({ config, ...(rkey !== undefined ? { rkey } : {}) });
    },
    async deleteServiceConfig(rkey: string) {
      calls.del.push(rkey);
    },
  } as unknown as CoreClient;
  registerServiceConfigProxyRoutes(app, { core });
  return app;
}

const CFG = {
  isDiscoverable: true,
  name: 'Route 42',
  description: 'x',
  capabilities: { eta_query: { category: 'transit', responsePolicy: 'auto' } },
} as unknown as ServiceConfig;

describe('Brain — service-config proxy (web My-Services publish)', () => {
  it('PUT /api/v1/service/config forwards the listing to Core', async () => {
    const calls: Calls = { put: [], del: [] };
    const app = makeApp(calls);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/service/config',
      payload: CFG,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(calls.put).toHaveLength(1);
    expect(calls.put[0]?.config.name).toBe('Route 42');
    await app.close();
  });

  it('surfaces a Core validation rejection as 400 (not a 502 gateway error)', async () => {
    const app = makeApp({ put: [], del: [] }, { putError: 'invalid service listing: missing_category' });
    const res = await app.inject({ method: 'PUT', url: '/api/v1/service/config', payload: CFG });
    expect(res.statusCode).toBe(400);
    expect(String((res.json() as { error: string }).error)).toMatch(/missing_category/);
    await app.close();
  });

  it('GET /api/v1/service/config returns 404 when nothing is published (→ web null)', async () => {
    const app = makeApp({ put: [], del: [] }, { config: null });
    const res = await app.inject({ method: 'GET', url: '/api/v1/service/config' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /api/v1/service/config returns the config when published', async () => {
    const app = makeApp({ put: [], del: [] }, { config: CFG });
    const res = await app.inject({ method: 'GET', url: '/api/v1/service/config' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ServiceConfig).name).toBe('Route 42');
    await app.close();
  });

  it('GET /api/v1/service/configs lists every listing', async () => {
    const listings = [{ rkey: 'self', config: CFG }] as unknown as ServiceListing[];
    const app = makeApp({ put: [], del: [] }, { listings });
    const res = await app.inject({ method: 'GET', url: '/api/v1/service/configs' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { listings: unknown[] }).listings).toHaveLength(1);
    await app.close();
  });

  it('DELETE /api/v1/service/config/:rkey removes a listing', async () => {
    const calls: Calls = { put: [], del: [] };
    const app = makeApp(calls);
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/service/config/self' });
    expect(res.statusCode).toBe(200);
    expect(calls.del).toEqual(['self']);
    await app.close();
  });
});
