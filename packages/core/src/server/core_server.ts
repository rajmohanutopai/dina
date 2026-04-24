/**
 * Core surface — a pure-function CoreRouter, no Express.
 *
 * Dina-mobile runs under Expo's managed workflow, which forbids Node
 * HTTP servers. Every transport (Brain↔Core in-process, MsgBox RPC
 * inbound from paired devices) adapts to this router via
 * `createInProcessDispatch`. Tests call `handleCoreRequest` directly.
 *
 * A cloud-hosted variant of Dina-as-a-Home-Node on a server would layer
 * an Express or Fastify adapter on top — but that's a separate build
 * target, not something the mobile app ships with.
 */

import { CoreRouter } from './router';
import { registerVaultRoutes } from './routes/vault';
import { registerStagingRoutes } from './routes/staging';
import { registerPIIRoutes } from './routes/pii';
import { registerDevicesRoutes } from './routes/devices';
import { registerD2DMsgRoutes } from './routes/d2d_msg';
import { registerServiceConfigRoutes } from './routes/service_config';
import { registerWorkflowRoutes } from './routes/workflow';
import { registerServiceQueryRoutes, type ServiceQueryRouteOptions } from './routes/service_query';
import {
  registerServiceRespondRoutes,
  type ServiceRespondRouteOptions,
} from './routes/service_respond';
import { registerMemoryRoutes } from './routes/memory';
import { registerContactsRoutes } from './routes/contacts';
import { registerPairRoutes } from './routes/pair';
import { registerScratchpadRoutes } from './routes/scratchpad';

import { CORE_DEFAULT_PORT } from '../constants';
export const DEFAULT_PORT = CORE_DEFAULT_PORT;
export const HEALTHZ_PATH = '/healthz';

export interface CoreRouterOptions {
  serviceQuery?: ServiceQueryRouteOptions;
  serviceRespond?: ServiceRespondRouteOptions;
}

/**
 * Build a CoreRouter with every mobile-MVP route registered. The
 * returned router is pure — hand it to `createInProcessDispatch`
 * (brain-side client) or the MsgBox RPC handler (inbound agent
 * requests). No HTTP server is started.
 */
export function createCoreRouter(options: CoreRouterOptions = {}): CoreRouter {
  const router = new CoreRouter();

  router.get(
    HEALTHZ_PATH,
    async () => ({
      status: 200,
      body: { status: 'ok', service: 'core', timestamp: new Date().toISOString() },
    }),
    { auth: 'public' },
  );

  registerVaultRoutes(router);
  registerStagingRoutes(router);
  registerPIIRoutes(router);
  registerDevicesRoutes(router);
  registerD2DMsgRoutes(router);
  registerServiceConfigRoutes(router);
  registerWorkflowRoutes(router);
  registerServiceQueryRoutes(router, options.serviceQuery);
  registerServiceRespondRoutes(router, options.serviceRespond);
  // Memory routes read from the module-global per-persona repo map
  // (populated by `openPersonaDB`) + the module-global MemoryService
  // (installed in bootstrap). No wiring options needed at router
  // construction time; see WM-CORE-09 + WM-CORE-10.
  registerMemoryRoutes(router);

  // Contacts HTTP surface (PC-CORE-10 + PC-CORE-11). Reads the
  // module-global contact directory; no options needed at router
  // construction time.
  registerContactsRoutes(router);

  // Device pairing — `/v1/pair/initiate` (admin) + `/v1/pair/complete`
  // (public, code-authenticated). Port of `dina-admin device pair`
  // so the docker openclaw + dina-cli flow has somewhere to pair
  // against. See `docker/openclaw/README.md`.
  registerPairRoutes(router);

  // Scratchpad — checkpoint/resume/clear for multi-step reasoning
  // tasks. Service auto-provisions an in-memory backend on first
  // use; production boot can swap in SQLiteScratchpadRepository via
  // `setScratchpadRepository(new SQLiteScratchpadRepository(db))`
  // before the first request. Python parity:
  // `brain/src/service/scratchpad.py` + Go's scratchpad adapter.
  registerScratchpadRoutes(router);

  return router;
}
