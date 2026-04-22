/**
 * Task 4.71 — auto-lock TTL tests.
 *
 * Uses a mock timer + clock so tests are fully deterministic (no
 * setTimeout race conditions).
 */

import {
  AutoLockRegistry,
  DEFAULT_AUTO_LOCK_TTL_MS,
  type AutoLockEvent,
} from '../src/persona/auto_lock';

/** Controllable clock + timer mock driven manually by the tests. */
function mockEnv() {
  let now = 1_000_000;
  const timers: Array<{ fire: () => void; fireAt: number }> = [];

  return {
    nowMsFn: () => now,
    advance: (ms: number) => {
      now += ms;
      // Fire any timer whose deadline has passed.
      while (true) {
        const due = timers
          .filter((t) => t.fireAt <= now)
          .sort((a, b) => a.fireAt - b.fireAt);
        if (due.length === 0) break;
        const next = due[0]!;
        const idx = timers.indexOf(next);
        if (idx >= 0) timers.splice(idx, 1);
        next.fire();
      }
    },
    set: (ms: number) => {
      now = ms;
    },
    setTimerFn: (fn: () => void, ms: number): unknown => {
      const entry = { fire: fn, fireAt: now + ms };
      timers.push(entry);
      return entry;
    },
    clearTimerFn: (handle: unknown) => {
      const idx = timers.indexOf(handle as { fire: () => void; fireAt: number });
      if (idx >= 0) timers.splice(idx, 1);
    },
    pendingTimers: () => timers.length,
  };
}

