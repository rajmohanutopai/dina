/**
 * Task 5.1 scaffold — proves config loads, boot returns, /healthz
 * responds 200, and close resolves.
 *
 * Uses `port: 0` throughout to let the OS pick a free port — avoids
 * flakiness on CI when 18200 is bound by another test.
 */

import { bootServer, ConfigError, loadConfig } from '../src/main';

describe('brain-server — config (task 5.1/5.4 scaffold)', () => {
  it('loads defaults from empty env', () => {
    const c = loadConfig({});
    expect(c.network.host).toBe('127.0.0.1');
    expect(c.network.port).toBe(8200);
    expect(c.runtime.logLevel).toBe('info');
    expect(c.runtime.prettyLogs).toBe(false);
  });

  it('honours DINA_BRAIN_HOST + PORT overrides', () => {
    const c = loadConfig({ DINA_BRAIN_HOST: '0.0.0.0', DINA_BRAIN_PORT: '8200' });
    expect(c.network.host).toBe('0.0.0.0');
    expect(c.network.port).toBe(8200);
  });

  it('throws ConfigError on invalid log level', () => {
    expect(() => loadConfig({ DINA_BRAIN_LOG_LEVEL: 'loud' })).toThrow(ConfigError);
  });

  it('throws ConfigError on out-of-range port', () => {
    expect(() => loadConfig({ DINA_BRAIN_PORT: '99999' })).toThrow(ConfigError);
  });

  it('prettyLogs=true when env flag is the string "true"', () => {
    const c = loadConfig({ DINA_BRAIN_PRETTY_LOGS: 'true' });
    expect(c.runtime.prettyLogs).toBe(true);
  });
});

describe('brain-server — boot (task 5.1)', () => {
  it('boots, serves /healthz, closes cleanly', async () => {
    const booted = await bootServer({
      DINA_BRAIN_HOST: '127.0.0.1',
      DINA_BRAIN_PORT: '0', // OS-assigned
      DINA_BRAIN_LOG_LEVEL: 'silent',
      DINA_BRAIN_PRETTY_LOGS: 'false',
    });
    try {
      expect(booted.boundAddress).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const res = await booted.app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok', role: 'brain' });
    } finally {
      await booted.app.close();
    }
  });

  it('config object is returned unchanged on the booted instance', async () => {
    const booted = await bootServer({
      DINA_BRAIN_HOST: '127.0.0.1',
      DINA_BRAIN_PORT: '0',
      DINA_BRAIN_LOG_LEVEL: 'silent',
      DINA_BRAIN_PRETTY_LOGS: 'false',
    });
    try {
      expect(booted.config.network.host).toBe('127.0.0.1');
      expect(booted.config.network.port).toBe(0);
    } finally {
      await booted.app.close();
    }
  });
});
