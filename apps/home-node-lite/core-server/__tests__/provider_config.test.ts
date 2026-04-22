/**
 * Task 5.23 — provider config loader tests.
 */

import {
  KNOWN_PROVIDER_NAMES,
  ProviderConfigError,
  availableProviders,
  loadProviderConfig,
  toCloudGateEntries,
  toLoggable,
} from '../src/brain/provider_config';

function sampleJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    providers: [
      {
        name: 'anthropic',
        kind: 'cloud',
        models: ['claude-sonnet-4-6', 'claude-opus-4-7'],
        defaultModel: 'claude-sonnet-4-6',
        enabled: true,
      },
      {
        name: 'local-llama',
        kind: 'local',
        models: ['gemma-3n'],
        defaultModel: 'gemma-3n',
        enabled: true,
      },
      ...((overrides['extraProviders'] as unknown[]) ?? []),
    ],
  });
}

function sampleEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DINA_ANTHROPIC_API_KEY: 'sk-test-anthropic',
    ...overrides,
  };
}

describe('loadProviderConfig (task 5.23)', () => {
  describe('constants', () => {
    it('KNOWN_PROVIDER_NAMES lists the 5 canonical providers', () => {
      expect([...KNOWN_PROVIDER_NAMES].sort()).toEqual([
        'anthropic',
        'google',
        'local-llama',
        'openai',
        'openrouter',
      ]);
    });
  });

  describe('happy path', () => {
    it('loads a well-formed config + merges API keys from env', () => {
      const config = loadProviderConfig({ rawJson: sampleJson(), env: sampleEnv() });
      expect(config.providers).toHaveLength(2);
      const anthropic = config.providers.find((p) => p.name === 'anthropic')!;
      expect(anthropic.apiKey).toBe('sk-test-anthropic');
      expect(anthropic.defaultModel).toBe('claude-sonnet-4-6');

      const local = config.providers.find((p) => p.name === 'local-llama')!;
      expect(local.kind).toBe('local');
      expect(local.apiKey).toBeUndefined(); // local doesn't need a key
    });

    it('enabled defaults to true when omitted', () => {
      const json = JSON.stringify({
        providers: [
          {
            name: 'local-llama',
            kind: 'local',
            models: ['m'],
            defaultModel: 'm',
          },
        ],
      });
      const config = loadProviderConfig({ rawJson: json, env: {} });
      expect(config.providers[0]!.enabled).toBe(true);
    });

    it('honours baseUrl override', () => {
      const json = JSON.stringify({
        providers: [
          {
            name: 'anthropic',
            kind: 'cloud',
            models: ['claude'],
            defaultModel: 'claude',
            baseUrl: 'https://proxy.example/v1',
            enabled: true,
          },
        ],
      });
      const config = loadProviderConfig({ rawJson: json, env: sampleEnv() });
      expect(config.providers[0]!.baseUrl).toBe('https://proxy.example/v1');
    });

    it('hyphens in provider name → underscores in env var name', () => {
      const json = JSON.stringify({
        providers: [
          {
            name: 'open-router',
            kind: 'cloud',
            models: ['grok'],
            defaultModel: 'grok',
            enabled: true,
          },
        ],
      });
      const config = loadProviderConfig({
        rawJson: json,
        env: { DINA_OPEN_ROUTER_API_KEY: 'sk-or-test' },
      });
      expect(config.providers[0]!.apiKey).toBe('sk-or-test');
    });
  });

  describe('error cases', () => {
    it('rejects malformed JSON', () => {
      expect(() => loadProviderConfig({ rawJson: '{not json', env: {} })).toThrow(
        ProviderConfigError,
      );
    });

    it('invalid_json carries the error code', () => {
      try {
        loadProviderConfig({ rawJson: '{', env: {} });
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderConfigError);
        if (err instanceof ProviderConfigError) expect(err.code).toBe('invalid_json');
      }
    });

    it('rejects invalid shape', () => {
      const json = JSON.stringify({ providers: [{ name: 'x' }] }); // missing required fields
      try {
        loadProviderConfig({ rawJson: json, env: {} });
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderConfigError);
        if (err instanceof ProviderConfigError) {
          expect(err.code).toBe('invalid_shape');
          expect(err.detail?.['issues']).toBeDefined();
        }
      }
    });

    it('rejects duplicate provider name', () => {
      const json = JSON.stringify({
        providers: [
          {
            name: 'anthropic',
            kind: 'cloud',
            models: ['m'],
            defaultModel: 'm',
          },
          {
            name: 'anthropic',
            kind: 'cloud',
            models: ['m'],
            defaultModel: 'm',
          },
        ],
      });
      try {
        loadProviderConfig({ rawJson: json, env: sampleEnv() });
        fail('expected throw');
      } catch (err) {
        if (err instanceof ProviderConfigError) {
          expect(err.code).toBe('duplicate_provider');
        }
      }
    });

    it('rejects defaultModel not in models', () => {
      const json = JSON.stringify({
        providers: [
          {
            name: 'anthropic',
            kind: 'cloud',
            models: ['a', 'b'],
            defaultModel: 'c',
          },
        ],
      });
      try {
        loadProviderConfig({ rawJson: json, env: sampleEnv() });
        fail('expected throw');
      } catch (err) {
        if (err instanceof ProviderConfigError) {
          expect(err.code).toBe('default_model_not_in_list');
          expect(err.detail?.['provider']).toBe('anthropic');
        }
      }
    });

    it('rejects missing API key for enabled cloud provider', () => {
      try {
        loadProviderConfig({ rawJson: sampleJson(), env: {} });
        fail('expected throw');
      } catch (err) {
        if (err instanceof ProviderConfigError) {
          expect(err.code).toBe('missing_api_key');
          expect(err.detail?.['envVar']).toBe('DINA_ANTHROPIC_API_KEY');
        }
      }
    });

    it('disabled cloud provider WITHOUT api key is OK', () => {
      const json = JSON.stringify({
        providers: [
          {
            name: 'anthropic',
            kind: 'cloud',
            models: ['m'],
            defaultModel: 'm',
            enabled: false,
          },
        ],
      });
      expect(() => loadProviderConfig({ rawJson: json, env: {} })).not.toThrow();
    });

    it('local provider needs no api key', () => {
      expect(() =>
        loadProviderConfig({
          rawJson: JSON.stringify({
            providers: [
              {
                name: 'local-llama',
                kind: 'local',
                models: ['m'],
                defaultModel: 'm',
              },
            ],
          }),
          env: {},
        }),
      ).not.toThrow();
    });
  });

  describe('toLoggable', () => {
    it('redacts apiKey for cloud providers', () => {
      const config = loadProviderConfig({ rawJson: sampleJson(), env: sampleEnv() });
      const log = toLoggable(config);
      const anthropic = log.find((p) => p['name'] === 'anthropic')!;
      expect(anthropic['apiKey']).toBe('<present>');
      expect(JSON.stringify(log)).not.toContain('sk-test-anthropic');
    });

    it('reports <missing> for cloud-without-key (disabled provider)', () => {
      const json = JSON.stringify({
        providers: [
          {
            name: 'openai',
            kind: 'cloud',
            models: ['gpt'],
            defaultModel: 'gpt',
            enabled: false,
          },
        ],
      });
      const config = loadProviderConfig({ rawJson: json, env: {} });
      const log = toLoggable(config);
      expect(log[0]!['apiKey']).toBe('<missing>');
    });

    it('omits apiKey entirely for local providers', () => {
      const config = loadProviderConfig({ rawJson: sampleJson(), env: sampleEnv() });
      const log = toLoggable(config);
      const local = log.find((p) => p['name'] === 'local-llama')!;
      expect('apiKey' in local).toBe(false);
    });
  });

  describe('availableProviders', () => {
    it('excludes disabled + key-less cloud', () => {
      const json = JSON.stringify({
        providers: [
          {
            name: 'anthropic',
            kind: 'cloud',
            models: ['m'],
            defaultModel: 'm',
            enabled: true,
          },
          {
            name: 'openai',
            kind: 'cloud',
            models: ['m'],
            defaultModel: 'm',
            enabled: false,
          },
          {
            name: 'local-llama',
            kind: 'local',
            models: ['m'],
            defaultModel: 'm',
            enabled: true,
          },
        ],
      });
      const config = loadProviderConfig({ rawJson: json, env: sampleEnv() });
      const avail = availableProviders(config).map((p) => p.name).sort();
      expect(avail).toEqual(['anthropic', 'local-llama']);
    });
  });

  describe('toCloudGateEntries', () => {
    it('lifts into {name, kind} for CloudGate consumption', () => {
      const config = loadProviderConfig({ rawJson: sampleJson(), env: sampleEnv() });
      expect(toCloudGateEntries(config)).toEqual([
        { name: 'anthropic', kind: 'cloud' },
        { name: 'local-llama', kind: 'local' },
      ]);
    });
  });
});
