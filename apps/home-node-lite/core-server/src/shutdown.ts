/**
 * Task 4.9 — graceful shutdown orchestration.
 *
 * Registers SIGINT + SIGTERM handlers that run the shutdown sequence
 * in the order the spec calls for: **Fastify close → MsgBox close →
 * DB close**. Each step is best-effort — we log failures but continue
 * so one stuck subsystem doesn't prevent the others from cleaning up.
 *
 * The sequence order matters:
 *
 *   1. **Fastify close first.** Stops accepting new connections while
 *      draining in-flight requests via Fastify's own close protocol
 *      (respects connection limit + keep-alive timeouts). Requests
 *      already running finish naturally; new ones get ECONNREFUSED.
 *
 *   2. **MsgBox close next.** Detaches the relay subscription so we
 *      don't leave a stale client hanging. Done after Fastify close
 *      because a graceful MsgBox leave may take a round-trip, and
 *      we don't want to hold new inbound requests in the meantime.
 *
 *   3. **DB close last.** Closing SQLCipher checkpoints the WAL and
 *      releases the file lock. MUST be last — Fastify handlers and
 *      MsgBox inbound handlers may still be mid-write when the upper
 *      layers are closing, so DB close waits for those drains.
 *
 * **Force-kill on second signal.** If SIGINT/SIGTERM arrives again
 * while shutdown is in progress, exit immediately with code 1.
 * Prevents a hung shutdown from requiring `kill -9`.
 *
 * **Test hook.** The `registerSignalHandlers` return value is a
 * deregister function, so tests can wire the handlers in, exercise
 * them, and clean up.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4a task 4.9.
 */

import type { Logger } from './logger';

/** One shutdown step — named so log entries + error reports stay legible. */
export interface ShutdownStep {
  name: string;
  /** Must resolve (even on error) so the next step can run. */
  close: () => Promise<void> | void;
}

export interface GracefulShutdownOptions {
  logger: Logger;
  /** Ordered list of things to close. Fastify → MsgBox → DB. */
  steps: ShutdownStep[];
  /** Total budget for the whole sequence. Default: 15s. */
  overallTimeoutMs?: number;
  /** Per-step budget. Default: 5s. */
  perStepTimeoutMs?: number;
  /** Process exit hook — injected for tests (default: `process.exit`). */
  exit?: (code: number) => void;
}

const DEFAULT_OVERALL_TIMEOUT_MS = 15_000;
const DEFAULT_PER_STEP_TIMEOUT_MS = 5_000;

/**
 * Run the shutdown sequence once, honoring per-step + overall timeouts.
 * Returns after every step has been awaited (or timed out). The caller
 * decides whether to exit the process; we don't hard-exit here so tests
 * can inspect state.
 */
export async function runShutdown(opts: GracefulShutdownOptions): Promise<void> {
  const { logger, steps } = opts;
  const overallBudget = opts.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
  const perStepBudget = opts.perStepTimeoutMs ?? DEFAULT_PER_STEP_TIMEOUT_MS;

  const start = Date.now();
  logger.info({ steps: steps.map((s) => s.name) }, 'shutdown sequence starting');

  for (const step of steps) {
    const elapsed = Date.now() - start;
    if (elapsed >= overallBudget) {
      logger.warn({ step: step.name, elapsedMs: elapsed }, 'shutdown: overall budget exhausted, skipping');
      continue;
    }
    const remaining = overallBudget - elapsed;
    const budget = Math.min(perStepBudget, remaining);
    try {
      await withTimeout(step.close(), budget, step.name);
      logger.info({ step: step.name }, 'shutdown: step ok');
    } catch (err) {
      // Best-effort: log + continue so later steps still run.
      logger.warn(
        { step: step.name, err: (err as Error).message },
        'shutdown: step failed',
      );
    }
  }
  logger.info({ elapsedMs: Date.now() - start }, 'shutdown sequence complete');
}

/**
 * Wire SIGINT + SIGTERM to the shutdown sequence.
 * Returns a deregister function to unwire them (tests call this).
 *
 * On the SECOND signal while a shutdown is already in progress, the
 * process is hard-exited with code 1 — prevents a stuck close from
 * requiring `kill -9`.
 */
export function registerSignalHandlers(opts: GracefulShutdownOptions): () => void {
  const { logger } = opts;
  const exit = opts.exit ?? ((code) => process.exit(code));

  let shuttingDown = false;

  const handler = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      logger.warn({ signal }, 'second shutdown signal received — forcing exit');
      exit(1);
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutdown signal received');
    try {
      await runShutdown(opts);
      exit(0);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'shutdown crashed');
      exit(1);
    }
  };

  const sigint = (): Promise<void> => handler('SIGINT');
  const sigterm = (): Promise<void> => handler('SIGTERM');

  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);

  return () => {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(
  work: Promise<T> | T,
  timeoutMs: number,
  context: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${context}: shutdown step exceeded ${timeoutMs}ms budget`));
    }, timeoutMs);

    Promise.resolve(work).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
