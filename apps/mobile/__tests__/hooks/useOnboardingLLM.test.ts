/**
 * T4.4 — Onboarding LLM setup: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 4.4
 */

import {
  getProviderOptions,
  validateKey,
  setupProvider,
  skipLLMSetup,
  isLLMConfigured,
  getSetupSummary,
  resetLLMSetup,
} from '../../src/hooks/useOnboardingLLM';

describe('Onboarding LLM Setup Hook (4.4)', () => {
  beforeEach(() => resetLLMSetup());

  describe('getProviderOptions', () => {
    it('returns 4 cloud provider options', () => {
      const options = getProviderOptions();
      expect(options).toHaveLength(4);
      expect(options.map((o) => o.name)).toEqual(['claude', 'openai', 'gemini', 'openrouter']);
    });

    it('each has label, description, keyPrefix', () => {
      for (const opt of getProviderOptions()) {
        expect(opt.label.length).toBeGreaterThan(0);
        expect(opt.description.length).toBeGreaterThan(0);
        expect(opt.keyPrefix.length).toBeGreaterThan(0);
      }
    });
  });

  describe('validateKey', () => {
    it('accepts valid Claude key', () => {
      expect(validateKey('claude', 'sk-ant-abc123-long-enough-key')).toBeNull();
    });

    it('accepts valid OpenAI key', () => {
      expect(validateKey('openai', 'sk-proj-1234567890abcdef')).toBeNull();
    });

    it('rejects invalid prefix', () => {
      expect(validateKey('claude', 'not-valid-prefix')).not.toBeNull();
    });

    it('rejects empty key', () => {
      expect(validateKey('openai', '')).not.toBeNull();
    });

    it('rejects too-short key', () => {
      expect(validateKey('openai', 'sk-abc')).not.toBeNull();
    });
  });

  describe('setupProvider', () => {
    it('configures Claude successfully', () => {
      const err = setupProvider('claude', 'sk-ant-abc123-long-enough-key');
      expect(err).toBeNull();
      expect(isLLMConfigured()).toBe(true);
    });

    it('returns error for invalid key', () => {
      const err = setupProvider('claude', 'bad');
      expect(err).not.toBeNull();
      expect(isLLMConfigured()).toBe(false);
    });

    it('configures OpenAI successfully', () => {
      expect(setupProvider('openai', 'sk-proj-1234567890abcdef')).toBeNull();
      expect(isLLMConfigured()).toBe(true);
    });

    it('configures Gemini successfully', () => {
      expect(setupProvider('gemini', 'AIzaSy1234567890abcdef')).toBeNull();
    });
  });

  describe('skipLLMSetup', () => {
    it('enables local-only mode', () => {
      skipLLMSetup();
      expect(isLLMConfigured()).toBe(true);
    });

    it('summary shows local mode', () => {
      skipLLMSetup();
      const summary = getSetupSummary();
      expect(summary.provider).toBe('Local');
      expect(summary.mode).toContain('On-device');
    });
  });

  describe('isLLMConfigured', () => {
    it('false before any setup', () => {
      expect(isLLMConfigured()).toBe(false);
    });

    it('true after cloud provider', () => {
      setupProvider('openai', 'sk-proj-1234567890abcdef');
      expect(isLLMConfigured()).toBe(true);
    });

    it('true after skip (local mode)', () => {
      skipLLMSetup();
      expect(isLLMConfigured()).toBe(true);
    });
  });

  describe('getSetupSummary', () => {
    it('shows none when nothing configured', () => {
      const summary = getSetupSummary();
      expect(summary.provider).toBe('None');
      expect(summary.mode).toContain('FTS-only');
    });

    it('shows cloud provider name', () => {
      setupProvider('claude', 'sk-ant-abc123-long-enough-key');
      const summary = getSetupSummary();
      expect(summary.provider).toBe('Anthropic Claude');
      expect(summary.mode).toBe('Cloud');
    });

    it('shows hybrid when local + cloud', () => {
      skipLLMSetup();
      setupProvider('openai', 'sk-proj-1234567890abcdef');
      const summary = getSetupSummary();
      expect(summary.mode).toContain('Hybrid');
    });
  });
});
