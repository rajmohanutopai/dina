/**
 * Task 4.90 — SupervisedLoop tests.
 *
 * Uses a controllable mock scheduler so every timer fire is manual —
 * no real wall-clock delays, fully deterministic.
 */

import {
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_BACKOFF_MS,
  SupervisedLoop,
  type SupervisedLoopEvent,
} from '../src/supervision/supervised_loop';

/** A simple ordered list of pending timers. Fires oldest first. */
function mockScheduler() {
  type Entry = { fn: () => void; delayMs: number; cancelled: boolean };
  const pending: Entry[] = [];
  return {
    setTimerFn: (fn: () => void, delayMs: number) => {
      const entry: Entry = { fn, delayMs, cancelled: false };
      pending.push(entry);
      return entry;
    },
    clearTimerFn: (handle: unknown) => {
      const e = handle as Entry | undefined;
      if (e) e.cancelled = true;
    },
    /** Fire the oldest non-cancelled timer. Returns its delayMs, or undefined if none. */
    fireNext: async () => {
      while (pending.length > 0) {
        const e = pending.shift()!;
        if (e.cancelled) continue;
        e.fn();
        // Wait a microtask so the iteration's promise chain resolves.
        await new Promise<void>((r) => queueMicrotask(r));
        return e.delayMs;
      }
      return undefined;
    },
    pendingCount: () => pending.filter((e) => !e.cancelled).length,
  };
}

function mockClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  return {
    nowMsFn: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const baseIteration = async () => {
  // no-op
};

describe('SupervisedLoop (task 4.90)', () => {
  describe('start + stop lifecycle', () => {
    it('start fires `started` event then schedules an immediate tick', async () => {
      const events: SupervisedLoopEvent[] = [];
      const sched = mockScheduler();
      const loop = new SupervisedLoop({
        name: 'test',
        iteration: baseIteration,
        onEvent: (e) => events.push(e),
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      loop.start();
      expect(events.map((e) => e.kind)).toEqual(['started']);
      expect(sched.pendingCount()).toBe(1);
      await loop.stop();
    });

    it('start is idempotent', async () => {
      const events: SupervisedLoopEvent[] = [];
      const sched = mockScheduler();
      const loop = new SupervisedLoop({
        name: 'test',
        iteration: baseIteration,
        onEvent: (e) => events.push(e),
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      loop.start();
      loop.start();
      loop.start();
      expect(events.filter((e) => e.kind === 'started')).toHaveLength(1);
      await loop.stop();
    });

    it('stop is idempotent and waits for in-flight', async () => {
      const sched = mockScheduler();
      let resolveIteration!: () => void;
      const iteration = () =>
        new Promise<void>((r) => {
          resolveIteration = r;
        });
      const loop = new SupervisedLoop({
        name: 'test',
        iteration,
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      loop.start();
      // Fire the immediate tick → iteration starts but doesn't resolve yet.
      sched.setTimerFn(() => undefined, 0); // prevent fireNext from advancing (we want to see inflight behavior)
      void sched.fireNext(); // schedule fire
      // Stop concurrently; should wait for iteration.
      const stopPromise = loop.stop();
      resolveIteration();
      await stopPromise;
      await loop.stop(); // second stop is no-op
    });

    it('stop after start without a fire cancels the pending tick', async () => {
      const sched = mockScheduler();
      const loop = new SupervisedLoop({
        name: 'test',
        iteration: baseIteration,
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      loop.start();
      expect(sched.pendingCount()).toBe(1);
      await loop.stop();
      expect(sched.pendingCount()).toBe(0);
    });

    it('start after stop throws', async () => {
      const sched = mockScheduler();
      const loop = new SupervisedLoop({
        name: 'test',
        iteration: baseIteration,
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      loop.start();
      await loop.stop();
      expect(() => loop.start()).toThrow(/cannot restart a stopped loop/);
    });

    it('isRunning reflects state', async () => {
      const sched = mockScheduler();
      const loop = new SupervisedLoop({
        name: 'test',
        iteration: baseIteration,
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      expect(loop.isRunning()).toBe(false);
      loop.start();
      expect(loop.isRunning()).toBe(true);
      await loop.stop();
      expect(loop.isRunning()).toBe(false);
    });
  });

  describe('success path', () => {
    it('after a successful iteration, next tick is scheduled at intervalMs', async () => {
      const events: SupervisedLoopEvent[] = [];
      const sched = mockScheduler();
      const clock = mockClock();
      let iterations = 0;
      const loop = new SupervisedLoop({
        name: 'test',
        iteration: async () => {
          iterations++;
        },
        intervalMs: 5000,
        onEvent: (e) => events.push(e),
        nowMsFn: clock.nowMsFn,
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      loop.start();
      await sched.fireNext(); // first (immediate) tick
      expect(iterations).toBe(1);
      // Next tick scheduled at intervalMs.
      const nextDelay = await sched.fireNext();
      expect(nextDelay).toBe(5000);
      expect(iterations).toBe(2);
      await loop.stop();
    });

    it('failureStreak resets to 0 after a success', async () => {
      const sched = mockScheduler();
      let call = 0;
      const loop = new SupervisedLoop({
        name: 'test',
        iteration: async () => {
          call++;
          if (call === 1) throw new Error('boom');
        },
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      loop.start();
      await sched.fireNext(); // iteration 1: fails
      expect(loop.failureStreak()).toBe(1);
      await sched.fireNext(); // iteration 2: succeeds
      expect(loop.failureStreak()).toBe(0);
      await loop.stop();
    });

    it('emits iteration_ok with duration', async () => {
      const events: SupervisedLoopEvent[] = [];
      const sched = mockScheduler();
      let now = 1_000_000;
      const nowMsFn = () => now;
      const loop = new SupervisedLoop({
        name: 'test',
        iteration: async () => {
          now += 50; // simulated 50ms work
        },
        onEvent: (e) => events.push(e),
        nowMsFn,
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      loop.start();
      await sched.fireNext();
      const ok = events.find((e) => e.kind === 'iteration_ok') as Extract<
        SupervisedLoopEvent,
        { kind: 'iteration_ok' }
      >;
      expect(ok).toBeDefined();
      expect(ok.durationMs).toBe(50);
      await loop.stop();
    });
  });

  describe('failure + backoff', () => {
    it('consecutive failures double the backoff up to the cap', async () => {
      const events: SupervisedLoopEvent[] = [];
      const sched = mockScheduler();
      const loop = new SupervisedLoop({
        name: 'test',
        iteration: async () => {
          throw new Error('fail');
        },
        initialBackoffMs: 100,
        maxBackoffMs: 1000,
        onEvent: (e) => events.push(e),
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      loop.start();

      const delays: number[] = [];
      for (let i = 0; i < 6; i++) {
        const d = await sched.fireNext();
        if (d !== undefined) delays.push(d);
      }
      // Immediate tick has delay 0, then 100, 200, 400, 800, 1000 (capped).
      expect(delays).toEqual([0, 100, 200, 400, 800, 1000]);

      const failures = events.filter((e) => e.kind === 'iteration_failed');
      expect(failures.length).toBeGreaterThanOrEqual(5);
      await loop.stop();
    });

    it('emits `restarting` with the computed backoff', async () => {
      const events: SupervisedLoopEvent[] = [];
      const sched = mockScheduler();
      const loop = new SupervisedLoop({
        name: 'test',
        iteration: async () => {
          throw new Error('fail');
        },
        initialBackoffMs: 250,
        maxBackoffMs: 10_000,
        onEvent: (e) => events.push(e),
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      loop.start();
      await sched.fireNext(); // fires + fails → schedules backoff
      const restart = events.find((e) => e.kind === 'restarting') as Extract<
        SupervisedLoopEvent,
        { kind: 'restarting' }
      >;
      expect(restart).toBeDefined();
      expect(restart.backoffMs).toBe(250);
      expect(restart.consecutiveFailures).toBe(1);
      await loop.stop();
    });

    it('iteration_failed carries the error message', async () => {
      const events: SupervisedLoopEvent[] = [];
      const sched = mockScheduler();
      const loop = new SupervisedLoop({
        name: 'test',
        iteration: async () => {
          throw new Error('specific failure');
        },
        onEvent: (e) => events.push(e),
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      loop.start();
      await sched.fireNext();
      const failed = events.find((e) => e.kind === 'iteration_failed') as Extract<
        SupervisedLoopEvent,
        { kind: 'iteration_failed' }
      >;
      expect(failed.error).toBe('specific failure');
      await loop.stop();
    });
  });

  describe('abort signal', () => {
    it('stop() aborts the in-flight iteration signal', async () => {
      const sched = mockScheduler();
      let receivedSignal: AbortSignal | undefined;
      let resolveIteration!: () => void;
      const iteration = (signal?: AbortSignal) => {
        receivedSignal = signal;
        return new Promise<void>((r) => {
          resolveIteration = r;
        });
      };
      const loop = new SupervisedLoop({
        name: 'test',
        iteration,
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      loop.start();
      void sched.fireNext();
      // Wait a microtask for iteration to start.
      await new Promise<void>((r) => queueMicrotask(r));
      expect(receivedSignal).toBeDefined();
      expect(receivedSignal!.aborted).toBe(false);
      const stopPromise = loop.stop();
      // After stop, signal should be aborted.
      expect(receivedSignal!.aborted).toBe(true);
      resolveIteration();
      await stopPromise;
    });
  });

  describe('constructor validation', () => {
    it('rejects missing name', () => {
      expect(
        () =>
          new SupervisedLoop({
            name: '',
            iteration: baseIteration,
          }),
      ).toThrow(/name is required/);
    });

    it('rejects missing iteration', () => {
      expect(
        () =>
          new SupervisedLoop({
            name: 'test',
            iteration: undefined as unknown as typeof baseIteration,
          }),
      ).toThrow(/iteration is required/);
    });

    it('rejects non-positive intervalMs', () => {
      expect(
        () =>
          new SupervisedLoop({
            name: 't',
            iteration: baseIteration,
            intervalMs: 0,
          }),
      ).toThrow(/intervalMs must be > 0/);
    });

    it('rejects non-positive initialBackoffMs', () => {
      expect(
        () =>
          new SupervisedLoop({
            name: 't',
            iteration: baseIteration,
            initialBackoffMs: -1,
          }),
      ).toThrow(/initialBackoffMs must be > 0/);
    });

    it('rejects maxBackoffMs below initialBackoffMs', () => {
      expect(
        () =>
          new SupervisedLoop({
            name: 't',
            iteration: baseIteration,
            initialBackoffMs: 1000,
            maxBackoffMs: 500,
          }),
      ).toThrow(/maxBackoffMs must be >= initialBackoffMs/);
    });
  });

  describe('constants', () => {
    it('DEFAULT_INTERVAL_MS = 60 000 (1 minute)', () => {
      expect(DEFAULT_INTERVAL_MS).toBe(60_000);
    });
    it('DEFAULT_INITIAL_BACKOFF_MS = 1000', () => {
      expect(DEFAULT_INITIAL_BACKOFF_MS).toBe(1_000);
    });
    it('DEFAULT_MAX_BACKOFF_MS = 30 000', () => {
      expect(DEFAULT_MAX_BACKOFF_MS).toBe(30_000);
    });
  });
});
