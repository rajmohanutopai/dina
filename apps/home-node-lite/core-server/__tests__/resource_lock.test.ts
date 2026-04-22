/**
 * resource_lock tests.
 */

import {
  LockAbortedError,
  LockTimeoutError,
  ResourceLock,
} from '../src/brain/resource_lock';

describe('ResourceLock — basic acquire/release', () => {
  it('first acquire is immediate', async () => {
    const lock = new ResourceLock();
    const handle = await lock.acquire();
    expect(handle.released).toBe(false);
    expect(lock.isLocked()).toBe(true);
    handle.release();
    expect(handle.released).toBe(true);
    expect(lock.isLocked()).toBe(false);
  });

  it('second acquire queues until release', async () => {
    const lock = new ResourceLock();
    const h1 = await lock.acquire();
    let h2Resolved = false;
    const h2Promise = lock.acquire().then((h) => {
      h2Resolved = true;
      return h;
    });
    // Give the event loop a tick.
    await Promise.resolve();
    expect(h2Resolved).toBe(false);
    expect(lock.queueSize()).toBe(1);
    h1.release();
    const h2 = await h2Promise;
    expect(h2Resolved).toBe(true);
    expect(lock.isLocked()).toBe(true);
    h2.release();
    expect(lock.isLocked()).toBe(false);
  });

  it('release is idempotent', async () => {
    const lock = new ResourceLock();
    const handle = await lock.acquire();
    handle.release();
    handle.release(); // no-op
    handle.release();
    expect(handle.released).toBe(true);
    expect(lock.isLocked()).toBe(false);
  });

  it('FIFO order for queued waiters', async () => {
    const lock = new ResourceLock();
    const h1 = await lock.acquire();
    const order: number[] = [];
    const p1 = lock.acquire().then((h) => { order.push(1); h.release(); });
    const p2 = lock.acquire().then((h) => { order.push(2); h.release(); });
    const p3 = lock.acquire().then((h) => { order.push(3); h.release(); });
    h1.release();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('ResourceLock.withLock', () => {
  it('releases automatically on success', async () => {
    const lock = new ResourceLock();
    const result = await lock.withLock(async () => {
      expect(lock.isLocked()).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(lock.isLocked()).toBe(false);
  });

  it('releases automatically on throw', async () => {
    const lock = new ResourceLock();
    await expect(
      lock.withLock(async () => {
        throw new Error('kaboom');
      }),
    ).rejects.toThrow('kaboom');
    expect(lock.isLocked()).toBe(false);
  });

  it('serialises concurrent critical sections', async () => {
    const lock = new ResourceLock();
    let counter = 0;
    const runs: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      runs.push(
        lock.withLock(async () => {
          const snapshot = counter;
          // Yield so interleaving WOULD occur if unserialised.
          await new Promise((r) => setTimeout(r, 1));
          counter = snapshot + 1;
        }),
      );
    }
    await Promise.all(runs);
    expect(counter).toBe(10);
  });

  it('accepts sync functions', async () => {
    const lock = new ResourceLock();
    const r = await lock.withLock(() => 'sync');
    expect(r).toBe('sync');
  });
});

describe('ResourceLock — timeout', () => {
  it('acquire rejects with LockTimeoutError past timeoutMs', async () => {
    const lock = new ResourceLock();
    const held = await lock.acquire(); // hold it
    const start = Date.now();
    await expect(
      lock.acquire({ timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    expect(lock.queueSize()).toBe(0); // timed-out waiter removed.
    held.release();
  });

  it('rejects invalid timeoutMs', async () => {
    const lock = new ResourceLock();
    const held = await lock.acquire();
    await expect(
      lock.acquire({ timeoutMs: -1 }),
    ).rejects.toThrow(/timeoutMs/);
    held.release();
  });

  it('acquire before timeout completes normally', async () => {
    const lock = new ResourceLock();
    const h1 = await lock.acquire();
    const p = lock.acquire({ timeoutMs: 1000 });
    setTimeout(() => h1.release(), 10);
    const h2 = await p;
    h2.release();
  });
});

describe('ResourceLock — abort', () => {
  it('pre-aborted signal rejects immediately', async () => {
    const lock = new ResourceLock();
    const c = new AbortController();
    c.abort();
    await expect(
      lock.acquire({ signal: c.signal }),
    ).rejects.toBeInstanceOf(LockAbortedError);
  });

  it('abort during wait rejects with LockAbortedError', async () => {
    const lock = new ResourceLock();
    const held = await lock.acquire();
    const c = new AbortController();
    const p = lock.acquire({ signal: c.signal });
    setTimeout(() => c.abort(), 10);
    await expect(p).rejects.toBeInstanceOf(LockAbortedError);
    expect(lock.queueSize()).toBe(0);
    held.release();
  });

  it('abort after acquire is a no-op', async () => {
    const lock = new ResourceLock();
    const c = new AbortController();
    const handle = await lock.acquire({ signal: c.signal });
    c.abort(); // after acquire — shouldn't do anything
    expect(handle.released).toBe(false);
    handle.release();
  });

  it('withLock honours abort during wait', async () => {
    const lock = new ResourceLock();
    const held = await lock.acquire();
    const c = new AbortController();
    const p = lock.withLock(async () => 'x', { signal: c.signal });
    setTimeout(() => c.abort(), 10);
    await expect(p).rejects.toBeInstanceOf(LockAbortedError);
    held.release();
  });
});

describe('ResourceLock — fairness + reordering', () => {
  it('queued waiters advance after each release', async () => {
    const lock = new ResourceLock();
    const h1 = await lock.acquire();
    const results: string[] = [];
    const p2 = lock.acquire().then((h) => { results.push('2'); h.release(); });
    const p3 = lock.acquire().then((h) => { results.push('3'); h.release(); });
    h1.release();
    await p2;
    await p3;
    expect(results).toEqual(['2', '3']);
  });

  it('timeout of one waiter does not affect others', async () => {
    const lock = new ResourceLock();
    const h1 = await lock.acquire();
    const results: string[] = [];
    const pTimeout = lock.acquire({ timeoutMs: 20 }).catch((err) => {
      results.push(`timeout:${(err as Error).name}`);
    });
    const pOk = lock.acquire().then((h) => {
      results.push('ok');
      h.release();
    });
    await pTimeout;
    expect(results).toEqual(['timeout:LockTimeoutError']);
    // Now release — ok waiter gets it.
    h1.release();
    await pOk;
    expect(results).toEqual(['timeout:LockTimeoutError', 'ok']);
  });
});

describe('ResourceLock — introspection', () => {
  it('queueSize reflects current waiters', async () => {
    const lock = new ResourceLock();
    const h1 = await lock.acquire();
    expect(lock.queueSize()).toBe(0);
    const p1 = lock.acquire();
    const p2 = lock.acquire();
    await Promise.resolve();
    expect(lock.queueSize()).toBe(2);
    h1.release();
    await p1;
    // first queued waiter took the lock; second is still queued.
    expect(lock.queueSize()).toBe(1);
    const h2 = await p1;
    h2.release();
    await p2;
  });
});
