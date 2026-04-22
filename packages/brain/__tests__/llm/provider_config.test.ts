/**
 * T4.4/4.16 — LLM provider configuration manager.
 *
 * Source: ARCHITECTURE.md Tasks 4.4, 4.16
 */

import {
  configureProvider,
  removeProvider,
  getProviderConfig,
  validateKeyFormat,
  isProviderAvailable,
  getProviderStatuses,
  getBestProvider,
  configuredCount,
  resetProviderConfig,
  getProviderTiers,
} from '../../src/llm/provider_config';

describe('LLM Provider Configuration', () => {
  beforeEach(() => resetProviderConfig());

  describe('configureProvider', () => {
    it('configures Claude with API key', () => {
      configureProvider('claude', 'sk-ant-test-key-12345');
      const config = getProviderConfig('claude');
      expect(config).not.toBeNull();
      expect(config!.apiKey).toBe('sk-ant-test-key-12345');
      expect(config!.model).toBe('claude-sonnet-4-6');
      expect(config!.enabled).toBe(true);
    });

    it('configures OpenAI with custom model', () => {
      configureProvider('openai', 'sk-test-key', 'gpt-4-turbo');
      expect(getProviderConfig('openai')!.model).toBe('gpt-4-turbo');
    });

    it('local provider needs no API key', () => {
      configureProvider('local', '');
      expect(isProviderAvailable('local')).toBe(true);
    });

    it('empty API key disables cloud provider', () => {
      configureProvider('claude', '');
      expect(isProviderAvailable('claude')).toBe(false);
    });

    it('overwrites existing config (hot-reload)', () => {
      configureProvider('claude', 'sk-ant-old');
      configureProvider('claude', 'sk-ant-new');
      expect(getProviderConfig('claude')!.apiKey).toBe('sk-ant-new');
    });

    it('tracks configuredAt timestamp', () => {
      const before = Date.now();
      configureProvider('claude', 'sk-ant-test');
      expect(getProviderConfig('claude')!.configuredAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('removeProvider', () => {
    it('removes configuration', () => {
      configureProvider('claude', 'sk-ant-test');
      removeProvider('claude');
      expect(getProviderConfig('claude')).toBeNull();
      expect(isProviderAvailable('claude')).toBe(false);
    });
  });

  describe('validateKeyFormat', () => {
    it('Claude: valid sk-ant- prefix', () => {
      expect(validateKeyFormat('claude', 'sk-ant-12345678901234567890')).toBeNull();
    });

    it('Claude: wrong prefix → error', () => {
      expect(validateKeyFormat('claude', 'wrong-prefix')).toContain('Invalid key format');
    });

    it('OpenAI: valid sk- prefix', () => {
      expect(validateKeyFormat('openai', 'sk-1234567890abcdef')).toBeNull();
    });

    it('Gemini: valid AI prefix', () => {
      expect(validateKeyFormat('gemini', 'AIzaSyD-test-key-12345')).toBeNull();
    });

    it('empty key → error', () => {
      expect(validateKeyFormat('claude', '')).toContain('required');
    });

    it('too short → error', () => {
      expect(validateKeyFormat('openai', 'sk-x')).toContain('too short');
    });

    it('local → always valid', () => {
      expect(validateKeyFormat('local', '')).toBeNull();
    });
  });

  describe('isProviderAvailable', () => {
    it('not configured → false', () => {
      expect(isProviderAvailable('claude')).toBe(false);
    });

    it('configured with key → true', () => {
      configureProvider('openai', 'sk-valid-key-1234567890');
      expect(isProviderAvailable('openai')).toBe(true);
    });

    it('local without key → true', () => {
      configureProvider('local', '');
      expect(isProviderAvailable('local')).toBe(true);
    });
  });

  describe('getProviderStatuses', () => {
    it('returns status for all 5 providers', () => {
      const statuses = getProviderStatuses();
      expect(statuses).toHaveLength(5);
      expect(statuses.map((s) => s.name)).toContain('claude');
      expect(statuses.map((s) => s.name)).toContain('local');
    });

    it('unconfigured provider → "Not configured"', () => {
      const statuses = getProviderStatuses();
      const claude = statuses.find((s) => s.name === 'claude');
      expect(claude!.available).toBe(false);
      expect(claude!.reason).toBe('Not configured');
    });

    it('configured provider → "Ready"', () => {
      configureProvider('claude', 'sk-ant-test-key');
      const statuses = getProviderStatuses();
      const claude = statuses.find((s) => s.name === 'claude');
      expect(claude!.available).toBe(true);
      expect(claude!.reason).toBe('Ready');
    });
  });

  describe('getBestProvider', () => {
    it('returns null when nothing configured', () => {
      expect(getBestProvider()).toBeNull();
    });

    it('prefers local when available', () => {
      configureProvider('local', '');
      configureProvider('claude', 'sk-ant-key');
      expect(getBestProvider()).toBe('local');
    });

    it('falls back to claude when no local', () => {
      configureProvider('claude', 'sk-ant-key');
      configureProvider('openai', 'sk-key');
      expect(getBestProvider()).toBe('claude');
    });

    it('falls through to openai when no local/claude', () => {
      configureProvider('openai', 'sk-key1234567890');
      expect(getBestProvider()).toBe('openai');
    });
  });

  describe('configuredCount', () => {
    it('starts at 0', () => expect(configuredCount()).toBe(0));

    it('counts configured providers', () => {
      configureProvider('claude', 'sk-ant-key');
      configureProvider('local', '');
      expect(configuredCount()).toBe(2);
    });
  });

  // -------------------------------------------------------------------
  // PC-BRAIN-17 — getProviderTiers
  // -------------------------------------------------------------------

  describe('getProviderTiers (PC-BRAIN-17)', () => {
    it('returns the claude tier defaults when the provider is unconfigured', () => {
      const tiers = getProviderTiers('claude');
      expect(tiers.primary).toBe('claude-sonnet-4-6');
      expect(tiers.lite).toBe('claude-haiku-4-5-20251001');
      expect(tiers.heavy).toBe('claude-sonnet-4-6');
    });

    it('returns the gemini pro-on-heavy default (search_vault loop regression fix)', () => {
      // The pro model is the heavy-tier pick because flash-preview
      // was observed looping on search_vault tool calls (main-dina
      // PC-BRAIN-17 commit note). Pinning the heavy pick here
      // guards against a regression that reverts the tier.
      const tiers = getProviderTiers('gemini');
      expect(tiers.heavy).toBe('gemini-3.1-pro-preview');
      expect(tiers.lite).toBe('gemini-3.1-flash-lite-preview');
    });

    it('returns a tier map for every provider', () => {
      for (const name of ['claude', 'openai', 'gemini', 'openrouter', 'local'] as const) {
        const tiers = getProviderTiers(name);
        expect(tiers.primary).not.toBe('');
        expect(tiers.lite).not.toBe('');
        expect(tiers.heavy).not.toBe('');
      }
    });

    it("a configured provider's explicit model overrides the primary tier", () => {
      // User picked a specific model via Settings → Configure — the
      // override wins on the primary slot so router choices honour
      // the user's preference.
      configureProvider('gemini', 'AIzkey', 'gemini-2.5-flash');
      expect(getProviderTiers('gemini').primary).toBe('gemini-2.5-flash');
      // Lite / heavy still fall through to the provider defaults —
      // there's no per-tier override surface (yet).
      expect(getProviderTiers('gemini').lite).toBe('gemini-3.1-flash-lite-preview');
    });

    it('returns a fresh object per call (caller mutations do not leak)', () => {
      const a = getProviderTiers('claude');
      const b = getProviderTiers('claude');
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
      a.primary = 'mutated';
      expect(getProviderTiers('claude').primary).toBe('claude-sonnet-4-6');
    });

    it('local tier falls back to the primary for every slot (single-model stack)', () => {
      const tiers = getProviderTiers('local');
      expect(tiers.primary).toBe('llama-3n');
      expect(tiers.lite).toBe('llama-3n');
      expect(tiers.heavy).toBe('llama-3n');
    });
  });
});
