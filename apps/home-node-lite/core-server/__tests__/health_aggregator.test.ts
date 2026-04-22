/**
 * health_aggregator tests.
 */

import {
  HealthAggregatorError,
  aggregateHealth,
  compareStatus,
  isWorseStatus,
  type HealthCheck,
  type HealthStatus,
} from '../src/brain/health_aggregator';

function check(overrides: Partial<HealthCheck> = {}): HealthCheck {
  return { name: 'ok', status: 'up', ...overrides };
}

describe('aggregateHealth — input validation', () => {
  it.each([
    ['non-array', 'x'],
    ['empty array', []],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() =>
      aggregateHealth(bad as unknown as HealthCheck[]),
    ).toThrow(HealthAggregatorError);
  });

  it.each([
    ['null check', [null as unknown as HealthCheck]],
    ['missing name', [{ status: 'up' } as unknown as HealthCheck]],
    ['empty name', [{ name: '', status: 'up' } as HealthCheck]],
    ['bad status', [{ name: 'x', status: 'bogus' } as unknown as HealthCheck]],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() => aggregateHealth(bad)).toThrow(/invalid_check/);
  });

  it('duplicate names → duplicate_name', () => {
    expect(() =>
      aggregateHealth([
        check({ name: 'dup' }),
        check({ name: 'dup', status: 'down' }),
      ]),
    ).toThrow(/duplicate_name/);
  });
});

describe('aggregateHealth — status resolution (worst wins)', () => {
  it('all up → up', () => {
    const r = aggregateHealth([
      check({ name: 'a' }),
      check({ name: 'b' }),
      check({ name: 'c' }),
    ]);
    expect(r.status).toBe('up');
    expect(r.counts).toEqual({ up: 3, degraded: 0, down: 0 });
    expect(r.failingChecks).toEqual([]);
    expect(r.summary).toContain('all 3 checks up');
  });

  it('one degraded → degraded', () => {
    const r = aggregateHealth([
      check({ name: 'a' }),
      check({ name: 'b', status: 'degraded', detail: 'slow' }),
      check({ name: 'c' }),
    ]);
    expect(r.status).toBe('degraded');
    expect(r.failingChecks).toEqual(['b']);
    expect(r.summary).toContain('1/3 checks failing');
  });

  it('one down → down', () => {
    const r = aggregateHealth([
      check({ name: 'a' }),
      check({ name: 'b', status: 'down' }),
      check({ name: 'c', status: 'degraded' }),
    ]);
    expect(r.status).toBe('down');
    expect(r.counts).toEqual({ up: 1, degraded: 1, down: 1 });
    expect(r.failingChecks).toEqual(['b', 'c']);
  });

  it('multiple down still reports down', () => {
    const r = aggregateHealth([
      check({ status: 'down', name: 'a' }),
      check({ status: 'down', name: 'b' }),
    ]);
    expect(r.status).toBe('down');
    expect(r.counts.down).toBe(2);
  });
});

describe('aggregateHealth — criticality', () => {
  it('non-critical down demoted to degraded by default', () => {
    const r = aggregateHealth([
      check({ name: 'core' }),
      check({ name: 'llm', status: 'down', critical: false }),
    ]);
    expect(r.status).toBe('degraded');
  });

  it('non-critical down NOT demoted when demoteNonCritical=false', () => {
    const r = aggregateHealth(
      [
        check({ name: 'core' }),
        check({ name: 'llm', status: 'down', critical: false }),
      ],
      { demoteNonCritical: false },
    );
    expect(r.status).toBe('down');
  });

  it('critical down not demoted (default true still triggers down)', () => {
    const r = aggregateHealth([
      check({ name: 'core', status: 'down' }), // critical defaults true
    ]);
    expect(r.status).toBe('down');
  });

  it('non-critical degraded → degraded', () => {
    const r = aggregateHealth([
      check({ name: 'a', status: 'degraded', critical: false }),
    ]);
    expect(r.status).toBe('degraded');
  });
});

describe('aggregateHealth — echoed fields', () => {
  it('checks array preserves input order + detail + latency', () => {
    const r = aggregateHealth([
      check({ name: 'a', latencyMs: 12 }),
      check({ name: 'b', detail: 'hi', latencyMs: 300 }),
    ]);
    expect(r.checks.map((c) => c.name)).toEqual(['a', 'b']);
    expect(r.checks[0]!.latencyMs).toBe(12);
    expect(r.checks[1]!.detail).toBe('hi');
  });

  it('optional fields omitted in output when absent', () => {
    const r = aggregateHealth([check({ name: 'a' })]);
    expect(r.checks[0]).not.toHaveProperty('detail');
    expect(r.checks[0]).not.toHaveProperty('critical');
    expect(r.checks[0]).not.toHaveProperty('latencyMs');
  });
});

describe('aggregateHealth — summary rendering', () => {
  it('up summary lists count', () => {
    const r = aggregateHealth([check({ name: 'a' }), check({ name: 'b' })]);
    expect(r.summary).toBe('all 2 checks up');
  });

  it('down summary lists failing names', () => {
    const r = aggregateHealth([
      check({ name: 'a' }),
      check({ name: 'b', status: 'down' }),
      check({ name: 'c', status: 'degraded' }),
    ]);
    expect(r.summary).toBe('2/3 checks failing: b, c');
  });
});

describe('isWorseStatus / compareStatus', () => {
  it.each([
    ['up', 'up', false],
    ['up', 'degraded', false],
    ['degraded', 'up', true],
    ['down', 'degraded', true],
    ['down', 'up', true],
    ['degraded', 'down', false],
  ] as const)('isWorseStatus(%s, %s) = %s', (a, b, expected) => {
    expect(isWorseStatus(a as HealthStatus, b as HealthStatus)).toBe(expected);
  });

  it('compareStatus is sort-compatible', () => {
    const arr: HealthStatus[] = ['down', 'up', 'degraded'];
    arr.sort(compareStatus);
    expect(arr).toEqual(['up', 'degraded', 'down']);
  });
});

describe('aggregateHealth — counts accuracy', () => {
  it('counts accurate across mixed statuses', () => {
    const r = aggregateHealth([
      check({ name: 'a' }),
      check({ name: 'b' }),
      check({ name: 'c', status: 'degraded' }),
      check({ name: 'd', status: 'down' }),
    ]);
    expect(r.counts).toEqual({ up: 2, degraded: 1, down: 1 });
  });

  it('counts record RAW status (not demoted)', () => {
    // Even though non-critical down is demoted for the aggregate status,
    // counts should reflect the actual reported status.
    const r = aggregateHealth([
      check({ name: 'a' }),
      check({ name: 'b', status: 'down', critical: false }),
    ]);
    expect(r.status).toBe('degraded');
    expect(r.counts.down).toBe(1); // NOT moved to degraded
  });
});
