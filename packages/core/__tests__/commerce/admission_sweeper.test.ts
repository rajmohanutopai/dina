/**
 * Commerce admission recovery sweeper (WS-2.2, §9.9 step 3).
 *
 * The engine method this drives was correct and unreachable: nothing in the
 * repository called `recoverAdmissions()` outside its own tests, so no
 * running node ever timed out a reservation. These tests are about the
 * sweeper's job as a wired component — that it runs, that it survives the
 * states a real boot puts it in, and that a stuck row is reported rather
 * than swallowed.
 */

import { CommerceAdmissionSweeper } from '../../src/commerce/admission_sweeper';

import type { AdmissionRecoverySweep } from '../../src/commerce/admission';

const EMPTY: AdmissionRecoverySweep = { timedOut: [], stuck: [] };

/** Manual scheduler, so cadence is asserted rather than waited for. */
function makeTimers(): {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
  fire: () => void;
  intervals: number[];
  cleared: number;
} {
  let pending: (() => void) | null = null;
  const intervals: number[] = [];
  let cleared = 0;
  return {
    setInterval: (fn, ms) => {
      intervals.push(ms);
      pending = fn;
      return { id: intervals.length };
    },
    clearInterval: () => {
      cleared += 1;
      pending = null;
    },
    fire: () => pending?.(),
    intervals,
    get cleared() {
      return cleared;
    },
  };
}

describe('commerce admission sweeper', () => {
  it('sweeps on start and on every interval', () => {
    const timers = makeTimers();
    let calls = 0;
    const sweeper = new CommerceAdmissionSweeper({
      engine: () => ({
        recoverAdmissions: () => {
          calls += 1;
          return EMPTY;
        },
      }),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    sweeper.start();
    expect(calls).toBe(1); // an immediate sweep, not one interval late
    timers.fire();
    timers.fire();
    expect(calls).toBe(3);
    sweeper.stop();
    timers.fire();
    expect(calls).toBe(3);
  });

  it('start is idempotent and stop before start is harmless', () => {
    const timers = makeTimers();
    const sweeper = new CommerceAdmissionSweeper({
      engine: () => null,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    sweeper.stop();
    sweeper.start();
    sweeper.start();
    expect(timers.intervals).toHaveLength(1);
  });

  /**
   * The states a real boot puts it in. Commerce composes after storage, is
   * absent entirely on a node with no published epoch (§16.2), and is torn
   * down on identity change — so "no engine" is the NORMAL case, not a fault,
   * and the sweeper must keep ticking through it rather than die or shout.
   */
  it('is a quiet no-op while there is no commerce runtime', () => {
    const timers = makeTimers();
    const errors: unknown[] = [];
    let engine: { recoverAdmissions: () => AdmissionRecoverySweep } | null = null;
    const sweeper = new CommerceAdmissionSweeper({
      engine: () => engine,
      onError: (err) => errors.push(err),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    sweeper.start();
    expect(errors).toEqual([]);

    // Commerce arrives LATER — the reason the engine is resolved per tick
    // rather than captured at wiring time.
    let swept = 0;
    engine = {
      recoverAdmissions: () => {
        swept += 1;
        return EMPTY;
      },
    };
    timers.fire();
    expect(swept).toBe(1);

    // ...and goes away again on identity teardown, without stopping the loop.
    engine = null;
    timers.fire();
    expect(swept).toBe(1);
    expect(errors).toEqual([]);
  });

  it('survives a resolver that throws — a fail-closed epoch is not a fault', () => {
    // On a server node `currentEpoch()` throws until the epoch record is
    // published (§16.2). That must not kill the sweeper: the node may publish
    // a minute later and every later tick has to still run.
    const timers = makeTimers();
    const errors: unknown[] = [];
    let broken = true;
    let swept = 0;
    const sweeper = new CommerceAdmissionSweeper({
      engine: () => {
        if (broken) throw new Error('commerce: epoch service not installed');
        return {
          recoverAdmissions: () => {
            swept += 1;
            return EMPTY;
          },
        };
      },
      onError: (err) => errors.push(err),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    sweeper.start();
    expect(errors).toHaveLength(1);
    broken = false;
    timers.fire();
    expect(swept).toBe(1);
  });

  it('survives a sweep that throws', () => {
    const timers = makeTimers();
    const errors: unknown[] = [];
    let fail = true;
    const sweeper = new CommerceAdmissionSweeper({
      engine: () => ({
        recoverAdmissions: () => {
          if (fail) throw new Error('db locked');
          return EMPTY;
        },
      }),
      onError: (err) => errors.push(err),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    sweeper.start();
    expect(errors).toHaveLength(1);
    fail = false;
    expect(timers.fire.call(timers)).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('reports stuck rows separately from timed-out ones', () => {
    // The distinction is the point. A sweep that resolves nothing and a sweep
    // that CANNOT resolve anything both used to read as "0 timed out", so a
    // node leaking every hold looked identical to an idle one.
    const timedOut: string[] = [];
    const stuck: { purchaseOrderId: string; reason: string }[] = [];
    const errors: unknown[] = [];
    const sweeper = new CommerceAdmissionSweeper({
      engine: () => ({
        recoverAdmissions: () => ({
          timedOut: ['po-1'],
          stuck: [{ purchaseOrderId: 'po-2', reason: 'reference_unloadable' }],
        }),
      }),
      onTimedOut: (id) => timedOut.push(id),
      onStuck: (skip) => stuck.push(skip),
      onError: (err) => errors.push(err),
      setInterval: () => ({}),
      clearInterval: () => undefined,
    });
    expect(sweeper.runTick()).toEqual({
      timedOut: ['po-1'],
      stuck: [{ purchaseOrderId: 'po-2', reason: 'reference_unloadable' }],
    });
    expect(timedOut).toEqual(['po-1']);
    expect(stuck).toEqual([{ purchaseOrderId: 'po-2', reason: 'reference_unloadable' }]);
    // A stuck row is not an error: reporting it as one would drown the signal
    // that something actually broke.
    expect(errors).toEqual([]);
  });

  it('one throwing observer does not lose the rest of the report', () => {
    const seen: string[] = [];
    const errors: unknown[] = [];
    const sweeper = new CommerceAdmissionSweeper({
      engine: () => ({
        recoverAdmissions: () => ({ timedOut: ['po-1', 'po-2'], stuck: [] }),
      }),
      onTimedOut: (id) => {
        if (id === 'po-1') throw new Error('logger down');
        seen.push(id);
      },
      onError: (err) => errors.push(err),
      setInterval: () => ({}),
      clearInterval: () => undefined,
    });
    sweeper.runTick();
    expect(seen).toEqual(['po-2']);
    expect(errors).toHaveLength(1);
  });

  it('refuses a non-positive interval rather than spinning', () => {
    expect(() => new CommerceAdmissionSweeper({ engine: () => null, intervalMs: 0 })).toThrow(
      /intervalMs/,
    );
  });
});
