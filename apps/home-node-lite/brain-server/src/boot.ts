/**
 * Task 5.1 — ordered boot sequence for the Brain server.
 *
 * Current scaffold: config → logger → signed Core client when a Brain
 * service key is provisioned → hosted AppView client → Fastify (with
 * /healthz and /readyz) → staging drain scheduler when Core is configured
 * → optional ask coordinator/route composition when LLM runtime is supplied
 * → listen.
 *
 * Canonical target sequence (tasks 5.1 – 5.49, filled in progressively):
 *
 *   1. `config`         — env → typed config (this task)
 *   2. `logger`         — pino root logger (this task)
 *   3. `adapter_wire`   — @dina/adapters-node: crypto, fs, keystore, net
 *   4. `core_client`    — HttpCoreTransport wired to Core's HTTP endpoint
 *   5. `appview_client` — shared AppView client from hosted endpoint config
 *   6. `brain_compose`  — @dina/brain pure package receives the injected
 *                         CoreClient + platform adapters
 *   7. `fastify_start`  — route bindings (api + admin), listen
 *   8. `ready`          — flip /readyz to green
 *
 * Steps past configured Core/AppView clients land in tasks 5.3 – 5.49.
 * The current scaffold proves the env → listen path end-to-end with
 * health/readiness probes and constructs the Core/AppView clients that
 * Brain composition reuses.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { AppViewClient, StagingDrainScheduler } from '@dina/brain';
import type { AskCoordinator } from '@dina/brain';
import { installNodeTraceScopeStorage } from '@dina/brain/node-trace-storage';
import {
  buildHomeNodeAskRuntime,
  type HomeNodeAskRuntime,
  type HomeNodeAskRuntimeOptions,
} from '@dina/home-node/ask-runtime';
import type { HomeNodeRuntime } from '@dina/home-node';
import {
  buildHomeNodeServiceRuntime,
  type HomeNodeServiceRuntime,
  type HomeNodeServiceRuntimeOptions,
} from '@dina/home-node/service-runtime';
import type { CoreClient } from '@dina/core';

import { buildCoreClient, type CoreClientStatus } from './core_client';
import { loadConfig, type BrainServerConfig } from './config';
import { buildBrainServerLLMRuntime } from './llm_provider';
import { createLogger, type Logger } from './logger';
import { registerAskRoutes } from './routes/ask';

export interface BrainServerClients {
  appView: AppViewClient;
  core?: CoreClient;
}

export interface BrainServerDependencyStatus {
  appView: 'configured';
  core: CoreClientStatus;
  askRoutes: 'configured' | 'disabled';
  serviceRuntime: 'configured' | 'disabled';
  stagingDrain: 'running' | 'disabled';
  runtime: 'pending';
}

export interface BrainServerSchedulers {
  stagingDrain?: StagingDrainScheduler;
}

export interface BrainServerCompositions {
  ask?: HomeNodeAskRuntime;
  service?: HomeNodeServiceRuntime;
}

export interface BootedServer {
  app: FastifyInstance;
  logger: Logger;
  config: BrainServerConfig;
  clients: BrainServerClients;
  schedulers: BrainServerSchedulers;
  compositions: BrainServerCompositions;
  dependencyStatus: BrainServerDependencyStatus;
  /** Present once server boot is wired to the shared Home Node runtime. */
  runtime?: HomeNodeRuntime;
  /** The socket address Fastify is listening on (e.g. "127.0.0.1:18200"). */
  boundAddress: string;
}

export interface BrainServerBootOptions {
  /** Already-composed ask coordinator. When supplied, boot registers /api/v1/ask routes. */
  askCoordinator?: AskCoordinator;
  /**
   * Server-resolved ask runtime dependencies. When supplied with a
   * configured Core client, boot builds the real Pattern A coordinator
   * from Core/AppView/LLM/approval dependencies and registers routes.
   * Explicit `askCoordinator` wins when both are supplied.
   */
  askRuntime?: HomeNodeAskRuntimeOptions;
  /**
   * Server-resolved service runtime dependencies. When supplied with a
   * configured Core client, boot composes the same shared Brain service
   * primitives mobile uses. Omit to keep service handling explicitly disabled.
   */
  serviceRuntime?: HomeNodeServiceRuntimeOptions;
  /** Route prefix for ask routes. Defaults to /api/v1. */
  askRoutePrefix?: string;
  /** Test hook for the staging-drain cadence timer. Production uses Node globals. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  /** Test hook paired with `setInterval`. */
  clearInterval?: (handle: unknown) => void;
}

