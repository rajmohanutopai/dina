/**
 * Task 4.6 (logger half) — pino logger factory.
 *
 * Returns a logger that emits:
 *   - JSON lines in production (prettyLogs=false), compatible with Go
 *     slog's output shape so log pipelines don't care which core is
 *     running; see task 4.7 for the exact field-name mapping.
 *   - Pretty, colorized output in development (prettyLogs=true) via
 *     `pino-pretty` as a transport.
 *
 * **Field parity with Go slog.** Go's `log/slog` emits `time`, `level`,
 * `msg`, plus whatever caller-supplied fields. Pino's default shape is
 * `{ level: 30, time: <epoch-ms>, msg: ... }`. We realign so TS + Go
 * output is drop-in interchangeable for log pipelines:
 *
 *   - `level` rendered as a STRING (`"info"`, `"warn"`) not a number,
 *     matching slog's `LevelInfo`/`LevelWarn` string encoding.
 *   - `time` rendered as RFC3339 (`"2026-04-21T21:52:00Z"`), matching
 *     slog's `time.Time` default format.
 *   - `msg` key unchanged (matches slog).
 *
 * Task 4.7 adds the optional request-context fields (`persona`, `did`,
 * `request_id`, `route`) as per-request bindings on the logger — not
 * done here; the base logger just has to have the right shape for them
 * to slot into.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4a tasks 4.6–4.7.
 */

import { pino, type Logger, type LoggerOptions } from 'pino';
import type { CoreServerConfig } from './config';

export type { Logger };

/**
 * Build the root logger for a given config. Pass `config.runtime` as a
 * hermetic input — this lets tests exercise the pretty/JSON branch
 * without touching process.env.
 */
export function createLogger(config: CoreServerConfig): Logger {
  const options: LoggerOptions = {
    level: config.runtime.logLevel,
    // Render level as a string (matches Go slog).
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    // Render time as RFC3339 (matches Go slog's default format).
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    // `msg` is pino's default message key — identical to slog.
    messageKey: 'msg',
    // Pass `null` (not `undefined`) to suppress pid + hostname — that's
    // pino's documented opt-out shape. Go slog omits these fields too.
    base: null,
  };

  if (config.runtime.prettyLogs) {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        singleLine: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    };
  }

  return pino(options);
}
