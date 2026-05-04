/**
 * Task 4.4 + 4.5 — config loader + Zod validation tests.
 *
 * Uses an explicit `env` object (not `process.env`) to keep tests hermetic.
 */

import { loadConfig, ConfigError, DEFAULTS } from '../src/config';

/** Minimum env for a valid config — tests mutate/extend this. */
function minimalEnv(): NodeJS.ProcessEnv {
  return { DINA_VAULT_DIR: '/var/lib/dina' };
}

describe('core-server config (task 4.4/4.5)', () => {
  describe('happy path', () => {
    it('loads minimal env + fills in safe defaults', () => {
      const cfg = loadConfig(minimalEnv());
      expect(cfg).toEqual({
        endpoints: {
          mode: 'test',
          msgboxWsUrl: 'wss://test-mailbox.dinakernel.com/ws',
          pdsBaseUrl: 'https://test-pds.dinakernel.com',
          appViewBaseUrl: 'https://test-appview.dinakernel.com',
          plcDirectoryUrl: 'https://plc.directory',
        },
        network: { host: DEFAULTS.network.host, port: DEFAULTS.network.port },
        storage: { vaultDir: '/var/lib/dina', cachePages: DEFAULTS.storage.cachePages },
        runtime: {
          logLevel: DEFAULTS.runtime.logLevel,
          rateLimitPerMinute: DEFAULTS.runtime.rateLimitPerMinute,
          prettyLogs: DEFAULTS.runtime.prettyLogs,
        },
        msgbox: { url: 'wss://test-mailbox.dinakernel.com/ws', enabled: true },
        cors: {},
      });
    });

    it('accepts fully-specified env', () => {
      const cfg = loadConfig({
        DINA_VAULT_DIR: '/opt/dina/vault',
        DINA_CORE_HOST: '0.0.0.0',
        DINA_CORE_PORT: '9443',
        DINA_CACHE_PAGES: '5000',
        DINA_LOG_LEVEL: 'debug',
        DINA_RATE_LIMIT: '1000',
        DINA_PRETTY_LOGS: 'true',
        DINA_ENDPOINT_MODE: 'release',
        DINA_MSGBOX_URL: 'wss://msgbox.dina.example/ws',
        DINA_PDS_URL: 'https://pds.dina.example/',
        DINA_APPVIEW_URL: 'https://appview.dina.example/',
        DINA_PLC_URL: 'https://plc.dina.example/',
        DINA_HOMENODE_DID: 'did:plc:example',
        DINA_MSGBOX_ENABLED: 'false',
        DINA_CORS_ORIGIN: 'https://admin.example.com',
      });
      expect(cfg).toEqual({
        endpoints: {
          mode: 'release',
          msgboxWsUrl: 'wss://msgbox.dina.example/ws',
          pdsBaseUrl: 'https://pds.dina.example',
          appViewBaseUrl: 'https://appview.dina.example',
          plcDirectoryUrl: 'https://plc.dina.example',
        },
        network: { host: '0.0.0.0', port: 9443 },
        storage: { vaultDir: '/opt/dina/vault', cachePages: 5000 },
        runtime: { logLevel: 'debug', rateLimitPerMinute: 1000, prettyLogs: true },
        msgbox: {
          url: 'wss://msgbox.dina.example/ws',
          homeNodeDid: 'did:plc:example',
          enabled: false,
        },
        cors: { allowOrigin: 'https://admin.example.com' },
      });
    });

    it.each([
      ['1', true],
      ['true', true],
      ['YES', true],
      ['on', true],
      ['0', false],
      ['false', false],
      ['NO', false],
      ['off', false],
    ])('DINA_PRETTY_LOGS=%s → prettyLogs=%s', (input, expected) => {
      const cfg = loadConfig({ ...minimalEnv(), DINA_PRETTY_LOGS: input });
      expect(cfg.runtime.prettyLogs).toBe(expected);
    });

    it.each([
      ['1', true],
      ['true', true],
      ['YES', true],
      ['on', true],
      ['0', false],
      ['false', false],
      ['NO', false],
      ['off', false],
    ])('DINA_MSGBOX_ENABLED=%s → msgbox.enabled=%s', (input, expected) => {
      const cfg = loadConfig({ ...minimalEnv(), DINA_MSGBOX_ENABLED: input });
      expect(cfg.msgbox.enabled).toBe(expected);
    });
  });

  describe('required fields', () => {
    it('rejects missing DINA_VAULT_DIR', () => {
      expect(() => loadConfig({})).toThrow(ConfigError);
      try {
        loadConfig({});
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).issues[0]?.path).toBe('DINA_VAULT_DIR');
      }
    });

    it('empty-string DINA_VAULT_DIR is treated as missing', () => {
      expect(() => loadConfig({ DINA_VAULT_DIR: '' })).toThrow(/DINA_VAULT_DIR is required/);
    });
  });

  describe('type coercion + validation', () => {
    it('rejects non-integer port', () => {
      expect(() => loadConfig({ ...minimalEnv(), DINA_CORE_PORT: 'not-a-number' })).toThrow(
        /DINA_CORE_PORT must be an integer/,
      );
    });

    it('rejects port out of range', () => {
      expect(() => loadConfig({ ...minimalEnv(), DINA_CORE_PORT: '70000' })).toThrow(ConfigError);
      expect(() => loadConfig({ ...minimalEnv(), DINA_CORE_PORT: '-1' })).toThrow(ConfigError);
    });

    it('accepts port 0 (ephemeral / OS-chosen, commonly used in tests)', () => {
      const cfg = loadConfig({ ...minimalEnv(), DINA_CORE_PORT: '0' });
      expect(cfg.network.port).toBe(0);
    });

    it('rejects invalid log level', () => {
      const err = captureError(() =>
        loadConfig({ ...minimalEnv(), DINA_LOG_LEVEL: 'verbose' }),
      );
      expect(err).toBeInstanceOf(ConfigError);
      expect(err?.issues.some((i) => i.path === 'runtime.logLevel')).toBe(true);
    });

    it('rejects invalid boolean', () => {
      expect(() =>
        loadConfig({ ...minimalEnv(), DINA_PRETTY_LOGS: 'maybe' }),
      ).toThrow(/DINA_PRETTY_LOGS must be a boolean/);
    });

    it('rejects invalid MsgBox enabled boolean', () => {
      expect(() =>
        loadConfig({ ...minimalEnv(), DINA_MSGBOX_ENABLED: 'maybe' }),
      ).toThrow(/DINA_MSGBOX_ENABLED must be a boolean/);
    });

    it('rejects cachePages below minimum', () => {
      const err = captureError(() =>
        loadConfig({ ...minimalEnv(), DINA_CACHE_PAGES: '5' }),
      );
      expect(err).toBeInstanceOf(ConfigError);
      expect(err?.issues.some((i) => i.path === 'storage.cachePages')).toBe(true);
    });

    it('rejects non-URL msgbox', () => {
      const err = captureError(() =>
        loadConfig({ ...minimalEnv(), DINA_MSGBOX_URL: 'not a url' }),
      );
      expect(err).toBeInstanceOf(ConfigError);
      expect(err?.issues.some((i) => i.path === 'DINA_MSGBOX_URL')).toBe(true);
    });

    it('rejects invalid endpoint mode', () => {
      const err = captureError(() =>
        loadConfig({ ...minimalEnv(), DINA_ENDPOINT_MODE: 'prod' }),
      );
      expect(err).toBeInstanceOf(ConfigError);
      expect(err?.issues.some((i) => i.path === 'DINA_ENDPOINT_MODE')).toBe(true);
    });
  });

  describe('defaults are frozen', () => {
    it('DEFAULTS cannot be mutated at runtime', () => {
      expect(Object.isFrozen(DEFAULTS)).toBe(true);
      // Even nested network object is via `as const` — TS blocks mutation
      // at compile time; runtime freeze is shallow but sufficient for
      // the top-level DEFAULTS object.
    });
  });
});

function captureError(fn: () => unknown): ConfigError | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof ConfigError ? err : null;
  }
}
