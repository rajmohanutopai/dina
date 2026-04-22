/**
 * Task 5.6 — ShutdownCoordinator tests.
 */

import {
  DEFAULT_OVERALL_DEADLINE_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  ShutdownCoordinator,
  type ShutdownEvent,
  type ShutdownStep,
} from '../src/brain/shutdown_coordinator';

function okStep(name: string, delayMs = 0): ShutdownStep {
  return {
    name,
    close: async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    },
  };
}

function failStep(name: string, msg = 'boom'): ShutdownStep {
  return {
    name,
    close: async () => {
      throw new Error(msg);
    },
  };
}

function hangStep(name: string): ShutdownStep {
  return {
    name,
    close: () => new Promise(() => {}),
  };
}

describe('ShutdownCoordinator (task 5.6)', () => {
  describe('register', () => {
    it('registers + reports size', () => {
      const co = new ShutdownCoordinator();
      co.register(okStep('a'));
      co.register(okStep('b'));
      expect(co.size()).toBe(2);
    });

    it('rejects duplicate name', () => {
      const co = new ShutdownCoordinator();
      co.register(okStep('a'));
      expect(() => co.register(okStep('a'))).toThrow(/already/);
    });

    it.each([
      ['missing name', { name: '', close: async () => {} }],
      ['missing close', { name: 'x', close: undefined as unknown as ShutdownStep['close'] }],
    ])('rejects %s', (_label, step) => {
      const co = new ShutdownCoordinator();
      expect(() => co.register(step as ShutdownStep)).toThrow();
    });

    it('throws register after run()', async () => {
      const co = new ShutdownCoordinator();
      await co.run();
      expect(() => co.register(okStep('late'))).toThrow(/after run/);
    });

    it('DEFAULT_OVERALL_DEADLINE_MS is 30s', () => {
      expect(DEFAULT_OVERALL_DEADLINE_MS).toBe(30_000);
    });

    it('DEFAULT_STEP_TIMEOUT_MS is 5s', () => {
      expect(DEFAULT_STEP_TIMEOUT_MS).toBe(5_000);
    });
  });

  describe('happy path', () => {
    it('runs every step in registration order + returns clean report', async () => {
      const executed: string[] = [];
      const co = new ShutdownCoordinator();
      co.register({
        name: 'stop-http',
        close: async () => {
          executed.push('stop-http');
        },
      });
      co.register({
        name: 'stop-loops',
        close: async () => {
          executed.push('stop-loops');
        },
      });
      co.register({
        name: 'flush-notify',
        close: async () => {
          executed.push('flush-notify');
        },
      });
      const report = await co.run();
      expect(executed).toEqual(['stop-http', 'stop-loops', 'flush-notify']);
      expect(report.status).toBe('clean');
      expect(report.steps).toHaveLength(3);
      expect(report.steps.every((s) => s.status === 'ok')).toBe(true);
      expect(report.deadlineExceeded).toBe(false);
    });

    it('zero steps → clean report with empty steps array', async () => {
      const co = new ShutdownCoordinator();
      const report = await co.run();
      expect(report.status).toBe('clean');
      expect(report.steps).toEqual([]);
    });

    it('duration recorded for each step', async () => {
      const co = new ShutdownCoordinator();
      co.register(okStep('fast', 5));
      co.register(okStep('slower', 20));
      const report = await co.run();
      expect(report.steps[0]!.durationMs).toBeLessThan(report.steps[1]!.durationMs);
    });
  });

  describe('failure handling', () => {
    it('step throw → status failed but shutdown continues', async () => {
      const executed: string[] = [];
      const co = new ShutdownCoordinator();
      co.register({
        name: 'ok-first',
        close: async () => {
          executed.push('ok-first');
        },
      });
      co.register(failStep('bad', 'oh no'));
      co.register({
        name: 'ok-last',
        close: async () => {
          executed.push('ok-last');
        },
      });
      const report = await co.run();
      expect(executed).toEqual(['ok-first', 'ok-last']);
      expect(report.status).toBe('degraded');
      const bad = report.steps.find((s) => s.name === 'bad');
      expect(bad?.status).toBe('failed');
      expect(bad?.error).toMatch(/oh no/);
    });

    it('multiple failures still finish', async () => {
      const co = new ShutdownCoordinator();
      co.register(failStep('a'));
      co.register(failStep('b'));
      co.register(okStep('c'));
      const report = await co.run();
      expect(report.steps).toHaveLength(3);
      expect(report.status).toBe('degraded');
    });
  });

  describe('per-step timeout', () => {
    it('hung step times out + shutdown continues', async () => {
      const co = new ShutdownCoordinator({ defaultStepTimeoutMs: 20 });
      co.register(hangStep('stuck'));
      co.register(okStep('fine'));
      const report = await co.run();
      const stuck = report.steps.find((s) => s.name === 'stuck');
      expect(stuck?.status).toBe('timeout');
      expect(stuck?.error).toMatch(/timed out/);
      const fine = report.steps.find((s) => s.name === 'fine');
      expect(fine?.status).toBe('ok');
    });

    it('per-step override honoured', async () => {
      const co = new ShutdownCoordinator({ defaultStepTimeoutMs: 1000 });
      co.register({
        name: 'tight',
        timeoutMs: 20,
        close: () => new Promise(() => {}),
      });
      const report = await co.run();
      expect(report.steps[0]!.error).toMatch(/20ms/);
    });
  });

  describe('overall deadline', () => {
    it('remaining steps skipped after deadline exceeded', async () => {
      // Step 1 actually takes 50ms (no timeout); overall deadline 30ms.
      // After step 1 completes, elapsed >= overallDeadline → step 2 skipped.
      const co = new ShutdownCoordinator({
        overallDeadlineMs: 30,
        defaultStepTimeoutMs: 500,
      });
      co.register(okStep('slow-but-valid', 50));
      co.register(okStep('would-run'));
      const report = await co.run();
      expect(report.deadlineExceeded).toBe(true);
      const skipped = report.steps.find((s) => s.name === 'would-run');
      expect(skipped?.status).toBe('skipped');
      expect(skipped?.error).toMatch(/deadline exceeded/);
    });

    it('step timeout capped by remaining budget', async () => {
      // overallDeadline=60ms, first step takes ~40ms, second step gets
      // the remaining ~20ms even though its own timeout is 1000ms.
      const co = new ShutdownCoordinator({
        overallDeadlineMs: 60,
        defaultStepTimeoutMs: 1000,
      });
      co.register(okStep('a', 40));
      co.register({
        name: 'b',
        timeoutMs: 1000,
        close: () => new Promise(() => {}),
      });
      const report = await co.run();
      const b = report.steps.find((s) => s.name === 'b');
      expect(b?.status).toBe('timeout');
      // Step b's timeout was clamped to roughly the remaining ~20ms.
      const timeoutMatch = b?.error?.match(/timed out after (\d+)ms/);
      expect(Number(timeoutMatch?.[1])).toBeLessThan(200);
    });
  });

  describe('one-shot', () => {
    it('run() twice throws', async () => {
      const co = new ShutdownCoordinator();
      await co.run();
      await expect(co.run()).rejects.toThrow(/already called/);
    });
  });

  describe('events', () => {
    it('fires started + step_started + step_ok + finished', async () => {
      const events: ShutdownEvent[] = [];
      const co = new ShutdownCoordinator({ onEvent: (e) => events.push(e) });
      co.register(okStep('only'));
      await co.run();
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(['started', 'step_started', 'step_ok', 'finished']);
    });

    it('fires step_failed', async () => {
      const events: ShutdownEvent[] = [];
      const co = new ShutdownCoordinator({ onEvent: (e) => events.push(e) });
      co.register(failStep('bad', 'boom'));
      await co.run();
      const fail = events.find((e) => e.kind === 'step_failed') as Extract<
        ShutdownEvent,
        { kind: 'step_failed' }
      >;
      expect(fail.error).toMatch(/boom/);
    });

    it('fires step_timeout', async () => {
      const events: ShutdownEvent[] = [];
      const co = new ShutdownCoordinator({
        defaultStepTimeoutMs: 20,
        onEvent: (e) => events.push(e),
      });
      co.register(hangStep('stuck'));
      await co.run();
      expect(events.some((e) => e.kind === 'step_timeout')).toBe(true);
    });

    it('fires step_skipped + deadline_exceeded when deadline hits', async () => {
      const events: ShutdownEvent[] = [];
      const co = new ShutdownCoordinator({
        overallDeadlineMs: 30,
        defaultStepTimeoutMs: 500,
        onEvent: (e) => events.push(e),
      });
      co.register(okStep('slow-but-valid', 50));
      co.register(okStep('late'));
      await co.run();
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain('deadline_exceeded');
      expect(kinds).toContain('step_skipped');
    });
  });

  describe('realistic wiring', () => {
    it('Brain-style ordered shutdown: http → loops → notify → asks → clients', async () => {
      const events: ShutdownEvent[] = [];
      const co = new ShutdownCoordinator({ onEvent: (e) => events.push(e) });
      const order: string[] = [];
      for (const name of [
        'close-http',
        'stop-loops',
        'flush-notify',
        'drain-asks',
        'close-pds',
        'close-keystore',
      ]) {
        co.register({
          name,
          close: async () => {
            order.push(name);
          },
        });
      }
      const report = await co.run();
      expect(report.status).toBe('clean');
      expect(order).toEqual([
        'close-http',
        'stop-loops',
        'flush-notify',
        'drain-asks',
        'close-pds',
        'close-keystore',
      ]);
    });
  });
});
