/**
 * T4.16 — Settings LLM providers: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 4.16
 */

import {
  getProviderUIStates,
  setProviderKey,
  clearProviderKey,
  enableLocalProvider,
  getBestAvailable,
  getConfiguredCount,
  hasAnyProvider,
  resetProviders,
} from '../../src/hooks/useLLMProviders';

describe('LLM Provider Settings Hook (4.16)', () => {
  beforeEach(() => resetProviders());

  describe('getProviderUIStates', () => {
    it('returns all 5 providers with display names', () => {
      const states = getProviderUIStates();

      expect(states).toHaveLength(5);
      const names = states.map((s) => s.name);
      expect(names).toContain('claude');
      expect(names).toContain('openai');
      expect(names).toContain('gemini');
      expect(names).toContain('openrouter');
      expect(names).toContain('local');
    });

    it('all unconfigured by default', () => {
      const states = getProviderUIStates();
      expect(states.every((s) => !s.available)).toBe(true);
      expect(states.every((s) => !s.hasKey)).toBe(true);
    });

    it('shows human-readable display names', () => {
      const states = getProviderUIStates();
      const claude = states.find((s) => s.name === 'claude');
      expect(claude!.displayName).toBe('Anthropic Claude');
    });
  });

  describe('setProviderKey', () => {
    it('configures Claude with valid key', () => {
      const err = setProviderKey('claude', 'sk-ant-abc123-long-enough-key');
      expect(err).toBeNull();

      const states = getProviderUIStates();
      const claude = states.find((s) => s.name === 'claude');
      expect(claude!.available).toBe(true);
      expect(claude!.hasKey).toBe(true);
      expect(claude!.keyPreview).toContain('sk-ant');
      expect(claude!.keyPreview).toContain('****');
    });

    it('configures OpenAI with valid key', () => {
      const err = setProviderKey('openai', 'sk-proj-1234567890abcdef');
      expect(err).toBeNull();

      const states = getProviderUIStates();
      expect(states.find((s) => s.name === 'openai')!.available).toBe(true);
    });

    it('rejects invalid key format', () => {
      const err = setProviderKey('claude', 'not-a-valid-key');
      expect(err).not.toBeNull();
      expect(err).toContain('Invalid key format');
    });

    it('rejects empty key', () => {
      const err = setProviderKey('openai', '');
      expect(err).not.toBeNull();
    });

    it('accepts custom model override', () => {
      setProviderKey('openai', 'sk-proj-1234567890abcdef', 'gpt-4o-mini');

      const states = getProviderUIStates();
      expect(states.find((s) => s.name === 'openai')!.model).toBe('gpt-4o-mini');
    });

    it('hot-reload: update key takes effect immediately', () => {
      setProviderKey('claude', 'sk-ant-abc123-first-key-here');
      expect(getProviderUIStates().find((s) => s.name === 'claude')!.available).toBe(true);

      setProviderKey('claude', 'sk-ant-xyz789-second-key-now');
      const state = getProviderUIStates().find((s) => s.name === 'claude');
      // Key preview: first 6 + **** + last 4 = "sk-ant****-now"
      expect(state!.keyPreview).not.toContain('first');
      expect(state!.keyPreview).toContain('sk-ant'); // new key's prefix
    });
  });

  describe('clearProviderKey', () => {
    it('removes a configured provider', () => {
      setProviderKey('openai', 'sk-proj-1234567890abcdef');
      expect(getProviderUIStates().find((s) => s.name === 'openai')!.available).toBe(true);

      clearProviderKey('openai');
      expect(getProviderUIStates().find((s) => s.name === 'openai')!.available).toBe(false);
    });
  });

  describe('enableLocalProvider', () => {
    it('enables local without API key', () => {
      enableLocalProvider();

      const states = getProviderUIStates();
      const local = states.find((s) => s.name === 'local');
      expect(local!.available).toBe(true);
    });

    it('accepts custom local model', () => {
      enableLocalProvider('gemma-3n');

      const local = getProviderUIStates().find((s) => s.name === 'local');
      expect(local!.model).toBe('gemma-3n');
    });
  });

  describe('getBestAvailable', () => {
    it('returns null when nothing configured', () => {
      expect(getBestAvailable()).toBeNull();
    });

    it('prefers local over cloud', () => {
      enableLocalProvider();
      setProviderKey('openai', 'sk-proj-1234567890abcdef');

      const best = getBestAvailable();
      expect(best!.name).toBe('local');
    });

    it('returns cloud when no local', () => {
      setProviderKey('claude', 'sk-ant-abc123-long-enough-key');

      const best = getBestAvailable();
      expect(best!.name).toBe('claude');
      expect(best!.displayName).toBe('Anthropic Claude');
    });
  });

  describe('counts and status', () => {
    it('getConfiguredCount reflects changes', () => {
      expect(getConfiguredCount()).toBe(0);

      setProviderKey('claude', 'sk-ant-abc123-long-enough-key');
      expect(getConfiguredCount()).toBe(1);

      setProviderKey('openai', 'sk-proj-1234567890abcdef');
      expect(getConfiguredCount()).toBe(2);
    });

    it('hasAnyProvider', () => {
      expect(hasAnyProvider()).toBe(false);
      enableLocalProvider();
      expect(hasAnyProvider()).toBe(true);
    });
  });

  describe('key masking', () => {
    it('masks long keys showing prefix and suffix', () => {
      setProviderKey('claude', 'sk-ant-abc123-very-long-api-key-here');
      const state = getProviderUIStates().find((s) => s.name === 'claude');
      expect(state!.keyPreview).toMatch(/^sk-ant\*\*\*\*here$/);
    });
  });
});
