/**
 * Task 5.1 — pino logger factory for the Brain server.
 *
 * Mirrors `apps/home-node-lite/core-server/src/logger.ts` so operators
 * reading a mixed Core/Brain log pipeline get the same JSON shape
 * regardless of which process emitted the line.
 *
 * Field convention (parity with Go slog):
 *   - `level` rendered as a string (`"info"`, `"warn"`, …)
 *   - `time`  rendered as RFC3339
 *   - `msg`   unchanged — pino's default, identical to slog
 *   - `pid` + `hostname` suppressed (slog omits them)
 */

import { pino, type Logger, type LoggerOptions } from 'pino';

import type { BrainServerConfig } from './config';

export type { Logger };

export function createLogger(config: BrainServerConfig): Logger {
  const options: LoggerOptions = {
    level: config.runtime.logLevel,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    messageKey: 'msg',
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
