/**
 * `/api/v1/chat` Fastify route — thin shim over `handleChat`.
 *
 * The orchestrator's full behaviour is pinned in
 * `packages/brain/__tests__/chat/orchestrator.test.ts`. These tests
 * only pin the HTTP wiring: request shape validation, response
 * surface, error path, reset path, and the `DINA_BRAIN_DEV_UI` gate
 * for the `/dev` HTML page.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { registerChatRoutes } from '../src/routes/chat';

function makeApp(opts: { exposeDevUI?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  registerChatRoutes(app, opts);
  return app;
}

describe('Brain server — /api/v1/chat HTTP wiring', () => {
  it('rejects empty text with 400', async () => {
    const app = makeApp();
    const resp = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { text: '' },
    });
    expect(resp.statusCode).toBe(400);
    expect(JSON.parse(resp.body)).toMatchObject({ error: expect.any(String) });
    await app.close();
  });

  it('forwards a /help command to handleChat and returns a ChatResponse-shaped body', async () => {
    const app = makeApp();
    // /help is the simplest orchestrator path that doesn't need
    // Core/LLM wired — it returns a static command-list. Plain free-
    // form text would hit the /ask path which needs an LLM provider
    // registered (covered by the orchestrator's own tests).
    const resp = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { text: '/help', threadId: 'unit-test' },
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body) as { intent: string; response: string };
    expect(typeof body.intent).toBe('string');
    expect(typeof body.response).toBe('string');
    expect(body.response.length).toBeGreaterThan(0);
    await app.close();
  });

  it('surfaces orchestrator errors as 500 with a JSON error body', async () => {
    const app = makeApp();
    // Free-form text → /ask path. Without an LLM provider wired
    // up at this test boundary the orchestrator throws; the route
    // catches and returns 500 with the error message. Pins the
    // dev-surface contract: errors are visible, not hidden.
    const resp = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { text: 'what is the capital of france' },
    });
    expect(resp.statusCode).toBe(500);
    const body = JSON.parse(resp.body) as { error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
    await app.close();
  });

  it('reset endpoint clears the thread', async () => {
    const app = makeApp();
    // Seed a message so the reset has something to clear.
    await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { text: 'seed', threadId: 'reset-thread' },
    });
    const resp = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/reset',
      payload: { threadId: 'reset-thread' },
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body) as { ok: boolean };
    expect(body.ok).toBe(true);
    await app.close();
  });

  it('does NOT expose /dev by default', async () => {
    const app = makeApp({ exposeDevUI: false });
    const resp = await app.inject({ method: 'GET', url: '/dev' });
    expect(resp.statusCode).toBe(404);
    await app.close();
  });

  it('exposes /dev HTML when exposeDevUI is true', async () => {
    const app = makeApp({ exposeDevUI: true });
    const resp = await app.inject({ method: 'GET', url: '/dev' });
    expect(resp.statusCode).toBe(200);
    expect(resp.headers['content-type']).toContain('text/html');
    expect(resp.body).toContain('Dina');
    // Sanity: the page references the chat endpoint it calls.
    expect(resp.body).toContain('/api/v1/chat');
    await app.close();
  });
});
