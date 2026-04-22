/**
 * backoff_tracker tests.
 */

import {
  BackoffTracker,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_FACTOR,
  DEFAULT_BACKOFF_MAX_CAP_MS,
} from '../src/brain/backoff_tracker';

class Clock {
  private t = 0;
  now = (): number => this.t;
  advance(ms: number): void { this.t += ms; }
  set(ms: number): void { this.t = ms; }
}

describe('BackoffTracker — construction', () => {
  it.each([
    ['zero base', { baseMs: 0 }],
    ['neg base', { baseMs: -1 }],
    ['NaN base', { baseMs: Number.NaN }],
    ['zero factor', { factor: 0 }],
    ['cap below base', { baseMs: 1000, maxCapMs: 500 }],
    ['zero cooldown', { onCooldownMs: 0 }],
    ['neg cooldown', { onCooldownMs: -1 }],
    ['fraction maxAttempts', { maxAttempts: 1.5 }],
    ['zero maxAttempts', { maxAttempts: 0 }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() => new BackoffTracker(bad)).toThrow();
  });

  it('defaults documented', () => {
    expect(DEFAULT_BACKOFF_BASE_MS).toBe(500);
    expect(DEFAULT_BACKOFF_FACTOR).toBe(2);
    expect(DEFAULT_BACKOFF_MAX_CAP_MS).toBe(60_000);
  });
});

describe('BackoffTracker — input validation', () => {
  const b = new BackoffTracker();
  it('recordFailure rejects empty key', () => {
    expect(() => b.recordFailure('')).toThrow(/key/);
  });
  it('recordSuccess rejects empty key', () => {
    expect(() => b.recordSuccess('')).toThrow(/key/);
  });
});

describe('BackoffTracker — exponential growth', () => {
  it('nextDelayMs is 0 for fresh key', () => {
    const b = new BackoffTracker();
    expect(b.nextDelayMs('k')).toBe(0);
  });

  it('first failure → base delay', () => {
    const b = new BackoffTracker({ baseMs: 100, factor: 2 });
    expect(b.recordFailure('k')).toBe(100);
  });

  it('second failure → base*factor', () => {
    const b = new BackoffTracker({ baseMs: 100, factor: 2 });
    b.recordFailure('k');
    expect(b.recordFailure('k')).toBe(200);
  });

  it('third failure → base*factor^2', () => {
    const b = new BackoffTracker({ baseMs: 100, factor: 2 });
    b.recordFailure('k');
    b.recordFailure('k');
    expect(b.recordFailure('k')).toBe(400);
  });

  it('caps at maxCapMs', () => {
    const b = new BackoffTracker({ baseMs: 100, factor: 10, maxCapMs: 500 });
    b.recordFailure('k');
    b.recordFailure('k');
    // 100 * 10^2 = 10000 → cap 500.
    expect(b.recordFailure('k')).toBe(500);
  });

  it('custom factor', () => {
    const b = new BackoffTracker({ baseMs: 100, factor: 3 });
    b.recordFailure('k');
    expect(b.recordFailure('k')).toBe(300);
  });
});

describe('BackoffTracker — per-key isolation', () => {
  it('different keys tracked separately', () => {
    const b = new BackoffTracker({ baseMs: 100, factor: 2 });
    b.recordFailure('a');
    b.recordFailure('a');
    b.recordFailure('b');
    expect(b.failureCount('a')).toBe(2);
    expect(b.failureCount('b')).toBe(1);
  });

  it('recordSuccess clears only that key', () => {
    const b = new BackoffTracker();
    b.recordFailure('a');
    b.recordFailure('b');
    b.recordSuccess('a');
    expect(b.failureCount('a')).toBe(0);
    expect(b.failureCount('b')).toBe(1);
  });

  it('recordSuccess returns true only when entry existed', () => {
    const b = new BackoffTracker();
    expect(b.recordSuccess('missing')).toBe(false);
    b.recordFailure('x');
    expect(b.recordSuccess('x')).toBe(true);
  });
});

