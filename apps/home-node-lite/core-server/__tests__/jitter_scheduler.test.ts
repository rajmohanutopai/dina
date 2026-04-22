/**
 * jitter_scheduler tests.
 */

import {
  JitterSchedulerError,
  decorrelatedJitter,
  equalJitter,
  fullJitter,
  type DecorrelatedJitterInput,
  type JitterOptions,
} from '../src/brain/jitter_scheduler';

function opts(overrides: Partial<JitterOptions> = {}): JitterOptions {
  return { baseMs: 100, maxCapMs: 1000, ...overrides };
}

describe('fullJitter — input validation', () => {
  it.each([
    ['negative attempt', -1, opts()],
    ['fraction attempt', 1.5, opts()],
    ['zero baseMs', 0, opts({ baseMs: 0 })],
    ['neg baseMs', 0, opts({ baseMs: -1 })],
    ['cap below base', 0, opts({ baseMs: 200, maxCapMs: 100 })],
    ['NaN factor', 0, opts({ factor: Number.NaN })],
    ['zero factor', 0, opts({ factor: 0 })],
  ] as const)('rejects %s', (_l, attempt, o) => {
    expect(() => fullJitter(attempt, o)).toThrow(JitterSchedulerError);
  });
});

describe('fullJitter — math', () => {
  it('rng=0 → delay=0', () => {
    expect(fullJitter(0, opts({ rng: () => 0 }))).toBe(0);
  });

  it('rng=0.9999 at attempt 0 → delay ≈ baseMs', () => {
    const d = fullJitter(0, opts({ rng: () => 0.9999 }));
    // base = 100, ceiling = min(1000, 100*2^0) = 100 → delay <= 99
    expect(d).toBeLessThan(100);
    expect(d).toBeGreaterThanOrEqual(0);
  });

  it('exponential growth until cap', () => {
    const rng = () => 0.5;
    // attempt 0: ceiling = 100; attempt 3: 100*8 = 800; attempt 5: capped at 1000.
    expect(fullJitter(0, opts({ rng }))).toBeLessThan(100);
    expect(fullJitter(3, opts({ rng }))).toBeLessThan(800);
    expect(fullJitter(10, opts({ rng }))).toBeLessThan(1000);
  });

  it('custom factor changes growth rate', () => {
    const rng = () => 0.9999;
    // factor=3, attempt=2 → 100*9 = 900
    const d = fullJitter(2, opts({ factor: 3, rng }));
    expect(d).toBeLessThan(900);
    expect(d).toBeGreaterThanOrEqual(800);
  });

  it('deterministic under fixed rng', () => {
    let i = 0;
    const seq = [0.1, 0.2, 0.3];
    const rng = () => seq[i++ % seq.length]!;
    expect(fullJitter(0, opts({ rng }))).toBe(fullJitter(0, opts({ rng: () => 0.1 })));
  });
});

describe('equalJitter — math', () => {
  it('rng=0 → delay=ceiling/2', () => {
    const d = equalJitter(0, opts({ rng: () => 0 }));
    expect(d).toBe(50);
  });

  it('rng=0.9999 → delay ≈ ceiling', () => {
    const d = equalJitter(0, opts({ rng: () => 0.9999 }));
    expect(d).toBeLessThan(100);
    expect(d).toBeGreaterThanOrEqual(50);
  });

  it('always at least ceiling/2 (floor)', () => {
    const d = equalJitter(0, opts({ rng: () => 0.5 }));
    expect(d).toBeGreaterThanOrEqual(50);
  });

  it('capped delay when attempt high', () => {
    const d = equalJitter(100, opts({ rng: () => 0 }));
    expect(d).toBe(500); // cap 1000 / 2
  });
});

describe('decorrelatedJitter — input validation', () => {
  it.each([
    ['null input', null],
    ['missing baseMs', { prevMs: 100, maxCapMs: 1000 }],
    ['zero baseMs', { prevMs: 100, baseMs: 0, maxCapMs: 1000 }],
    ['maxCap below base', { prevMs: 100, baseMs: 200, maxCapMs: 100 }],
    ['zero prevMs', { prevMs: 0, baseMs: 100, maxCapMs: 1000 }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() =>
      decorrelatedJitter(bad as unknown as DecorrelatedJitterInput),
    ).toThrow(JitterSchedulerError);
  });
});

describe('decorrelatedJitter — math', () => {
  it('first call with prev=base → result in [base, base*3)', () => {
    const d = decorrelatedJitter({
      prevMs: 100,
      baseMs: 100,
      maxCapMs: 1000,
      rng: () => 0.5,
    });
    // random in [100, 300) → floor gives 100 + floor(0.5 * 200) = 200.
    expect(d).toBe(200);
  });

  it('result capped by maxCapMs', () => {
    const d = decorrelatedJitter({
      prevMs: 10_000,
      baseMs: 100,
      maxCapMs: 500,
      rng: () => 0.5,
    });
    // upper = min(500, 30_000) = 500; range = 400; delay = 100 + 200 = 300.
    expect(d).toBeLessThanOrEqual(500);
    expect(d).toBe(300);
  });

  it('grows across successive attempts', () => {
    let prev = 100;
    const rng = () => 0.9; // always pick near the top
    const values: number[] = [];
    for (let i = 0; i < 5; i++) {
      const d = decorrelatedJitter({
        prevMs: prev, baseMs: 100, maxCapMs: 10_000, rng,
      });
      values.push(d);
      prev = d;
    }
    // Ensure monotonic non-decreasing approach to cap.
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    }
  });

  it('zero-range case (base = cap) returns base', () => {
    const d = decorrelatedJitter({
      prevMs: 100, baseMs: 100, maxCapMs: 100, rng: () => 0.5,
    });
    expect(d).toBe(100);
  });
});

describe('jitter distributions — statistical sanity', () => {
  it('fullJitter has wider spread than equalJitter for same cap', () => {
    let fullMin = Infinity;
    let fullMax = -Infinity;
    let equalMin = Infinity;
    let equalMax = -Infinity;
    for (let i = 0; i < 100; i++) {
      const r = i / 100;
      const rng = () => r;
      fullMin = Math.min(fullMin, fullJitter(5, opts({ rng })));
      fullMax = Math.max(fullMax, fullJitter(5, opts({ rng })));
      equalMin = Math.min(equalMin, equalJitter(5, opts({ rng })));
      equalMax = Math.max(equalMax, equalJitter(5, opts({ rng })));
    }
    const fullSpread = fullMax - fullMin;
    const equalSpread = equalMax - equalMin;
    expect(fullSpread).toBeGreaterThan(equalSpread);
  });
});
