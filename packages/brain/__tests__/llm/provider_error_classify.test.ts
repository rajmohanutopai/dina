/**
 * Provider error classifier — kind + template mapping.
 *
 * Live incident 2026-06-10: Gemini prepaid exhaustion ("Your prepayment
 * credits are depleted", RESOURCE_EXHAUSTED) matched NO pattern, so chat
 * showed the generic apology for hours. These tests pin the credits family
 * and the order guarantee (credits beats the generic 429/rate-limit match —
 * waiting will not refill a balance).
 */

import {
  classifyProviderErrorKind,
  classifyProviderErrorMessage,
  GENERIC_PROVIDER_FAILURE_MESSAGE,
} from '../../src/llm/provider_error_classify';

describe('classifyProviderErrorKind', () => {
  it('classifies the live Gemini prepaid-exhaustion message as credits_exhausted', () => {
    const raw =
      'ApiError: {"error":{"code":429,"message":"Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.","status":"RESOURCE_EXHAUSTED"}}';
    expect(classifyProviderErrorKind(raw)).toBe('credits_exhausted');
  });

  it('classifies RESOURCE_EXHAUSTED alone as credits_exhausted (beats the 429 rate-limit match)', () => {
    expect(classifyProviderErrorKind('got status 429: RESOURCE_EXHAUSTED')).toBe(
      'credits_exhausted',
    );
  });

  it('classifies OpenAI insufficient_quota as credits_exhausted', () => {
    expect(
      classifyProviderErrorKind(
        '429 You exceeded your current quota, please check your plan and billing details.',
      ),
    ).toBe('credits_exhausted');
    expect(classifyProviderErrorKind('error type: insufficient_quota')).toBe('credits_exhausted');
  });

  it('plain 429 / rate limit (no exhaustion phrase) stays rate_limited', () => {
    expect(classifyProviderErrorKind('Rate limit reached for requests')).toBe('rate_limited');
    expect(classifyProviderErrorKind('HTTP 429 too many requests')).toBe('rate_limited');
  });

  it('classifies key rejection as invalid_key', () => {
    expect(classifyProviderErrorKind('API key not valid. Please pass a valid API key.')).toBe(
      'invalid_key',
    );
    expect(classifyProviderErrorKind('server responded 401 unauthorized')).toBe('invalid_key');
  });

  it('timeout + network families unchanged', () => {
    expect(classifyProviderErrorKind('AbortError: signal timed out')).toBe('timeout');
    expect(classifyProviderErrorKind('TypeError: Network request failed')).toBe('network');
  });

  it('unknown text → null', () => {
    expect(classifyProviderErrorKind('some opaque vendor blob')).toBeNull();
  });

  // @google/genai's retry wrapper DISCARDS the vendor body — only the HTTP
  // statusText survives (verified live 2026-06-10 with a corrupted key: the
  // loop received exactly "Non-retryable exception Bad Request sending
  // request"). The classifier must work from the wrapper shapes alone.
  it('genai wrapper: "Non-retryable exception Bad Request sending request" → invalid_key', () => {
    expect(classifyProviderErrorKind('Non-retryable exception Bad Request sending request')).toBe(
      'invalid_key',
    );
    expect(classifyProviderErrorKind('Non-retryable exception Unauthorized sending request')).toBe(
      'invalid_key',
    );
    expect(classifyProviderErrorKind('Non-retryable exception Forbidden sending request')).toBe(
      'invalid_key',
    );
  });

  it('genai wrapper: "Retryable HTTP Error: Too Many Requests" → rate_limited (body lost — template hedges toward credits)', () => {
    expect(classifyProviderErrorKind('Retryable HTTP Error: Too Many Requests')).toBe(
      'rate_limited',
    );
  });
});

describe('classifyProviderErrorMessage', () => {
  it('credits family gets the top-up template, NOT the generic apology and NOT "wait a minute"', () => {
    const msg = classifyProviderErrorMessage('Your prepayment credits are depleted.');
    expect(msg).toMatch(/credits are exhausted/i);
    expect(msg).toMatch(/Manage AI providers/);
    expect(msg).not.toBe(GENERIC_PROVIDER_FAILURE_MESSAGE);
    expect(msg).not.toMatch(/wait a minute/i);
  });

  it('null for unmatched text (caller supplies the generic fallback)', () => {
    expect(classifyProviderErrorMessage('opaque')).toBeNull();
  });
});
