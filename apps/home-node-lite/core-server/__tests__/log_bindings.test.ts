/**
 * Task 4.7 — per-request log bindings tests.
 *
 * Verifies the slog-parity per-request context (`request_id`, `route`)
 * is populated on every request's child logger, and that
 * `req.bindDidContext` attaches `did` + `persona` so the auth
 * middleware can propagate caller identity into log entries.
 *
 * Instead of scraping stdout, we install a capturing pino logger and
 * assert the emitted JSON objects directly.
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
          // ignore non-JSON lines (pino-pretty output etc)
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

describe('per-request log bindings (task 4.7)', () => {
  it('handler-emitted log entries carry request_id + route', async () => {
    const { logger, lines } = capturingLogger();
    const app = await createServer({ config: baseConfig(), logger });

    app.get('/thing', async (req) => {
      req.log.info('inside handler');
      return { ok: true };
    });

    await app.inject({ method: 'GET', url: '/thing' });
    await app.close();

    const inside = lines.find((l) => l['msg'] === 'inside handler');
    expect(inside).toBeDefined();
    expect(inside?.['request_id']).toMatch(/^req-\d+$/);
    expect(inside?.['route']).toBe('/thing');
  });

  it('Fastify built-in access logs use request_id label (not reqId)', async () => {
    const { logger, lines } = capturingLogger();
    const app = await createServer({ config: baseConfig(), logger });

    await app.inject({ method: 'GET', url: '/healthz' });
    await app.close();

    const accessLogs = lines.filter(
      (l) => l['msg'] === 'incoming request' || l['msg'] === 'request completed',
    );
    expect(accessLogs.length).toBeGreaterThanOrEqual(2);
    for (const line of accessLogs) {
      expect(line['request_id']).toMatch(/^req-\d+$/);
      // Legacy `reqId` must NOT appear — the label rename is total.
      expect(line['reqId']).toBeUndefined();
    }
  });

  it('request_id increments monotonically across requests', async () => {
    const { logger, lines } = capturingLogger();
    const app = await createServer({ config: baseConfig(), logger });

    app.get('/a', async (req) => {
      req.log.info('a');
      return { ok: true };
    });
    app.get('/b', async (req) => {
      req.log.info('b');
      return { ok: true };
    });

    await app.inject({ method: 'GET', url: '/a' });
    await app.inject({ method: 'GET', url: '/b' });
    await app.close();

    const ids = lines
      .filter((l) => l['msg'] === 'a' || l['msg'] === 'b')
      .map((l) => l['request_id'] as string);
    expect(ids).toEqual(['req-1', 'req-2']);
  });

  it('route reflects matched Fastify route pattern (not the raw URL)', async () => {
    const { logger, lines } = capturingLogger();
    const app = await createServer({ config: baseConfig(), logger });

    app.get('/v1/items/:id', async (req) => {
      req.log.info('item fetch');
      return { ok: true };
    });

    await app.inject({ method: 'GET', url: '/v1/items/abc-123' });
    await app.close();

    const line = lines.find((l) => l['msg'] === 'item fetch');
    expect(line?.['route']).toBe('/v1/items/:id');
    expect(line?.['route']).not.toBe('/v1/items/abc-123');
  });

  it('bindDidContext attaches did + persona to subsequent log entries', async () => {
    const { logger, lines } = capturingLogger();
    const app = await createServer({ config: baseConfig(), logger });

    app.get('/echo', async (req) => {
      req.bindDidContext({ did: 'did:plc:caller', persona: 'health' });
      req.log.info('after bind');
      return { ok: true };
    });

    await app.inject({ method: 'GET', url: '/echo' });
    await app.close();

    const afterBind = lines.find((l) => l['msg'] === 'after bind');
    expect(afterBind).toBeDefined();
    expect(afterBind?.['did']).toBe('did:plc:caller');
    expect(afterBind?.['persona']).toBe('health');
    // request_id + route still present.
    expect(afterBind?.['request_id']).toMatch(/^req-\d+$/);
    expect(afterBind?.['route']).toBe('/echo');
  });

  it('bindDidContext called twice overwrites earlier context', async () => {
    const { logger, lines } = capturingLogger();
    const app = await createServer({ config: baseConfig(), logger });

    app.get('/echo', async (req) => {
      req.bindDidContext({ did: 'did:plc:first' });
      req.bindDidContext({ did: 'did:plc:second', persona: 'work' });
      req.log.info('final');
      return { ok: true };
    });

    await app.inject({ method: 'GET', url: '/echo' });
    await app.close();

    const final = lines.find((l) => l['msg'] === 'final');
    expect(final?.['did']).toBe('did:plc:second');
    expect(final?.['persona']).toBe('work');
  });

  it('unbound requests carry NO did / persona keys (omitted, not null)', async () => {
    const { logger, lines } = capturingLogger();
    const app = await createServer({ config: baseConfig(), logger });

    app.get('/nop', async (req) => {
      req.log.info('no bind');
      return { ok: true };
    });

    await app.inject({ method: 'GET', url: '/nop' });
    await app.close();

    const noBind = lines.find((l) => l['msg'] === 'no bind');
    expect(noBind).toBeDefined();
    expect(noBind && 'did' in noBind).toBe(false);
    expect(noBind && 'persona' in noBind).toBe(false);
  });
});
