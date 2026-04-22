/**
 * Task 5.13 — ConfigReloader tests.
 */

import {
  ConfigReloader,
  DEFAULT_RELOAD_INTERVAL_MS,
  defaultEquals,
  type ConfigReloaderEvent,
} from '../src/brain/config_reloader';

interface TestConfig {
  version: number;
  personas: string[];
  flags?: Record<string, boolean>;
}

function cfg(version: number, personas: string[] = ['general']): TestConfig {
  return { version, personas };
}

describe('defaultEquals (task 5.13)', () => {
  it('deep-equal objects are equal', () => {
    expect(defaultEquals(cfg(1), cfg(1))).toBe(true);
  });

  it('different values → not equal', () => {
    expect(defaultEquals(cfg(1), cfg(2))).toBe(false);
  });

  it('key-order independent', () => {
    const a = { x: 1, y: 2 };
    const b = { y: 2, x: 1 };
    expect(defaultEquals(a, b)).toBe(true);
  });

  it('nested key-order independent', () => {
    const a = { x: { nested: { a: 1, b: 2 } } };
    const b = { x: { nested: { b: 2, a: 1 } } };
    expect(defaultEquals(a, b)).toBe(true);
  });

  it('array order matters', () => {
    expect(defaultEquals([1, 2, 3], [3, 2, 1])).toBe(false);
  });

  it('undefined values are dropped (matches JSON.stringify)', () => {
    expect(defaultEquals({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });
});

describe('ConfigReloader (task 5.13)', () => {
  describe('construction', () => {
    it('throws without name', () => {
      expect(
        () =>
          new ConfigReloader({
            name: '',
            fetchFn: async () => cfg(1),
          }),
      ).toThrow(/name/);
    });

    it('throws without fetchFn', () => {
      expect(
        () =>
          new ConfigReloader({
            name: 'x',
            fetchFn: undefined as unknown as () => Promise<TestConfig>,
          }),
      ).toThrow(/fetchFn/);
    });

    it('DEFAULT_RELOAD_INTERVAL_MS is 60s', () => {
      expect(DEFAULT_RELOAD_INTERVAL_MS).toBe(60_000);
    });
  });

  describe('pre-start state', () => {
    it('getCurrent() returns null + isReady() false before any fetch', () => {
      const r = new ConfigReloader<TestConfig>({
        name: 'c',
        fetchFn: async () => cfg(1),
      });
      expect(r.getCurrent()).toBeNull();
      expect(r.isReady()).toBe(false);
      expect(r.isRunning()).toBe(false);
    });
  });

  describe('reloadNow — out-of-band', () => {
    it('first reload populates + fires first_load', async () => {
      const events: ConfigReloaderEvent<TestConfig>[] = [];
      const r = new ConfigReloader<TestConfig>({
        name: 'c',
        fetchFn: async () => cfg(1, ['general', 'work']),
        onEvent: (e) => events.push(e),
      });
      await r.reloadNow();
      expect(r.getCurrent()).toEqual(cfg(1, ['general', 'work']));
      expect(r.isReady()).toBe(true);
      expect(events.some((e) => e.kind === 'first_load')).toBe(true);
    });

    it('subsequent reload with same data → unchanged event', async () => {
      const events: ConfigReloaderEvent<TestConfig>[] = [];
      const r = new ConfigReloader<TestConfig>({
        name: 'c',
        fetchFn: async () => cfg(1),
        onEvent: (e) => events.push(e),
      });
      await r.reloadNow();
      await r.reloadNow();
      expect(events.filter((e) => e.kind === 'unchanged')).toHaveLength(1);
      expect(events.filter((e) => e.kind === 'first_load')).toHaveLength(1);
    });

    it('change fires changed with previous + next', async () => {
      const events: ConfigReloaderEvent<TestConfig>[] = [];
      let v = 1;
      const r = new ConfigReloader<TestConfig>({
        name: 'c',
        fetchFn: async () => cfg(v),
        onEvent: (e) => events.push(e),
      });
      await r.reloadNow(); // v=1 → first_load
      v = 2;
      await r.reloadNow(); // v=2 → changed
      const changed = events.find((e) => e.kind === 'changed') as Extract<
        ConfigReloaderEvent<TestConfig>,
        { kind: 'changed' }
      >;
      expect(changed.previous.version).toBe(1);
      expect(changed.next.version).toBe(2);
    });

    it('fetch error fires fetch_failed + leaves cache intact', async () => {
      const events: ConfigReloaderEvent<TestConfig>[] = [];
      let shouldFail = false;
      const r = new ConfigReloader<TestConfig>({
        name: 'c',
        fetchFn: async () => {
          if (shouldFail) throw new Error('core offline');
          return cfg(1);
        },
        onEvent: (e) => events.push(e),
      });
      await r.reloadNow();
      shouldFail = true;
      await expect(r.reloadNow()).rejects.toThrow(/core offline/);
      expect(r.getCurrent()).toEqual(cfg(1)); // cache preserved
      expect(r.isReady()).toBe(false); // signals stale
      expect(events.some((e) => e.kind === 'fetch_failed')).toBe(true);
    });

    it('key-order change does NOT trigger changed event', async () => {
      const events: ConfigReloaderEvent<TestConfig>[] = [];
      let layout: 'a' | 'b' = 'a';
      const r = new ConfigReloader<TestConfig>({
        name: 'c',
        fetchFn: async () => {
          if (layout === 'a') return { version: 1, personas: ['x'] };
          return { personas: ['x'], version: 1 } as TestConfig;
        },
        onEvent: (e) => events.push(e),
      });
      await r.reloadNow();
      layout = 'b';
      await r.reloadNow();
      expect(events.some((e) => e.kind === 'changed')).toBe(false);
      expect(events.filter((e) => e.kind === 'unchanged')).toHaveLength(1);
    });
  });

  describe('custom equalsFn', () => {
    it('custom equalsFn respected', async () => {
      const events: ConfigReloaderEvent<TestConfig>[] = [];
      let v = 1;
      const r = new ConfigReloader<TestConfig>({
        name: 'c',
        fetchFn: async () => cfg(v, [`p-${Math.random()}`]),
        equalsFn: (a, b) => a.version === b.version, // ignore personas
        onEvent: (e) => events.push(e),
      });
      await r.reloadNow();
      await r.reloadNow();
      // Same version even though personas differ → unchanged.
      expect(events.some((e) => e.kind === 'unchanged')).toBe(true);
      v = 2;
      await r.reloadNow();
      expect(events.some((e) => e.kind === 'changed')).toBe(true);
    });
  });

  describe('ManagedLoop integration', () => {
    it('satisfies the ManagedLoop shape (start/stop/isRunning)', () => {
      const r = new ConfigReloader<TestConfig>({
        name: 'c',
        fetchFn: async () => cfg(1),
      });
      expect(typeof r.start).toBe('function');
      expect(typeof r.stop).toBe('function');
      expect(typeof r.isRunning).toBe('function');
    });

    it('start() then stop() round-trip cleans up', async () => {
      const r = new ConfigReloader<TestConfig>({
        name: 'c',
        fetchFn: async () => cfg(1),
      });
      r.start();
      expect(r.isRunning()).toBe(true);
      await r.stop();
      expect(r.isRunning()).toBe(false);
    });
  });

  describe('event pass-through', () => {
    it('SupervisedLoop events propagate through onEvent', async () => {
      const events: ConfigReloaderEvent<TestConfig>[] = [];
      const r = new ConfigReloader<TestConfig>({
        name: 'c',
        fetchFn: async () => cfg(1),
        onEvent: (e) => events.push(e),
      });
      r.start();
      // started event fires immediately.
      expect(events.some((e) => e.kind === 'started')).toBe(true);
      await r.stop();
      expect(events.some((e) => e.kind === 'stopped')).toBe(true);
    });
  });
});
