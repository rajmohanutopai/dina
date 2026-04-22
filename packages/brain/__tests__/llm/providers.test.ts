/**
 * T2D.2 — LLM provider spec parsing, model routing, embed inference.
 *
 * Wired to real provider_config module + inline parseProviderSpec.
 *
 * Source: tests/test_providers.py
 */

import {
  configureProvider,
  getProviderStatuses,
  resetProviderConfig,
} from '../../src/llm/provider_config';

/** Parse "provider/model" spec string. */
function parseProviderSpec(spec: string): { provider: string; model: string } {
  if (!spec.includes('/')) throw new Error(`Invalid spec: missing "/" in "${spec}"`);
  const slashIdx = spec.indexOf('/');
  const provider = spec.slice(0, slashIdx).toLowerCase();
  const model = spec.slice(slashIdx + 1);
  if (!provider) throw new Error('Invalid spec: empty provider');
  if (!model) throw new Error('Invalid spec: empty model');
  return { provider, model };
}

/** Create provider config from env vars. */
function createProviderConfig(env: Record<string, string>): {
  light?: string;
  heavy?: string;
  embed?: string;
  canAnalyzeVideo: boolean;
} {
  const light = env.DINA_LIGHT ? parseProviderSpec(env.DINA_LIGHT) : undefined;
  const heavy = env.DINA_HEAVY ? parseProviderSpec(env.DINA_HEAVY) : undefined;
  const embed = env.DINA_EMBED ? parseProviderSpec(env.DINA_EMBED) : undefined;

  if (!light && !heavy) throw new Error('At least one of DINA_LIGHT or DINA_HEAVY must be set');

  return {
    light: light ? `${light.provider}/${light.model}` : undefined,
    heavy: heavy ? `${heavy.provider}/${heavy.model}` : undefined,
    embed: embed
      ? `${embed.provider}/${embed.model}`
      : light
        ? `${light.provider}/embed`
        : undefined,
    canAnalyzeVideo: heavy?.provider === 'gemini',
  };
}

describe('LLM Provider Configuration', () => {
  beforeEach(() => resetProviderConfig());

  describe('parseProviderSpec', () => {
    it('parses ollama/model', () => {
      expect(parseProviderSpec('ollama/llama3')).toEqual({ provider: 'ollama', model: 'llama3' });
    });

    it('parses gemini/model', () => {
      expect(parseProviderSpec('gemini/flash-2.0')).toEqual({
        provider: 'gemini',
        model: 'flash-2.0',
      });
    });

    it('normalizes provider to lowercase', () => {
      expect(parseProviderSpec('GEMINI/model').provider).toBe('gemini');
    });

    it('rejects spec without slash', () => {
      expect(() => parseProviderSpec('no-slash')).toThrow('missing "/"');
    });

    it('rejects empty provider', () => {
      expect(() => parseProviderSpec('/model')).toThrow('empty provider');
    });

    it('rejects empty model', () => {
      expect(() => parseProviderSpec('gemini/')).toThrow('empty model');
    });

    it('handles multiple slashes (org/model)', () => {
      const result = parseProviderSpec('openrouter/meta/llama-3');
      expect(result.provider).toBe('openrouter');
      expect(result.model).toBe('meta/llama-3');
    });
  });

  describe('createProviderConfig', () => {
    it('light-only config', () => {
      const config = createProviderConfig({ DINA_LIGHT: 'gemini/flash-lite' });
      expect(config.light).toBe('gemini/flash-lite');
    });

    it('heavy-only config', () => {
      const config = createProviderConfig({ DINA_HEAVY: 'gemini/pro-2.0' });
      expect(config.heavy).toBe('gemini/pro-2.0');
    });

    it('both light + heavy', () => {
      const config = createProviderConfig({
        DINA_LIGHT: 'ollama/llama3',
        DINA_HEAVY: 'gemini/pro-2.0',
      });
      expect(config.light).toBeDefined();
      expect(config.heavy).toBeDefined();
    });

    it('raises when nothing configured', () => {
      expect(() => createProviderConfig({})).toThrow('At least one');
    });

    it('verdict model uses heavy', () => {
      expect(createProviderConfig({ DINA_HEAVY: 'gemini/pro' }).heavy).toBe('gemini/pro');
    });

    it('chat model uses light', () => {
      expect(createProviderConfig({ DINA_LIGHT: 'ollama/llama3' }).light).toBe('ollama/llama3');
    });

    it('embed inferred from light', () => {
      expect(createProviderConfig({ DINA_LIGHT: 'gemini/flash' }).embed).toBe('gemini/embed');
    });

    it('explicit embed overrides', () => {
      const config = createProviderConfig({
        DINA_LIGHT: 'ollama/llama3',
        DINA_EMBED: 'openai/text-embedding-3-small',
      });
      expect(config.embed).toBe('openai/text-embedding-3-small');
    });

    it('gemini heavy → canAnalyzeVideo true', () => {
      expect(createProviderConfig({ DINA_HEAVY: 'gemini/pro-2.0' }).canAnalyzeVideo).toBe(true);
    });

    it('ollama heavy → canAnalyzeVideo false', () => {
      expect(createProviderConfig({ DINA_HEAVY: 'ollama/llama3' }).canAnalyzeVideo).toBe(false);
    });

    it('status shows configured providers', () => {
      configureProvider('claude', 'sk-ant-test-key');
      const statuses = getProviderStatuses();
      expect(statuses.find((s) => s.name === 'claude')!.available).toBe(true);
    });
  });
});
