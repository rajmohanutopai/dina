/**
 * LLM adapter safety — shared error handling and timeout for all adapters.
 *
 * Every LLM API call is wrapped with:
 *   - 60s timeout (matching Python's asyncio.wait_for)
 *   - Error classification (401→ConfigError, 429→LLMError, timeout→LLMError)
 *
 * Ported from: brain/src/adapter/llm_openai.py, llm_gemini.py, llm_claude.py
 */

import { LLMError, ConfigError } from '../../../../core/src/errors';

/** Default LLM call timeout in milliseconds (60 seconds, matching Python). */
export const LLM_TIMEOUT_MS = 60_000;

/**
 * Gemini-specific timeout, bumped to 180 seconds to match main-dina's
 * `brain/src/adapter/llm_gemini.py::_TIMEOUT_S = 180.0` (PC-BRAIN-18).
 *
 * Rationale: the pro-class Gemini models used for multi-turn
 * tool-using reasoning can take well over the default 60s on a
 * single response. Keeping the other adapters on the 60s default
 * means we don't over-relax timeouts where they aren't needed —
 * this constant is imported only by the Gemini adapter.
 */
export const GEMINI_TIMEOUT_MS = 180_000;

/**
 * Execute a promise with a timeout.
 *
 * If the promise doesn't resolve within `ms` milliseconds, it rejects
 * with a timeout error. Uses AbortController for clean cancellation.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number = LLM_TIMEOUT_MS): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new LLMError('LLM request timed out after 60s'));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

/**
 * Classify an LLM error into the appropriate Dina error type.
 *
 * Matches Python's error classification pattern:
 *   - 401/unauthorized/invalid/authentication → ConfigError (bad API key)
 *   - 429/rate_limit/resource_exhausted → LLMError (rate limited)
 *   - timeout/aborted → LLMError (timed out)
 *   - generic → LLMError (catch-all)
 *
 * @throws ConfigError or LLMError — never returns
 */
export function classifyAndThrow(err: unknown): never {
  // Already a Dina error — rethrow as-is
  if (err instanceof LLMError || err instanceof ConfigError) {
    throw err;
  }

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  // Auth errors → ConfigError (bad API key)
  if (
    lower.includes('401') ||
    lower.includes('unauthorized') ||
    (lower.includes('invalid') && lower.includes('key')) ||
    lower.includes('authentication')
  ) {
    throw new ConfigError(`Invalid API key: ${message}`);
  }

  // Rate limit → LLMError
  if (
    lower.includes('429') ||
    lower.includes('rate_limit') ||
    lower.includes('rate limit') ||
    lower.includes('resource_exhausted')
  ) {
    throw new LLMError(`Rate limited: ${message}`);
  }

  // Timeout → LLMError
  if (lower.includes('timeout') || lower.includes('aborted') || lower.includes('timed out')) {
    throw new LLMError(`Request timed out: ${message}`);
  }

  // Generic → LLMError
  throw new LLMError(`LLM call failed: ${message}`);
}

/**
 * Wrap an async LLM call with timeout and error classification.
 *
 * Usage in adapters:
 *   return safeCall(() => this.client.chat.completions.create(params));
 */
export async function safeCall<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
  try {
    return await withTimeout(fn(), timeoutMs);
  } catch (err) {
    classifyAndThrow(err);
  }
}
