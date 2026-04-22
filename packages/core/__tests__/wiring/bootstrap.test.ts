/**
 * T2A.17 — Composition root / wiring validation.
 *
 * Category B: contract test. Verifies that all Core dependencies can
 * be wired together — no missing implementations, no circular deps.
 * Adapted from Go's wiring_test.go for the TS composition root.
 *
 * Source: core/test/wiring_test.go
 */

import { CoreTestHarness } from '@dina/test-harness';

describe('Composition Root / Wiring', () => {
  async function createOrSkip(config?: Record<string, unknown>): Promise<CoreTestHarness> {
    const h = await CoreTestHarness.tryCreate(config as any);
    if (!h) {
      // Fail with a clear message — Jest marks it as failed, not silently skipped
      throw new Error(
        'Socket binding unavailable (sandboxed environment) — test requires network access',
      );
    }
    return h;
  }

  describe('CoreTestHarness boots successfully', () => {
    it('creates a harness without errors', async () => {
      const harness = await createOrSkip();
      expect(harness).toBeDefined();
      expect(harness.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      await harness.teardown();
    });

    it('harness serves health endpoint', async () => {
      const harness = await createOrSkip();
      const res = await harness.request('GET', '/healthz');
      expect(res.status).toBe(200);
      await harness.teardown();
    });

    it('harness authenticates Brain requests', async () => {
      const harness = await createOrSkip();
      const res = await harness.request(
        'POST',
        '/v1/vault/query',
        {
          persona: 'general',
          mode: 'fts5',
          text: 'test',
          limit: 10,
        },
        { as: 'brain' },
      );
      expect(res.status).not.toBe(401);
      await harness.teardown();
    });

    it('harness rejects unauthenticated protected requests', async () => {
      const harness = await createOrSkip();
      const res = await harness.request('POST', '/v1/vault/store', {
        persona: 'general',
        item: {},
      });
      expect(res.status).toBe(401);
      await harness.teardown();
    });

    it('multiple harnesses can coexist (different ports)', async () => {
      const h1 = await createOrSkip();
      const h2 = await createOrSkip();
      expect(h1.baseURL).not.toBe(h2.baseURL);
      const r1 = await h1.request('GET', '/healthz');
      const r2 = await h2.request('GET', '/healthz');
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      await h1.teardown();
      await h2.teardown();
    });

    it('teardown is idempotent', async () => {
      const harness = await createOrSkip();
      await harness.teardown();
      await harness.teardown(); // second call should not throw
    });
  });

  describe('custom route registrar', () => {
    it('accepts a custom routeRegistrar', async () => {
      const harness = await createOrSkip({
        routeRegistrar: (router: any) => {
          router.get('/custom', async () => ({ status: 200, body: { custom: true } }));
        },
      });
      const res = await harness.request('GET', '/custom', undefined, { as: 'brain' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ custom: true });
      await harness.teardown();
    });

    it('custom registrar replaces stub routes', async () => {
      const harness = await createOrSkip({
        routeRegistrar: (router: any) => {
          router.get('/healthz', async () => ({ status: 200, body: { status: 'custom' } }));
        },
      });
      const res = await harness.request('GET', '/healthz');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'custom' });
      await harness.teardown();
    });
  });
});
