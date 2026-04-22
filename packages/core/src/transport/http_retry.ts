/**
 * Shared HTTP retry logic — exponential backoff with error classification.
 *
 * Extracted from CoreHTTPClient and BrainCoreClient to eliminate duplication.
 *
 * Retry semantics:
 *   - 5xx responses: retryable
 *   - Connection errors: retryable
 *   - 401/403: NOT retryable (auth/authz failure)
 *   - Timeout (AbortError): retryable
 *
 * Backoff: 1s × 2^attempt (1s, 2s, 4s, ...)
 */

/** Status codes that must NOT be retried. */
export const NON_RETRYABLE_STATUSES = new Set([401, 403]);

/** Base delay for exponential backoff (ms). */
export const BASE_RETRY_DELAY_MS = 1000;

/**
 * Compute exponential backoff delay.
 */
export function computeRetryDelay(attempt: number): number {
  return BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
}

/**
 * Sleep for the backoff duration.
 */
export function backoff(attempt: number): Promise<void> {
  const delay = computeRetryDelay(attempt);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Check if an HTTP status is retryable.
 */
export function isRetryableStatus(status: number): boolean {
  if (NON_RETRYABLE_STATUSES.has(status)) return false;
  return status >= 500;
}

/**
 * Check if an HTTP status is a non-retryable auth failure.
 */
export function isNonRetryableStatus(status: number): boolean {
  return NON_RETRYABLE_STATUSES.has(status);
}

/**
 * Parse a response body as JSON, falling back to text.
 */
export async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
