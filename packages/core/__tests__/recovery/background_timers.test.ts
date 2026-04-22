/**
 * T3.4 — Background timer lifecycle: fire when active, stop on background,
 * resume on foreground.
 *
 * Source: mobile-specific
 */

import {
  registerTimer,
  startTimers,
  stopTimers,
  resumeTimers,
  areTimersActive,
  getRegisteredTimers,
  clearTimers,
} from '../../src/background/timers';

describe('Background Timer Lifecycle (Mobile-Specific)', () => {
  beforeEach(() => clearTimers());
  afterEach(() => clearTimers());

  describe('registerTimer', () => {
    it('registers a named timer', () => {
      const id = registerTimer({ name: 'staging_sweep', intervalMs: 300_000, handler: () => {} });
      expect(id).toMatch(/^timer-/);
    });

    it('returns unique timer IDs', () => {
      const id1 = registerTimer({ name: 'a', intervalMs: 1000, handler: () => {} });
      const id2 = registerTimer({ name: 'b', intervalMs: 1000, handler: () => {} });
      expect(id1).not.toBe(id2);
    });
  });

  describe('startTimers', () => {
    it('starts all registered timers', () => {
      registerTimer({ name: 'test', intervalMs: 100_000, handler: () => {} });
      startTimers();
      expect(areTimersActive()).toBe(true);
    });
  });

  describe('stopTimers (app backgrounded)', () => {
    it('stops all timers', () => {
      registerTimer({ name: 'test', intervalMs: 100_000, handler: () => {} });
      startTimers();
      stopTimers();
      expect(areTimersActive()).toBe(false);
    });
  });

  describe('resumeTimers (app foregrounded)', () => {
    it('resumes all timers', () => {
      registerTimer({ name: 'test', intervalMs: 100_000, handler: () => {} });
      resumeTimers();
      expect(areTimersActive()).toBe(true);
    });
  });

  describe('getRegisteredTimers', () => {
    it('lists all registered timer names', () => {
      registerTimer({ name: 'staging_sweep', intervalMs: 300_000, handler: () => {} });
      registerTimer({ name: 'outbox_retry', intervalMs: 30_000, handler: () => {} });
      const names = getRegisteredTimers();
      expect(names).toContain('staging_sweep');
      expect(names).toContain('outbox_retry');
    });

    it('returns empty when no timers registered', () => {
      expect(getRegisteredTimers()).toEqual([]);
    });
  });

  describe('expected timers from server goroutines', () => {
    const expectedTimers = [
      { name: 'trace_purge', interval: '10m' },
      { name: 'outbox_retry', interval: '30s' },
      { name: 'replay_cache_cleanup', interval: '5m' },
      { name: 'staging_sweep', interval: '5m' },
      { name: 'pairing_code_purge', interval: '1m' },
      { name: 'watchdog', interval: '30s' },
    ];

    for (const { name, interval } of expectedTimers) {
      it(`"${name}" timer (${interval}) registerable`, () => {
        const id = registerTimer({ name, intervalMs: 1000, handler: () => {} });
        expect(id).toMatch(/^timer-/);
        expect(getRegisteredTimers()).toContain(name);
      });
    }
  });
});
