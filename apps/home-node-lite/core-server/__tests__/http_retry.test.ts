/**
 * Task 5.11 — HTTP retry + exponential backoff tests.
 */

import {
  DEFAULT_BACKOFF_FACTOR,
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_JITTER,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_BACKOFF_MS,
  computeBackoff,
  retryWithBackoff,
  type RetryEvent,
} from '../src/brain/http_retry';

describe('retryWithBackoff (task 5.11)', () => {
  describe('constants', () => {
    it('DEFAULT_MAX_ATTEMPTS = 4', () => {
      expect(DEFAULT_MAX_ATTEMPTS).toBe(4);
    });
    it('DEFAULT_INITIAL_BACKOFF_MS = 500', () => {
      expect(DEFAULT_INITIAL_BACKOFF_MS).toBe(500);
    });
    it('DEFAULT_MAX_BACKOFF_MS = 30 000', () => {
      expect(DEFAULT_MAX_BACKOFF_MS).toBe(30_000);
    });
    it('DEFAULT_BACKOFF_FACTOR = 2', () => {
      expect(DEFAULT_BACKOFF_FACTOR).toBe(2);
    });
    it('DEFAULT_JITTER = 0.1', () => {
      expect(DEFAULT_JITTER).toBe(0.1);
    });
  });

  describe('happy path', () => {
    it('returns immediately on first-attempt success', async () => {
      const events: RetryEvent[] = [];
      const result = await retryWithBackoff(async () => 'ok', {
        onEvent: (e) => events.push(e),
      });
      expect(result).toBe('ok');
      expect(events.map((e) => e.kind)).toEqual(['succeeded']);
    });

    it('succeeds on second attempt after one retryable failure', async () => {
      let attempts = 0;
      const events: RetryEvent[] = [];
      const result = await retryWithBackoff(
        async () => {
          attempts++;
          if (attempts === 1) {
            const err: Error & { code?: string } = new Error('ECONNREFUSED');
            err.code = 'ECONNREFUSED';
            throw err;
          }
          return 'ok';
        },
        {
          initialBackoffMs: 1, // fast test
          setTimerFn: (fn) => setTimeout(fn, 0) as unknown,
          clearTimerFn: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
          onEvent: (e) => events.push(e),
        },
      );
      expect(result).toBe('ok');
      expect(attempts).toBe(2);
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(['attempt_failed', 'succeeded']);
    });
  });

  describe('retry classification', () => {
    it('non-retryable error is thrown immediately on first attempt', async () => {
      let attempts = 0;
      const events: RetryEvent[] = [];
      await expect(
        retryWithBackoff(
          async () => {
            attempts++;
            throw new Error('bad request');
          },
          {
            isRetryable: () => false,
            onEvent: (e) => events.push(e),
          },
        ),
      ).rejects.toThrow(/bad request/);
      expect(attempts).toBe(1);
      const failed = events.find((e) => e.kind === 'attempt_failed') as Extract<
        RetryEvent,
        { kind: 'attempt_failed' }
      >;
      expect(failed.willRetry).toBe(false);
    });

    it('default isRetryable: HTTP 500 response is retried; 400 is not', async () => {
      let attempts = 0;
      const result = await retryWithBackoff(
        async () => {
          attempts++;
          if (attempts === 1) {
            return { status: 500, body: 'ise' } as const;
          }
          return { status: 200, body: 'ok' } as const;
        },
        {
          initialBackoffMs: 1,
          setTimerFn: (fn) => setTimeout(fn, 0) as unknown,
          clearTimerFn: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        },
      );
      expect(result).toEqual({ status: 200, body: 'ok' });
    });

    it('HTTP 400 is not retried (returns as-is)', async () => {
      let attempts = 0;
      const result = await retryWithBackoff(
        async () => {
          attempts++;
          return { status: 400, body: 'bad' } as const;
        },
        { initialBackoffMs: 1 },
      );
      expect(result).toEqual({ status: 400, body: 'bad' });
      expect(attempts).toBe(1);
    });

    it('HTTP 429 is retried', async () => {
      let attempts = 0;
      const result = await retryWithBackoff(
        async () => {
          attempts++;
          if (attempts < 2) return { status: 429 } as const;
          return { status: 200 } as const;
        },
        {
          initialBackoffMs: 1,
          setTimerFn: (fn) => setTimeout(fn, 0) as unknown,
          clearTimerFn: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        },
      );
      expect(result.status).toBe(200);
    });

    it('network error with ETIMEDOUT is retried', async () => {
      let attempts = 0;
      const result = await retryWithBackoff(
        async () => {
          attempts++;
          if (attempts < 2) {
            const err: Error & { code?: string } = new Error('network');
            err.code = 'ETIMEDOUT';
            throw err;
          }
          return 'ok';
        },
        {
          initialBackoffMs: 1,
          setTimerFn: (fn) => setTimeout(fn, 0) as unknown,
          clearTimerFn: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        },
      );
      expect(result).toBe('ok');
    });
  });

  describe('exhaustion', () => {
    it('throws the last error after maxAttempts', async () => {
      const events: RetryEvent[] = [];
      await expect(
        retryWithBackoff(
          async () => {
            const err: Error & { code?: string } = new Error('network');
            err.code = 'ECONNREFUSED';
            throw err;
          },
          {
            maxAttempts: 3,
            initialBackoffMs: 1,
            setTimerFn: (fn) => setTimeout(fn, 0) as unknown,
            clearTimerFn: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
            onEvent: (e) => events.push(e),
          },
        ),
      ).rejects.toThrow(/network/);
      expect(events.some((e) => e.kind === 'exhausted')).toBe(true);
      expect(events.filter((e) => e.kind === 'attempt_failed')).toHaveLength(3);
    });
  });

  describe('AbortSignal', () => {
    it('aborts immediately when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        retryWithBackoff(async () => 'ok', { signal: controller.signal }),
      ).rejects.toThrow();
    });

    it('aborts during backoff wait', async () => {
      const controller = new AbortController();
      let attempts = 0;
      const promise = retryWithBackoff(
        async () => {
          attempts++;
          if (attempts === 1) {
            const err: Error & { code?: string } = new Error('network');
            err.code = 'ECONNREFUSED';
            throw err;
          }
          return 'ok';
        },
        {
          signal: controller.signal,
          initialBackoffMs: 5_000,
        },
      );
      // Abort during the 5s wait.
      setTimeout(() => controller.abort(), 10);
      await expect(promise).rejects.toThrow();
      expect(attempts).toBe(1);
    });
  });

  describe('construction validation', () => {
    it.each([
      ['maxAttempts 0', { maxAttempts: 0 }],
      ['maxAttempts fractional', { maxAttempts: 1.5 }],
      ['initialBackoffMs 0', { initialBackoffMs: 0 }],
      ['maxBackoffMs < initial', { initialBackoffMs: 1000, maxBackoffMs: 500 }],
      ['backoffFactor < 1', { backoffFactor: 0.5 }],
      ['jitter > 1', { jitter: 2 }],
      ['jitter < 0', { jitter: -0.1 }],
    ])('rejects %s', async (_label, opts) => {
      await expect(retryWithBackoff(async () => 'ok', opts)).rejects.toThrow();
    });
  });
});

