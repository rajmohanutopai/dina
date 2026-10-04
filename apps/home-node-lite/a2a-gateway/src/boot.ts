/**
 * Boot: config → logger → service key → Core link → server → listen →
 * delivery loop (design §7.5). Closing the server stops the loop (letting
 * webhook POSTs in flight finish and reporting them) and ends every stream.
 *
 * The gateway refuses to start without its own service key, and checks the
 * key against the DID Core registered when one is configured: a gateway that
 * signs as anyone else would only collect Core's refusals.
 */

import { createA2AHostTransport } from '@dina/net-node';

import { loadConfig, type GatewayConfig } from './config';
import { createCoreLink } from './core_link';
import { DeliveryPump } from './delivery_pump';
import { EdgeLimiter } from './edge_limit';
import { createLogger, type Logger } from './logger';
import { buildGatewayServer } from './server';
import { loadServiceKey } from './service_key';
import { StreamHub } from './stream_hub';

import type { FastifyInstance } from 'fastify';

export interface BootedGateway {
  app: FastifyInstance;
  logger: Logger;
  config: GatewayConfig;
  did: string;
}

export class ServiceKeyError extends Error {
  constructor(readonly reason: string) {
    super(`a2a-gateway service key: ${reason}`);
    this.name = 'ServiceKeyError';
  }
}

export async function bootGateway(env: NodeJS.ProcessEnv = process.env): Promise<BootedGateway> {
  const config = loadConfig(env);
  const logger = createLogger(config);
  const key = await loadServiceKey(config.serviceKey.dir, config.serviceKey.file, config.serviceKey.did);
  if (!key.ok) throw new ServiceKeyError(key.reason);
  const core = createCoreLink({ baseUrl: config.core.baseUrl, key: key.key, timeoutMs: config.core.timeoutMs });
  const hub = new StreamHub({
    maxStreams: config.streams.max,
    bufferMs: 30_000,
    bufferEvents: 64,
    bufferTasks: 10_000,
    bufferBytes: 8 * 1024 * 1024,
  });
  const app = buildGatewayServer({
    core,
    limiter: new EdgeLimiter(config.limits.perIpPerMinute),
    logger,
    cardCacheMs: config.limits.cardCacheMs,
    trustProxy: config.network.trustProxy,
    hub,
    streams: config.streams,
  });
  const pump = new DeliveryPump({ core, hub, transport: createA2AHostTransport(), logger, ...config.delivery });
  // Before the server closes: it waits for every open connection, and a
  // stream never goes idle, so ending the streams afterwards would wait on
  // itself. Stop claiming (in-flight webhook POSTs finish and are reported),
  // then end every stream; clients recover with GetTask (§7.5).
  app.addHook('preClose', async () => {
    await pump.stop();
    hub.closeAll();
  });
  await app.listen({ host: config.network.host, port: config.network.port });
  pump.start();
  logger.info({ host: config.network.host, port: config.network.port, did: key.key.did }, 'a2a gateway listening');
  return { app, logger, config, did: key.key.did };
}
