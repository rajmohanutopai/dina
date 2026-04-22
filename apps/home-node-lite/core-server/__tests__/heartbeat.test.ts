/**
 * Task 4.39 — WebSocket heartbeat tests.
 *
 * All timing is driven by an injected scheduler (no real setTimeout)
 * so tests are deterministic.
 */

import {
  installHeartbeat,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
} from '../src/ws/heartbeat';

/**
 * Mock scheduler: captures the callback + interval; tests advance time
 * by invoking `fire()` manually.
 */
function mockSchedule() {
  let registered: (() => void) | null = null;
  let registeredMs = 0;
  let stopped = false;
  return {
    scheduler: (fn: () => void, ms: number) => {
      registered = fn;
      registeredMs = ms;
      return {
        stop: () => {
          stopped = true;
        },
      };
    },
    fire: () => {
      if (registered && !stopped) registered();
    },
    stopped: () => stopped,
    registeredMs: () => registeredMs,
  };
}

/** A mock clock you advance explicitly. */
function mockClock(initial = 1_000_000) {
  let now = initial;
  return {
    nowMsFn: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    set: (ms: number) => {
      now = ms;
    },
  };
}

describe('installHeartbeat (task 4.39)', () => {
  describe('happy path', () => {
    it('sends a ping on each interval tick', () => {
      let pings = 0;
      const sched = mockSchedule();
      const clock = mockClock();
      const hb = installHeartbeat({
        sendPing: () => {
          pings++;
        },
        onTimeout: () => {
          throw new Error('unexpected timeout');
        },
        intervalMs: 30_000,
        timeoutMs: 60_000,
        nowMsFn: clock.nowMsFn,
        setIntervalFn: sched.scheduler,
      });

      // Tick 1: advance 30s, fire — should send a ping (pong was just
      // anchored on install, well within 60s budget).
      clock.advance(30_000);
      sched.fire();
      expect(pings).toBe(1);

      // Tick 2: advance another 30s. Pong was marked at install (0ms);
      // we're at 60s with budget 60s → exact boundary → elapsed >=
      // timeout → timeout fires, not a ping. Update pong first.
      hb.markPong();
      clock.advance(30_000);
      sched.fire();
      expect(pings).toBe(2);

      hb.stop();
    });

    it('markPong resets the staleness clock', () => {
      let pings = 0;
      let timedOut = false;
      const sched = mockSchedule();
      const clock = mockClock();
      installHeartbeat({
        sendPing: () => {
          pings++;
        },
        onTimeout: () => {
          timedOut = true;
        },
        intervalMs: 30_000,
        timeoutMs: 60_000,
        nowMsFn: clock.nowMsFn,
        setIntervalFn: sched.scheduler,
      });

      // Walk forward without markPong — 45s elapsed, under 60s budget.
      clock.advance(45_000);
      sched.fire();
      expect(pings).toBe(1);
      expect(timedOut).toBe(false);

      // Keep walking — at 65s from last pong → timeout.
      clock.advance(20_000);
      sched.fire();
      expect(timedOut).toBe(true);
    });
  });

  describe('timeout', () => {
    it('onTimeout fires when no pong in `timeoutMs`', () => {
      let timedOut = false;
      let pings = 0;
      const sched = mockSchedule();
      const clock = mockClock();
      installHeartbeat({
        sendPing: () => pings++,
        onTimeout: () => {
          timedOut = true;
        },
        intervalMs: 30_000,
        timeoutMs: 60_000,
        nowMsFn: clock.nowMsFn,
        setIntervalFn: sched.scheduler,
      });

      // Advance 65s without a pong → tick fires → timeout.
      clock.advance(65_000);
      sched.fire();
      expect(timedOut).toBe(true);
      expect(pings).toBe(0); // no ping sent when timing out
    });

    it('stops the scheduler after timeout (no duplicate fires)', () => {
      let timeouts = 0;
      const sched = mockSchedule();
      const clock = mockClock();
      installHeartbeat({
        sendPing: () => undefined,
        onTimeout: () => timeouts++,
        intervalMs: 30_000,
        timeoutMs: 60_000,
        nowMsFn: clock.nowMsFn,
        setIntervalFn: sched.scheduler,
      });

      clock.advance(65_000);
      sched.fire(); // times out once
      expect(timeouts).toBe(1);
      expect(sched.stopped()).toBe(true);

      // Subsequent fires (if any) don't invoke onTimeout again — the
      // mock scheduler's `fire` checks `stopped` and is a no-op.
      sched.fire();
      expect(timeouts).toBe(1);
    });

    it('exact-boundary elapsed === timeoutMs triggers timeout (inclusive)', () => {
      let timedOut = false;
      const sched = mockSchedule();
      const clock = mockClock();
      installHeartbeat({
        sendPing: () => undefined,
        onTimeout: () => {
          timedOut = true;
        },
        intervalMs: 30_000,
        timeoutMs: 60_000,
        nowMsFn: clock.nowMsFn,
        setIntervalFn: sched.scheduler,
      });
      clock.advance(60_000);
      sched.fire();
      expect(timedOut).toBe(true);
    });

    it('sendPing throwing is treated as a timeout', () => {
      let timedOut = false;
      const sched = mockSchedule();
      const clock = mockClock();
      installHeartbeat({
        sendPing: () => {
          throw new Error('socket closed');
        },
        onTimeout: () => {
          timedOut = true;
        },
        intervalMs: 30_000,
        timeoutMs: 60_000,
        nowMsFn: clock.nowMsFn,
        setIntervalFn: sched.scheduler,
      });
      clock.advance(10_000);
      sched.fire();
      expect(timedOut).toBe(true);
      expect(sched.stopped()).toBe(true);
    });
  });

  describe('handle API', () => {
    it('stop() halts the scheduler', () => {
      let pings = 0;
      const sched = mockSchedule();
      const clock = mockClock();
      const hb = installHeartbeat({
        sendPing: () => pings++,
        onTimeout: () => undefined,
        intervalMs: 30_000,
        nowMsFn: clock.nowMsFn,
        setIntervalFn: sched.scheduler,
      });
      hb.stop();
      clock.advance(30_000);
      sched.fire(); // stopped mock → no-op
      expect(pings).toBe(0);
      expect(sched.stopped()).toBe(true);
    });

    it('stop() is idempotent', () => {
      const sched = mockSchedule();
      const hb = installHeartbeat({
        sendPing: () => undefined,
        onTimeout: () => undefined,
        intervalMs: 30_000,
        setIntervalFn: sched.scheduler,
      });
      hb.stop();
      expect(() => hb.stop()).not.toThrow();
    });

    it('lastPongAt() reflects most recent markPong', () => {
      const sched = mockSchedule();
      const clock = mockClock(1_000_000);
      const hb = installHeartbeat({
        sendPing: () => undefined,
        onTimeout: () => undefined,
        intervalMs: 30_000,
        nowMsFn: clock.nowMsFn,
        setIntervalFn: sched.scheduler,
      });
      expect(hb.lastPongAt()).toBe(1_000_000);
      clock.set(2_000_000);
      hb.markPong();
      expect(hb.lastPongAt()).toBe(2_000_000);
    });
  });

  describe('defaults', () => {
    it('intervalMs default is 30_000 (30 seconds)', () => {
      const sched = mockSchedule();
      installHeartbeat({
        sendPing: () => undefined,
        onTimeout: () => undefined,
        setIntervalFn: sched.scheduler,
      });
      expect(sched.registeredMs()).toBe(30_000);
    });

    it('DEFAULT_HEARTBEAT_INTERVAL_MS constant is 30s', () => {
      expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(30_000);
    });

    it('timeoutMs default is 2 × intervalMs', () => {
      let timedOut = false;
      const sched = mockSchedule();
      const clock = mockClock();
      installHeartbeat({
        sendPing: () => undefined,
        onTimeout: () => {
          timedOut = true;
        },
        intervalMs: 30_000,
        // timeoutMs omitted → default 60_000
        nowMsFn: clock.nowMsFn,
        setIntervalFn: sched.scheduler,
      });
      clock.advance(59_999);
      sched.fire();
      expect(timedOut).toBe(false);
      clock.advance(1);
      sched.fire();
      expect(timedOut).toBe(true);
    });
  });

  describe('input validation', () => {
    it('rejects intervalMs <= 0', () => {
      expect(() =>
        installHeartbeat({
          sendPing: () => undefined,
          onTimeout: () => undefined,
          intervalMs: 0,
        }),
      ).toThrow(/intervalMs must be > 0/);
    });

    it('rejects timeoutMs <= 0', () => {
      expect(() =>
        installHeartbeat({
          sendPing: () => undefined,
          onTimeout: () => undefined,
          intervalMs: 30_000,
          timeoutMs: 0,
        }),
      ).toThrow(/timeoutMs must be > 0/);
    });

    it('rejects NaN / Infinity', () => {
      expect(() =>
        installHeartbeat({
          sendPing: () => undefined,
          onTimeout: () => undefined,
          intervalMs: NaN,
        }),
      ).toThrow(/intervalMs must be > 0/);
      expect(() =>
        installHeartbeat({
          sendPing: () => undefined,
          onTimeout: () => undefined,
          intervalMs: Infinity,
        }),
      ).toThrow(/intervalMs must be > 0/);
    });
  });

  describe('logger hook', () => {
    it('logs trace on ping + warn on timeout', () => {
      const lines: Array<[string, string]> = [];
      const sched = mockSchedule();
      const clock = mockClock();
      installHeartbeat({
        sendPing: () => undefined,
        onTimeout: () => undefined,
        intervalMs: 30_000,
        timeoutMs: 60_000,
        nowMsFn: clock.nowMsFn,
        setIntervalFn: sched.scheduler,
        logger: {
          trace: (msg) => lines.push(['trace', msg]),
          warn: (msg) => lines.push(['warn', msg]),
        },
      });
      clock.advance(30_000);
      sched.fire(); // within budget → trace ping
      clock.advance(35_000);
      sched.fire(); // 65s since last pong → timeout → warn
      expect(lines.some(([lvl]) => lvl === 'trace')).toBe(true);
      expect(lines.some(([lvl]) => lvl === 'warn')).toBe(true);
    });
  });
});
