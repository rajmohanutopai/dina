/**
 * Task 5.5 — HealthChecker tests.
 */

import {
  DEFAULT_CHECK_TIMEOUT_MS,
  HealthChecker,
  type CheckDefinition,
  type HealthCheckerEvent,
} from '../src/brain/health_checker';

function okCheck(name: string, kind: CheckDefinition['kind'] = 'both'): CheckDefinition {
  return {
    name,
    kind,
    run: async () => ({ ok: true, detail: `${name} is healthy` }),
  };
}

function failCheck(name: string, detail: string, kind: CheckDefinition['kind'] = 'both'): CheckDefinition {
  return {
    name,
    kind,
    run: async () => ({ ok: false, detail }),
  };
}

describe('HealthChecker (task 5.5)', () => {
  describe('register', () => {
    it('registers a check + reports size', () => {
      const hc = new HealthChecker();
      hc.register(okCheck('core'));
      expect(hc.size()).toBe(1);
      expect(hc.names()).toEqual(['core']);
    });

    it('rejects duplicate name', () => {
      const hc = new HealthChecker();
      hc.register(okCheck('core'));
      expect(() => hc.register(okCheck('core'))).toThrow(/already/);
    });

    it.each([
      ['missing name', { name: '', kind: 'both', run: async () => ({ ok: true }) }],
      ['missing run', { name: 'x', kind: 'both', run: undefined as unknown as CheckDefinition['run'] }],
      ['invalid kind', { name: 'x', kind: 'invalid' as unknown as CheckDefinition['kind'], run: async () => ({ ok: true }) }],
    ])('rejects %s', (_label, check) => {
      const hc = new HealthChecker();
      expect(() => hc.register(check as CheckDefinition)).toThrow();
    });

    it('unregister removes + returns true', () => {
      const hc = new HealthChecker();
      hc.register(okCheck('core'));
      expect(hc.unregister('core')).toBe(true);
      expect(hc.unregister('core')).toBe(false);
    });

    it('DEFAULT_CHECK_TIMEOUT_MS is 2s', () => {
      expect(DEFAULT_CHECK_TIMEOUT_MS).toBe(2_000);
    });
  });

  describe('liveness', () => {
    it('no checks → status ok, empty checks array', async () => {
      const hc = new HealthChecker();
      const r = await hc.liveness();
      expect(r.status).toBe('ok');
      expect(r.checks).toEqual([]);
    });

    it('only "liveness" + "both" checks contribute', async () => {
      const hc = new HealthChecker();
      hc.register(okCheck('live-only', 'liveness'));
      hc.register(okCheck('ready-only', 'readiness'));
      hc.register(okCheck('both-check', 'both'));
      const r = await hc.liveness();
      const names = r.checks.map((c) => c.name);
      expect(names).toEqual(['both-check', 'live-only']);
    });

    it('all ok → status ok', async () => {
      const hc = new HealthChecker();
      hc.register(okCheck('a'));
      hc.register(okCheck('b'));
      const r = await hc.liveness();
      expect(r.status).toBe('ok');
    });

    it('any fail → status degraded', async () => {
      const hc = new HealthChecker();
      hc.register(okCheck('good'));
      hc.register(failCheck('bad', 'out of disk'));
      const r = await hc.liveness();
      expect(r.status).toBe('degraded');
      const bad = r.checks.find((c) => c.name === 'bad');
      expect(bad?.status).toBe('fail');
      expect(bad?.detail).toBe('out of disk');
    });
  });

  describe('readiness', () => {
    it('only "readiness" + "both" contribute', async () => {
      const hc = new HealthChecker();
      hc.register(okCheck('live-only', 'liveness'));
      hc.register(okCheck('ready-only', 'readiness'));
      hc.register(okCheck('both-check', 'both'));
      const r = await hc.readiness();
      expect(r.checks.map((c) => c.name)).toEqual(['both-check', 'ready-only']);
    });
  });

  describe('check timeout', () => {
    it('hanging check reported as timeout', async () => {
      const hc = new HealthChecker({ defaultTimeoutMs: 20 });
      hc.register({
        name: 'slow',
        kind: 'both',
        run: () => new Promise(() => {}), // never resolves
      });
      const r = await hc.readiness();
      const slow = r.checks.find((c) => c.name === 'slow');
      expect(slow?.status).toBe('timeout');
      expect(slow?.detail).toMatch(/timed out/);
      expect(r.status).toBe('degraded');
    });

    it('per-check timeout override', async () => {
      const hc = new HealthChecker({ defaultTimeoutMs: 100 });
      hc.register({
        name: 'very-slow',
        kind: 'both',
        timeoutMs: 10,
        run: () => new Promise(() => {}),
      });
      const r = await hc.readiness();
      const detail = r.checks[0]!.detail;
      expect(detail).toMatch(/10ms/);
    });

    it('timeout aborts the check via AbortSignal', async () => {
      let aborted = false;
      const hc = new HealthChecker({ defaultTimeoutMs: 20 });
      hc.register({
        name: 'abort-aware',
        kind: 'both',
        run: (signal) =>
          new Promise((resolve) => {
            signal?.addEventListener('abort', () => {
              aborted = true;
              // Resolve so the underlying work can clean up.
              resolve({ ok: false, detail: 'aborted' });
            });
          }),
      });
      await hc.readiness();
      expect(aborted).toBe(true);
    });
  });

  describe('check throw', () => {
    it('thrown error reported as error status', async () => {
      const hc = new HealthChecker();
      hc.register({
        name: 'crashy',
        kind: 'both',
        run: async () => {
          throw new Error('database unreachable');
        },
      });
      const r = await hc.readiness();
      const c = r.checks[0]!;
      expect(c.status).toBe('error');
      expect(c.detail).toMatch(/database unreachable/);
      expect(r.status).toBe('degraded');
    });
  });

  describe('parallel execution', () => {
    it('checks run in parallel, not serial', async () => {
      const hc = new HealthChecker();
      const startTimes: number[] = [];
      for (let i = 0; i < 3; i++) {
        hc.register({
          name: `parallel-${i}`,
          kind: 'both',
          run: async () => {
            startTimes.push(Date.now());
            await new Promise((r) => setTimeout(r, 20));
            return { ok: true };
          },
        });
      }
      await hc.readiness();
      expect(startTimes).toHaveLength(3);
      // All three started within ~5ms (parallel) not ~20ms apart (serial).
      expect(startTimes[2]! - startTimes[0]!).toBeLessThan(10);
    });
  });

  describe('events', () => {
    it('emits probe_started + check_ok + probe_finished for happy path', async () => {
      const events: HealthCheckerEvent[] = [];
      const hc = new HealthChecker({ onEvent: (e) => events.push(e) });
      hc.register(okCheck('core'));
      await hc.readiness();
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(['probe_started', 'check_ok', 'probe_finished']);
    });

    it('emits check_failed on fail', async () => {
      const events: HealthCheckerEvent[] = [];
      const hc = new HealthChecker({ onEvent: (e) => events.push(e) });
      hc.register(failCheck('bad', 'x'));
      await hc.readiness();
      expect(events.some((e) => e.kind === 'check_failed')).toBe(true);
    });

    it('emits check_threw on throw', async () => {
      const events: HealthCheckerEvent[] = [];
      const hc = new HealthChecker({ onEvent: (e) => events.push(e) });
      hc.register({
        name: 'crashy',
        kind: 'both',
        run: async () => {
          throw new Error('x');
        },
      });
      await hc.readiness();
      expect(events.some((e) => e.kind === 'check_threw')).toBe(true);
    });

    it('emits check_timeout on timeout', async () => {
      const events: HealthCheckerEvent[] = [];
      const hc = new HealthChecker({
        defaultTimeoutMs: 20,
        onEvent: (e) => events.push(e),
      });
      hc.register({
        name: 'slow',
        kind: 'both',
        run: () => new Promise(() => {}),
      });
      await hc.readiness();
      expect(events.some((e) => e.kind === 'check_timeout')).toBe(true);
    });
  });

  describe('stable ordering', () => {
    it('checks sorted by name in output', async () => {
      const hc = new HealthChecker();
      hc.register(okCheck('zeta'));
      hc.register(okCheck('alpha'));
      hc.register(okCheck('mu'));
      const r = await hc.readiness();
      expect(r.checks.map((c) => c.name)).toEqual(['alpha', 'mu', 'zeta']);
    });
  });

  describe('durationMs reporting', () => {
    it('every check has a numeric duration', async () => {
      const hc = new HealthChecker();
      hc.register(okCheck('core'));
      hc.register(failCheck('bad', 'x'));
      const r = await hc.readiness();
      for (const c of r.checks) {
        expect(c.durationMs).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('realistic wiring', () => {
    it('liveness is lighter than readiness when tagged appropriately', async () => {
      const events: HealthCheckerEvent[] = [];
      const hc = new HealthChecker({ onEvent: (e) => events.push(e) });
      hc.register(okCheck('process-up', 'liveness'));
      hc.register(okCheck('core-reachable', 'readiness'));
      hc.register(okCheck('pds-reachable', 'readiness'));
      hc.register(okCheck('identity-loaded', 'both'));
      const live = await hc.liveness();
      const ready = await hc.readiness();
      expect(live.checks.map((c) => c.name)).toEqual(['identity-loaded', 'process-up']);
      expect(ready.checks.map((c) => c.name)).toEqual([
        'core-reachable',
        'identity-loaded',
        'pds-reachable',
      ]);
    });
  });
});
