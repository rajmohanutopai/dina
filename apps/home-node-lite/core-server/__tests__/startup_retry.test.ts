/**
 * Task 5.12 — waitUntilReachable / computeBackoffMs tests.
 */

import {
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_JITTER,
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_MAX_DURATION_MS,
  StartupAbortError,
  StartupTimeoutError,
  computeBackoffMs,
  waitUntilReachable,
  type ProbeFn,
} from '../src/brain/startup_retry';

/**
 * Mock scheduler that queues timers + fires them on demand. Lets
 * tests simulate elapsed time without real waits.
 */
function mockScheduler(): {
  setTimerFn: (fn: () => void, ms: number) => unknown;
  clearTimerFn: (h: unknown) => void;
  advance: (ms: number) => void;
  pending: () => number;
} {
  const queue: Array<{ fn: () => void; fireAt: number }> = [];
  let now = 0;
  let nextHandle = 1;
  const handles = new Map<number, { fn: () => void; fireAt: number }>();
  return {
    setTimerFn: (fn: () => void, ms: number): unknown => {
      const h = nextHandle++;
      const entry = { fn, fireAt: now + ms };
      queue.push(entry);
      handles.set(h, entry);
      return h;
    },
    clearTimerFn: (h: unknown): void => {
      const entry = handles.get(h as number);
      if (entry) {
        const idx = queue.indexOf(entry);
        if (idx !== -1) queue.splice(idx, 1);
        handles.delete(h as number);
      }
    },
    advance: (ms: number): void => {
      now += ms;
      while (queue.length && queue[0]!.fireAt <= now) {
        const entry = queue.shift()!;
        entry.fn();
      }
    },
    pending: (): number => queue.length,
  };
}

describe('computeBackoffMs (task 5.12)', () => {
  it('exponential ×2 without jitter', () => {
    const opts = {
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitter: 0,
      randomFn: () => 0.5,
    };
    expect(computeBackoffMs(0, opts)).toBe(500);
    expect(computeBackoffMs(1, opts)).toBe(1000);
    expect(computeBackoffMs(2, opts)).toBe(2000);
    expect(computeBackoffMs(3, opts)).toBe(4000);
    expect(computeBackoffMs(4, opts)).toBe(8000);
  });

  it('clamps to maxDelayMs', () => {
    const opts = {
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitter: 0,
      randomFn: () => 0.5,
    };
    expect(computeBackoffMs(10, opts)).toBe(10_000); // 2^10 × 500 = 512k → clamped
  });

  it('jitter with random=0.5 → no change (midpoint)', () => {
    const opts = {
      initialDelayMs: 1000,
      maxDelayMs: 10_000,
      jitter: 0.2,
      randomFn: () => 0.5,
    };
    expect(computeBackoffMs(0, opts)).toBe(1000);
  });

  it('jitter with random=1.0 → +jitter', () => {
    const opts = {
      initialDelayMs: 1000,
      maxDelayMs: 10_000,
      jitter: 0.2,
      randomFn: () => 1.0,
    };
    expect(computeBackoffMs(0, opts)).toBe(1200);
  });

  it('jitter with random=0.0 → -jitter', () => {
    const opts = {
      initialDelayMs: 1000,
      maxDelayMs: 10_000,
      jitter: 0.2,
      randomFn: () => 0.0,
    };
    expect(computeBackoffMs(0, opts)).toBe(800);
  });

  it('negative attempts clamp to 0', () => {
    expect(
      computeBackoffMs(-5, {
        initialDelayMs: 500,
        maxDelayMs: 10_000,
        jitter: 0,
        randomFn: () => 0.5,
      }),
    ).toBe(500);
  });

  describe('constants', () => {
    it.each([
      ['DEFAULT_INITIAL_DELAY_MS', DEFAULT_INITIAL_DELAY_MS, 500],
      ['DEFAULT_MAX_DELAY_MS', DEFAULT_MAX_DELAY_MS, 10_000],
      ['DEFAULT_MAX_DURATION_MS', DEFAULT_MAX_DURATION_MS, 60_000],
      ['DEFAULT_JITTER', DEFAULT_JITTER, 0.2],
    ])('%s = %i', (_label, actual, expected) => {
      expect(actual).toBe(expected);
    });
  });
});

