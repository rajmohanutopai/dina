/**
 * Task 5.3 — Brain-server configuration loader tests.
 */

import {
  BrainConfigError,
  DEFAULT_BRAIN_PORT,
  DEFAULT_LOG_LEVEL,
  DEFAULT_MODEL_DEFAULT,
  hasProviderKey,
  loadBrainConfig,
  toLoggable,
  type BrainConfig,
} from '../src/brain/brain_config';

/** Base env with the required DINA_CORE_URL set so each test only asserts its own delta. */
function env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { DINA_CORE_URL: 'http://core.local:8100', HOME: '/home/test', ...extra };
}

describe('loadBrainConfig (task 5.3)', () => {
  describe('defaults + required keys', () => {
    it('returns defaults when only DINA_CORE_URL is set', () => {
      const cfg = loadBrainConfig({ env: env() });
      expect(cfg.port).toBe(DEFAULT_BRAIN_PORT);
      expect(cfg.coreUrl).toBe('http://core.local:8100');
      expect(cfg.modelDefault).toBe(DEFAULT_MODEL_DEFAULT);
      expect(cfg.logLevel).toBe(DEFAULT_LOG_LEVEL);
      expect(cfg.configDir).toBe('/home/test/.dina/brain');
      expect(cfg.providerKeys).toEqual({});
    });

    it('DEFAULT constants match documented values', () => {
      expect(DEFAULT_BRAIN_PORT).toBe(8200);
      expect(DEFAULT_MODEL_DEFAULT).toBe('anthropic:claude-haiku-4-5');
      expect(DEFAULT_LOG_LEVEL).toBe('info');
    });

    it('missing DINA_CORE_URL throws missing_required', () => {
      expect(() => loadBrainConfig({ env: { HOME: '/h' } })).toThrow(BrainConfigError);
      try {
        loadBrainConfig({ env: { HOME: '/h' } });
      } catch (err) {
        const e = err as BrainConfigError;
        expect(e.code).toBe('missing_required');
        expect(e.detail).toMatchObject({ key: 'DINA_CORE_URL' });
        expect(e.detail.hint).toMatch(/DINA_CORE_URL/);
      }
    });

    it('empty DINA_CORE_URL treated as missing', () => {
      expect(() => loadBrainConfig({ env: { HOME: '/h', DINA_CORE_URL: '' } })).toThrow(
        BrainConfigError,
      );
    });

    it('allowMissingCoreUrl lets boot proceed with empty coreUrl', () => {
      const cfg = loadBrainConfig({
        env: { HOME: '/h' },
        allowMissingCoreUrl: true,
      });
      expect(cfg.coreUrl).toBe('');
    });

    it('falls back to USERPROFILE when HOME is absent', () => {
      const cfg = loadBrainConfig({
        env: { DINA_CORE_URL: 'http://c', USERPROFILE: 'C:/Users/x' },
      });
      expect(cfg.configDir).toBe('C:/Users/x/.dina/brain');
    });

    it('configDir ultimate fallback is /tmp when no HOME or USERPROFILE', () => {
      const cfg = loadBrainConfig({ env: { DINA_CORE_URL: 'http://c' } });
      expect(cfg.configDir).toBe('/tmp/.dina/brain');
    });
  });

  describe('source precedence (overrides > env > defaults)', () => {
    it('env overrides defaults', () => {
      const cfg = loadBrainConfig({
        env: env({
          DINA_BRAIN_PORT: '1234',
          DINA_MODEL_DEFAULT: 'openai:gpt-5',
          DINA_LOG_LEVEL: 'debug',
          DINA_CONFIG_DIR: '/data/brain',
        }),
      });
      expect(cfg.port).toBe(1234);
      expect(cfg.modelDefault).toBe('openai:gpt-5');
      expect(cfg.logLevel).toBe('debug');
      expect(cfg.configDir).toBe('/data/brain');
    });

    it('overrides beat env', () => {
      const cfg = loadBrainConfig({
        env: env({ DINA_BRAIN_PORT: '1234', DINA_LOG_LEVEL: 'debug' }),
        overrides: { port: 9999, logLevel: 'trace' },
      });
      expect(cfg.port).toBe(9999);
      expect(cfg.logLevel).toBe('trace');
    });

    it('override coreUrl beats env coreUrl', () => {
      const cfg = loadBrainConfig({
        env: env({ DINA_CORE_URL: 'http://from-env' }),
        overrides: { coreUrl: 'https://from-override' },
      });
      expect(cfg.coreUrl).toBe('https://from-override');
    });
  });

  describe('port validation', () => {
    it.each([
      ['0', 'invalid_port'],
      ['-1', 'invalid_port'],
      ['65536', 'invalid_port'],
      ['abc', 'invalid_port'],
      ['1.5', 'invalid_port'],
    ])('DINA_BRAIN_PORT=%s rejected as %s', (value, code) => {
      expect(() => loadBrainConfig({ env: env({ DINA_BRAIN_PORT: value }) })).toThrow(
        BrainConfigError,
      );
      try {
        loadBrainConfig({ env: env({ DINA_BRAIN_PORT: value }) });
      } catch (err) {
        expect((err as BrainConfigError).code).toBe(code);
      }
    });

    it('accepts boundary values 1 and 65535', () => {
      expect(loadBrainConfig({ env: env({ DINA_BRAIN_PORT: '1' }) }).port).toBe(1);
      expect(loadBrainConfig({ env: env({ DINA_BRAIN_PORT: '65535' }) }).port).toBe(65535);
    });
  });

  describe('URL validation', () => {
    it.each([
      ['not-a-url'],
      ['ftp://elsewhere'],
      ['ws://core'],
      ['://missing-scheme'],
    ])('rejects non-http(s) URL %s', (url) => {
      expect(() =>
        loadBrainConfig({ env: { HOME: '/h', DINA_CORE_URL: url } }),
      ).toThrow(BrainConfigError);
      try {
        loadBrainConfig({ env: { HOME: '/h', DINA_CORE_URL: url } });
      } catch (err) {
        expect((err as BrainConfigError).code).toBe('invalid_url');
        expect((err as BrainConfigError).detail.supplied).toBe(url);
      }
    });

    it('accepts http and https', () => {
      expect(
        loadBrainConfig({ env: { HOME: '/h', DINA_CORE_URL: 'http://x' } }).coreUrl,
      ).toBe('http://x');
      expect(
        loadBrainConfig({ env: { HOME: '/h', DINA_CORE_URL: 'https://y:8100' } }).coreUrl,
      ).toBe('https://y:8100');
    });
  });

  describe('model default validation', () => {
    it.each([['no-colon'], [''], ['   ']])('rejects %s', (value) => {
      expect(() =>
        loadBrainConfig({ env: env({ DINA_MODEL_DEFAULT: value }) }),
      ).toThrow(BrainConfigError);
    });

    it('accepts provider:model shape', () => {
      const cfg = loadBrainConfig({
        env: env({ DINA_MODEL_DEFAULT: 'anthropic:claude-opus-4-7' }),
      });
      expect(cfg.modelDefault).toBe('anthropic:claude-opus-4-7');
    });
  });

  describe('log level validation', () => {
    it.each(['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const)(
      'accepts %s',
      (level) => {
        const cfg = loadBrainConfig({ env: env({ DINA_LOG_LEVEL: level }) });
        expect(cfg.logLevel).toBe(level);
      },
    );

    it('rejects unknown level', () => {
      expect(() =>
        loadBrainConfig({ env: env({ DINA_LOG_LEVEL: 'verbose' }) }),
      ).toThrow(BrainConfigError);
      try {
        loadBrainConfig({ env: env({ DINA_LOG_LEVEL: 'verbose' }) });
      } catch (err) {
        const e = err as BrainConfigError;
        expect(e.code).toBe('invalid_log_level');
        expect(e.detail.allowed).toContain('info');
      }
    });
  });

  describe('provider keys', () => {
    it('scans DINA_<PROVIDER>_API_KEY env vars', () => {
      const cfg = loadBrainConfig({
        env: env({
          DINA_ANTHROPIC_API_KEY: 'sk-ant-x',
          DINA_GEMINI_API_KEY: 'sk-gem-y',
          DINA_OPENAI_API_KEY: 'sk-oai-z',
        }),
      });
      expect(cfg.providerKeys).toEqual({
        anthropic: 'sk-ant-x',
        gemini: 'sk-gem-y',
        openai: 'sk-oai-z',
      });
    });

    it('ignores unrelated DINA_* vars', () => {
      const cfg = loadBrainConfig({
        env: env({
          DINA_RATE_LIMIT: '100',
          DINA_API_KEY: 'not-a-provider-key', // no provider segment
          DINA_ANTHROPIC_API_KEY: 'sk-ant',
        }),
      });
      expect(Object.keys(cfg.providerKeys)).toEqual(['anthropic']);
    });

    it('converts underscores in provider id to hyphens', () => {
      const cfg = loadBrainConfig({
        env: env({ DINA_VOYAGE_AI_API_KEY: 'sk-v' }),
      });
      expect(cfg.providerKeys).toEqual({ 'voyage-ai': 'sk-v' });
    });

    it('skips empty-string keys', () => {
      const cfg = loadBrainConfig({
        env: env({ DINA_ANTHROPIC_API_KEY: '' }),
      });
      expect(cfg.providerKeys).toEqual({});
    });

    it('overrides.providerKeys merge over env keys', () => {
      const cfg = loadBrainConfig({
        env: env({ DINA_ANTHROPIC_API_KEY: 'sk-env' }),
        overrides: { providerKeys: { anthropic: 'sk-override', cohere: 'sk-co' } },
      });
      expect(cfg.providerKeys).toEqual({ anthropic: 'sk-override', cohere: 'sk-co' });
    });
  });
});

describe('toLoggable (task 5.3)', () => {
  it('redacts every provider key to <present>', () => {
    const cfg = loadBrainConfig({
      env: env({
        DINA_ANTHROPIC_API_KEY: 'sk-ant-secret',
        DINA_GEMINI_API_KEY: 'sk-gem-secret',
      }),
    });
    const safe = toLoggable(cfg);
    expect(safe.providerKeys).toEqual({
      anthropic: '<present>',
      gemini: '<present>',
    });
  });

  it('preserves non-secret fields verbatim', () => {
    const cfg = loadBrainConfig({ env: env({ DINA_BRAIN_PORT: '9100' }) });
    const safe = toLoggable(cfg);
    expect(safe.port).toBe(9100);
    expect(safe.coreUrl).toBe(cfg.coreUrl);
    expect(safe.modelDefault).toBe(cfg.modelDefault);
    expect(safe.logLevel).toBe(cfg.logLevel);
    expect(safe.configDir).toBe(cfg.configDir);
  });

  it('no secret value leaks into JSON serialisation of the loggable view', () => {
    const cfg = loadBrainConfig({
      env: env({ DINA_ANTHROPIC_API_KEY: 'sk-leaky-secret-VALUE' }),
    });
    const serialised = JSON.stringify(toLoggable(cfg));
    expect(serialised).not.toContain('sk-leaky-secret-VALUE');
    expect(serialised).toContain('<present>');
  });
});

describe('hasProviderKey (task 5.3)', () => {
  it('returns true for present providers, false for absent', () => {
    const cfg: BrainConfig = loadBrainConfig({
      env: env({ DINA_ANTHROPIC_API_KEY: 'sk-x' }),
    });
    expect(hasProviderKey(cfg, 'anthropic')).toBe(true);
    expect(hasProviderKey(cfg, 'gemini')).toBe(false);
  });

  it('is not fooled by prototype keys', () => {
    const cfg = loadBrainConfig({ env: env() });
    expect(hasProviderKey(cfg, 'toString')).toBe(false);
    expect(hasProviderKey(cfg, 'constructor')).toBe(false);
  });
});

describe('BrainConfigError (task 5.3)', () => {
  it('carries code + detail and preserves error name', () => {
    const err = new BrainConfigError('invalid_port', { supplied: '0', hint: 'h' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BrainConfigError');
    expect(err.code).toBe('invalid_port');
    expect(err.detail).toEqual({ supplied: '0', hint: 'h' });
    expect(err.message).toContain('invalid_port');
  });
});
