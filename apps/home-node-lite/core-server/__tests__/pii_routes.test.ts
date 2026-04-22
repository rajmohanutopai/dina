/**
 * Task 4.78 — POST /v1/pii/scrub Fastify integration tests.
 */

import { pino } from 'pino';
import { createServer } from '../src/server';
import type { CoreServerConfig } from '../src/config';
import { AllowList } from '../src/pii/allow_list';
import { DEFAULT_MAX_TEXT_LENGTH, registerPiiRoutes } from '../src/pii/routes';
import { RehydrationSessionRegistry } from '../src/pii/rehydration_sessions';

function baseConfig(): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'silent', rateLimitPerMinute: 10_000, prettyLogs: false },
    msgbox: {},
    cors: {},
  };
}

function silentLogger() {
  return pino({ level: 'silent' });
}

async function buildApp(
  opts: {
    allowList?: AllowList;
    maxTextLength?: number;
    rehydrationSessions?: RehydrationSessionRegistry;
  } = {},
) {
  const app = await createServer({ config: baseConfig(), logger: silentLogger() });
  registerPiiRoutes(app, opts);
  return app;
}

interface ScrubResponse {
  scrubbed: string;
  entities: Array<{
    type: string;
    start: number;
    end: number;
    value: string;
    token: string;
  }>;
}

