/**
 * Task 5.1 — ordered boot sequence for the Brain server.
 *
 * Current scaffold: config → logger → Fastify (with /healthz) → listen.
 *
 * Canonical target sequence (tasks 5.1 – 5.49, filled in progressively):
 *
 *   1. `config`         — env → typed config (this task)
 *   2. `logger`         — pino root logger (this task)
 *   3. `adapter_wire`   — @dina/adapters-node: crypto, fs, keystore, net
 *   4. `core_client`    — HttpCoreTransport wired to Core's HTTP endpoint
 *   5. `brain_compose`  — @dina/brain pure package receives the injected
 *                         CoreClient + platform adapters
 *   6. `fastify_start`  — route bindings (api + admin), listen
 *   7. `ready`          — flip /readyz to green
 *
 * Steps past #2 land in tasks 5.3 – 5.49. The current scaffold proves
 * the env → listen path end-to-end with a /healthz probe, nothing
 * more.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { loadConfig, type BrainServerConfig } from './config';
import { createLogger, type Logger } from './logger';

export interface BootedServer {
  app: FastifyInstance;
  logger: Logger;
  config: BrainServerConfig;
  /** The socket address Fastify is listening on (e.g. "127.0.0.1:18200"). */
  boundAddress: string;
}

export async function bootServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BootedServer> {
  // 1. config.
  const config = loadConfig(env);

  // 2. logger.
  const logger = createLogger(config);
  logger.info({ host: config.network.host, port: config.network.port }, 'brain-server boot');

  // 6. fastify_start (scaffold — full route binding in tasks 5.3 – 5.49).
  const app = Fastify({ logger: false }); // we manage our own logger
  app.get('/healthz', async () => ({ status: 'ok', role: 'brain' }));

  const boundAddress = await app.listen({
    host: config.network.host,
    port: config.network.port,
  });
  logger.info({ boundAddress }, 'brain-server listening');

  return { app, logger, config, boundAddress };
}