describe('AutoLockRegistry (task 4.71)', () => {
  describe('unlock → timeout fires lockFn', () => {
    it('locks after ttl elapses', () => {
      const locked: string[] = [];
      const env = mockEnv();
      const reg = new AutoLockRegistry({
        lockFn: (p) => locked.push(p),
        nowMsFn: env.nowMsFn,
        setTimerFn: env.setTimerFn,
        clearTimerFn: env.clearTimerFn,
      });
      reg.unlock('/health', { ttlMs: 10_000 });
      expect(reg.isUnlocked('/health')).toBe(true);
      env.advance(9_999);
      expect(locked).toEqual([]);
      env.advance(1);
      expect(locked).toEqual(['/health']);
      expect(reg.isUnlocked('/health')).toBe(false);
    });

    it('default ttl = 15 minutes when unlock omits ttlMs', () => {
      const locked: string[] = [];
      const env = mockEnv();
      const reg = new AutoLockRegistry({
        lockFn: (p) => locked.push(p),
        nowMsFn: env.nowMsFn,
        setTimerFn: env.setTimerFn,
        clearTimerFn: env.clearTimerFn,
      });
      reg.unlock('/health');
      env.advance(15 * 60 * 1000 - 1);
      expect(locked).toEqual([]);
      env.advance(1);
      expect(locked).toEqual(['/health']);
    });
  });

  describe('touch resets deadline', () => {
    it('activity pushes the deadline forward', () => {
      const locked: string[] = [];
      const env = mockEnv();
      const reg = new AutoLockRegistry({
        lockFn: (p) => locked.push(p),
        nowMsFn: env.nowMsFn,
        setTimerFn: env.setTimerFn,
        clearTimerFn: env.clearTimerFn,
      });
      reg.unlock('/health', { ttlMs: 10_000 });
      env.advance(9_000);
      reg.touch('/health');
      env.advance(9_000); // total 18s; deadline reset to +10s at t=9s → fires at 19s
      expect(locked).toEqual([]);
      env.advance(1_000); // now at 19s → deadline
      expect(locked).toEqual(['/health']);
    });

    it('touch on an unknown persona is a no-op', () => {
      const env = mockEnv();
      const reg = new AutoLockRegistry({
        lockFn: () => undefined,
        nowMsFn: env.nowMsFn,
        setTimerFn: env.setTimerFn,
        clearTimerFn: env.clearTimerFn,
      });
      expect(() => reg.touch('/never-unlocked')).not.toThrow();
      expect(env.pendingTimers()).toBe(0);
    });
  });

  describe('explicit lock', () => {
    it('cancels the pending timer and drops the entry', () => {
      const locked: string[] = [];
      const env = mockEnv();
      const reg = new AutoLockRegistry({
        lockFn: (p) => locked.push(p),
        nowMsFn: env.nowMsFn,
        setTimerFn: env.setTimerFn,
        clearTimerFn: env.clearTimerFn,
      });
      reg.unlock('/health', { ttlMs: 10_000 });
      expect(env.pendingTimers()).toBe(1);
      reg.lock('/health');
      expect(env.pendingTimers()).toBe(0);
      env.advance(20_000);
      expect(locked).toEqual([]); // lockFn NOT called — explicit lock short-circuits
      expect(reg.isUnlocked('/health')).toBe(false);
    });

    it('lock on an unknown persona is a no-op', () => {
      const reg = new AutoLockRegistry({ lockFn: () => undefined });
      expect(() => reg.lock('/never-unlocked')).not.toThrow();
    });
  });

  describe('re-unlock replaces prior timer', () => {
    it('calling unlock again cancels the prior timer + starts fresh', () => {
      const locked: string[] = [];
      const env = mockEnv();
      const reg = new AutoLockRegistry({
        lockFn: (p) => locked.push(p),
        nowMsFn: env.nowMsFn,
        setTimerFn: env.setTimerFn,
        clearTimerFn: env.clearTimerFn,
      });
      reg.unlock('/health', { ttlMs: 10_000 });
      env.advance(5_000);
      reg.unlock('/health', { ttlMs: 20_000 }); // fresh 20s deadline
      env.advance(15_000); // total 20s; fresh deadline = 25s (5 + 20)
      expect(locked).toEqual([]);
      env.advance(5_001);
      expect(locked).toEqual(['/health']);
      expect(env.pendingTimers()).toBe(0);
    });
  });

  describe('multiple personas isolated', () => {
    it('each persona has its own deadline + timer', () => {
      const locked: string[] = [];
      const env = mockEnv();
      const reg = new AutoLockRegistry({
        lockFn: (p) => locked.push(p),
        nowMsFn: env.nowMsFn,
        setTimerFn: env.setTimerFn,
        clearTimerFn: env.clearTimerFn,
      });
      reg.unlock('/health', { ttlMs: 5_000 });
      reg.unlock('/financial', { ttlMs: 10_000 });
      expect(reg.size()).toBe(2);
      env.advance(5_001);
      expect(locked).toEqual(['/health']);
      expect(reg.isUnlocked('/financial')).toBe(true);
      env.advance(5_000);
      expect(locked).toEqual(['/health', '/financial']);
      expect(reg.size()).toBe(0);
    });
  });

  describe('lockAll (shutdown integration)', () => {
    it('locks every in-flight persona + returns the count', () => {
      const locked: string[] = [];
      const env = mockEnv();
      const reg = new AutoLockRegistry({
        lockFn: (p) => locked.push(p),
        nowMsFn: env.nowMsFn,
        setTimerFn: env.setTimerFn,
        clearTimerFn: env.clearTimerFn,
      });
      reg.unlock('/health');
      reg.unlock('/financial');
      reg.unlock('/citizen');
      expect(reg.lockAll()).toBe(3);
      // Explicit-lock does NOT invoke lockFn (caller already locked them).
      expect(locked).toEqual([]);
      expect(reg.size()).toBe(0);
      expect(env.pendingTimers()).toBe(0);
    });
  });

  describe('lockFn throwing', () => {
    it('is swallowed + emits lock_fn_threw event', () => {
      const events: AutoLockEvent[] = [];
      const env = mockEnv();
      const reg = new AutoLockRegistry({
        lockFn: () => {
          throw new Error('gatekeeper refused');
        },
        nowMsFn: env.nowMsFn,
        setTimerFn: env.setTimerFn,
        clearTimerFn: env.clearTimerFn,
        onEvent: (e) => events.push(e),
      });
      reg.unlock('/health', { ttlMs: 1000 });
      env.advance(1001);
      // The persona is STILL removed from the registry even though lockFn threw.
      expect(reg.isUnlocked('/health')).toBe(false);
      const threwEvent = events.find((e) => e.kind === 'lock_fn_threw');
      expect(threwEvent).toMatchObject({ kind: 'lock_fn_threw', persona: '/health' });
    });
  });

  describe('events', () => {
    it('fires unlock → touch → lock_timeout OR lock_explicit in order', () => {
      const events: AutoLockEvent[] = [];
      const env = mockEnv();
      const reg = new AutoLockRegistry({
        lockFn: () => undefined,
        nowMsFn: env.nowMsFn,
        setTimerFn: env.setTimerFn,
        clearTimerFn: env.clearTimerFn,
        onEvent: (e) => events.push(e),
      });
      reg.unlock('/health', { ttlMs: 1000 });
      reg.touch('/health', { ttlMs: 1000 });
      reg.lock('/health');
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(['unlock', 'unlock', 'touch', 'lock_explicit']);
      // touch internally re-unlocks (emits unlock + touch). This is the
      // observable contract.
    });
  });

  describe('constants + validation', () => {
    it('DEFAULT_AUTO_LOCK_TTL_MS = 15 min', () => {
      expect(DEFAULT_AUTO_LOCK_TTL_MS).toBe(15 * 60 * 1000);
    });
    it('rejects missing lockFn', () => {
      expect(() =>
        // @ts-expect-error — deliberate missing required field
        new AutoLockRegistry({}),
      ).toThrow(/lockFn is required/);
    });
    it('rejects non-positive defaultTtlMs', () => {
      expect(() =>
        new AutoLockRegistry({ lockFn: () => undefined, defaultTtlMs: 0 }),
      ).toThrow(/defaultTtlMs must be > 0/);
      expect(() =>
        new AutoLockRegistry({ lockFn: () => undefined, defaultTtlMs: NaN }),
      ).toThrow(/defaultTtlMs must be > 0/);
    });
    it('rejects empty persona name', () => {
      const reg = new AutoLockRegistry({ lockFn: () => undefined });
      expect(() => reg.unlock('')).toThrow(/persona is required/);
    });
    it('rejects non-positive ttlMs', () => {
      const reg = new AutoLockRegistry({ lockFn: () => undefined });
      expect(() => reg.unlock('/health', { ttlMs: 0 })).toThrow(/ttlMs must be > 0/);
    });
  });

  describe('deadline + isUnlocked', () => {
    it('deadline returns ms-since-epoch of the pending lock', () => {
      const env = mockEnv();
      const reg = new AutoLockRegistry({
        lockFn: () => undefined,
        nowMsFn: env.nowMsFn,
        setTimerFn: env.setTimerFn,
        clearTimerFn: env.clearTimerFn,
      });
      reg.unlock('/health', { ttlMs: 5000 });
      expect(reg.deadline('/health')).toBe(env.nowMsFn() + 5000);
      expect(reg.deadline('/never-unlocked')).toBeNull();
    });
  });
});