describe('computeBackoff (task 5.11 pure helper)', () => {
  it('doubles per attempt', () => {
    const args = {
      initialBackoffMs: 100,
      maxBackoffMs: 10_000,
      backoffFactor: 2,
      jitter: 0,
      randomFn: () => 0.5,
    };
    expect(computeBackoff({ ...args, attempt: 0 })).toBe(100);
    expect(computeBackoff({ ...args, attempt: 1 })).toBe(200);
    expect(computeBackoff({ ...args, attempt: 2 })).toBe(400);
    expect(computeBackoff({ ...args, attempt: 3 })).toBe(800);
  });

  it('caps at maxBackoffMs', () => {
    const args = {
      initialBackoffMs: 1000,
      maxBackoffMs: 5000,
      backoffFactor: 2,
      jitter: 0,
      randomFn: () => 0.5,
    };
    // attempt 3 raw = 8000 → capped to 5000
    expect(computeBackoff({ ...args, attempt: 3 })).toBe(5000);
  });

  it('applies symmetric jitter', () => {
    const base = computeBackoff({
      attempt: 2,
      initialBackoffMs: 100,
      maxBackoffMs: 10_000,
      backoffFactor: 2,
      jitter: 0,
      randomFn: () => 0.5,
    });
    // random=0 → lower bound (1 - jitter)*base
    const low = computeBackoff({
      attempt: 2,
      initialBackoffMs: 100,
      maxBackoffMs: 10_000,
      backoffFactor: 2,
      jitter: 0.2,
      randomFn: () => 0,
    });
    // random=1 → upper bound (1 + jitter)*base
    const high = computeBackoff({
      attempt: 2,
      initialBackoffMs: 100,
      maxBackoffMs: 10_000,
      backoffFactor: 2,
      jitter: 0.2,
      randomFn: () => 1,
    });
    expect(low).toBe(Math.round(base * 0.8));
    expect(high).toBe(Math.round(base * 1.2));
  });

  it('retryAfterMs overrides exponential', () => {
    expect(
      computeBackoff({
        attempt: 10,
        initialBackoffMs: 100,
        maxBackoffMs: 60_000,
        backoffFactor: 2,
        jitter: 0,
        randomFn: () => 0.5,
        retryAfterMs: 2_500,
      }),
    ).toBe(2_500);
  });

  it('retryAfterMs is still capped by maxBackoffMs', () => {
    expect(
      computeBackoff({
        attempt: 0,
        initialBackoffMs: 100,
        maxBackoffMs: 1000,
        backoffFactor: 2,
        jitter: 0,
        randomFn: () => 0.5,
        retryAfterMs: 999_999,
      }),
    ).toBe(1000);
  });
});

