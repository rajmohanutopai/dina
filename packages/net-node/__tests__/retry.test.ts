/**
 * `@dina/net-node` RetryingHttpClient tests (task 3.36).
 *
 * Uses an injected no-op `sleepMs` + deterministic `random` so tests
 * run in milliseconds and the jittered delay is predictable.
 */

import { RetryingHttpClient, type HttpClient, type HttpResponse } from '../src';

/** Fake HttpClient that returns pre-queued responses or throws pre-queued errors. */
class FakeClient implements HttpClient {
  private readonly queue: Array<(() => Promise<HttpResponse>)> = [];
  public calls = 0;

  enqueueResponse(status: number): void {
    this.queue.push(async () => ({ status, headers: {}, body: new Uint8Array() }));
  }
  enqueueError(message: string): void {
    this.queue.push(() => Promise.reject(new Error(message)));
  }

  async request(): Promise<HttpResponse> {
    this.calls++;
    const fn = this.queue.shift();
    if (fn === undefined) throw new Error('FakeClient: ran out of queued responses');
    return fn();
  }
}

const noSleep = async (_ms: number): Promise<void> => {
  // no-op — tests pretend to sleep instantly
};

describe('RetryingHttpClient (task 3.36)', () => {
  describe('success on first attempt', () => {
    it('returns 2xx without retrying', async () => {
      const fake = new FakeClient();
      fake.enqueueResponse(200);
      const retry = new RetryingHttpClient(fake, { sleepMs: noSleep });
      const res = await retry.request('http://x', { method: 'GET', headers: {} });
      expect(res.status).toBe(200);
      expect(fake.calls).toBe(1);
    });
  });

  describe('5xx → retry → success', () => {
    it('retries a 500, succeeds on 2nd attempt', async () => {
      const fake = new FakeClient();
      fake.enqueueResponse(500);
      fake.enqueueResponse(200);
      const retry = new RetryingHttpClient(fake, { sleepMs: noSleep });
      const res = await retry.request('http://x', { method: 'GET', headers: {} });
      expect(res.status).toBe(200);
      expect(fake.calls).toBe(2);
    });

    it('retries a 503, succeeds on 3rd attempt', async () => {
      const fake = new FakeClient();
      fake.enqueueResponse(503);
      fake.enqueueResponse(503);
      fake.enqueueResponse(200);
      const retry = new RetryingHttpClient(fake, { sleepMs: noSleep });
      const res = await retry.request('http://x', { method: 'GET', headers: {} });
      expect(res.status).toBe(200);
      expect(fake.calls).toBe(3);
    });
  });

  describe('5xx → retry → exhausted', () => {
    it('returns the last 5xx after maxRetries attempts fail', async () => {
      const fake = new FakeClient();
      // maxRetries: 2 = 1 initial + 2 retries = 3 attempts max
      fake.enqueueResponse(500);
      fake.enqueueResponse(500);
      fake.enqueueResponse(500);
      const retry = new RetryingHttpClient(fake, { sleepMs: noSleep, maxRetries: 2 });
      const res = await retry.request('http://x', { method: 'GET', headers: {} });
      expect(res.status).toBe(500);
      expect(fake.calls).toBe(3);
    });
  });

  describe('non-retryable 4xx', () => {
    it.each([
      [400, 'Bad Request'],
      [401, 'Unauthorized'],
      [403, 'Forbidden'],
      [404, 'Not Found'],
      [409, 'Conflict'],
      [422, 'Unprocessable Entity'],
    ])('%s returns immediately without retrying (%s)', async (status) => {
      const fake = new FakeClient();
      fake.enqueueResponse(status);
      const retry = new RetryingHttpClient(fake, { sleepMs: noSleep });
      const res = await retry.request('http://x', { method: 'GET', headers: {} });
      expect(res.status).toBe(status);
      expect(fake.calls).toBe(1);
    });
  });

  describe('IETF transient 4xx', () => {
    it('408 (request timeout) retries', async () => {
      const fake = new FakeClient();
      fake.enqueueResponse(408);
      fake.enqueueResponse(200);
      const retry = new RetryingHttpClient(fake, { sleepMs: noSleep });
      const res = await retry.request('http://x', { method: 'GET', headers: {} });
      expect(res.status).toBe(200);
      expect(fake.calls).toBe(2);
    });

    it('429 (rate limit) retries', async () => {
      const fake = new FakeClient();
      fake.enqueueResponse(429);
      fake.enqueueResponse(200);
      const retry = new RetryingHttpClient(fake, { sleepMs: noSleep });
      const res = await retry.request('http://x', { method: 'GET', headers: {} });
      expect(res.status).toBe(200);
      expect(fake.calls).toBe(2);
    });
  });

  describe('network errors', () => {
    it('retries a throwing client, succeeds when recovered', async () => {
      const fake = new FakeClient();
      fake.enqueueError('ECONNRESET');
      fake.enqueueError('ETIMEDOUT');
      fake.enqueueResponse(200);
      const retry = new RetryingHttpClient(fake, { sleepMs: noSleep });
      const res = await retry.request('http://x', { method: 'GET', headers: {} });
      expect(res.status).toBe(200);
      expect(fake.calls).toBe(3);
    });

    it('throws the last error when retries exhausted on network failures', async () => {
      const fake = new FakeClient();
      fake.enqueueError('err-1');
      fake.enqueueError('err-2');
      fake.enqueueError('err-last');
      const retry = new RetryingHttpClient(fake, { sleepMs: noSleep, maxRetries: 2 });
      await expect(
        retry.request('http://x', { method: 'GET', headers: {} }),
      ).rejects.toThrow(/err-last/);
      expect(fake.calls).toBe(3);
    });
  });

  describe('backoff timing', () => {
    it('delays grow by backoffFactor each retry', async () => {
      const fake = new FakeClient();
      fake.enqueueResponse(500);
      fake.enqueueResponse(500);
      fake.enqueueResponse(200);
      const delays: number[] = [];
      const retry = new RetryingHttpClient(fake, {
        sleepMs: async (ms) => {
          delays.push(ms);
        },
        maxRetries: 3,
        initialDelayMs: 100,
        backoffFactor: 2,
        jitter: 0, // no jitter — deterministic delay
      });
      await retry.request('http://x', { method: 'GET', headers: {} });
      // 2 retries → 2 delays. First = 100 (initial), second = 100*2.
      expect(delays).toEqual([100, 200]);
    });

    it('jitter widens delay to [0.5x, 1.5x] with jitter=0.5', async () => {
      const fake = new FakeClient();
      fake.enqueueResponse(500);
      fake.enqueueResponse(200);
      const delays: number[] = [];
      // `random()` always returns 0 → 0 - 0.5 = -0.5 → multiplier 0.5.
      const retry = new RetryingHttpClient(fake, {
        sleepMs: async (ms) => {
          delays.push(ms);
        },
        initialDelayMs: 100,
        jitter: 0.5,
        random: () => 0,
      });
      await retry.request('http://x', { method: 'GET', headers: {} });
      expect(delays).toEqual([50]); // 100 * (1 + (0 - 0.5) * 2 * 0.5) = 100 * 0.5 = 50
    });

    it('jitter with random=1.0 multiplies by 1.5x', async () => {
      const fake = new FakeClient();
      fake.enqueueResponse(500);
      fake.enqueueResponse(200);
      const delays: number[] = [];
      const retry = new RetryingHttpClient(fake, {
        sleepMs: async (ms) => {
          delays.push(ms);
        },
        initialDelayMs: 100,
        jitter: 0.5,
        random: () => 0.9999,
      });
      await retry.request('http://x', { method: 'GET', headers: {} });
      // 100 * (1 + (0.9999 - 0.5) * 2 * 0.5) = 100 * 1.4999 ≈ 149.99
      // Math.floor(149.99) = 149 → delay is in [149, 150)
      expect(delays[0]).toBeGreaterThanOrEqual(149);
      expect(delays[0]).toBeLessThan(150);
    });
  });

  describe('custom nonRetryableStatuses', () => {
    it('removes 422 from non-retryable → it retries like a 5xx', async () => {
      // Override — note that 422 isn't in the default nonRetryable set
      // here, but 422 isn't a 5xx/408/429 either, so plain removal
      // alone won't trigger retry. We'd need to extend "transient".
      // Instead, test that EXPANDING the non-retryable set stops
      // retries that would otherwise happen.
      const fake = new FakeClient();
      fake.enqueueResponse(500);
      const retry = new RetryingHttpClient(fake, {
        sleepMs: noSleep,
        // Add 500 to non-retryable → fail-fast on first attempt.
        nonRetryableStatuses: new Set([500]),
      });
      const res = await retry.request('http://x', { method: 'GET', headers: {} });
      expect(res.status).toBe(500);
      expect(fake.calls).toBe(1);
    });
  });

  describe('onRetry callback', () => {
    it('fires once per retry with attempt number + response OR error', async () => {
      const fake = new FakeClient();
      fake.enqueueResponse(500);
      fake.enqueueError('net');
      fake.enqueueResponse(200);
      const events: Array<{
        attempt: number;
        status: number | null;
        errorMsg: string | null;
      }> = [];
      const retry = new RetryingHttpClient(fake, {
        sleepMs: noSleep,
        onRetry: (attempt, response, error) => {
          events.push({
            attempt,
            status: response?.status ?? null,
            errorMsg: error?.message ?? null,
          });
        },
      });
      await retry.request('http://x', { method: 'GET', headers: {} });

      // 2 retries happened (after first 500, after network error).
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ attempt: 1, status: 500, errorMsg: null });
      expect(events[1]).toEqual({ attempt: 2, status: null, errorMsg: 'net' });
    });
  });

  describe('.client escape hatch', () => {
    it('exposes the underlying HttpClient for opt-out callers', () => {
      const fake = new FakeClient();
      const retry = new RetryingHttpClient(fake);
      expect(retry.client).toBe(fake);
    });
  });
});