describe('waitUntilReachable (task 5.12)', () => {
  describe('construction', () => {
    it('throws without name', async () => {
      await expect(
        waitUntilReachable({
          name: '',
          probeFn: async () => ({ ok: true }),
        }),
      ).rejects.toThrow(/name/);
    });

    it('throws without probeFn', async () => {
      await expect(
        waitUntilReachable({
          name: 'x',
          probeFn: undefined as unknown as ProbeFn,
        }),
      ).rejects.toThrow(/probeFn/);
    });
  });

  describe('happy path', () => {
    it('immediate success on first probe', async () => {
      let calls = 0;
      const res = await waitUntilReachable({
        name: 'core',
        probeFn: async () => {
          calls++;
          return { ok: true };
        },
      });
      expect(calls).toBe(1);
      expect(res.attempts).toBe(1);
    });

    it('fires probe_started + probe_ok events', async () => {
      const events: unknown[] = [];
      await waitUntilReachable({
        name: 'core',
        probeFn: async () => ({ ok: true }),
        onEvent: (e) => events.push(e),
      });
      const kinds = events.map((e) => (e as { kind: string }).kind);
      expect(kinds).toEqual(['probe_started', 'probe_ok']);
    });

    it('succeeds after a few failures', async () => {
      let now = 0;
      let calls = 0;
      const sched = mockScheduler();
      const result = await waitUntilReachable({
        name: 'core',
        probeFn: async () => {
          calls++;
          if (calls < 3) return { ok: false, reason: 'not ready' };
          return { ok: true };
        },
        setTimerFn: (fn, ms) => {
          // Drive the scheduler immediately so the test doesn't stall.
          const h = sched.setTimerFn(fn, ms);
          sched.advance(ms);
          return h;
        },
        clearTimerFn: sched.clearTimerFn,
        nowMsFn: () => now,
        randomFn: () => 0.5,
      });
      expect(result.attempts).toBe(3);
      expect(calls).toBe(3);
    });
  });

  describe('budget exhaustion', () => {
    it('gives up after maxDurationMs with StartupTimeoutError', async () => {
      let now = 0;
      const sched = mockScheduler();
      const promise = waitUntilReachable({
        name: 'core',
        probeFn: async () => ({ ok: false, reason: 'still down' }),
        maxDurationMs: 2000,
        setTimerFn: (fn, ms) => {
          const h = sched.setTimerFn(fn, ms);
          // Advance clock + the scheduler together so budget tracking sees the time.
          now += ms;
          sched.advance(ms);
          return h;
        },
        clearTimerFn: sched.clearTimerFn,
        nowMsFn: () => now,
        randomFn: () => 0.5,
        initialDelayMs: 500,
        maxDelayMs: 10_000,
      });
      await expect(promise).rejects.toBeInstanceOf(StartupTimeoutError);
    });

    it('gave_up event carries lastReason', async () => {
      let now = 0;
      const sched = mockScheduler();
      const events: unknown[] = [];
      await waitUntilReachable({
        name: 'core',
        probeFn: async () => ({ ok: false, reason: 'port closed' }),
        maxDurationMs: 100,
        initialDelayMs: 50,
        setTimerFn: (fn, ms) => {
          const h = sched.setTimerFn(fn, ms);
          now += ms;
          sched.advance(ms);
          return h;
        },
        clearTimerFn: sched.clearTimerFn,
        nowMsFn: () => now,
        randomFn: () => 0.5,
        onEvent: (e) => events.push(e),
      }).catch(() => undefined);
      const gaveUp = events.find(
        (e) => (e as { kind: string }).kind === 'gave_up',
      ) as { lastReason: string };
      expect(gaveUp.lastReason).toBe('port closed');
    });
  });

  describe('probe throwing', () => {
    it('treats thrown error as a failed probe', async () => {
      let calls = 0;
      let now = 0;
      const sched = mockScheduler();
      const res = await waitUntilReachable({
        name: 'core',
        probeFn: async () => {
          calls++;
          if (calls === 1) throw new Error('ECONNREFUSED');
          return { ok: true };
        },
        setTimerFn: (fn, ms) => {
          const h = sched.setTimerFn(fn, ms);
          now += ms;
          sched.advance(ms);
          return h;
        },
        clearTimerFn: sched.clearTimerFn,
        nowMsFn: () => now,
        randomFn: () => 0.5,
      });
      expect(res.attempts).toBe(2);
    });

    it('non-Error thrown value surfaces as string in reason', async () => {
      const events: unknown[] = [];
      let now = 0;
      const sched = mockScheduler();
      await waitUntilReachable({
        name: 'core',
        probeFn: async () => {
          throw 'plain string';
        },
        maxDurationMs: 100,
        initialDelayMs: 50,
        setTimerFn: (fn, ms) => {
          const h = sched.setTimerFn(fn, ms);
          now += ms;
          sched.advance(ms);
          return h;
        },
        clearTimerFn: sched.clearTimerFn,
        nowMsFn: () => now,
        randomFn: () => 0.5,
        onEvent: (e) => events.push(e),
      }).catch(() => undefined);
      const failed = events.find(
        (e) => (e as { kind: string }).kind === 'probe_failed',
      ) as { reason: string };
      expect(failed.reason).toBe('plain string');
    });
  });

  describe('abort signal', () => {
    it('aborting before first probe → StartupAbortError (attempts=0)', async () => {
      const ac = new AbortController();
      ac.abort();
      const err = (await waitUntilReachable({
        name: 'core',
        probeFn: async () => ({ ok: true }),
        signal: ac.signal,
      }).catch((e) => e)) as StartupAbortError;
      expect(err).toBeInstanceOf(StartupAbortError);
      expect(err.attempts).toBe(0);
    });

    it('aborting mid-wait rejects immediately', async () => {
      const ac = new AbortController();
      let calls = 0;
      const sched = mockScheduler();
      let now = 0;
      const promise = waitUntilReachable({
        name: 'core',
        probeFn: async () => {
          calls++;
          if (calls === 1) {
            // Abort during the first wait.
            setImmediate(() => ac.abort());
          }
          return { ok: false, reason: 'still down' };
        },
        initialDelayMs: 10_000, // long wait so the abort can fire first
        maxDurationMs: 100_000,
        setTimerFn: (fn, ms) => sched.setTimerFn(fn, ms),
        clearTimerFn: sched.clearTimerFn,
        nowMsFn: () => now,
        randomFn: () => 0.5,
        signal: ac.signal,
      });
      await expect(promise).rejects.toThrow();
    });
  });

  describe('event stream', () => {
    it('fires probe_failed between attempts', async () => {
      let calls = 0;
      let now = 0;
      const sched = mockScheduler();
      const events: unknown[] = [];
      await waitUntilReachable({
        name: 'core',
        probeFn: async () => {
          calls++;
          if (calls < 3) return { ok: false, reason: `fail-${calls}` };
          return { ok: true };
        },
        setTimerFn: (fn, ms) => {
          const h = sched.setTimerFn(fn, ms);
          now += ms;
          sched.advance(ms);
          return h;
        },
        clearTimerFn: sched.clearTimerFn,
        nowMsFn: () => now,
        randomFn: () => 0.5,
        onEvent: (e) => events.push(e),
      });
      const failedEvents = events.filter(
        (e) => (e as { kind: string }).kind === 'probe_failed',
      );
      expect(failedEvents).toHaveLength(2);
      expect((failedEvents[0] as { reason: string }).reason).toBe('fail-1');
    });
  });
});
