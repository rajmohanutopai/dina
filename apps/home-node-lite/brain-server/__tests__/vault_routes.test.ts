/**
 * `/api/v1/vault/*` Fastify routes — thin proxy over the CoreClient the
 * SPA uses (mobile hits the in-process vault instead). Driven with a
 * MockCoreClient so a handler/path/shape regression fails here without
 * standing up core-server.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { MockCoreClient } from '@dina/test-harness';

import { registerVaultApiRoutes } from '../src/routes/vault';

function makeApp(core: MockCoreClient): FastifyInstance {
  const app = Fastify({ logger: false });
  registerVaultApiRoutes(app, { core });
  return app;
}

describe('Brain server — /api/v1/vault/* HTTP wiring', () => {
  it('query forwards persona (querystring) + search params (body) to CoreClient', async () => {
    const core = new MockCoreClient();
    core.vaultQueryResult = { items: [{ id: 'i1' }], count: 1 } as never;
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/query?persona=health',
        payload: { text: 'blood pressure', mode: 'hybrid', limit: 5 },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { count: number }).count).toBe(1);
      const call = core.calls.find((c) => c.method === 'vaultQuery');
      expect(call?.args[0]).toBe('health');
      expect(call?.args[1]).toMatchObject({ text: 'blood pressure', mode: 'hybrid', limit: 5 });
    } finally {
      await app.close();
    }
  });

  it('item GET returns the item, and 404 when CoreClient yields null', async () => {
    const core = new MockCoreClient();
    core.vaultGetResult = { id: 'i9', type: 'note' } as never;
    const app = makeApp(core);
    try {
      const found = await app.inject({ method: 'GET', url: '/api/v1/vault/item/i9?persona=general' });
      expect(found.statusCode).toBe(200);
      expect((found.json() as { id: string }).id).toBe('i9');

      core.vaultGetResult = null;
      const missing = await app.inject({
        method: 'GET',
        url: '/api/v1/vault/item/nope?persona=general',
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('store forwards persona + item body', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/store?persona=work',
        payload: { type: 'note', content: { text: 'standup at 9' } },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { id: string }).id).toBe('mock-item-id');
      const call = core.calls.find((c) => c.method === 'vaultStore');
      expect(call?.args[0]).toBe('work');
      expect(call?.args[1]).toMatchObject({ type: 'note' });
    } finally {
      await app.close();
    }
  });

  it('list passes limit/offset/type through as VaultListOptions', async () => {
    const core = new MockCoreClient();
    core.vaultListResult = { items: [], count: 0, total: 7 } as never;
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/vault/list?persona=general&limit=10&offset=20&type=contact',
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { total: number }).total).toBe(7);
      const call = core.calls.find((c) => c.method === 'vaultList');
      expect(call?.args[0]).toBe('general');
      expect(call?.args[1]).toEqual({ limit: 10, offset: 20, type: 'contact' });
    } finally {
      await app.close();
    }
  });

  it('subjects requires person_id and returns { items }', async () => {
    const core = new MockCoreClient();
    core.vaultItemsForPersonResult = [{ id: 's1' }] as never;
    const app = makeApp(core);
    try {
      const missing = await app.inject({
        method: 'GET',
        url: '/api/v1/vault/subjects?persona=general',
      });
      expect(missing.statusCode).toBe(400);

      const ok = await app.inject({
        method: 'GET',
        url: '/api/v1/vault/subjects?persona=general&person_id=p1&limit=3',
      });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { items: unknown[] }).items).toHaveLength(1);
      const call = core.calls.find((c) => c.method === 'vaultItemsForPerson');
      expect(call?.args).toEqual(['general', 'p1', 3]);
    } finally {
      await app.close();
    }
  });

  it('delete returns the CoreClient result', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'DELETE', url: '/api/v1/vault/item/i1?persona=general' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { deleted: boolean }).deleted).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('400s when persona is missing on every route', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      for (const inj of [
        { method: 'POST' as const, url: '/api/v1/vault/query', payload: {} },
        { method: 'GET' as const, url: '/api/v1/vault/item/i1' },
        { method: 'POST' as const, url: '/api/v1/vault/store', payload: {} },
        { method: 'GET' as const, url: '/api/v1/vault/list' },
        { method: 'GET' as const, url: '/api/v1/vault/subjects?person_id=p1' },
        { method: 'DELETE' as const, url: '/api/v1/vault/item/i1' },
      ]) {
        const res = await app.inject(inj);
        expect(res.statusCode).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it('maps a CoreClient failure to 502', async () => {
    const core = new MockCoreClient();
    core.throwOn.vaultQuery = new Error('core unreachable');
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/query?persona=general',
        payload: { text: 'x' },
      });
      expect(res.statusCode).toBe(502);
      expect((res.json() as { error: string }).error).toMatch(/core unreachable/);
    } finally {
      await app.close();
    }
  });
});
