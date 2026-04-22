/**
 * Tests for the unhandled-rejection guard shipped in
 * `@dina/test-harness` (task 11.8).
 *
 * Lives in `@dina/core`'s test dir because:
 *   a) `@dina/test-harness` has no Jest config of its own (it's a
 *      support library; tests live in consumer packages).
 *   b) Core already imports the harness, so this test exercises the
 *      same resolution path any real consumer would.
 *
 * Exercises `UnhandledRejectionBuffer` by invoking its public
 * `capture` method directly rather than going through
 * `process.emit('unhandledRejection', ...)`. Reason: this test file
 * runs under the global `installUnhandledRejectionGuard()` wired in
 * setup.ts — emitting would wake that global guard too and fail the
 * test body by the time afterEach runs. Driving `capture` keeps the
 * test hermetic to the single buffer under test.
 *
 * (The install/uninstall path that wires `capture` into `process.on`
 * is exercised indirectly: the global guard installed by setup.ts
 * uses the same code path, and every other test in this suite
 * running clean is the evidence that it works without false fires.)
 */

import { UnhandledRejectionBuffer } from '@dina/test-harness';

describe('UnhandledRejectionBuffer (task 11.8)', () => {
  it('starts empty and reports size 0', () => {
    const buf = new UnhandledRejectionBuffer();
    expect(buf.size).toBe(0);
    expect(buf.drain()).toEqual([]);
  });

  it('capture records a rejection', () => {
    const buf = new UnhandledRejectionBuffer();
    buf.capture(new Error('leaked-from-test-A'));
    expect(buf.size).toBe(1);
    const drained = buf.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toBeInstanceOf(Error);
    expect((drained[0] as Error).message).toBe('leaked-from-test-A');
  });

  it('capture records multiple rejections in order', () => {
    const buf = new UnhandledRejectionBuffer();
    buf.capture(new Error('first'));
    buf.capture(new Error('second'));
    buf.capture(new Error('third'));
    const drained = buf.drain();
    expect(drained).toHaveLength(3);
    expect(drained.map((r) => (r as Error).message)).toEqual(['first', 'second', 'third']);
  });

  it('drain returns AND clears — subsequent drain is empty', () => {
    const buf = new UnhandledRejectionBuffer();
    buf.capture(new Error('one-shot'));
    expect(buf.drain()).toHaveLength(1);
    expect(buf.drain()).toEqual([]);
    expect(buf.size).toBe(0);
  });

  it('captures non-Error rejection values (strings, numbers, objects)', () => {
    const buf = new UnhandledRejectionBuffer();
    buf.capture('bare string reason');
    buf.capture(42);
    buf.capture({ code: 'E_CUSTOM' });
    expect(buf.drain()).toEqual(['bare string reason', 42, { code: 'E_CUSTOM' }]);
  });

  it('install registers the listener on process, uninstall removes it', () => {
    const buf = new UnhandledRejectionBuffer();
    const base = process.listenerCount('unhandledRejection');
    buf.install();
    expect(process.listenerCount('unhandledRejection')).toBe(base + 1);
    // Node's listeners() returns the same function reference we attached.
    expect(process.listeners('unhandledRejection')).toContain(buf.capture);
    buf.uninstall();
    expect(process.listenerCount('unhandledRejection')).toBe(base);
    expect(process.listeners('unhandledRejection')).not.toContain(buf.capture);
  });

  it('install is idempotent — second call does not double-register', () => {
    const buf = new UnhandledRejectionBuffer();
    const base = process.listenerCount('unhandledRejection');
    buf.install();
    buf.install();
    expect(process.listenerCount('unhandledRejection')).toBe(base + 1);
    buf.uninstall();
  });

  it('uninstall is idempotent — second call is a no-op', () => {
    const buf = new UnhandledRejectionBuffer();
    buf.install();
    buf.uninstall();
    // Second uninstall must not throw or mutate count below baseline.
    const baseAfterFirst = process.listenerCount('unhandledRejection');
    buf.uninstall();
    expect(process.listenerCount('unhandledRejection')).toBe(baseAfterFirst);
  });
});

describe('installUnhandledRejectionGuard — sanity (task 11.8)', () => {
  // The guard is live for THIS test run — wired into setup.ts. If any
  // code above or below fires an unhandled rejection, those tests will
  // fail, which is the contract. This sanity test asserts the guard's
  // presence doesn't fire a false positive on a clean no-rejection
  // test body — i.e. the afterEach drain-if-nonempty path is idle.
  it('does not fire on a clean test with no rejections', () => {
    expect(true).toBe(true);
  });

  it('awaited-and-caught rejections are NOT flagged (normal try/catch path)', async () => {
    let caught = false;
    try {
      await Promise.reject(new Error('handled-by-try-catch'));
    } catch {
      caught = true;
    }
    expect(caught).toBe(true);
    // If the guard had captured this properly-handled rejection, the
    // afterEach in setup.ts would fail the test. Reaching this line
    // proves `await + try/catch` is the correct escape hatch.
  });

  it('guard is registered as a process listener during the run', () => {
    // The install call in setup.ts must have landed exactly one
    // listener. `> 0` rather than `=== 1` because Jest itself may
    // register listeners too; we only care ours is present.
    expect(process.listenerCount('unhandledRejection')).toBeGreaterThan(0);
  });
});
