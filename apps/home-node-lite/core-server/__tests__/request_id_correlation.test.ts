/**
 * Task 4.35 — request-ID correlation tests.
 *
 * Verifies:
 *   1. Inbound `X-Request-Id` header is preferred over our monotonic
 *      generator (client / upstream proxy trace correlation).
 *   2. Missing inbound header → our `req-N` generator fires (default path).
 *   3. Every response echoes the final `X-Request-Id` header.
 *   4. Handler-emitted logs carry `request_id: <client-supplied>` when
 *      the header was provided.
 */

import { Writable } from 'node:stream';
import { pino } from 'pino';
import { createServer } from '../src/server';
import type { Logger } from '../src/logger';
import type { CoreServerConfig } from '../src/config';

function baseConfig(): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'info', rateLimitPerMinute: 60, prettyLogs: false },
    msgbox: {},
    cors: {},
  };
}

interface LogCapture {
  logger: Logger;
  lines: Array<Record<string, unknown>>;
}

function capturingLogger(): LogCapture {
  const lines: Array<Record<string, unknown>> = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString('utf8');
      for (const raw of text.split('\n').filter(Boolean)) {
        try {
          lines.push(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          // ignore
        }
      }
      cb();
    },
  });
  const logger: Logger = pino(
    {
      level: 'info',
      formatters: { level: (label) => ({ level: label }) },
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      messageKey: 'msg',
      base: null,
    },
    sink,
  );
  return { logger, lines };
}

describe('request-ID correlation (task 4.35)', () => {
  it('uses inbound X-Request-Id when present', async () => {
    const { logger, lines } = capturingLogger();
    const app = await createServer({ config: baseConfig(), logger });

    app.get('/thing', async (req) => {
      req.log.info('handler-emitted');
      return { ok: true };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/thing',
      headers: { 'x-request-id': 'trace-from-brain-42' },
    });

    // Response echoes the header back.
    expect(res.headers['x-request-id']).toBe('trace-from-brain-42');

    // Handler-emitted log carries the inbound id, not req-1.
    const handlerLog = lines.find((l) => l['msg'] === 'handler-emitted');
    expect(handlerLog?.['request_id']).toBe('trace-from-brain-42');

    await app.close();
  });

  it('generates a req-N id when no inbound header', async () => {
    const { logger, lines } = capturingLogger();
    const app = await createServer({ config: baseConfig(), logger });

    app.get('/thing', async (req) => {
      req.log.info('handler-emitted');
      return { ok: true };
    });

    const res = await app.inject({ method: 'GET', url: '/thing' });
    expect(res.headers['x-request-id']).toMatch(/^req-\d+$/);

    const handlerLog = lines.find((l) => l['msg'] === 'handler-emitted');
    expect(handlerLog?.['request_id']).toMatch(/^req-\d+$/);

    await app.close();
  });

  it('echoes generated id on /healthz too', async () => {
    const app = await createServer({ config: baseConfig(), logger: pino({ level: 'silent' }) });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-request-id']).toMatch(/^req-\d+$/);
    await app.close();
  });

  it('echoes inbound id on /healthz', async () => {
    const app = await createServer({ config: baseConfig(), logger: pino({ level: 'silent' }) });
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'trace-abc' },
    });
    expect(res.headers['x-request-id']).toBe('trace-abc');
    await app.close();
  });

  it('echoes the id on 4xx responses (error paths must correlate too)', async () => {
    const app = await createServer({ config: baseConfig(), logger: pino({ level: 'silent' }) });
    const res = await app.inject({
      method: 'GET',
      url: '/does-not-exist',
      headers: { 'x-request-id': 'trace-for-404' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-request-id']).toBe('trace-for-404');
    await app.close();
  });

  it('echoes the id on 5xx responses too', async () => {
    const app = await createServer({ config: baseConfig(), logger: pino({ level: 'silent' }) });
    app.get('/crash', async () => {
      throw new Error('boom');
    });
    const res = await app.inject({
      method: 'GET',
      url: '/crash',
      headers: { 'x-request-id': 'trace-for-500' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.headers['x-request-id']).toBe('trace-for-500');
    await app.close();
  });

  it('multiple concurrent requests preserve their own ids', async () => {
    const app = await createServer({ config: baseConfig(), logger: pino({ level: 'silent' }) });
    app.get('/thing', async () => ({ ok: true }));

    const [a, b, c] = await Promise.all([
      app.inject({ method: 'GET', url: '/thing', headers: { 'x-request-id': 'id-A' } }),
      app.inject({ method: 'GET', url: '/thing', headers: { 'x-request-id': 'id-B' } }),
      app.inject({ method: 'GET', url: '/thing' }), // generates req-N
    ]);

    expect(a?.headers['x-request-id']).toBe('id-A');
    expect(b?.headers['x-request-id']).toBe('id-B');
    expect(c?.headers['x-request-id']).toMatch(/^req-\d+$/);

    await app.close();
  });
});