describe('Retry-After header integration', () => {
  it('honours integer-seconds Retry-After', async () => {
    let attempts = 0;
    const events: RetryEvent[] = [];
    const result = await retryWithBackoff(
      async () => {
        attempts++;
        if (attempts === 1) {
          return {
            status: 429,
            headers: { 'retry-after': '1' },
          } as const;
        }
        return { status: 200 } as const;
      },
      {
        initialBackoffMs: 1,
        maxBackoffMs: 60_000,
        setTimerFn: (fn) => setTimeout(fn, 0) as unknown,
        clearTimerFn: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        onEvent: (e) => events.push(e),
      },
    );
    expect(result.status).toBe(200);
    const attemptFailed = events.find((e) => e.kind === 'attempt_failed') as Extract<
      RetryEvent,
      { kind: 'attempt_failed' }
    >;
    // retry_after: '1' → 1000ms delay computed
    expect(attemptFailed.nextDelayMs).toBe(1000);
  });

  it('handles Retry-After via Headers-like .get()', async () => {
    let attempts = 0;
    const events: RetryEvent[] = [];
    await retryWithBackoff(
      async () => {
        attempts++;
        if (attempts === 1) {
          return {
            status: 429,
            headers: {
              get(key: string): string | null {
                return key.toLowerCase() === 'retry-after' ? '2' : null;
              },
            },
          } as const;
        }
        return { status: 200 } as const;
      },
      {
        initialBackoffMs: 1,
        maxBackoffMs: 60_000,
        setTimerFn: (fn) => setTimeout(fn, 0) as unknown,
        clearTimerFn: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        onEvent: (e) => events.push(e),
      },
    );
    const attemptFailed = events.find((e) => e.kind === 'attempt_failed') as Extract<
      RetryEvent,
      { kind: 'attempt_failed' }
    >;
    expect(attemptFailed.nextDelayMs).toBe(2000);
  });
});
