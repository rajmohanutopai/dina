/**
 * rate_limiter tests.
 */

import { RateLimiter, type RateLimiterOptions } from '../src/brain/rate_limiter';

class Clock {
  private t = 0;
  now = (): number => this.t;
  set(ms: number): void { this.t = ms; }
  advance(ms: number): void { this.t += ms; }
}

function rig(overrides: Partial<RateLimiterOptions> = {}): { limiter: RateLimiter; clock: Clock } {
  const clock = new Clock();
  const limiter = new RateLimiter({
    capacity: 10,
    refillPerSec: 1, // 1 token per second
    nowMsFn: clock.now,
    ...overrides,
  });
  return { limiter, clock };
}

describe('RateLimiter — construction', () => {
  it.each([
    ['null opts', null],
    ['zero capacity', { capacity: 0, refillPerSec: 1 }],
    ['negative capacity', { capacity: -1, refillPerSec: 1 }],
    ['NaN capacity', { capacity: NaN, refillPerSec: 1 }],
    ['zero refillPerSec', { capacity: 10, refillPerSec: 0 }],
    ['negative refillPerSec', { capacity: 10, refillPerSec: -1 }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(
      () =>
        new RateLimiter(
          bad as unknown as RateLimiterOptions,
        ),
    ).toThrow();
  });

  it('rejects initialTokens out of range', () => {
    expect(() =>
      new RateLimiter({ capacity: 10, refillPerSec: 1, initialTokens: -1 }),
    ).toThrow(/initialTokens/);
    expect(() =>
      new RateLimiter({ capacity: 10, refillPerSec: 1, initialTokens: 11 }),
    ).toThrow(/initialTokens/);
  });

  it('new limiter has zero buckets', () => {
    const { limiter } = rig();
    expect(limiter.size()).toBe(0);
  });
});

describe('RateLimiter.consume — happy path', () => {
  it('first call is allowed with full bucket', () => {
    const { limiter } = rig();
    const r = limiter.consume('k');
    expect(r.allowed).toBe(true);
    expect(r.tokensRemaining).toBe(9);
    expect(r.retryAfterMs).toBe(0);
  });

  it('cost parameter reduces multiple tokens', () => {
    const { limiter } = rig();
    const r = limiter.consume('k', 3);
    expect(r.allowed).toBe(true);
    expect(r.tokensRemaining).toBe(7);
  });

  it('exhausting the bucket denies the next call', () => {
    const { limiter } = rig();
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume('k').allowed).toBe(true);
    }
    const r = limiter.consume('k');
    expect(r.allowed).toBe(false);
    expect(r.tokensRemaining).toBe(0);
    // 1 token at 1/sec = 1000ms retry.
    expect(r.retryAfterMs).toBe(1000);
  });

  it('per-key isolation — separate buckets for separate keys', () => {
    const { limiter } = rig();
    for (let i = 0; i < 10; i++) limiter.consume('a');
    expect(limiter.consume('a').allowed).toBe(false);
    expect(limiter.consume('b').allowed).toBe(true);
  });
});

describe('RateLimiter.consume — refill math', () => {
  it('refill after 1s allows 1 more call', () => {
    const { limiter, clock } = rig();
    for (let i = 0; i < 10; i++) limiter.consume('k');
    expect(limiter.consume('k').allowed).toBe(false);
    clock.advance(1000);
    const r = limiter.consume('k');
    expect(r.allowed).toBe(true);
    expect(r.tokensRemaining).toBe(0);
  });

  it('refill caps at capacity (no overflow)', () => {
    const { limiter, clock } = rig();
    limiter.consume('k'); // 1 → 9 tokens
    clock.advance(60_000); // 60s → 60 tokens refilled, capped at 10.
    // Consume 10 after full refill.
    for (let i = 0; i < 10; i++) expect(limiter.consume('k').allowed).toBe(true);
    expect(limiter.consume('k').allowed).toBe(false);
  });

  it('fractional refillPerSec', () => {
    const { limiter, clock } = rig({ capacity: 2, refillPerSec: 0.5 });
    limiter.consume('k');
    limiter.consume('k');
    expect(limiter.consume('k').allowed).toBe(false);
    clock.advance(1000); // 0.5 tokens — not enough for cost=1.
    expect(limiter.consume('k').allowed).toBe(false);
    clock.advance(1000); // total 1.0 token.
    expect(limiter.consume('k').allowed).toBe(true);
  });

  it('burst capacity ≠ sustained rate', () => {
    const { limiter, clock } = rig({ capacity: 5, refillPerSec: 1 });
    // Burst of 5 up-front.
    for (let i = 0; i < 5; i++) expect(limiter.consume('k').allowed).toBe(true);
    expect(limiter.consume('k').allowed).toBe(false);
    // Sustained: wait 5s → 5 more.
    clock.advance(5_000);
    for (let i = 0; i < 5; i++) expect(limiter.consume('k').allowed).toBe(true);
  });
});

