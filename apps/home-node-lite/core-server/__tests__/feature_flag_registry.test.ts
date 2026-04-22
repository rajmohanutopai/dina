/**
 * feature_flag_registry tests.
 */

import {
  FeatureFlagError,
  FeatureFlagRegistry,
  type FeatureFlagEvent,
  type RegisterFlagInput,
} from '../src/brain/feature_flag_registry';

class Clock {
  private t = 0;
  now = (): number => this.t;
  advance(ms: number): void { this.t += ms; }
  set(ms: number): void { this.t = ms; }
}

describe('FeatureFlagRegistry — register', () => {
  it.each([
    ['null input', null],
    ['missing name', { enabled: true }],
    ['empty name', { name: '', enabled: true }],
    ['invalid chars in name', { name: 'bad name', enabled: true }],
    ['starts with digit', { name: '1abc', enabled: true }],
    ['enabled not boolean', { name: 'ok', enabled: 'yes' as unknown as boolean }],
    ['bad defaultEnabled', { name: 'ok', enabled: true, defaultEnabled: 1 as unknown as boolean }],
    ['zero expiresAtMs', { name: 'ok', enabled: true, expiresAtMs: 0 }],
    ['negative expiresAtMs', { name: 'ok', enabled: true, expiresAtMs: -1 }],
    ['NaN expiresAtMs', { name: 'ok', enabled: true, expiresAtMs: Number.NaN }],
    ['non-string variant', { name: 'ok', enabled: true, variant: 42 as unknown as string }],
  ] as const)('rejects %s', (_l, bad) => {
    const r = new FeatureFlagRegistry();
    expect(() =>
      r.register(bad as unknown as RegisterFlagInput),
    ).toThrow(FeatureFlagError);
  });

  it('register returns the created flag', () => {
    const clock = new Clock();
    clock.set(1000);
    const r = new FeatureFlagRegistry({ nowMsFn: clock.now });
    const flag = r.register({ name: 'new-search', enabled: true });
    expect(flag.name).toBe('new-search');
    expect(flag.enabled).toBe(true);
    expect(flag.defaultEnabled).toBe(false);
    expect(flag.expiresAtMs).toBeNull();
    expect(flag.variant).toBeNull();
    expect(flag.description).toBeNull();
    expect(flag.updatedAtMs).toBe(1000);
  });

  it('duplicate register throws', () => {
    const r = new FeatureFlagRegistry();
    r.register({ name: 'x', enabled: true });
    expect(() => r.register({ name: 'x', enabled: false })).toThrow(/duplicate/);
  });

  it('register emits registered event', () => {
    const events: FeatureFlagEvent[] = [];
    const r = new FeatureFlagRegistry({ onEvent: (e) => events.push(e) });
    r.register({ name: 'x', enabled: true });
    expect(events[0]!.kind).toBe('registered');
  });

  it('name pattern enforced', () => {
    const r = new FeatureFlagRegistry();
    expect(() => r.register({ name: 'a'.repeat(64), enabled: true })).not.toThrow();
    expect(() => r.register({ name: 'b'.repeat(65), enabled: true })).toThrow(/invalid_name/);
  });
});

describe('FeatureFlagRegistry — isEnabled', () => {
  it('enabled flag → true', () => {
    const r = new FeatureFlagRegistry();
    r.register({ name: 'x', enabled: true });
    expect(r.isEnabled('x')).toBe(true);
  });

  it('disabled flag → false', () => {
    const r = new FeatureFlagRegistry();
    r.register({ name: 'x', enabled: false });
    expect(r.isEnabled('x')).toBe(false);
  });

  it('unregistered flag → defaultEnabled argument', () => {
    const r = new FeatureFlagRegistry();
    expect(r.isEnabled('missing')).toBe(false);
    expect(r.isEnabled('missing', true)).toBe(true);
  });
});

describe('FeatureFlagRegistry — update', () => {
  it('updates enabled state', () => {
    const r = new FeatureFlagRegistry();
    r.register({ name: 'x', enabled: false });
    r.update('x', { enabled: true });
    expect(r.isEnabled('x')).toBe(true);
  });

  it('updates variant + description', () => {
    const r = new FeatureFlagRegistry();
    r.register({ name: 'x', enabled: true });
    const out = r.update('x', { variant: 'B', description: 'test' });
    expect(out.variant).toBe('B');
    expect(out.description).toBe('test');
  });

  it('null clears variant/description/expiry', () => {
    const clock = new Clock();
    clock.set(100);
    const r = new FeatureFlagRegistry({ nowMsFn: clock.now });
    r.register({ name: 'x', enabled: true, variant: 'A', description: 'd', expiresAtMs: 10_000 });
    const out = r.update('x', { variant: null, description: null, expiresAtMs: null });
    expect(out.variant).toBeNull();
    expect(out.description).toBeNull();
    expect(out.expiresAtMs).toBeNull();
  });

  it('unknown flag → unknown error', () => {
    const r = new FeatureFlagRegistry();
    expect(() => r.update('missing', { enabled: true })).toThrow(/unknown/);
  });

  it('invalid name → invalid_name', () => {
    const r = new FeatureFlagRegistry();
    expect(() => r.update('bad name', { enabled: true })).toThrow(/invalid_name/);
  });

  it('zero expiresAtMs → invalid_expiry', () => {
    const r = new FeatureFlagRegistry();
    r.register({ name: 'x', enabled: true });
    expect(() => r.update('x', { expiresAtMs: 0 })).toThrow(/invalid_expiry/);
  });

  it('update emits updated event', () => {
    const events: FeatureFlagEvent[] = [];
    const r = new FeatureFlagRegistry({ onEvent: (e) => events.push(e) });
    r.register({ name: 'x', enabled: true });
    r.update('x', { enabled: false });
    expect(events.map((e) => e.kind)).toEqual(['registered', 'updated']);
  });
});

