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

import { listNotifications, resetNotifications } from '@dina/brain/notifications';

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

  describe('/chat/service-result — R4-02 watch delivery (shared silence pipeline)', () => {
    // A watch result now flows through the SAME `deliverWatchResult` silence
    // pipeline mobile uses: the route always returns { ok: true }; whether it
    // surfaced is observed on the notification inbox (empty = suppressed). A
    // provider card gives deterministic rendered display for the wake filter.
    // R3-05 always appends for a resolved+active result (banner deferral aside),
    // so inbox length is a DND-agnostic delivery signal.
    beforeEach(() => {
      resetNotifications();
    });

    function watchTask(originChannel: string): Record<string, unknown> {
      return {
        id: 'wt-1',
        kind: 'service_query',
        payload: JSON.stringify({
          origin_channel: originChannel,
          query_id: 'q1',
          capability: 'flight_status',
        }),
      };
    }
    const event = { task_id: 'wt-1', event_kind: 'service_response', event_id: 1 };
    function details(cardTitle: string, cardBody: string): Record<string, unknown> {
      return {
        response_status: 'success',
        capability: 'flight_status',
        service_name: 'Flights',
        result: { note: cardBody },
        card: {
          version: 1,
          blocks: [
            { kind: 'title', text: cardTitle },
            { kind: 'body', text: cardBody },
          ],
        },
      };
    }

    async function post(payload: Record<string, unknown>) {
      const app = makeApp();
      const resp = await app.inject({ method: 'POST', url: '/api/v1/chat/service-result', payload });
      const body = JSON.parse(resp.body) as { ok?: boolean };
      await app.close();
      return { statusCode: resp.statusCode, body };
    }

    it('SUPPRESSES a watch result when the forwarded policy is inactive — fail closed', async () => {
      const { statusCode, body } = await post({
        text: 'BA117 delayed',
        event,
        task: watchTask('watch:sub-1'),
        details: details('Flight delayed', 'BA117 +40m'),
        watch_policy: { active: false },
      });
      expect(statusCode).toBe(200);
      expect(body).toMatchObject({ ok: true });
      expect(listNotifications()).toHaveLength(0); // suppressed — nothing surfaced
    });

    it('SUPPRESSES a watch result when the wake filter does not match', async () => {
      const { statusCode } = await post({
        text: 'BA117 on time',
        event,
        task: watchTask('watch:sub-1'),
        details: details('On time', 'BA117 on time'), // card has no "delayed"
        watch_policy: { active: true, filter: { contains: 'delayed' } },
      });
      expect(statusCode).toBe(200);
      expect(listNotifications()).toHaveLength(0);
    });

    it('fails CLOSED for an active policy carrying a MALFORMED filter (R4-02)', async () => {
      const { statusCode } = await post({
        text: 'BA117 delayed',
        event,
        task: watchTask('watch:sub-1'),
        details: details('Flight delayed', 'BA117 +40m'),
        // active:true but the wake filter is corrupt (empty contains) — must NOT
        // silently degrade to "fire always"; it fails closed (policy → null).
        watch_policy: { active: true, filter: { contains: '' } },
      });
      expect(statusCode).toBe(200);
      expect(listNotifications()).toHaveLength(0);
    });

    it('fails CLOSED for a watch origin with NO forwarded policy (malformed → suppress)', async () => {
      const { statusCode } = await post({
        text: 'BA117 delayed',
        event,
        task: watchTask('watch:sub-1'),
        details: details('Flight delayed', 'BA117 +40m'),
        // watch_policy omitted → parseForwardedWatchPolicy → null → watchActive false
      });
      expect(statusCode).toBe(200);
      expect(listNotifications()).toHaveLength(0);
    });

    it('DELIVERS an active, matching watch result into the notification inbox', async () => {
      const { statusCode, body } = await post({
        text: 'BA117 delayed 40m',
        event,
        task: watchTask('watch:sub-1'),
        details: details('Flight delayed', 'BA117 +40m'),
        watch_policy: { active: true, filter: { contains: 'delayed' } },
      });
      expect(statusCode).toBe(200);
      expect(body).toMatchObject({ ok: true });
      // Retained in the inbox (the proper silence-tiered surface, not chat).
      const items = listNotifications();
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Flight delayed');
    });

    it('does NOT route a non-watch service result to the inbox (stays on chat)', async () => {
      const { statusCode, body } = await post({
        text: 'BA117 delayed 40m',
        event,
        task: watchTask('talk:peer-1'), // not a watch origin
        details: details('Flight delayed', 'BA117 +40m'),
      });
      expect(statusCode).toBe(200);
      expect(body).toMatchObject({ ok: true });
      expect(listNotifications()).toHaveLength(0); // went to the chat thread
    });
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
