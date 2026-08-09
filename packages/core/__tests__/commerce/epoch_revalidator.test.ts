/**
 * The tick that asks the epoch service to re-verify (WS-2.4).
 *
 * `revalidate()` could be perfect and change nothing if nothing called it —
 * which is the defect this workstream has produced more than any other. These
 * assert the loop's own obligations: resolve per tick, never overlap, survive
 * a throwing observer, and stop cleanly.
 */

import { CommerceEpochRevalidator, startCommerceSweepers } from '../../src/commerce';

import type { EpochRevalidation } from '../../src/commerce';

/** A hand-driven timer, so no test waits on a wall clock. */
function fakeTimers() {
  const ticks: (() => void)[] = [];
  let cleared = 0;
  return {
    ticks,
    get cleared() {
      return cleared;
    },
    setInterval: (fn: () => void) => {
      ticks.push(fn);
      return ticks.length;
    },
    clearInterval: () => {
      cleared += 1;
    },
    fire: () => {
      for (const t of [...ticks]) t();
    },
  };
}

const CURRENT: EpochRevalidation = { kind: 'current', epoch: '1' };

describe('CommerceEpochRevalidator', () => {
  it('runs one pass immediately at start, not one interval later', async () => {
    const seen: EpochRevalidation[] = [];
    const timers = fakeTimers();
    const revalidator = new CommerceEpochRevalidator({
      service: () => ({ revalidateIfDue: async () => CURRENT }),
      onOutcome: (o) => seen.push(o),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    revalidator.start();
    // `start()` fires the first pass without awaiting it.
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([CURRENT]);
  });

  it('is quiet on a node with no epoch service', async () => {
    const revalidator = new CommerceEpochRevalidator({ service: () => null });
    expect(await revalidator.runTick()).toBeNull();
  });

  it('reports nothing when the re-read was not due', async () => {
    let outcomes = 0;
    const revalidator = new CommerceEpochRevalidator({
      service: () => ({ revalidateIfDue: async () => null }),
      onOutcome: () => {
        outcomes += 1;
      },
    });
    expect(await revalidator.runTick()).toBeNull();
    expect(outcomes).toBe(0);
  });

  it('resolves the service PER TICK rather than capturing it', async () => {
    // The epoch service is installed only once publication succeeds and is
    // torn down on identity change, so a captured one would pin whatever
    // existed at wiring time.
    let installed: { revalidateIfDue: () => Promise<EpochRevalidation | null> } | null = null;
    const revalidator = new CommerceEpochRevalidator({ service: () => installed });
    expect(await revalidator.runTick()).toBeNull();
    installed = { revalidateIfDue: async () => CURRENT };
    expect(await revalidator.runTick()).toEqual(CURRENT);
  });

  it('does not stack a second read on top of a slow one', async () => {
    // The read is network-bound and the interval is not. Stacking requests
    // against a repo that is already struggling is the wrong response to it
    // being slow.
    let inFlight = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const revalidator = new CommerceEpochRevalidator({
      service: () => ({
        revalidateIfDue: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          inFlight -= 1;
          return CURRENT;
        },
      }),
    });
    const first = revalidator.runTick();
    await Promise.resolve();
    expect(await revalidator.runTick()).toBeNull();
    release?.();
    await first;
    expect(peak).toBe(1);
  });

  it('reports a throwing resolver as an error rather than dying', async () => {
    // The resolver itself can throw — `currentEpoch()` is fail-closed until
    // the epoch record is published. That is a node with commerce disabled,
    // not a revalidator fault.
    const errors: unknown[] = [];
    const revalidator = new CommerceEpochRevalidator({
      service: () => {
        throw new Error('commerce epoch: not established');
      },
      onError: (err) => errors.push(err),
    });
    expect(await revalidator.runTick()).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it('reports a throwing re-read as an error and keeps ticking', async () => {
    const errors: unknown[] = [];
    let fail = true;
    const revalidator = new CommerceEpochRevalidator({
      service: () => ({
        revalidateIfDue: async () => {
          if (fail) throw new Error('boom');
          return CURRENT;
        },
      }),
      onError: (err) => errors.push(err),
    });
    expect(await revalidator.runTick()).toBeNull();
    fail = false;
    expect(await revalidator.runTick()).toEqual(CURRENT);
    expect(errors).toHaveLength(1);
  });

  it('does not let a throwing observer turn a completed re-read into a failed one', async () => {
    const errors: unknown[] = [];
    const revalidator = new CommerceEpochRevalidator({
      service: () => ({ revalidateIfDue: async () => CURRENT }),
      onOutcome: () => {
        throw new Error('logger exploded');
      },
      onError: (err) => errors.push(err),
    });
    expect(await revalidator.runTick()).toEqual(CURRENT);
    expect(errors).toHaveLength(1);
  });

  it('start is idempotent and stop clears exactly one timer', () => {
    const timers = fakeTimers();
    const revalidator = new CommerceEpochRevalidator({
      service: () => null,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    revalidator.start();
    revalidator.start();
    expect(timers.ticks).toHaveLength(1);
    revalidator.stop();
    revalidator.stop();
    expect(timers.cleared).toBe(1);
  });

  it('refuses a non-positive interval rather than spinning', () => {
    expect(() => new CommerceEpochRevalidator({ service: () => null, intervalMs: 0 })).toThrow(
      /intervalMs/,
    );
  });
});

describe('startCommerceSweepers', () => {
  it('starts both ticks and stops both', () => {
    const timers = fakeTimers();
    const sweepers = startCommerceSweepers({
      admission: { engine: () => null },
      epoch: { service: () => null },
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    // Two timers, because the two have different clocks and different failure
    // meanings; one call site, because a tick each root must remember to start
    // is a tick one root eventually forgets.
    expect(timers.ticks).toHaveLength(2);
    sweepers.stop();
    expect(timers.cleared).toBe(2);
  });

  it('stops the second tick even when the first stop throws', () => {
    // A teardown that abandons the second timer leaves a phone polling a repo
    // for an identity the user has already switched away from.
    let epochCleared = false;
    let first = true;
    const sweepers = startCommerceSweepers({
      admission: { engine: () => null },
      epoch: { service: () => null },
      setInterval: () => 1,
      clearInterval: () => {
        if (first) {
          first = false;
          throw new Error('clear failed');
        }
        epochCleared = true;
      },
    });
    expect(() => sweepers.stop()).toThrow('clear failed');
    expect(epochCleared).toBe(true);
  });
});
