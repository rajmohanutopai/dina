/**
 * CORE-P0-011 + CORE-P0-T04 — bounded RPC worker pool + dedup tests.
 */

import { RPCWorkerPool, WorkerPoolQueueFullError } from '../../src/rpc/worker_pool';

function makeDeferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('RPCWorkerPool — construction', () => {
  it('rejects non-positive maxConcurrent', () => {
    expect(() => new RPCWorkerPool({ maxConcurrent: 0 })).toThrow(/maxConcurrent/);
    expect(() => new RPCWorkerPool({ maxConcurrent: -1 })).toThrow(/maxConcurrent/);
  });
});

describe('RPCWorkerPool — concurrency cap', () => {
  it('runs jobs up to maxConcurrent in parallel, queues the rest', async () => {
    const pool = new RPCWorkerPool({ maxConcurrent: 2 });
    const d1 = makeDeferred<number>();
    const d2 = makeDeferred<number>();
    const d3 = makeDeferred<number>();

    const p1 = pool.submitDuplicate('a', () => d1.promise);
    const p2 = pool.submitDuplicate('b', () => d2.promise);
    // Let p1 and p2 enter the running pool.
    await Promise.resolve();
    expect(pool.runningCount()).toBe(2);

    const p3 = pool.submitDuplicate('c', () => d3.promise);
    await Promise.resolve();
    expect(pool.runningCount()).toBe(2);
    expect(pool.queuedCount()).toBe(1);

    d1.resolve(1);
    await p1;
    // Slot released; p3 should start.
    await Promise.resolve();
    expect(pool.runningCount()).toBe(2);
    expect(pool.queuedCount()).toBe(0);

    d2.resolve(2);
    d3.resolve(3);
    await Promise.all([p2, p3]);
    expect(pool.runningCount()).toBe(0);
  });
});

describe('RPCWorkerPool — submitDuplicate dedup (CORE-P0-T04)', () => {
  it('5 concurrent duplicate submissions → 1 worker execution', async () => {
    const pool = new RPCWorkerPool({ maxConcurrent: 10 });
    let calls = 0;
    const deferred = makeDeferred<string>();
    const work = async () => {
      calls++;
      return deferred.promise;
    };
    const promises = [
      pool.submitDuplicate('shared-key', work),
      pool.submitDuplicate('shared-key', work),
      pool.submitDuplicate('shared-key', work),
      pool.submitDuplicate('shared-key', work),
      pool.submitDuplicate('shared-key', work),
    ];
    // All five callers got the same underlying promise.
    await Promise.resolve();
    expect(pool.inFlightCount()).toBe(1);
    expect(calls).toBe(1);

    deferred.resolve('result');
    const results = await Promise.all(promises);
    expect(results).toEqual(['result', 'result', 'result', 'result', 'result']);
    expect(calls).toBe(1); // still only one execution
  });

  it('different keys run as independent jobs', async () => {
    const pool = new RPCWorkerPool({ maxConcurrent: 10 });
    let aCalls = 0;
    let bCalls = 0;
    await Promise.all([
      pool.submitDuplicate('a', async () => {
        aCalls++;
      }),
      pool.submitDuplicate('b', async () => {
        bCalls++;
      }),
    ]);
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
  });

  it('key becomes re-submittable after completion', async () => {
    const pool = new RPCWorkerPool({ maxConcurrent: 10 });
    let calls = 0;
    await pool.submitDuplicate('k', async () => {
      calls++;
      return 1;
    });
    await pool.submitDuplicate('k', async () => {
      calls++;
      return 2;
    });
    expect(calls).toBe(2);
  });

  it('shared failure: all callers see the same rejection', async () => {
    const pool = new RPCWorkerPool({ maxConcurrent: 10 });
    const err = new Error('boom');
    const p1 = pool.submitDuplicate('k', async () => {
      throw err;
    });
    const p2 = pool.submitDuplicate('k', async () => {
      throw new Error('never');
    });
    await expect(p1).rejects.toBe(err);
    await expect(p2).rejects.toBe(err);
  });
});

describe('RPCWorkerPool — queue-full rejection', () => {
  it('rejects with WorkerPoolQueueFullError when queue depth is exceeded', async () => {
    const pool = new RPCWorkerPool({ maxConcurrent: 1, maxQueueDepth: 2 });
    const d = makeDeferred<void>();
    // Occupy the running slot (swallow rejection on test cleanup).
    const a = pool.submitDuplicate('a', () => d.promise).catch(() => {});
    // Fill the queue.
    const b = pool.submitDuplicate('b', () => Promise.resolve());
    const c = pool.submitDuplicate('c', () => Promise.resolve());
    // Next submission rejects — submit is async so wrap assertion accordingly.
    await expect(pool.submitDuplicate('d', () => Promise.resolve())).rejects.toBeInstanceOf(
      WorkerPoolQueueFullError,
    );
    // Drain so jest doesn't see dangling promises.
    d.resolve();
    await Promise.all([a, b, c]);
  });
});
