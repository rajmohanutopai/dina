/**
 * LLM adapter safety — error classification and timeout.
 *
 * Tests the shared safety utilities used by all 3 LLM adapters.
 */

import {
  withTimeout,
  classifyAndThrow,
  safeCall,
  LLM_TIMEOUT_MS,
  GEMINI_TIMEOUT_MS,
} from '../../../src/llm/adapters/safety';
import { LLMError, ConfigError } from '../../../../core/src/errors';

describe('LLM Adapter Safety', () => {
  describe('LLM_TIMEOUT_MS', () => {
    it('is 60 seconds (matching Python)', () => {
      expect(LLM_TIMEOUT_MS).toBe(60_000);
    });
  });

  describe('GEMINI_TIMEOUT_MS (PC-BRAIN-18)', () => {
    it('is 180 seconds (matches main-dina llm_gemini.py::_TIMEOUT_S = 180.0)', () => {
      // Bumped from 60s because pro-class Gemini chat turns that
      // use tools / multi-step reasoning routinely exceed the
      // shared 60s default. The rest of the adapters stay on the
      // safer 60s — regression guard against a future developer
      // bumping `LLM_TIMEOUT_MS` in lockstep.
      expect(GEMINI_TIMEOUT_MS).toBe(180_000);
      expect(GEMINI_TIMEOUT_MS).toBeGreaterThan(LLM_TIMEOUT_MS);
    });
  });

  describe('classifyAndThrow', () => {
    it('401 → ConfigError', () => {
      expect(() => classifyAndThrow(new Error('Request failed: 401 Unauthorized'))).toThrow(
        ConfigError,
      );
    });

    it('authentication error → ConfigError', () => {
      expect(() => classifyAndThrow(new Error('authentication failed'))).toThrow(ConfigError);
    });

    it('invalid key → ConfigError', () => {
      expect(() => classifyAndThrow(new Error('invalid API key provided'))).toThrow(ConfigError);
    });

    it('429 → LLMError (rate limited)', () => {
      expect(() => classifyAndThrow(new Error('429 Too Many Requests'))).toThrow(LLMError);
      expect(() => classifyAndThrow(new Error('429 rate_limit'))).toThrow(/Rate limited/);
    });

    it('resource_exhausted → LLMError (rate limited)', () => {
      expect(() => classifyAndThrow(new Error('resource_exhausted: quota exceeded'))).toThrow(
        /Rate limited/,
      );
    });

    it('timeout → LLMError', () => {
      expect(() => classifyAndThrow(new Error('Request timed out'))).toThrow(/timed out/);
    });

    it('aborted → LLMError', () => {
      expect(() => classifyAndThrow(new Error('The operation was aborted'))).toThrow(/timed out/);
    });

    it('generic error → LLMError', () => {
      expect(() => classifyAndThrow(new Error('Connection refused'))).toThrow(LLMError);
      expect(() => classifyAndThrow(new Error('Connection refused'))).toThrow(/LLM call failed/);
    });

    it('non-Error → LLMError with stringified message', () => {
      expect(() => classifyAndThrow('something broke')).toThrow(LLMError);
    });

    it('already LLMError → rethrown as-is', () => {
      const original = new LLMError('already classified');
      try {
        classifyAndThrow(original);
      } catch (err) {
        expect(err).toBe(original); // same object reference
      }
    });

    it('already ConfigError → rethrown as-is', () => {
      const original = new ConfigError('already classified');
      try {
        classifyAndThrow(original);
      } catch (err) {
        expect(err).toBe(original);
      }
    });
  });

  describe('withTimeout', () => {
    it('resolves when promise completes before timeout', async () => {
      const result = await withTimeout(Promise.resolve(42), 1000);
      expect(result).toBe(42);
    });

    it('rejects with LLMError on timeout', async () => {
      const neverResolves = new Promise<void>(() => {});
      await expect(withTimeout(neverResolves, 50)).rejects.toThrow(LLMError);
      await expect(withTimeout(new Promise(() => {}), 50)).rejects.toThrow(/timed out/);
    });

    it('passes through rejections from the wrapped promise', async () => {
      const err = new Error('API error');
      await expect(withTimeout(Promise.reject(err), 5000)).rejects.toThrow('API error');
    });
  });

  describe('safeCall', () => {
    it('returns result on success', async () => {
      const result = await safeCall(() => Promise.resolve({ text: 'hello' }));
      expect(result).toEqual({ text: 'hello' });
    });

    it('classifies 401 as ConfigError', async () => {
      await expect(safeCall(() => Promise.reject(new Error('401 Unauthorized')))).rejects.toThrow(
        ConfigError,
      );
    });

    it('classifies 429 as LLMError', async () => {
      await expect(safeCall(() => Promise.reject(new Error('429 rate_limit')))).rejects.toThrow(
        LLMError,
      );
    });

    it('classifies generic errors as LLMError', async () => {
      await expect(safeCall(() => Promise.reject(new Error('network error')))).rejects.toThrow(
        LLMError,
      );
    });

    it('times out with LLMError', async () => {
      await expect(safeCall(() => new Promise(() => {}), 50)).rejects.toThrow(/timed out/);
    });
  });
});
