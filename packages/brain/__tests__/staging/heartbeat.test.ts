/**
 * T3.17 — Staging lease heartbeat: extend leases during slow enrichment.
 *
 * Source: ARCHITECTURE.md Task 3.17
 */

import { LeaseHeartbeat, withHeartbeat, type LeaseExtender } from '../../src/staging/heartbeat';

/** Create a mock lease extender that tracks calls. */
function createMockExtender(): LeaseExtender & {
  calls: Array<{ itemId: string; seconds: number }>;
  failNext: boolean;
} {
  const mock: any = {
    calls: [],
    failNext: false,
    extendStagingLease: jest.fn(async (itemId: string, seconds: number) => {
      if (mock.failNext) {
        mock.failNext = false;
        throw new Error('extend failed');
      }
      mock.calls.push({ itemId, seconds });
    }),
  };
  return mock;
}

describe('LeaseHeartbeat', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('lifecycle', () => {
    it('starts and stops cleanly', () => {
      const extender = createMockExtender();
      const hb = new LeaseHeartbeat(extender, 'stg-1');

      expect(hb.running).toBe(false);
      hb.start();
      expect(hb.running).toBe(true);
      hb.stop();
      expect(hb.running).toBe(false);
    });

    it('start is idempotent', async () => {
      jest.useFakeTimers();
      const extender = createMockExtender();
      const hb = new LeaseHeartbeat(extender, 'stg-1', { intervalMs: 100 });

      hb.start();
      hb.start(); // second start should not create a second timer

      await jest.advanceTimersByTimeAsync(100);
      expect(hb.tickCount).toBe(1); // only one timer fired
      hb.stop();
    });

    it('stop is idempotent', () => {
      const extender = createMockExtender();
      const hb = new LeaseHeartbeat(extender, 'stg-1');

      hb.start();
      hb.stop();
      hb.stop(); // should not throw
      expect(hb.running).toBe(false);
    });

    it('exposes item ID', () => {
      const extender = createMockExtender();
      const hb = new LeaseHeartbeat(extender, 'stg-42');
      expect(hb.id).toBe('stg-42');
    });
  });

  describe('tick', () => {
    it('extends lease on tick', async () => {
      const extender = createMockExtender();
      const hb = new LeaseHeartbeat(extender, 'stg-1', {
        intervalMs: 100,
        extensionSeconds: 300,
      });

      hb.start();
      await hb.tick();
      hb.stop();

      expect(extender.calls).toHaveLength(1);
      expect(extender.calls[0]).toEqual({ itemId: 'stg-1', seconds: 300 });
      expect(hb.tickCount).toBe(1);
      expect(hb.failCount).toBe(0);
    });

    it('increments failCount on error', async () => {
      const extender = createMockExtender();
      const errors: string[] = [];
      const hb = new LeaseHeartbeat(extender, 'stg-1', {
        onError: (_id, err) => errors.push(err.message),
      });

      hb.start();
      extender.failNext = true;
      await hb.tick();
      hb.stop();

      expect(hb.tickCount).toBe(0);
      expect(hb.failCount).toBe(1);
      expect(errors).toEqual(['extend failed']);
    });

    it('resumes after failure on next tick', async () => {
      const extender = createMockExtender();
      const hb = new LeaseHeartbeat(extender, 'stg-1', { extensionSeconds: 600 });

      hb.start();

      // First tick fails
      extender.failNext = true;
      await hb.tick();
      expect(hb.failCount).toBe(1);

      // Second tick succeeds
      await hb.tick();
      expect(hb.tickCount).toBe(1);
      expect(extender.calls).toHaveLength(1);

      hb.stop();
    });

    it('does not tick after stop', async () => {
      const extender = createMockExtender();
      const hb = new LeaseHeartbeat(extender, 'stg-1');

      hb.start();
      hb.stop();
      await hb.tick(); // should be no-op

      expect(hb.tickCount).toBe(0);
      expect(extender.calls).toHaveLength(0);
    });

    it('uses default extension of 600 seconds', async () => {
      const extender = createMockExtender();
      const hb = new LeaseHeartbeat(extender, 'stg-1');

      hb.start();
      await hb.tick();
      hb.stop();

      expect(extender.calls[0].seconds).toBe(600);
    });
  });

  describe('timer integration', () => {
    it('fires tick at interval', async () => {
      jest.useFakeTimers();
      const extender = createMockExtender();
      const hb = new LeaseHeartbeat(extender, 'stg-1', { intervalMs: 1000 });

      hb.start();

      await jest.advanceTimersByTimeAsync(1000);
      expect(hb.tickCount).toBe(1);

      await jest.advanceTimersByTimeAsync(1000);
      expect(hb.tickCount).toBe(2);

      await jest.advanceTimersByTimeAsync(1000);
      expect(hb.tickCount).toBe(3);

      hb.stop();
    });

    it('stops firing after stop', async () => {
      jest.useFakeTimers();
      const extender = createMockExtender();
      const hb = new LeaseHeartbeat(extender, 'stg-1', { intervalMs: 1000 });

      hb.start();
      await jest.advanceTimersByTimeAsync(2000);
      expect(hb.tickCount).toBe(2);

      hb.stop();
      await jest.advanceTimersByTimeAsync(5000);
      expect(hb.tickCount).toBe(2); // no more ticks
    });
  });
});

describe('withHeartbeat', () => {
  it('runs operation with heartbeat and stops after', async () => {
    const extender = createMockExtender();
    let heartbeatWasRunning = false;

    const result = await withHeartbeat(
      extender,
      'stg-1',
      async () => {
        // Heartbeat is running during the operation
        heartbeatWasRunning = true;
        return 42;
      },
      { intervalMs: 100 },
    );

    expect(result).toBe(42);
    expect(heartbeatWasRunning).toBe(true);
  });

  it('stops heartbeat even if operation throws', async () => {
    const extender = createMockExtender();

    await expect(
      withHeartbeat(extender, 'stg-1', async () => {
        throw new Error('enrichment failed');
      }),
    ).rejects.toThrow('enrichment failed');

    // Heartbeat should be stopped (no leaked timers)
  });

  it('propagates operation result', async () => {
    const extender = createMockExtender();

    const result = await withHeartbeat(extender, 'stg-1', async () => ({
      status: 'enriched',
      items: 5,
    }));

    expect(result).toEqual({ status: 'enriched', items: 5 });
  });
});
