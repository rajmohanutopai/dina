/**
 * T2A.2 — Brain→Core HTTP client: retry semantics, error classification.
 *
 * Category B: contract test. Verifies the Core HTTP client's retry
 * behavior, error classification, and timeout handling.
 *
 * Source: core/test/brainclient_test.go
 */

import { CoreHTTPClient, CoreHTTPError } from '../../src/brain_client/http';
import { TEST_ED25519_SEED } from '@dina/test-harness';

/** Create a mock fetch that returns a sequence of responses. */
function mockFetch(
  ...responses: Array<{ status: number; body?: unknown; delay?: number }>
): jest.Mock {
  let callIndex = 0;
  return jest.fn(async (_url: string, _opts?: RequestInit) => {
    const resp = responses[Math.min(callIndex++, responses.length - 1)];
    if (resp.delay) await new Promise((r) => setTimeout(r, resp.delay));
    return {
      status: resp.status,
      text: async () => JSON.stringify(resp.body ?? {}),
    } as Response;
  });
}

/** Create a mock fetch that throws a connection error. */
function mockFetchError(errorMsg = 'connect ECONNREFUSED'): jest.Mock {
  return jest.fn(async () => {
    throw new Error(errorMsg);
  });
}

const baseConfig = {
  coreURL: 'http://localhost:8100',
  privateKey: TEST_ED25519_SEED,
  did: 'did:key:z6MkBrainService',
};

describe('Brain→Core HTTP Client', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });
  describe('construction', () => {
    it('accepts valid config', () => {
      expect(() => new CoreHTTPClient({ ...baseConfig })).not.toThrow();
    });

    it('rejects empty coreURL', () => {
      expect(() => new CoreHTTPClient({ ...baseConfig, coreURL: '' })).toThrow(
        'coreURL is required',
      );
    });

    it('rejects empty DID', () => {
      expect(() => new CoreHTTPClient({ ...baseConfig, did: '' })).toThrow('did is required');
    });

    it('accepts custom timeout', () => {
      expect(() => new CoreHTTPClient({ ...baseConfig, timeoutMs: 5000 })).not.toThrow();
    });

    it('accepts custom maxRetries', () => {
      expect(() => new CoreHTTPClient({ ...baseConfig, maxRetries: 5 })).not.toThrow();
    });
  });

  describe('request', () => {
    it('sends signed request to Core', async () => {
      const fetch = mockFetch({ status: 200, body: { ok: true } });
      const client = new CoreHTTPClient({ ...baseConfig, fetch });
      const result = await client.request('GET', '/healthz');
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true });
      expect(fetch).toHaveBeenCalledTimes(1);

      // Verify auth headers were sent
      const callArgs = fetch.mock.calls[0][1] as RequestInit;
      const headers = callArgs.headers as Record<string, string>;
      expect(headers['X-DID']).toBe('did:key:z6MkBrainService');
      expect(headers['X-Timestamp']).toBeTruthy();
      expect(headers['X-Nonce']).toBeTruthy();
      expect(headers['X-Signature']).toBeTruthy();
      expect(headers['X-Request-ID']).toMatch(/^req-/);
    });

    it('retries on 5xx response', async () => {
      const fetch = mockFetch(
        { status: 500 },
        { status: 500 },
        { status: 200, body: { recovered: true } },
      );
      const client = new CoreHTTPClient({ ...baseConfig, fetch, maxRetries: 3 });
      const promise = client.request('POST', '/v1/vault/query', {});
      // Advance past backoff timers
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
        jest.advanceTimersByTime(5000);
      }
      const result = await promise;
      expect(result.status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('does NOT retry on 401', async () => {
      const fetch = mockFetch({ status: 401, body: { error: 'unauthorized' } });
      const client = new CoreHTTPClient({ ...baseConfig, fetch });
      await expect(client.request('POST', '/v1/vault/query', {})).rejects.toThrow(CoreHTTPError);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on 403', async () => {
      const fetch = mockFetch({ status: 403, body: { error: 'forbidden' } });
      const client = new CoreHTTPClient({ ...baseConfig, fetch });
      await expect(client.request('POST', '/v1/persona/unlock', {})).rejects.toThrow(CoreHTTPError);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('CoreHTTPError on 401 has retryable=false', async () => {
      const fetch = mockFetch({ status: 401 });
      const client = new CoreHTTPClient({ ...baseConfig, fetch });
      try {
        await client.request('GET', '/test');
        fail('should throw');
      } catch (err) {
        expect(err).toBeInstanceOf(CoreHTTPError);
        expect((err as CoreHTTPError).retryable).toBe(false);
        expect((err as CoreHTTPError).status).toBe(401);
      }
    });

    it('retries on connection error', async () => {
      let calls = 0;
      const fetch = jest.fn(async () => {
        calls++;
        if (calls <= 2) throw new Error('connect ECONNREFUSED');
        return { status: 200, text: async () => '{"ok":true}' } as Response;
      });
      const client = new CoreHTTPClient({ ...baseConfig, fetch, maxRetries: 3 });
      const promise = client.request('GET', '/healthz');
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
        jest.advanceTimersByTime(5000);
      }
      const result = await promise;
      expect(result.status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('exhausted retries throws last error', async () => {
      const fetch = mockFetch({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 });
      const client = new CoreHTTPClient({ ...baseConfig, fetch, maxRetries: 2 });
      const promise = client.request('GET', '/test');
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
        jest.advanceTimersByTime(10000);
      }
      await expect(promise).rejects.toThrow();
    });
  });

  describe('convenience methods', () => {
    it('get() sends GET with auth', async () => {
      const fetch = mockFetch({ status: 200, body: { health: 'ok' } });
      const client = new CoreHTTPClient({ ...baseConfig, fetch });
      const result = await client.get('/healthz');
      expect(result.status).toBe(200);
      expect((fetch.mock.calls[0][1] as RequestInit).method).toBe('GET');
    });

    it('post() sends POST with auth and body', async () => {
      const fetch = mockFetch({ status: 200, body: { items: [] } });
      const client = new CoreHTTPClient({ ...baseConfig, fetch });
      const result = await client.post('/v1/vault/query', { text: 'test' });
      expect(result.status).toBe(200);
      expect((fetch.mock.calls[0][1] as RequestInit).method).toBe('POST');
      expect((fetch.mock.calls[0][1] as RequestInit).body).toBe('{"text":"test"}');
    });
  });

  describe('isHealthy', () => {
    it('returns true when Core responds 200', async () => {
      const fetch = mockFetch({ status: 200 });
      const client = new CoreHTTPClient({ ...baseConfig, fetch });
      expect(await client.isHealthy()).toBe(true);
    });

    it('returns false when Core is unreachable', async () => {
      const fetch = mockFetchError();
      const client = new CoreHTTPClient({ ...baseConfig, fetch, maxRetries: 0 });
      expect(await client.isHealthy()).toBe(false);
    });
  });
});
