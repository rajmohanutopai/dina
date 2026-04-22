/**
 * Brain→Core HTTP client — Ed25519 signed requests with retry semantics.
 *
 * Retry: 3x exponential backoff (1s, 2s, 4s)
 * Non-retryable: 401 (auth failure), 403 (authorization)
 * Retryable: 5xx, connection errors
 * Timeout: 30 seconds per request
 * Request-ID propagation for audit trail correlation.
 *
 * Source: core/test/brainclient_test.go
 */

import { signRequest } from '../auth/canonical';
import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  isNonRetryableStatus,
  isRetryableStatus,
  backoff,
  parseResponseBody,
} from '../transport/http_retry';

export interface BrainClientConfig {
  coreURL: string;
  privateKey: Uint8Array;
  did: string;
  timeoutMs?: number; // default 30000
  maxRetries?: number; // default 3
  fetch?: typeof globalThis.fetch; // injectable for testing
}

export class CoreHTTPClient {
  private readonly coreURL: string;
  private readonly privateKey: Uint8Array;
  private readonly did: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config: BrainClientConfig) {
    if (!config.coreURL) throw new Error('coreURL is required');
    if (!config.did) throw new Error('did is required');

    this.coreURL = config.coreURL.replace(/\/$/, '');
    this.privateKey = config.privateKey;
    this.did = config.did;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.fetchFn = config.fetch ?? globalThis.fetch;
  }

  /**
   * Send a signed request to Core. Retries on 5xx/connection errors.
   *
   * Signs each attempt fresh (nonce + timestamp must be unique per attempt).
   * Propagates a Request-ID header for audit trail correlation.
   */
  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const url = `${this.coreURL}${path}`;
    const bodyStr = body !== undefined ? JSON.stringify(body) : '';
    const bodyBytes = new TextEncoder().encode(bodyStr);
    const requestId = `req-${bytesToHex(randomBytes(8))}`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Sign fresh per attempt (nonce + timestamp change)
      const authHeaders = signRequest(method, path, '', bodyBytes, this.privateKey, this.did);

      const headers: Record<string, string> = {
        ...authHeaders,
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      };

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await this.fetchFn(url, {
          method,
          headers,
          body: bodyStr || undefined,
          signal: controller.signal,
        });

        clearTimeout(timer);

        // Non-retryable status — fail immediately
        if (isNonRetryableStatus(response.status)) {
          const respBody = await parseResponseBody(response);
          throw new CoreHTTPError(response.status, respBody, false);
        }

        // Server error — retryable
        if (response.status >= 500) {
          lastError = new CoreHTTPError(response.status, null, true);
          if (attempt < this.maxRetries) {
            await backoff(attempt);
            continue;
          }
          throw lastError;
        }

        // Success
        const respBody = await parseResponseBody(response);
        return { status: response.status, body: respBody };
      } catch (err) {
        if (err instanceof CoreHTTPError && !err.retryable) {
          throw err;
        }

        lastError = err instanceof Error ? err : new Error(String(err));

        // Abort errors = timeout
        if (lastError.name === 'AbortError') {
          lastError = new CoreHTTPError(0, null, true, 'request timeout');
        }

        if (attempt < this.maxRetries && !(err instanceof CoreHTTPError && !err.retryable)) {
          await backoff(attempt);
          continue;
        }
      }
    }

    throw lastError ?? new Error('CoreHTTPClient: request failed');
  }

  /** GET with signed auth headers. */
  async get(path: string): Promise<{ status: number; body: unknown }> {
    return this.request('GET', path);
  }

  /** POST with signed auth headers. */
  async post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    return this.request('POST', path, body);
  }

  /** Check if Core is reachable. */
  async isHealthy(): Promise<boolean> {
    try {
      const result = await this.get('/healthz');
      return result.status === 200;
    } catch {
      return false;
    }
  }

  // parseBody and backoff extracted to transport/http_retry.ts
}

/** Typed HTTP error with retryable flag. */
export class CoreHTTPError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseBody: unknown,
    public readonly retryable: boolean,
    message?: string,
  ) {
    super(message ?? `CoreHTTPClient: HTTP ${status}`);
    this.name = 'CoreHTTPError';
  }
}
