/**
 * nudge_dedupe tests.
 */

import {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_ENGAGEMENT_MS,
  DEFAULT_TTL_SOLICITED_MS,
  NudgeDedupe,
  type NudgeCheckInput,
  type NudgeDedupeEvent,
} from '../src/brain/nudge_dedupe';

class Clock {
  private t = 0;
  now = (): number => this.t;
  advance(ms: number): void { this.t += ms; }
  set(ms: number): void { this.t = ms; }
}

function input(overrides: Partial<NudgeCheckInput> = {}): NudgeCheckInput {
  return {
    persona: 'general',
    topic: 'meeting',
    priority: 'engagement',
    ...overrides,
  };
}

describe('NudgeDedupe — construction', () => {
  it('defaults are documented', () => {
    expect(DEFAULT_TTL_SOLICITED_MS).toBe(10 * 60 * 1000);
    expect(DEFAULT_TTL_ENGAGEMENT_MS).toBe(4 * 60 * 60 * 1000);
    expect(DEFAULT_MAX_ENTRIES).toBe(10_000);
  });

  it.each([
    ['zero ttl', { ttlByPriority: { engagement: 0 } }],
    ['negative ttl', { ttlByPriority: { solicited: -1 } }],
    ['zero maxEntries', { maxEntries: 0 }],
    ['fraction maxEntries', { maxEntries: 1.5 }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() => new NudgeDedupe(bad)).toThrow();
  });
});

describe('NudgeDedupe.check — input validation', () => {
  const d = new NudgeDedupe();
  it.each([
    ['null input', null],
    ['empty persona', { ...input(), persona: '' }],
    ['empty topic', { ...input(), topic: '' }],
    ['non-string subject', { ...input(), subject: 42 as unknown as string }],
    ['bogus priority', { ...input(), priority: 'bogus' as NudgeCheckInput['priority'] }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() =>
      d.check(bad as NudgeCheckInput),
    ).toThrow();
  });
});

describe('NudgeDedupe.check — first-time delivers', () => {
  it('first call → deliver', () => {
    const d = new NudgeDedupe();
    const r = d.check(input());
    expect(r.action).toBe('deliver');
  });

  it('fires recorded event for engagement + solicited', () => {
    const events: NudgeDedupeEvent[] = [];
    const d = new NudgeDedupe({ onEvent: (e) => events.push(e) });
    d.check(input({ priority: 'engagement' }));
    d.check(input({ topic: 'other', priority: 'solicited' }));
    expect(events.filter((e) => e.kind === 'recorded')).toHaveLength(2);
  });
});

describe('NudgeDedupe.check — suppression within TTL', () => {
  it('second call within TTL → suppress', () => {
    const clock = new Clock();
    clock.set(1000);
    const d = new NudgeDedupe({ nowMsFn: clock.now });
    d.check(input());
    clock.advance(60_000);
    const r = d.check(input());
    expect(r.action).toBe('suppress');
    if (r.action === 'suppress') {
      expect(r.reason).toBe('within_ttl');
      expect(r.firstSeenMs).toBe(1000);
    }
  });

  it('second call after TTL → delivers again', () => {
    const clock = new Clock();
    clock.set(1000);
    const d = new NudgeDedupe({
      nowMsFn: clock.now,
      ttlByPriority: { engagement: 60_000 },
    });
    d.check(input());
    clock.advance(61_000);
    expect(d.check(input()).action).toBe('deliver');
  });

  it('suppressed event fired on suppress', () => {
    const events: NudgeDedupeEvent[] = [];
    const clock = new Clock();
    const d = new NudgeDedupe({
      nowMsFn: clock.now, onEvent: (e) => events.push(e),
    });
    d.check(input());
    d.check(input());
    expect(events.some((e) => e.kind === 'suppressed')).toBe(true);
  });
});

describe('NudgeDedupe — key composition', () => {
  it('different persona → different key', () => {
    const d = new NudgeDedupe();
    d.check(input({ persona: 'general' }));
    expect(d.check(input({ persona: 'work' })).action).toBe('deliver');
  });

  it('different topic → different key', () => {
    const d = new NudgeDedupe();
    d.check(input({ topic: 'meeting' }));
    expect(d.check(input({ topic: 'review' })).action).toBe('deliver');
  });

  it('different subject → different key', () => {
    const d = new NudgeDedupe();
    d.check(input({ subject: 'alice' }));
    expect(d.check(input({ subject: 'bob' })).action).toBe('deliver');
  });

  it('absent subject treated as "self"', () => {
    const d = new NudgeDedupe();
    d.check(input()); // no subject
    expect(d.check(input({ subject: 'self' })).action).toBe('suppress');
  });

  it('case + whitespace normalized', () => {
    const d = new NudgeDedupe();
    d.check(input({ persona: 'General', topic: 'Meeting' }));
    expect(d.check(input({ persona: 'GENERAL ', topic: ' meeting' })).action).toBe('suppress');
  });

  it('static keyFor exposes canonical key', () => {
    expect(NudgeDedupe.keyFor({ persona: 'General', topic: 'Meeting' })).toBe(
      'general:meeting:self',
    );
  });
});

