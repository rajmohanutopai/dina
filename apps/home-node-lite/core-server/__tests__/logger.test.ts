/**
 * Task 4.6 — pino logger shape tests.
 *
 * Verifies slog-parity:
 *   - `level` emitted as a string label (not pino's default number)
 *   - `time` emitted as RFC3339
 *   - `msg` is the message key
 *   - `pid` / `hostname` omitted
 *
 * Uses a writable stream to capture JSON output — no subprocesses, no
 * pino-pretty side effects.
 */

import { Writable } from 'node:stream';
import { pino } from 'pino';
import { createLogger } from '../src/logger';
import type { CoreServerConfig } from '../src/config';

function baseConfig(overrides: Partial<CoreServerConfig['runtime']> = {}): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 8100 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: {
      logLevel: 'info',
      rateLimitPerMinute: 60,
      prettyLogs: false,
      ...overrides,
    },
    msgbox: {},
    cors: {},
  };
}

/**
 * Build a pino logger that writes to an in-memory buffer, using the SAME
 * formatting options our `createLogger` installs. We can't easily
 * intercept the pino stream after construction, so this mirrors the
 * option surface to assert the emitted JSON shape.
 */
function sinkLogger(level = 'info') {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString('utf8'));
      cb();
    },
  });
  const logger = pino(
    {
      level,
      formatters: { level: (label) => ({ level: label }) },
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      messageKey: 'msg',
      base: null,
    },
    sink,
  );
  return { logger, lines };
}

describe('core-server logger (task 4.6)', () => {
  describe('createLogger factory', () => {
    it('constructs with JSON shape for prod config (prettyLogs=false)', () => {
      const logger = createLogger(baseConfig({ prettyLogs: false }));
      expect(logger.level).toBe('info');
    });

    it('honours log level from config', () => {
      const logger = createLogger(baseConfig({ logLevel: 'warn' }));
      expect(logger.level).toBe('warn');
    });

    it.each(['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const)(
      'accepts pino level %s',
      (level) => {
        const logger = createLogger(baseConfig({ logLevel: level }));
        expect(logger.level).toBe(level);
      },
    );

    it('pretty-logs config wires pino-pretty transport', () => {
      // We can't easily black-box the pretty output (it goes through a
      // worker thread). Just prove the factory doesn't throw when pretty
      // is enabled.
      const logger = createLogger(baseConfig({ prettyLogs: true }));
      expect(logger).toBeDefined();
      expect(logger.level).toBe('info');
    });
  });

  describe('slog-parity shape (via the same pino options)', () => {
    it('level is a string label, not a number', () => {
      const { logger, lines } = sinkLogger();
      logger.info('hello');
      expect(lines.length).toBe(1);
      const line = JSON.parse(lines[0] as string) as Record<string, unknown>;
      expect(line['level']).toBe('info');
      expect(typeof line['level']).toBe('string');
    });

    it('time is RFC3339', () => {
      const { logger, lines } = sinkLogger();
      logger.warn('sample');
      const line = JSON.parse(lines[0] as string) as Record<string, unknown>;
      expect(typeof line['time']).toBe('string');
      // ISO 8601 / RFC3339 with Z suffix.
      expect(line['time']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    });

    it('msg is the message key', () => {
      const { logger, lines } = sinkLogger();
      logger.info('hello world');
      const line = JSON.parse(lines[0] as string) as Record<string, unknown>;
      expect(line['msg']).toBe('hello world');
    });

    it('pid / hostname are omitted', () => {
      const { logger, lines } = sinkLogger();
      logger.info('check');
      const line = JSON.parse(lines[0] as string) as Record<string, unknown>;
      expect(line['pid']).toBeUndefined();
      expect(line['hostname']).toBeUndefined();
    });

    it('caller-supplied fields pass through unchanged (persona/did/route)', () => {
      const { logger, lines } = sinkLogger();
      logger.info({ persona: 'health', did: 'did:plc:abc', route: '/v1/vault/store' }, 'stored');
      const line = JSON.parse(lines[0] as string) as Record<string, unknown>;
      expect(line['persona']).toBe('health');
      expect(line['did']).toBe('did:plc:abc');
      expect(line['route']).toBe('/v1/vault/store');
      expect(line['msg']).toBe('stored');
    });
  });
});
