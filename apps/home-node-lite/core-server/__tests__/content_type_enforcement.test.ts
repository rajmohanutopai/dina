/**
 * Task 4.33 — Content-Type JSON enforcement tests.
 *
 * Writes (POST/PUT/PATCH) with a body must declare
 * `application/json` or `application/octet-stream`; otherwise 415.
 * Verbs without bodies (GET/DELETE) and empty-body writes are exempt.
 */

import { pino } from 'pino';
import { createServer } from '../src/server';
import type { Logger } from '../src/logger';
import type { CoreServerConfig } from '../src/config';

function baseConfig(): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'silent', rateLimitPerMinute: 60, prettyLogs: false },
    msgbox: {},
    cors: {},
  };
}
function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

describe('Content-Type JSON enforcement (task 4.33)', () => {
  it('accepts POST with application/json', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.post('/x', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/x',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ hello: 'world' }),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('accepts POST with application/octet-stream', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.post(
      '/x',
      {
        // Fastify needs a parser registered for octet-stream; register
        // the raw-buffer one our bind_core_router uses.
        preHandler: async () => undefined,
      },
      async () => ({ ok: true }),
    );
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/x',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from([0x01, 0x02, 0x03]),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('rejects POST with text/plain → 415', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.post('/x', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/x',
      headers: { 'content-type': 'text/plain' },
      payload: 'some text',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: 'unsupported media type' });
    await app.close();
  });

  it('rejects POST with no Content-Type header + body → 415', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.post('/x', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/x',
      payload: '{"hello":"world"}',
    });
    expect(res.statusCode).toBe(415);
    await app.close();
  });

  it('rejects PUT with text/html → 415', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.put('/x', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'PUT',
      url: '/x',
      headers: { 'content-type': 'text/html' },
      payload: '<p>nope</p>',
    });
    expect(res.statusCode).toBe(415);
    await app.close();
  });

  it('rejects PATCH with application/x-www-form-urlencoded → 415', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.patch('/x', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/x',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1&b=2',
    });
    expect(res.statusCode).toBe(415);
    await app.close();
  });

  it('GET is exempt (no body expected even if Content-Type is weird)', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.get('/x', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'GET',
      url: '/x',
      headers: { 'content-type': 'text/plain' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('DELETE is exempt', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.delete('/x', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'DELETE',
      url: '/x',
      headers: { 'content-type': 'text/plain' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('empty-body POST is exempt (no Content-Length → nothing to parse)', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.post('/x', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/x',
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('accepts charset suffix: application/json; charset=utf-8', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.post('/x', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/x',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: JSON.stringify({ hello: 'world' }),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('rejects UPPERCASE application/JSON → accepted (case-insensitive match)', async () => {
    // HTTP spec says Content-Type values are case-insensitive per the
    // media-type grammar. Pin that behavior.
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.post('/x', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/x',
      headers: { 'content-type': 'APPLICATION/JSON' },
      payload: JSON.stringify({ hello: 'world' }),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