describe('NudgeDedupe — fiduciary bypass', () => {
  it('fiduciary always delivers, even repeated', () => {
    const d = new NudgeDedupe();
    expect(d.check(input({ priority: 'fiduciary' })).action).toBe('deliver');
    expect(d.check(input({ priority: 'fiduciary' })).action).toBe('deliver');
    expect(d.check(input({ priority: 'fiduciary' })).action).toBe('deliver');
  });

  it('fiduciary does NOT leave a ttl entry', () => {
    const d = new NudgeDedupe();
    d.check(input({ priority: 'fiduciary' }));
    expect(d.size()).toBe(0);
  });

  it('fiduciary_bypassed event fires', () => {
    const events: NudgeDedupeEvent[] = [];
    const d = new NudgeDedupe({ onEvent: (e) => events.push(e) });
    d.check(input({ priority: 'fiduciary' }));
    expect(events.some((e) => e.kind === 'fiduciary_bypassed')).toBe(true);
  });

  it('fiduciary does NOT reset an existing engagement/solicited entry', () => {
    const clock = new Clock();
    clock.set(1000);
    const d = new NudgeDedupe({ nowMsFn: clock.now });
    d.check(input({ priority: 'engagement' }));
    d.check(input({ priority: 'fiduciary' }));
    // Next engagement still suppresses.
    expect(d.check(input({ priority: 'engagement' })).action).toBe('suppress');
  });

  it('fiduciary with non-null TTL DOES record', () => {
    const d = new NudgeDedupe({
      ttlByPriority: { fiduciary: 10_000 },
    });
    d.check(input({ priority: 'fiduciary' }));
    expect(d.size()).toBe(1);
  });
});

describe('NudgeDedupe — per-priority TTL', () => {
  it('solicited uses shorter default TTL', () => {
    const clock = new Clock();
    clock.set(1000);
    const d = new NudgeDedupe({ nowMsFn: clock.now });
    d.check(input({ priority: 'solicited' }));
    // Solicited TTL = 10 min; advance 11 min → delivers again.
    clock.advance(11 * 60 * 1000);
    expect(d.check(input({ priority: 'solicited' })).action).toBe('deliver');
  });

  it('engagement uses 4h default TTL', () => {
    const clock = new Clock();
    clock.set(1000);
    const d = new NudgeDedupe({ nowMsFn: clock.now });
    d.check(input({ priority: 'engagement' }));
    clock.advance(3 * 60 * 60 * 1000); // 3h < 4h
    expect(d.check(input({ priority: 'engagement' })).action).toBe('suppress');
    clock.advance(2 * 60 * 60 * 1000); // total 5h > 4h
    expect(d.check(input({ priority: 'engagement' })).action).toBe('deliver');
  });

  it('override ttlByPriority applied', () => {
    const clock = new Clock();
    clock.set(1000);
    const d = new NudgeDedupe({
      nowMsFn: clock.now,
      ttlByPriority: { engagement: 5000 },
    });
    d.check(input());
    clock.advance(4999);
    expect(d.check(input()).action).toBe('suppress');
    clock.advance(2);
    expect(d.check(input()).action).toBe('deliver');
  });
});

describe('NudgeDedupe — forget + clear + size', () => {
  it('forget deletes a specific key', () => {
    const d = new NudgeDedupe();
    const first = d.check(input());
    d.forget(first.key);
    expect(d.check(input()).action).toBe('deliver');
  });

  it('forget returns true once, false after', () => {
    const d = new NudgeDedupe();
    const first = d.check(input());
    expect(d.forget(first.key)).toBe(true);
    expect(d.forget(first.key)).toBe(false);
  });

  it('clear empties the store', () => {
    const d = new NudgeDedupe();
    d.check(input({ topic: 'a' }));
    d.check(input({ topic: 'b' }));
    d.clear();
    expect(d.size()).toBe(0);
  });

  it('size sweeps expired', () => {
    const clock = new Clock();
    clock.set(1000);
    const d = new NudgeDedupe({
      nowMsFn: clock.now,
      ttlByPriority: { engagement: 5000 },
    });
    d.check(input());
    clock.advance(6000);
    expect(d.size()).toBe(0);
  });
});

describe('NudgeDedupe — capacity eviction', () => {
  it('over-capacity → oldest FIFO evicted', () => {
    const d = new NudgeDedupe({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      d.check(input({ topic: `t${i}` }));
    }
    expect(d.size()).toBe(3);
  });
});