describe('BackoffTracker — cooldown', () => {
  it('after onCooldownMs of silence, failure count resets', () => {
    const clock = new Clock();
    const b = new BackoffTracker({
      baseMs: 100, factor: 2, onCooldownMs: 1000, nowMsFn: clock.now,
    });
    clock.set(0);
    b.recordFailure('k');
    b.recordFailure('k');
    clock.advance(1500);
    // Next failure should be treated as the first (count reset).
    expect(b.recordFailure('k')).toBe(100);
    expect(b.failureCount('k')).toBe(1);
  });

  it('within cooldown window, counter keeps growing', () => {
    const clock = new Clock();
    const b = new BackoffTracker({
      baseMs: 100, onCooldownMs: 1000, nowMsFn: clock.now,
    });
    b.recordFailure('k');
    clock.advance(500);
    expect(b.recordFailure('k')).toBe(200);
  });

  it('no cooldown by default — failures accumulate', () => {
    const clock = new Clock();
    const b = new BackoffTracker({ baseMs: 100, nowMsFn: clock.now });
    b.recordFailure('k');
    clock.advance(10_000_000);
    expect(b.recordFailure('k')).toBe(200);
  });
});

describe('BackoffTracker — maxAttempts circuit-breaker', () => {
  it('after maxAttempts failures → nextDelayMs returns null', () => {
    const b = new BackoffTracker({ baseMs: 100, maxAttempts: 3 });
    b.recordFailure('k');
    b.recordFailure('k');
    b.recordFailure('k');
    expect(b.recordFailure('k')).toBeNull();
  });

  it('nextDelayMs null on already-maxed key', () => {
    const b = new BackoffTracker({ baseMs: 100, maxAttempts: 2 });
    b.recordFailure('k');
    b.recordFailure('k');
    b.recordFailure('k');
    expect(b.nextDelayMs('k')).toBeNull();
  });

  it('recordSuccess clears circuit-broken state', () => {
    const b = new BackoffTracker({ baseMs: 100, maxAttempts: 2 });
    b.recordFailure('k');
    b.recordFailure('k');
    b.recordFailure('k');
    b.recordSuccess('k');
    expect(b.nextDelayMs('k')).toBe(0);
  });

  it('null maxAttempts → no cap', () => {
    const b = new BackoffTracker({ baseMs: 100, maxAttempts: null });
    for (let i = 0; i < 20; i++) b.recordFailure('k');
    expect(b.nextDelayMs('k')).not.toBeNull();
  });
});

describe('BackoffTracker — jitter', () => {
  it('jitter=true produces delay in [0, computed)', () => {
    const rngs = [0, 0.25, 0.75, 0.99];
    for (const r of rngs) {
      const b = new BackoffTracker({
        baseMs: 100, factor: 1, jitter: true, rng: () => r,
      });
      const d = b.recordFailure('k');
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(100);
    }
  });

  it('jitter=false returns deterministic delay', () => {
    const b = new BackoffTracker({ baseMs: 100, factor: 2, jitter: false });
    expect(b.recordFailure('k')).toBe(100);
    expect(b.recordFailure('k')).toBe(200);
  });
});

describe('BackoffTracker — snapshot + clear', () => {
  it('snapshot reports current state', () => {
    const clock = new Clock();
    clock.set(5000);
    const b = new BackoffTracker({ baseMs: 100, nowMsFn: clock.now });
    b.recordFailure('k');
    b.recordFailure('k');
    const snap = b.snapshot('k');
    expect(snap.key).toBe('k');
    expect(snap.failures).toBe(2);
    expect(snap.nextDelayMs).toBe(200);
    expect(snap.lastFailureAtMs).toBe(5000);
  });

  it('snapshot of fresh key returns zeros', () => {
    const b = new BackoffTracker();
    expect(b.snapshot('fresh')).toEqual({
      key: 'fresh',
      failures: 0,
      nextDelayMs: 0,
      lastFailureAtMs: null,
    });
  });

  it('clear drops every key', () => {
    const b = new BackoffTracker();
    b.recordFailure('a');
    b.recordFailure('b');
    expect(b.size()).toBe(2);
    b.clear();
    expect(b.size()).toBe(0);
  });
});
