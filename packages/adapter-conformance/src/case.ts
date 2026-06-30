/**
 * The conformance case shape + a result-collecting runner.
 *
 * A `ConformanceCase<T>` is a named assertion over a freshly-provided subject
 * `T` (a storage adapter, the crypto module, a keystore). Cases never
 * construct their subject — the RUNNER supplies a fresh one per case via
 * `makeSubject()` and tears it down — so the same case runs against
 * better-sqlite3 in node and op-sqlite on a device without the kit importing
 * either side.
 *
 * Two runners consume the SAME cases:
 *   - node/jest: `for (const c of CASES) it(c.name, () => runWithSubject(c, …))`
 *     (or just `await c.run(subject)` so a failure throws and reddens the test);
 *   - device: `await runCases(CASES, makeSubject, teardown)` → a report rendered
 *     as PASS/FAIL rows a Maestro flow can poll.
 */

export interface ConformanceCase<TSubject> {
  /** Stable, kebab-ish identifier — also used to build a per-case testID. */
  readonly name: string;
  /** Run the assertions; throw (sync or async) to fail. */
  run(subject: TSubject): void | Promise<void>;
}

export interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly durationMs: number;
}

export interface ConformanceReport {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly CaseResult[];
}

/** Injected clock — defaults to `Date.now` (available in both node + RN). */
export type Clock = () => number;

/**
 * Run a single case against a freshly-built subject, always tearing the
 * subject down. Returns a result instead of throwing, so a device runner can
 * render every case's outcome (one failing case must not abort the rest).
 */
export async function runCase<T>(
  testCase: ConformanceCase<T>,
  makeSubject: () => T | Promise<T>,
  teardown?: (subject: T) => void | Promise<void>,
  now: Clock = Date.now,
): Promise<CaseResult> {
  const started = now();
  let subject: T | undefined;
  let built = false;
  try {
    subject = await makeSubject();
    built = true;
    await testCase.run(subject);
    return { name: testCase.name, ok: true, durationMs: now() - started };
  } catch (err) {
    return {
      name: testCase.name,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: now() - started,
    };
  } finally {
    if (built && teardown && subject !== undefined) {
      try {
        await teardown(subject);
      } catch {
        // Teardown failures must not mask a case's real verdict.
      }
    }
  }
}

/** Run every case (fresh subject each) and aggregate into a report. */
export async function runCases<T>(
  cases: readonly ConformanceCase<T>[],
  makeSubject: () => T | Promise<T>,
  teardown?: (subject: T) => void | Promise<void>,
  now: Clock = Date.now,
): Promise<ConformanceReport> {
  const results: CaseResult[] = [];
  for (const testCase of cases) {
    results.push(await runCase(testCase, makeSubject, teardown, now));
  }
  const passed = results.filter((r) => r.ok).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}
