/**
 * pino logger for the gateway, in the same JSON shape as Core and Brain so
 * one log pipeline reads all three. Metadata only: never a body or a token.
 */

import { pino, type Logger, type LoggerOptions } from 'pino';

import type { GatewayConfig } from './config';

export type { Logger };

export function createLogger(config: GatewayConfig): Logger {
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
    redact: { paths: ['req.headers.authorization', 'authorization'], remove: true },
  };
  if (config.runtime.prettyLogs) {
    options.transport = { target: 'pino-pretty', options: { colorize: true, singleLine: true, translateTime: 'SYS:standard' } };
  }
  return pino(options);
}
