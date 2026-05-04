/**
 * T2A.1 — Core API contract: request/response schemas, wire format, errors.
 *
 * Category B: contract test. Verifies the HTTP API shape using the
 * Core test harness — real HTTP server with stub routes.
 *
 * Source: core/test/apicontract_test.go
 */

import { CoreTestHarness } from '@dina/test-harness';

describe('Core API Contract', () => {
  let harness: CoreTestHarness | null = null;

  beforeAll(async () => {
    harness = await CoreTestHarness.tryCreate();
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  // Skip all tests in this suite if harness couldn't bind a socket
  function requireHarness(): CoreTestHarness {
    if (!harness) {
      // eslint-disable-next-line jest/no-standalone-expect
      expect('harness').toBe('available (socket binding failed — skipping)');
    }
    return harness!;
  }

  describe('health endpoints', () => {
    it('GET /healthz returns 200 with status:ok', async () => {
      const h = requireHarness();
      const res = await h.request('GET', '/healthz');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('GET /readyz returns 200 with status:ready', async () => {
      const res = await requireHarness().request('GET', '/readyz');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ready' });
    });
  });

  describe('response format', () => {
    it('Content-Type is application/json', async () => {
      const res = await requireHarness().request('GET', '/healthz');
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('unknown route returns 404 with error body', async () => {
      const res = await requireHarness().request('GET', '/v1/nonexistent', undefined, {
        as: 'brain',
      });
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'not found');
    });
  });

  describe('auth enforcement', () => {
    it('protected endpoint without auth returns 401', async () => {
      const res = await requireHarness().request('POST', '/v1/vault/store', {
        persona: 'general',
        item: {},
      });
      expect(res.status).toBe(401);
    });

    it('protected endpoint with auth returns non-401', async () => {
      const res = await requireHarness().request(
        'POST',
        '/v1/vault/store',
        { persona: 'general', item: { id: 'test' } },
        { as: 'brain' },
      );
      expect(res.status).not.toBe(401);
    });

    it('public endpoints bypass auth', async () => {
      const res = await requireHarness().request('GET', '/healthz');
      expect(res.status).toBe(200);
    });
  });

  describe('vault endpoints', () => {
    it('POST /v1/vault/store returns 201 with id', async () => {
      const res = await requireHarness().request(
        'POST',
        '/v1/vault/store',
        {
          persona: 'general',
          item: { id: 'contract-test-1', type: 'note', summary: 'test' },
        },
        { as: 'brain' },
      );
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
    });

    it('POST /v1/vault/store without persona returns 400', async () => {
      const res = await requireHarness().request(
        'POST',
        '/v1/vault/store',
        {
          item: { id: 'no-persona' },
        },
        { as: 'brain' },
      );
      expect(res.status).toBe(400);
    });

    it('POST /v1/vault/query returns 200 with items array', async () => {
      const res = await requireHarness().request(
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
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('items');
      expect(Array.isArray((res.body as any).items)).toBe(true);
    });
  });

  describe('staging endpoints', () => {
    it('POST /v1/staging/ingest returns 201 with id + status', async () => {
      const res = await requireHarness().request(
        'POST',
        '/v1/staging/ingest',
        {
          source: 'gmail',
          source_id: 'gmail-msg-1',
          data: {
            type: 'email',
            body: 'test',
            summary: 'test',
          },
        },
        { as: 'brain' },
      );
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body).toHaveProperty('status', 'received');
    });

    it('POST /v1/staging/claim returns 200 with array', async () => {
      // Ingest first, then claim
      await requireHarness().request(
        'POST',
        '/v1/staging/ingest',
        {
          source: 'gmail',
          type: 'email',
          body: 'claim-test',
          summary: 'claim',
        },
        { as: 'brain' },
      );
      const res = await requireHarness().request('POST', '/v1/staging/claim', null, {
        as: 'brain',
        query: 'limit=5',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});
