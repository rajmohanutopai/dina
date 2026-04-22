/**
 * Task 4.44 — MsgBox reconnect policy tests.
 */

import {
  ReconnectPolicy,
  MSGBOX_RECONNECT_MAX_DELAY_MS,
  MSGBOX_RECONNECT_BASE_DELAY_MS,
  MSGBOX_RECONNECT_BACKOFF_FACTOR,
  type ReconnectEvent,
} from '../src/msgbox/reconnect_policy';

describe('ReconnectPolicy (task 4.44)', () => {
  describe('exponential schedule with 30s cap', () => {
    it('attempt 0 → base delay (1000 ms)', () => {
      const p = new ReconnectPolicy();
      expect(p.nextDelayMs()).toBe(1_000);
    });

    it('doubles each attempt up to the cap', () => {
      const p = new ReconnectPolicy();
      const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
      for (const want of expected) {
        expect(p.nextDelayMs()).toBe(want);
        p.recordFailure();
      }
    });

    it('cap sticks at 30s for attempts 5+', () => {
      const p = new ReconnectPolicy();
      for (let i = 0; i < 5; i++) p.recordFailure();
      expect(p.currentAttempt()).toBe(5);
      for (let i = 0; i < 10; i++) {
        expect(p.nextDelayMs()).toBeLessThanOrEqual(MSGBOX_RECONNECT_MAX_DELAY_MS);
        p.recordFailure();
      }
    });
  });

  describe('constants', () => {
    it('MSGBOX_RECONNECT_MAX_DELAY_MS = 30_000 (tighter than net-node default)', () => {
      expect(MSGBOX_RECONNECT_MAX_DELAY_MS).toBe(30_000);
    });
    it('MSGBOX_RECONNECT_BASE_DELAY_MS = 1_000', () => {
      expect(MSGBOX_RECONNECT_BASE_DELAY_MS).toBe(1_000);
    });
    it('MSGBOX_RECONNECT_BACKOFF_FACTOR = 2', () => {
      expect(MSGBOX_RECONNECT_BACKOFF_FACTOR).toBe(2);
    });
  });

  describe('recordFailure / recordSuccess', () => {
    it('recordFailure increments attempt + returns the delay for the NEXT retry', () => {
      const p = new ReconnectPolicy();
      const d0 = p.recordFailure();
      expect(d0).toBe(1_000); // delay BEFORE this call reflects attempt=0
      expect(p.currentAttempt()).toBe(1);
      const d1 = p.recordFailure();
      expect(d1).toBe(2_000);
      expect(p.currentAttempt()).toBe(2);
    });

    it('recordSuccess resets attempt to 0', () => {
      const p = new ReconnectPolicy();
      p.recordFailure();
      p.recordFailure();
      p.recordFailure();
      expect(p.currentAttempt()).toBe(3);
      p.recordSuccess();
      expect(p.currentAttempt()).toBe(0);
      // Next delay after success is back to base.
      expect(p.nextDelayMs()).toBe(1_000);
    });

    it('recordSuccess on a fresh policy is a no-op (no underflow)', () => {
      const p = new ReconnectPolicy();
      p.recordSuccess();
      expect(p.currentAttempt()).toBe(0);
      expect(p.nextDelayMs()).toBe(1_000);
    });
  });

  describe('jitter (opt-in)', () => {
    it('zero-jitter default → deterministic delay', () => {
      const p1 = new ReconnectPolicy();
      const p2 = new ReconnectPolicy();
      for (let i = 0; i < 5; i++) {
        expect(p1.nextDelayMs()).toBe(p2.nextDelayMs());
        p1.recordFailure();
        p2.recordFailure();
      }
    });

    it('non-zero jitter with deterministic random yields bounded variance', () => {
      // With random=0.5 (midpoint), jitter=0.1 yields no change
      // (1 + (0.5 - 0.5) × 2 × 0.1 = 1.0). Different random values
      // spread the delay within [delay*(1 - jitter), delay*(1 + jitter)].
      const base = new ReconnectPolicy({ jitter: 0, random: () => 0.5 });
      const jittered = new ReconnectPolicy({ jitter: 0.1, random: () => 0.5 });
      expect(jittered.nextDelayMs()).toBe(base.nextDelayMs());

      // Max jitter (random=1) pushes to upper bound.
      const jitteredHigh = new ReconnectPolicy({ jitter: 0.1, random: () => 1 });
      expect(jitteredHigh.nextDelayMs()).toBeGreaterThanOrEqual(base.nextDelayMs());
    });

    it('jitter is still clamped to the cap', () => {
      const p = new ReconnectPolicy({ jitter: 0.5, random: () => 1 });
      // Walk up to attempts past the cap.
      for (let i = 0; i < 10; i++) p.recordFailure();
      // Even with +50% jitter, the delay must not exceed the cap.
      expect(p.nextDelayMs()).toBeLessThanOrEqual(MSGBOX_RECONNECT_MAX_DELAY_MS);
    });
  });

  describe('custom overrides', () => {
    it('baseDelayMs + maxDelayMs + backoffFactor all honored', () => {
      const p = new ReconnectPolicy({
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        backoffFactor: 3,
      });
      // Schedule: 500, 1500, 4500, 5000 (capped), 5000, ...
      expect(p.nextDelayMs()).toBe(500);
      p.recordFailure();
      expect(p.nextDelayMs()).toBe(1_500);
      p.recordFailure();
      expect(p.nextDelayMs()).toBe(4_500);
      p.recordFailure();
      expect(p.nextDelayMs()).toBe(5_000); // capped
    });
  });

  describe('onEvent hook', () => {
    it('fires on every recordFailure + recordSuccess', () => {
      const events: ReconnectEvent[] = [];
      const p = new ReconnectPolicy({ onEvent: (e) => events.push(e) });
      p.recordFailure(); // attempt goes 0 → 1
      p.recordFailure(); // 1 → 2
      p.recordSuccess(); // 2 → 0
      expect(events).toEqual([
        { kind: 'failure', attempt: 1, nextDelayMs: 1_000 },
        { kind: 'failure', attempt: 2, nextDelayMs: 2_000 },
        { kind: 'success', attemptsUsed: 2 },
      ]);
    });
  });

  describe('nextDelayMs does not mutate state', () => {
    it('calling nextDelayMs() twice returns the same value', () => {
      const p = new ReconnectPolicy();
      const a = p.nextDelayMs();
      const b = p.nextDelayMs();
      expect(a).toBe(b);
      expect(p.currentAttempt()).toBe(0);
    });
  });
});
