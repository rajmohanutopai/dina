/**
 * Unhandled-promise-rejection guard (task 11.8).
 *
 * Jest's default behaviour prints unhandled rejections to stderr but
 * does not fail the test — a fire-and-forget `.catch`-less Promise
 * can slip through a green run. This guard turns those into test
 * failures so they surface immediately in CI, not during a future
 * soak run where the cause is long gone.
 *
 * Two public shapes:
 *
 *   1. `UnhandledRejectionBuffer` — a small class that captures
 *      rejections into an in-memory buffer. Testable, framework-free.
 *      Use directly when you need to assert on specific rejections.
 *
 *   2. `installUnhandledRejectionGuard()` — the Jest hook. Call once
 *      from a package's `setupFilesAfterEach` entry; it wires a
 *      `beforeEach` that drains pre-existing noise and an `afterEach`
 *      that throws if any rejection fired during the test.
 *
 * Idempotent: double-installing is a no-op (second buffer is never
 * attached). The listener is registered with `process.on`, not
 * `process.prependListener`, so existing Node default behaviour
 * (warnings to stderr) still runs as a belt-and-braces signal.
 */

// Ambient declarations for the Jest globals — the test-harness
// package itself doesn't depend on Jest at runtime (that would couple
// non-test code to the runner); the globals resolve at call-time
// when the hook is invoked from a Jest setup file.
declare function beforeEach(fn: () => void): void;
declare function afterEach(fn: () => void): void;

export class UnhandledRejectionBuffer {
  private captured: unknown[] = [];
  private installed = false;

  /**
   * The listener itself — exposed so tests can drive this buffer
   * without emitting to `process` (which would wake every other
   * `'unhandledRejection'` listener, including a global guard in the
   * same run). Production callers should use `install()`.
   */
  readonly capture = (reason: unknown): void => {
    this.captured.push(reason);
  };

  install(): void {
    if (this.installed) return;
    this.installed = true;
    process.on('unhandledRejection', this.capture);
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    process.off('unhandledRejection', this.capture);
  }

  /** Return + clear the captured rejections. Non-destructive if empty. */
  drain(): unknown[] {
    const out = this.captured;
    this.captured = [];
    return out;
  }

  get size(): number {
    return this.captured.length;
  }
}

let globalGuardInstalled = false;

/**
 * Wire the guard into the current Jest run. Safe to call from any
 * `setupFilesAfterEach` entry; later calls are no-ops so multiple
 * packages' setups can opt in without coordination.
 */
export function installUnhandledRejectionGuard(): void {
  if (globalGuardInstalled) return;
  globalGuardInstalled = true;

  const buf = new UnhandledRejectionBuffer();
  buf.install();

  beforeEach(() => {
    // Drop any leftover rejections from test-suite setup that ran
    // before the first test — they would otherwise attribute to
    // whichever test happens to land first.
    buf.drain();
  });

  afterEach(() => {
    const caught = buf.drain();
    if (caught.length === 0) return;
    const details = caught
      .map((r, i) => {
        const msg = r instanceof Error ? (r.stack ?? r.message) : String(r);
        return `  #${i + 1}: ${msg}`;
      })
      .join('\n');
    throw new Error(
      `${caught.length} unhandled promise rejection(s) during test (task 11.8):\n${details}`,
    );
  });
}
