/**
 * Task 5.4 — Fastify + pino.
 *
 * The brain-server uses pino as its structured log transport. Two
 * consumers share the same pino instance:
 *
 *   1. **Fastify**'s request logger — `fastify({logger})` emits request
 *      lines + error lines through pino directly.
 *   2. **`BrainLogger`** (task 5.52) — every structured record from
 *      handler code routes through an adapter that forwards to pino.
 *
 * This module exposes two primitives that keep those concerns
 * decoupled:
 *
 *   - `createBrainPinoLogger(opts)` — pino factory honouring the
 *     brain-server's log level + pretty-print toggle + service
 *     binding. Fastify consumes this.
 *   - `createPinoSink(logger)` — returns a `LogEmitFn` the
 *     `BrainLogger` constructor accepts. The sink maps records into
 *     pino calls without reshuffling canonical fields.
 *
 * **Why two primitives, not one class**: pino's lifecycle (streams,
 * transports) is orthogonal to log-record shaping. Keeping the
 * factory + sink distinct means tests can hold one constant while
 * varying the other, and production can wrap the pino instance in a
 * Fastify `ChildLoggerFactory` without the sink caring.
 *
 * **Level mapping**. `BrainLogger` emits 4 levels (`debug | info |
 * warn | error`); pino supports 6 (`fatal | error | warn | info |
 * debug | trace`). `fatal` + `trace` never come from BrainLogger, but
 * the pino factory accepts both (Fastify uses `fatal` for crash
 * reports), so `createBrainPinoLogger` widens its input accordingly
 * while the sink only ever calls pino's 4-of-6 subset.
 *
 * **Canonical-field preservation**. `BrainLogger` has already
 * partitioned fields into canonical Core slog keys + `extra`; the
 * sink passes them through to pino as the first argument so pino's
 * JSON line has canonical keys at the top level + extras grouped
 * under `extra`. No reshaping, no renaming — if the sink transformed
 * keys we'd drift from the Go Core's slog scheme.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5a task 5.4.
 */

import { pino, type Logger as PinoLogger, type LoggerOptions } from 'pino';

import type { LogEmitFn, LogLevel, LogRecord } from './brain_logger';

/** pino's native level set. `fatal` + `trace` aren't reachable from BrainLogger. */
export type PinoLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * Minimal subset of `PinoLogger` the sink needs. Tests pass a stub
 * that implements just these methods; production passes the real
 * pino instance (which trivially satisfies it).
 */
export interface PinoLoggerLike {
  debug(mergingObject: Record<string, unknown>, msg: string): void;
  info(mergingObject: Record<string, unknown>, msg: string): void;
  warn(mergingObject: Record<string, unknown>, msg: string): void;
  error(mergingObject: Record<string, unknown>, msg: string): void;
}

/**
 * Map from BrainLogger's 4-level enum to pino's method names. pino
 * methods are 1:1 by level name at the subset we use.
 */
const LEVEL_TO_METHOD: Record<LogLevel, keyof PinoLoggerLike> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

export interface CreateBrainPinoLoggerOptions {
  /**
   * Minimum level to emit. Accepts BrainLogger's 4-level form OR
   * pino's 6-level form — `fatal`/`trace` are passed through for
   * Fastify compatibility.
   */
  level?: LogLevel | PinoLevel;
  /** Human-readable dev output via pino-pretty. Default false. */
  pretty?: boolean;
  /**
   * Value bound at `service` on every record. Default 'brain'. Pass
   * `null` to skip the base binding — useful when the caller's
   * upstream logger (e.g. `BrainLogger`) already injects the field
   * to avoid two `service` keys on the wire.
   */
  serviceName?: string | null;
  /**
   * Optional writable destination stream — used by tests to capture
   * JSON lines into memory without touching stdout. Omit in production.
   */
  destination?: NodeJS.WritableStream;
}

/** Valid level values accepted at construction time. */
const VALID_LEVELS: ReadonlySet<string> = new Set<string>([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
]);

/**
 * Build the pino instance the brain-server wires into Fastify and
 * BrainLogger. The instance is configured to emit JSON lines with
 * `time` as RFC3339 + `level` as a string label (matching Go slog's
 * default shape so cross-service log pipelines don't need per-service
 * parsers).
 */
export function createBrainPinoLogger(
  opts: CreateBrainPinoLoggerOptions = {},
): PinoLogger {
  const level = opts.level ?? 'info';
  if (!VALID_LEVELS.has(level)) {
    throw new TypeError(
      `createBrainPinoLogger: invalid level "${level}" — expected one of ${Array.from(VALID_LEVELS).join(', ')}`,
    );
  }
  const serviceName = opts.serviceName === null ? null : (opts.serviceName ?? 'brain');

  const loggerOpts: LoggerOptions = {
    level,
    // Bind service at the root so every line carries it — matches the
    // scheme BrainLogger uses for its own default. `null` skips the
    // binding so upstream loggers that inject `service` themselves
    // don't produce duplicate keys.
    base: serviceName === null ? null : { service: serviceName },
    messageKey: 'msg',
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };

  if (opts.pretty) {
    if (opts.destination !== undefined) {
      // Transports own their output; pino ignores `destination` when a
      // transport is configured. Silently dropping the caller's
      // destination would be a debugging nightmare — fail loudly instead.
      throw new TypeError(
        'createBrainPinoLogger: `pretty: true` is incompatible with `destination` — pino-pretty owns its output',
      );
    }
    // pino-pretty is a worker-thread transport — only wire in dev.
    loggerOpts.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        singleLine: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    };
    return pino(loggerOpts);
  }

  return opts.destination !== undefined
    ? pino(loggerOpts, opts.destination)
    : pino(loggerOpts);
}

/**
 * Returns a `LogEmitFn` that forwards `BrainLogger` records to a
 * pino-like logger. The function is stateless — safe to reuse
 * across child loggers built via `BrainLogger.child(...)`.
 */
export function createPinoSink(logger: PinoLoggerLike): LogEmitFn {
  if (!logger || typeof logger !== 'object') {
    throw new TypeError('createPinoSink: logger is required');
  }
  for (const method of ['debug', 'info', 'warn', 'error'] as const) {
    if (typeof logger[method] !== 'function') {
      throw new TypeError(
        `createPinoSink: logger.${method} must be a function`,
      );
    }
  }
  return (record: LogRecord): void => {
    const merged: Record<string, unknown> = { ...record.fields };
    if (Object.keys(record.extra).length > 0) {
      merged['extra'] = record.extra;
    }
    const method = LEVEL_TO_METHOD[record.level];
    logger[method](merged, record.msg);
  };
}