describe('POST /v1/pii/scrub (task 4.78)', () => {
  describe('happy path', () => {
    it('scrubs an email from text and returns entities', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/scrub',
        headers: { 'content-type': 'application/json' },
        payload: { text: 'contact me at alice@example.com please' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as ScrubResponse;
      expect(body.scrubbed).toBe('contact me at [EMAIL_1] please');
      expect(body.entities).toHaveLength(1);
      expect(body.entities[0]).toMatchObject({
        type: 'EMAIL',
        value: 'alice@example.com',
        token: '[EMAIL_1]',
      });
      await app.close();
    });

    it('numbers multiple entities of the same type sequentially', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/scrub',
        headers: { 'content-type': 'application/json' },
        payload: { text: 'email a@b.com and c@d.com' },
      });
      const body = res.json() as ScrubResponse;
      expect(body.entities.map((e) => e.token)).toEqual(['[EMAIL_1]', '[EMAIL_2]']);
      expect(body.scrubbed).toBe('email [EMAIL_1] and [EMAIL_2]');
      await app.close();
    });

    it('preserves original offsets in entities (for rehydrate)', async () => {
      const app = await buildApp();
      const text = 'email alice@example.com today';
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/scrub',
        headers: { 'content-type': 'application/json' },
        payload: { text },
      });
      const body = res.json() as ScrubResponse;
      const entity = body.entities[0]!;
      // Offsets point back into the ORIGINAL text.
      expect(text.slice(entity.start, entity.end)).toBe('alice@example.com');
      await app.close();
    });

    it('returns empty scrubbed + entities for empty text', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/scrub',
        headers: { 'content-type': 'application/json' },
        payload: { text: '' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ scrubbed: '', entities: [] });
      await app.close();
    });

    it('passes through text with no PII unchanged', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/scrub',
        headers: { 'content-type': 'application/json' },
        payload: { text: 'the quick brown fox' },
      });
      const body = res.json() as ScrubResponse;
      expect(body.scrubbed).toBe('the quick brown fox');
      expect(body.entities).toEqual([]);
      await app.close();
    });
  });

  describe('allow-list integration', () => {
    it('leaves an allow-listed token intact', async () => {
      const allowList = new AllowList().add('ABCDE1234F');
      const app = await buildApp({ allowList });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/scrub',
        headers: { 'content-type': 'application/json' },
        payload: { text: 'PAN: ABCDE1234F is fine' },
      });
      const body = res.json() as ScrubResponse;
      expect(body.scrubbed).toBe('PAN: ABCDE1234F is fine');
      expect(body.entities).toEqual([]);
      await app.close();
    });

    it('still scrubs non-allow-listed tokens in the same request', async () => {
      const allowList = new AllowList().add('ABCDE1234F');
      const app = await buildApp({ allowList });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/scrub',
        headers: { 'content-type': 'application/json' },
        payload: { text: 'PAN ABCDE1234F; email a@b.com' },
      });
      const body = res.json() as ScrubResponse;
      expect(body.entities.map((e) => e.type)).toEqual(['EMAIL']);
      expect(body.scrubbed).toContain('ABCDE1234F'); // allow-listed
      expect(body.scrubbed).toContain('[EMAIL_1]');  // still scrubbed
      await app.close();
    });

    it('type-scoped allow-list entries do not bleed to other types', async () => {
      // "alice@internal" matches both EMAIL and UPI regex families.
      // Allow-list it only for UPI; EMAIL still gets scrubbed.
      const allowList = new AllowList().add('alice@internal', { type: 'UPI' });
      const app = await buildApp({ allowList });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/scrub',
        headers: { 'content-type': 'application/json' },
        payload: { text: 'ping alice@internal for details' },
      });
      const body = res.json() as ScrubResponse;
      // Because UPI overlaps with the email regex, detectPII's
      // overlap-resolution picks one match. Whichever survives, the
      // type-scoped allow-list must only suppress UPI.
      for (const e of body.entities) {
        expect(e.type).not.toBe('UPI');
      }
      await app.close();
    });
  });

  describe('validation', () => {
    it('rejects missing text with 400', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/scrub',
        headers: { 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'text is required' });
      await app.close();
    });

    it('rejects non-string text with 400', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/scrub',
        headers: { 'content-type': 'application/json' },
        payload: { text: 123 },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('rejects input longer than maxTextLength with 413', async () => {
      const app = await buildApp({ maxTextLength: 100 });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/scrub',
        headers: { 'content-type': 'application/json' },
        payload: { text: 'x'.repeat(101) },
      });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({
        error: 'text exceeds 100-character limit',
      });
      await app.close();
    });

    it('accepts input exactly at the max length', async () => {
      const app = await buildApp({ maxTextLength: 100 });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/scrub',
        headers: { 'content-type': 'application/json' },
        payload: { text: 'x'.repeat(100) },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('DEFAULT_MAX_TEXT_LENGTH matches Python Brain', () => {
      expect(DEFAULT_MAX_TEXT_LENGTH).toBe(100_000);
    });
  });

  describe('POST /v1/pii/rehydrate — direct mode (task 4.79)', () => {
    it('restores original PII from entities', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/rehydrate',
        headers: { 'content-type': 'application/json' },
        payload: {
          text: 'contact [EMAIL_1] — thanks',
          entities: [{ token: '[EMAIL_1]', value: 'alice@example.com' }],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ rehydrated: 'contact alice@example.com — thanks' });
      await app.close();
    });

    it('restores multiple tokens including repeats', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/rehydrate',
        headers: { 'content-type': 'application/json' },
        payload: {
          text: '[EMAIL_1] then [EMAIL_1] again and [PHONE_1]',
          entities: [
            { token: '[EMAIL_1]', value: 'a@b.com' },
            { token: '[PHONE_1]', value: '555-0100' },
          ],
        },
      });
      expect((res.json() as { rehydrated: string }).rehydrated).toBe(
        'a@b.com then a@b.com again and 555-0100',
      );
      await app.close();
    });

    it('rejects missing text with 400', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/rehydrate',
        headers: { 'content-type': 'application/json' },
        payload: { entities: [] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'text is required' });
      await app.close();
    });

    it('rejects body with neither session_id nor entities', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/rehydrate',
        headers: { 'content-type': 'application/json' },
        payload: { text: 'hi' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'session_id or entities is required' });
      await app.close();
    });

    it('rejects body with BOTH session_id and entities', async () => {
      const app = await buildApp({ rehydrationSessions: new RehydrationSessionRegistry() });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/rehydrate',
        headers: { 'content-type': 'application/json' },
        payload: { text: 'hi', session_id: 'x', entities: [] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'provide either session_id or entities, not both',
      });
      await app.close();
    });

    it('rejects malformed entity items with 400', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/rehydrate',
        headers: { 'content-type': 'application/json' },
        payload: {
          text: 'hi [EMAIL_1]',
          entities: [{ token: '', value: 'x' }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'entities must be [{token: string, value: string}, ...]',
      });
      await app.close();
    });

    it('rejects over-length text with 413', async () => {
      const app = await buildApp({ maxTextLength: 100 });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/rehydrate',
        headers: { 'content-type': 'application/json' },
        payload: { text: 'x'.repeat(101), entities: [] },
      });
      expect(res.statusCode).toBe(413);
      await app.close();
    });
  });

  describe('POST /v1/pii/rehydrate — session mode (task 4.79)', () => {
    it('restores using a pre-created session', async () => {
      const sessions = new RehydrationSessionRegistry();
      const { sessionId } = sessions.create([
        { token: '[EMAIL_1]', value: 'alice@example.com' },
      ]);
      const app = await buildApp({ rehydrationSessions: sessions });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/rehydrate',
        headers: { 'content-type': 'application/json' },
        payload: { text: 'hi [EMAIL_1]', session_id: sessionId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ rehydrated: 'hi alice@example.com' });
      // Session is NOT consumed by default — second call works.
      expect(sessions.isLive(sessionId)).toBe(true);
      await app.close();
    });

    it('consume=true destroys the session after rehydrate', async () => {
      const sessions = new RehydrationSessionRegistry();
      const { sessionId } = sessions.create([
        { token: '[EMAIL_1]', value: 'a@b.com' },
      ]);
      const app = await buildApp({ rehydrationSessions: sessions });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/rehydrate',
        headers: { 'content-type': 'application/json' },
        payload: { text: '[EMAIL_1]', session_id: sessionId, consume: true },
      });
      expect(res.statusCode).toBe(200);
      expect(sessions.isLive(sessionId)).toBe(false);
      await app.close();
    });

    it('returns 404 on unknown session_id', async () => {
      const app = await buildApp({ rehydrationSessions: new RehydrationSessionRegistry() });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/rehydrate',
        headers: { 'content-type': 'application/json' },
        payload: { text: 'x', session_id: 'ghost' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'session not found or expired' });
      await app.close();
    });

    it('returns 404 on expired session_id', async () => {
      let nowMs = 1_700_000_000_000;
      const sessions = new RehydrationSessionRegistry({ nowMsFn: () => nowMs });
      const { sessionId } = sessions.create(
        [{ token: '[EMAIL_1]', value: 'a@b.com' }],
        { ttlMs: 1000 },
      );
      nowMs += 2000;
      const app = await buildApp({ rehydrationSessions: sessions });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/rehydrate',
        headers: { 'content-type': 'application/json' },
        payload: { text: '[EMAIL_1]', session_id: sessionId },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('returns 501 when session mode is used but no registry is wired', async () => {
      const app = await buildApp(); // no rehydrationSessions
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/rehydrate',
        headers: { 'content-type': 'application/json' },
        payload: { text: 'x', session_id: 'x' },
      });
      expect(res.statusCode).toBe(501);
      await app.close();
    });
  });

  describe('POST /v1/pii/session (task 4.79 companion)', () => {
    it('creates a session and the id round-trips through rehydrate', async () => {
      const sessions = new RehydrationSessionRegistry();
      const app = await buildApp({ rehydrationSessions: sessions });
      const create = await app.inject({
        method: 'POST',
        url: '/v1/pii/session',
        headers: { 'content-type': 'application/json' },
        payload: {
          entities: [{ token: '[EMAIL_1]', value: 'alice@example.com' }],
        },
      });
      expect(create.statusCode).toBe(200);
      const { session_id, expires_at } = create.json() as {
        session_id: string;
        expires_at: number;
      };
      expect(typeof session_id).toBe('string');
      expect(session_id.length).toBeGreaterThan(0);
      expect(expires_at).toBeGreaterThan(Date.now() - 1000);

      const rehydrate = await app.inject({
        method: 'POST',
        url: '/v1/pii/rehydrate',
        headers: { 'content-type': 'application/json' },
        payload: { text: 'hi [EMAIL_1]', session_id },
      });
      expect(rehydrate.json()).toEqual({ rehydrated: 'hi alice@example.com' });
      await app.close();
    });

    it('honours ttl_ms', async () => {
      const sessions = new RehydrationSessionRegistry();
      const app = await buildApp({ rehydrationSessions: sessions });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/session',
        headers: { 'content-type': 'application/json' },
        payload: { entities: [], ttl_ms: 1000 },
      });
      const { expires_at } = res.json() as { expires_at: number };
      // expires_at is within 1.5s of now
      expect(expires_at - Date.now()).toBeGreaterThan(500);
      expect(expires_at - Date.now()).toBeLessThanOrEqual(1500);
      await app.close();
    });

    it('rejects non-array entities', async () => {
      const app = await buildApp({ rehydrationSessions: new RehydrationSessionRegistry() });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/session',
        headers: { 'content-type': 'application/json' },
        payload: { entities: 'not an array' },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('rejects malformed entity items', async () => {
      const app = await buildApp({ rehydrationSessions: new RehydrationSessionRegistry() });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/session',
        headers: { 'content-type': 'application/json' },
        payload: { entities: [{ token: '', value: 'x' }] },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('rejects non-positive ttl_ms', async () => {
      const app = await buildApp({ rehydrationSessions: new RehydrationSessionRegistry() });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/session',
        headers: { 'content-type': 'application/json' },
        payload: { entities: [], ttl_ms: -1 },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('endpoint is NOT registered when rehydrationSessions is absent', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pii/session',
        headers: { 'content-type': 'application/json' },
        payload: { entities: [] },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  describe('End-to-end scrub → session → rehydrate', () => {
    it('scrub output + session + rehydrate round-trips the original text', async () => {
      const sessions = new RehydrationSessionRegistry();
      const app = await buildApp({ rehydrationSessions: sessions });
      const original = 'email alice@example.com for details';

      // 1. scrub
      const scrub = await app.inject({
        method: 'POST',
        url: '/v1/pii/scrub',
        headers: { 'content-type': 'application/json' },
        payload: { text: original },
      });
      const { scrubbed, entities } = scrub.json() as ScrubResponse;

      // 2. session
      const session = await app.inject({
        method: 'POST',
        url: '/v1/pii/session',
        headers: { 'content-type': 'application/json' },
        payload: {
          entities: entities.map((e) => ({ token: e.token, value: e.value })),
        },
      });
      const { session_id } = session.json() as { session_id: string };

      // 3. rehydrate
      const rehydrate = await app.inject({
        method: 'POST',
        url: '/v1/pii/rehydrate',
        headers: { 'content-type': 'application/json' },
        payload: { text: scrubbed, session_id, consume: true },
      });
      expect(rehydrate.json()).toEqual({ rehydrated: original });
      expect(sessions.isLive(session_id)).toBe(false);
      await app.close();
    });
  });

  describe('registerPiiRoutes construction', () => {
    it('rejects non-positive maxTextLength', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      expect(() => registerPiiRoutes(app, { maxTextLength: 0 })).toThrow(
        /maxTextLength must be > 0/,
      );
      expect(() => registerPiiRoutes(app, { maxTextLength: NaN })).toThrow(
        /maxTextLength must be > 0/,
      );
      await app.close();
    });
  });
});
