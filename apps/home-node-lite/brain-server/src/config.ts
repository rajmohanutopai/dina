/**
 * Task 5.1 / 5.4 — env-driven config for the Brain server.
 *
 * Parses `process.env` into a typed `BrainServerConfig` with Zod.
 * Fails loud (throws `ConfigError`) on missing required values or
 * invalid types — the process should crash before Fastify binds a
 * port.
 *
 * Env-var names mirror `apps/home-node-lite/core-server` so operators
 * can rely on a single naming convention for both Node processes. The
 * full Brain-specific env set (Core URL, LLM provider, model, etc.)
 * lands in tasks 5.4 / 5.8 / 5.22-5.29; this scaffold covers the
 * universal networking + logging keys.
 */

import { z } from 'zod';

const NetworkSchema = z.object({
  /** Bind address. Default: loopback only. */
  host: z.string().min(1),
  /**
   * Listen port. Default: 8200 — same as ARCHITECTURE.md and the
   * Go/Python Brain's default. Paired with Core on 8200 by
   * convention; override via `DINA_BRAIN_PORT` when running both
   * stacks side-by-side.
   */
  port: z.number().int().min(0).max(65535),
});

const RuntimeSchema = z.object({
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']),
  prettyLogs: z.boolean(),
});

const BrainServerConfigSchema = z.object({
  network: NetworkSchema,
  runtime: RuntimeSchema,
});

export type BrainServerConfig = z.infer<typeof BrainServerConfigSchema>;

export class ConfigError extends Error {
  constructor(
    public readonly issues: Array<{ path: string; message: string }>,
  ) {
    super(
      `brain-server config invalid (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
    );
    this.name = 'ConfigError';
  }
}

/**
 * Parse `env` (defaulting to `process.env`) into a validated config.
 * Accepting a parameter lets tests exercise env-variant branches
 * without mutating process state.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrainServerConfig {
  const candidate = {
    network: {
      host: env.DINA_BRAIN_HOST ?? '127.0.0.1',
      port: parseInt(env.DINA_BRAIN_PORT ?? '8200', 10),
    },
    runtime: {
      logLevel: (env.DINA_BRAIN_LOG_LEVEL ?? 'info') as 'info',
      prettyLogs: (env.DINA_BRAIN_PRETTY_LOGS ?? 'false') === 'true',
    },
  };
  const result = BrainServerConfigSchema.safeParse(candidate);
  if (!result.success) {
    throw new ConfigError(
      result.error.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    );
  }
  return result.data;
}