describe('FeatureFlagRegistry — expiry', () => {
  it('flag expires at expiresAtMs → reverts to defaultEnabled', () => {
    const clock = new Clock();
    clock.set(100);
    const r = new FeatureFlagRegistry({ nowMsFn: clock.now });
    r.register({
      name: 'x', enabled: true, defaultEnabled: false, expiresAtMs: 1000,
    });
    expect(r.isEnabled('x')).toBe(true);
    clock.set(1500);
    expect(r.isEnabled('x')).toBe(false);
  });

  it('expiry emits expired event ONCE', () => {
    const events: FeatureFlagEvent[] = [];
    const clock = new Clock();
    clock.set(100);
    const r = new FeatureFlagRegistry({
      nowMsFn: clock.now, onEvent: (e) => events.push(e),
    });
    r.register({ name: 'x', enabled: true, expiresAtMs: 1000 });
    clock.set(1500);
    r.isEnabled('x'); // triggers sweep
    r.isEnabled('x'); // should NOT re-fire
    const exp = events.filter((e) => e.kind === 'expired');
    expect(exp).toHaveLength(1);
  });

  it('expired flag reverts to defaultEnabled=true when set', () => {
    const clock = new Clock();
    clock.set(100);
    const r = new FeatureFlagRegistry({ nowMsFn: clock.now });
    r.register({
      name: 'x', enabled: false, defaultEnabled: true, expiresAtMs: 1000,
    });
    clock.set(1500);
    expect(r.isEnabled('x')).toBe(true);
  });

  it('no expiry → flag stays until explicitly removed', () => {
    const clock = new Clock();
    const r = new FeatureFlagRegistry({ nowMsFn: clock.now });
    r.register({ name: 'x', enabled: true });
    clock.advance(10_000_000);
    expect(r.isEnabled('x')).toBe(true);
  });
});

describe('FeatureFlagRegistry — variants', () => {
  it('isVariant matches when enabled + variant matches', () => {
    const r = new FeatureFlagRegistry();
    r.register({ name: 'exp', enabled: true, variant: 'B' });
    expect(r.isVariant('exp', 'B')).toBe(true);
    expect(r.isVariant('exp', 'A')).toBe(false);
  });

  it('isVariant false when flag disabled', () => {
    const r = new FeatureFlagRegistry();
    r.register({ name: 'exp', enabled: false, variant: 'B' });
    expect(r.isVariant('exp', 'B')).toBe(false);
  });

  it('isVariant false when not registered', () => {
    const r = new FeatureFlagRegistry();
    expect(r.isVariant('missing', 'B')).toBe(false);
  });

  it('isVariant false on empty variant arg', () => {
    const r = new FeatureFlagRegistry();
    r.register({ name: 'exp', enabled: true, variant: 'B' });
    expect(r.isVariant('exp', '')).toBe(false);
  });
});

describe('FeatureFlagRegistry — get / list / remove / clear', () => {
  it('get returns a copy; mutation does not affect store', () => {
    const r = new FeatureFlagRegistry();
    r.register({ name: 'x', enabled: true });
    const got = r.get('x')!;
    got.enabled = false;
    expect(r.isEnabled('x')).toBe(true);
  });

  it('get unknown → null', () => {
    const r = new FeatureFlagRegistry();
    expect(r.get('missing')).toBeNull();
  });

  it('list sorted by name, copies', () => {
    const r = new FeatureFlagRegistry();
    r.register({ name: 'banana', enabled: true });
    r.register({ name: 'apple', enabled: true });
    const out = r.list();
    expect(out.map((f) => f.name)).toEqual(['apple', 'banana']);
  });

  it('remove returns true once, false after', () => {
    const r = new FeatureFlagRegistry();
    r.register({ name: 'x', enabled: true });
    expect(r.remove('x')).toBe(true);
    expect(r.remove('x')).toBe(false);
    expect(r.get('x')).toBeNull();
  });

  it('remove emits removed event', () => {
    const events: FeatureFlagEvent[] = [];
    const r = new FeatureFlagRegistry({ onEvent: (e) => events.push(e) });
    r.register({ name: 'x', enabled: true });
    r.remove('x');
    expect(events[events.length - 1]!.kind).toBe('removed');
  });

  it('clear empties registry', () => {
    const r = new FeatureFlagRegistry();
    r.register({ name: 'a', enabled: true });
    r.register({ name: 'b', enabled: true });
    r.clear();
    expect(r.size()).toBe(0);
  });
});