describe('RateLimiter.consume — input validation', () => {
  it('empty key throws', () => {
    const { limiter } = rig();
    expect(() => limiter.consume('')).toThrow(/key/);
  });

  it('non-positive cost throws', () => {
    const { limiter } = rig();
    expect(() => limiter.consume('k', 0)).toThrow(/cost/);
    expect(() => limiter.consume('k', -1)).toThrow(/cost/);
  });

  it('cost > capacity → permanently denied with Infinity retry', () => {
    const { limiter } = rig({ capacity: 10 });
    const r = limiter.consume('k', 20);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('RateLimiter.consume — retryAfterMs accuracy', () => {
  it('retryAfterMs counts down as time passes', () => {
    const { limiter, clock } = rig();
    for (let i = 0; i < 10; i++) limiter.consume('k');
    const r1 = limiter.consume('k');
    expect(r1.retryAfterMs).toBe(1000);
    clock.advance(300);
    const r2 = limiter.consume('k');
    // After 300ms passed, need 700ms more (with 0 tokens → 1 token wait).
    expect(r2.retryAfterMs).toBe(700);
  });

  it('retryAfterMs scales with cost > available', () => {
    const { limiter } = rig({ capacity: 10, refillPerSec: 1 });
    for (let i = 0; i < 9; i++) limiter.consume('k'); // 1 token left.
    const r = limiter.consume('k', 5); // need 4 more at 1/s.
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(4000);
  });
});

describe('RateLimiter.peek', () => {
  it('peek does not consume', () => {
    const { limiter } = rig();
    limiter.peek('k');
    limiter.peek('k');
    limiter.peek('k');
    expect(limiter.consume('k', 10).allowed).toBe(true);
  });

  it('peek on unseen key reports initialTokens', () => {
    const { limiter } = rig({ capacity: 10, initialTokens: 5 });
    const r = limiter.peek('fresh');
    expect(r.tokensRemaining).toBe(5);
  });

  it('peek includes refill time', () => {
    const { limiter, clock } = rig();
    for (let i = 0; i < 10; i++) limiter.consume('k');
    clock.advance(500);
    const r = limiter.peek('k');
    expect(r.tokensRemaining).toBeCloseTo(0.5, 4);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(500);
  });
});

describe('RateLimiter.reset + clear', () => {
  it('reset removes one key', () => {
    const { limiter } = rig();
    limiter.consume('a');
    limiter.consume('b');
    expect(limiter.reset('a')).toBe(true);
    expect(limiter.reset('a')).toBe(false);
    expect(limiter.size()).toBe(1);
  });

  it('reset unknown key returns false', () => {
    const { limiter } = rig();
    expect(limiter.reset('nope')).toBe(false);
  });

  it('clear empties everything', () => {
    const { limiter } = rig();
    for (let i = 0; i < 5; i++) limiter.consume(`k${i}`);
    expect(limiter.size()).toBe(5);
    limiter.clear();
    expect(limiter.size()).toBe(0);
  });
});

describe('RateLimiter.snapshot', () => {
  it('snapshot reflects active buckets', () => {
    const { limiter } = rig();
    limiter.consume('a', 3);
    limiter.consume('b', 1);
    const snap = limiter.snapshot().sort((x, y) => x.key.localeCompare(y.key));
    expect(snap.map((s) => s.key)).toEqual(['a', 'b']);
    expect(snap[0]!.capacity).toBe(10);
    expect(snap[0]!.tokens).toBe(7);
    expect(snap[1]!.tokens).toBe(9);
  });

  it('empty snapshot for new limiter', () => {
    const { limiter } = rig();
    expect(limiter.snapshot()).toEqual([]);
  });
});

describe('RateLimiter — initialTokens', () => {
  it('initialTokens sets starting level for new keys', () => {
    const { limiter } = rig({ capacity: 10, initialTokens: 3 });
    const r = limiter.consume('k', 4);
    expect(r.allowed).toBe(false);
    expect(r.tokensRemaining).toBe(3);
  });
});
