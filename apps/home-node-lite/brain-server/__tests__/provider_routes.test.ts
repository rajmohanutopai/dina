/**
 * `/api/v1/providers/status` — redacted AI-provider status for the SPA
 * (D7). Strictly never returns the API key. Driven against a real Fastify
 * instance via `inject`.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { registerProviderApiRoutes } from '../src/routes/providers';
import type { BrainServerConfig } from '../src/config';

function makeApp(llm: BrainServerConfig['llm']): FastifyInstance {
  const app = Fastify({ logger: false });
  registerProviderApiRoutes(app, { llm });
  return app;
}

describe('Brain server — /api/v1/providers/status', () => {
  it('reports a configured gemini provider WITHOUT leaking the key', async () => {
    const app = makeApp({ provider: 'gemini', apiKey: 'AIzaSECRETKEY1234', model: 'gemini-3.5' });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/providers/status' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toEqual({
        provider: 'gemini',
        configured: true,
        source: 'env',
        model: 'gemini-3.5',
        last4: '1234',
      });
      // Hard guard: the raw key must never appear anywhere in the payload.
      expect(JSON.stringify(body)).not.toContain('AIzaSECRETKEY');
    } finally {
      await app.close();
    }
  });

  it('reports unconfigured when provider is none', async () => {
    const app = makeApp({ provider: 'none' });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/providers/status' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        provider: 'none',
        configured: false,
        source: 'none',
        model: null,
        last4: null,
      });
    } finally {
      await app.close();
    }
  });
});