export async function bootServer(
  env: NodeJS.ProcessEnv = process.env,
  options: BrainServerBootOptions = {},
): Promise<BootedServer> {
  installNodeTraceScopeStorage();

  // 1. config.
  const config = loadConfig(env);

  // 2. logger.
  const logger = createLogger(config);
  logger.info({ host: config.network.host, port: config.network.port }, 'brain-server boot');

  // 4. core_client. Missing key material keeps readiness red; it does
  // not install a dummy signer or fake Core client.
  const coreResult = await buildCoreClient(config.core);
  if (coreResult.status === 'configured') {
    logger.info(
      { did: coreResult.did, keyFingerprint: coreResult.keyFingerprint },
      'brain-server Core client configured',
    );
  } else {
    logger.warn(
      { status: coreResult.status, detail: coreResult.detail },
      'brain-server Core client not configured',
    );
  }

  // 5. appview_client. Constructing the client is side-effect-free; it
  // stores the endpoint and fetch handle but does not touch the network
  // until Brain tools ask it to search/resolve.
  const clients: BrainServerClients = {
    appView: new AppViewClient({
      appViewURL: config.endpoints.appViewBaseUrl,
    }),
  };
  if (coreResult.core !== undefined) {
    clients.core = coreResult.core;
  }
  const schedulers: BrainServerSchedulers = {};
  const compositions: BrainServerCompositions = {};
  const dependencyStatus: BrainServerDependencyStatus = {
    appView: 'configured',
    core: coreResult.status,
    askRoutes: 'disabled',
    serviceRuntime: 'disabled',
    stagingDrain: 'disabled',
    runtime: 'pending',
  };

  if (clients.core !== undefined) {
    const stagingDrain = new StagingDrainScheduler({
      core: clients.core,
      logger: (entry) => logger.info(entry, 'brain-server staging drain'),
      onError: (err) => {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'brain-server staging drain tick failed',
        );
      },
      ...(options.setInterval !== undefined ? { setInterval: options.setInterval } : {}),
      ...(options.clearInterval !== undefined ? { clearInterval: options.clearInterval } : {}),
    });
    schedulers.stagingDrain = stagingDrain;
  }

  // fastify_start (scaffold — full route binding in tasks 5.3 – 5.49).
  const app = Fastify({ logger: false }); // we manage our own logger
  app.addHook('onClose', async () => {
    schedulers.stagingDrain?.stop();
    await compositions.service?.dispose();
  });
  app.get('/healthz', async () => ({ status: 'ok', role: 'brain' }));

  if (options.serviceRuntime !== undefined) {
    if (clients.core === undefined) {
      logger.warn(
        { core: dependencyStatus.core },
        'brain-server service runtime disabled because Core client is not configured',
      );
    } else {
      const serviceSetInterval = options.serviceRuntime.setInterval ?? options.setInterval;
      const serviceClearInterval = options.serviceRuntime.clearInterval ?? options.clearInterval;
      compositions.service = buildHomeNodeServiceRuntime({
        ...options.serviceRuntime,
        core: clients.core,
        appView: clients.appView,
        ...(serviceSetInterval !== undefined ? { setInterval: serviceSetInterval } : {}),
        ...(serviceClearInterval !== undefined ? { clearInterval: serviceClearInterval } : {}),
        logger: (entry) => {
          options.serviceRuntime?.logger?.(entry);
          logger.info(entry, 'brain-server service');
        },
      });
      dependencyStatus.serviceRuntime = 'configured';
      logger.info('brain-server service runtime configured');
    }
  }

  const askRuntime = options.askRuntime ?? buildBrainServerLLMRuntime(config.llm);
  let askCoordinator = options.askCoordinator;
  if (askCoordinator === undefined && askRuntime !== undefined) {
    if (clients.core === undefined) {
      logger.warn(
        { core: dependencyStatus.core },
        'brain-server ask coordinator disabled because Core client is not configured',
      );
    } else {
      const ask = buildHomeNodeAskRuntime({
        ...askRuntime,
        core: clients.core,
        appView: clients.appView,
        logger: (entry) => logger.info(entry, 'brain-server ask'),
      });
      compositions.ask = ask;
      askCoordinator = ask.coordinator;
      logger.info(
        { providerName: askRuntime.providerName },
        'brain-server ask coordinator configured',
      );
    }
  }
  if (askCoordinator !== undefined) {
    registerAskRoutes(app, {
      coordinator: askCoordinator,
      ...(options.askRoutePrefix !== undefined ? { prefix: options.askRoutePrefix } : {}),
    });
    dependencyStatus.askRoutes = 'configured';
  }
  app.get('/readyz', async (_req, reply) => {
    await reply.code(503).send({
      status: 'not_ready',
      role: 'brain',
      checks: {
        appView: 'ok',
        core: dependencyStatus.core === 'configured' ? 'ok' : 'fail',
        askRoutes: dependencyStatus.askRoutes === 'configured' ? 'ok' : 'disabled',
        serviceRuntime:
          dependencyStatus.serviceRuntime === 'configured' ? 'ok' : 'disabled',
        stagingDrain: dependencyStatus.stagingDrain === 'running' ? 'ok' : 'disabled',
        runtime: 'fail',
      },
    });
  });

  const boundAddress = await app.listen({
    host: config.network.host,
    port: config.network.port,
  });
  if (schedulers.stagingDrain !== undefined) {
    schedulers.stagingDrain.start();
    dependencyStatus.stagingDrain = 'running';
  }
  compositions.service?.start();
  logger.info({ boundAddress }, 'brain-server listening');

  return { app, logger, config, clients, schedulers, compositions, dependencyStatus, boundAddress };
}
