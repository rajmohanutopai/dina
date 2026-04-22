/**
 * LLM error classification + timeout tests.
 */

import { classifyLLMError, LLM_TIMEOUT_MS } from '../../src/ai/chat';

describe('LLM Error Classification', () => {
  it('classifies 401 as invalid API key', () => {
    expect(classifyLLMError(new Error('HTTP 401 Unauthorized'))).toContain('API key');
  });

  it('classifies authentication errors', () => {
    expect(classifyLLMError(new Error('authentication failed'))).toContain('API key');
  });

  it('classifies 429 as rate limited', () => {
    expect(classifyLLMError(new Error('HTTP 429 Too Many Requests'))).toContain('Rate limited');
  });

  it('classifies rate_limit errors', () => {
    expect(classifyLLMError(new Error('rate_limit exceeded'))).toContain('Rate limited');
  });

  it('classifies resource_exhausted (Gemini) as rate limited', () => {
    expect(classifyLLMError(new Error('resource_exhausted'))).toContain('Rate limited');
  });

  it('classifies timeout errors', () => {
    expect(classifyLLMError(new Error('The operation was aborted'))).toContain('timed out');
  });

  it('classifies timeout string', () => {
    expect(classifyLLMError(new Error('Request timed out after 60s'))).toContain('timed out');
  });

  it('returns generic message for unknown errors', () => {
    const msg = classifyLLMError(new Error('Something unexpected'));
    expect(msg).toContain('Something went wrong');
    expect(msg).toContain('Something unexpected');
  });

  it('handles non-Error objects', () => {
    expect(classifyLLMError('string error')).toContain('Something went wrong');
    expect(classifyLLMError(42)).toContain('Something went wrong');
  });

  it('timeout constant is 60 seconds', () => {
    expect(LLM_TIMEOUT_MS).toBe(60_000);
  });
});
