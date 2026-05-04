/**
 * Task 4.3 — ordered boot sequence.
 *
 * The Home Node Core server boots in a strict, documented sequence.
 * Each step's prereqs (the state it depends on being built) come from
 * the **preceding** step — crossing the order is an invariant
 * violation. Keeping the steps explicit + traced means:
 *   - a boot failure logs exactly which step crashed
 *   - ops reading the process start log can confirm at a glance that
 *     every step ran
 *   - a test or mock can override any single step without touching
 *     the others
 *
 * **Canonical ordering (per HOME_NODE_LITE_TASKS.md task 4.3)**:
 *
 *   1. `config`        — env → typed config (task 4.4-4.5)
 *   2. `identity`      — DID + root signing key loaded / generated
 *                        (task 4.51-4.57; pending)
 *   3. `keystore`      — operator keys available to adapters
 *                        (uses `@dina/adapters-node` FileKeystore)
 *   4. `db_open`       — SQLCipher opened with current schema
 *                        (task 3.6-3.19; pending on storage-node)
 *   5. `adapter_wire`  — core's DI points receive fs, crypto, keystore,
 *                        net, db adapters
 *   6. `core_router`   — `@dina/core`'s CoreRouter assembled with all
 *                        handlers registered
 *   7. `fastify_start` — bind_core_router onto Fastify + listen
 *   8. `msgbox_connect`— WS client to `DINA_MSGBOX_URL`
 *
 * Steps that aren't yet implementable are listed as `'pending'` in
 * `BootStepResult` — present in the trace + /readyz diagnostics, but
 * no-op at runtime.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4a task 4.3.
 */

import type { Logger } from './logger';
import type { LoadedCoreServerConfig } from './config';
import { createCoreRouter, deriveDIDKey, HEALTHZ_PATH, type CoreRouter } from '@dina/core';
import {
  bootstrapMsgBox,
  disconnectMsgBox,
  isMsgBoxAuthenticated,
  type MsgBoxBootConfig,
  type WSFactory,
} from '@dina/core/runtime';
import { makeNodeWebSocketFactory } from '@dina/net-node';
import { createLogger } from './logger';
import { createServer } from './server';
import { loadOrGenerateSeed, type SeedSource } from './identity/master_seed';
import { deriveIdentity } from './identity/derivations';
import { bindCoreRouter } from './server/bind_core_router';

/** The canonical sequence — enumerated once, consulted everywhere. */
export const BOOT_STEPS = [
  'config',
  'identity',
  'keystore',
  'db_open',
  'adapter_wire',
  'core_router',
  'fastify_start',
  'msgbox_connect',
] as const;

export type BootStep = (typeof BOOT_STEPS)[number];

export type BootStepStatus = 'ok' | 'pending' | 'failed';

export interface BootStepResult {
  step: BootStep;
  status: BootStepStatus;
  /** Duration of the step in ms. Always populated. */
  elapsedMs: number;
  /** Present when status === 'failed'. */
  error?: string;
  /** Present when status === 'pending' — explains why. */
  pendingReason?: string;
}

export interface BootTrace {
  steps: BootStepResult[];
  /** Total elapsed ms from step 1 start to last step end. */
  totalMs: number;
  /** True when every step is 'ok' or 'pending' (never 'failed'). */
  ok: boolean;
}

export interface BootedServer {
  config: LoadedCoreServerConfig;
  logger: Logger;
  app: Awaited<ReturnType<typeof createServer>>;
  coreRouter: CoreRouter;
  routesBound: number;
  trace: BootTrace;
  msgbox: MsgBoxBootState;
  /** Result of task 4.51's seed load/generate. `undefined` when the
   *  identity step is still pending in this process (wrapped-seed case
   *  before task 4.53 unwraps). */
  identity?: SeedSource;
}

export type MsgBoxBootStatus = 'connected' | 'pending';

export interface MsgBoxBootState {
  status: MsgBoxBootStatus;
  url: string;
  did?: string;
  pendingReason?: string;
}

export interface BootServerOptions {
  /** Test hook / alternate runtime hook. Production uses `@dina/net-node`. */
  msgboxWsFactory?: WSFactory;
  /** Initial MsgBox auth wait. Production default: 10s. Tests can shorten. */
  msgboxReadyTimeoutMs?: number;
  /** Sender resolver for inbound D2D. Defaults fail-closed with unknown trust. */
  resolveMsgBoxSender?: MsgBoxBootConfig['resolveSender'];
}

// ---------------------------------------------------------------------------
// Boot runner
// ---------------------------------------------------------------------------

/**
 * Execute the boot sequence. Each step is timed + traced. A failure
 * rethrows — callers (bin.ts) decide whether to exit. A 'pending'
 * step logs an info message + continues.
 */
export async function bootServer(options: BootServerOptions = {}): Promise<BootedServer> {
  const trace: BootStepResult[] = [];
  const start = Date.now();

  // Step 1: config — special-cased because it produces the logger's
  // inputs, so runs before the logger exists.
  const configStart = Date.now();
  let config: LoadedCoreServerConfig;
  try {
    config = (await import('./config')).loadConfig();
  } catch (err) {
    trace.push({
      step: 'config',
      status: 'failed',
      elapsedMs: Date.now() - configStart,
      error: (err as Error).message,
    });
    throw err;
  }
  trace.push({
    step: 'config',
    status: 'ok',
    elapsedMs: Date.now() - configStart,
  });

  const logger = createLogger(config);
  logger.info(
    {
      host: config.network.host,
      port: config.network.port,
      logLevel: config.runtime.logLevel,
    },
    'core-server booting',
  );

  // Step 2 (task 4.51 + 4.52): identity — load or first-boot-generate
  // the master seed. Convenience mode (raw keyfile) lands here;
  // wrapped-seed (task 4.53) returns a placeholder that leaves the
  // step 'pending' until a later upstream unwrap completes.
  const identityStart = Date.now();
  let identity: SeedSource | undefined;
  try {
    identity = await loadOrGenerateSeed(config.storage.vaultDir);
  } catch (err) {
    trace.push({
      step: 'identity',
      status: 'failed',
      elapsedMs: Date.now() - identityStart,
      error: (err as Error).message,
    });
    throw err;
  }
  if (identity.kind === 'wrapped') {
    trace.push({
      step: 'identity',
      status: 'pending',
      elapsedMs: Date.now() - identityStart,
      pendingReason: 'wrapped_seed.bin found; passphrase-unwrap step pending (task 4.53)',
    });
  } else {
    trace.push({
      step: 'identity',
      status: 'ok',
      elapsedMs: Date.now() - identityStart,
    });
    if (identity.kind === 'generated') {
      // First-boot flow: operator must see the mnemonic ONCE. Logged
      // at warn level so it stands out; the install script wraps this
      // path with better UX (prints a banner, waits for enter, etc).
      logger.warn(
        { mnemonic: identity.mnemonic },
        'first-boot: generated master seed; write down this mnemonic',
      );
    }
  }
  trace.push({
    step: 'keystore',
    status: 'pending',
    elapsedMs: 0,
    pendingReason: '@dina/adapters-node FileKeystore wiring pending identity',
  });
  trace.push({
    step: 'db_open',
    status: 'pending',
    elapsedMs: 0,
    pendingReason: '@dina/storage-node concrete adapter pending (Phase 3a)',
  });
  trace.push({
    step: 'adapter_wire',
    status: 'pending',
    elapsedMs: 0,
    pendingReason: 'waits on identity + keystore + db above',
  });

  // Step 6: core_router. The transport-independent CoreRouter is
  // usable now; storage-backed adapters still land behind the pending
  // adapter/db steps above. This gives the server the real Core HTTP
  // surface instead of health-only scaffolding while keeping readiness
  // honest about missing storage/MsgBox.
  const coreRouterStart = Date.now();
  let coreRouter: CoreRouter;
  try {
    coreRouter = createCoreRouter();
  } catch (err) {
    trace.push({
      step: 'core_router',
      status: 'failed',
      elapsedMs: Date.now() - coreRouterStart,
      error: (err as Error).message,
    });
    throw err;
  }
  trace.push({
    step: 'core_router',
    status: 'ok',
    elapsedMs: Date.now() - coreRouterStart,
  });

  // Step 7: fastify_start — this runs today, even without the earlier
  // dependencies, so /healthz + /readyz are reachable.
  const fastifyStart = Date.now();
  let app: Awaited<ReturnType<typeof createServer>>;
  let routesBound = 0;
  let msgboxState: MsgBoxBootState = {
    status: 'pending',
    url: config.msgbox.url,
    pendingReason: 'MsgBox connection has not started yet',
  };
  try {
    app = await createServer({
      config,
      logger,
      readinessChecks: [
        { name: 'core_router', probe: () => routesBound > 0 },
        {
          name: 'msgbox',
          probe: () => isMsgBoxAuthenticated(),
        },
      ],
    });
    app.addHook('onClose', async () => {
      await disconnectMsgBox();
    });
    routesBound = bindCoreRouter({
      coreRouter,
      app,
      skipRoutes: [{ method: 'GET', path: HEALTHZ_PATH }],
    });
    await app.listen({ host: config.network.host, port: config.network.port });
  } catch (err) {
    trace.push({
      step: 'fastify_start',
      status: 'failed',
      elapsedMs: Date.now() - fastifyStart,
      error: (err as Error).message,
    });
    throw err;
  }
  trace.push({
    step: 'fastify_start',
    status: 'ok',
    elapsedMs: Date.now() - fastifyStart,
  });

  // Step 8: msgbox_connect — every greenfield Home Node connects to the
  // hosted MsgBox fleet by default. Wrapped-seed boot cannot derive the
  // root signing key yet, so that path remains explicitly pending.
  const msgboxStart = Date.now();
  if (!config.msgbox.enabled) {
    msgboxState = {
      status: 'pending',
      url: config.msgbox.url,
      pendingReason: 'disabled by DINA_MSGBOX_ENABLED=false',
    };
    trace.push({
      step: 'msgbox_connect',
      status: 'pending',
      elapsedMs: Date.now() - msgboxStart,
      pendingReason: msgboxState.pendingReason,
    });
  } else if (identity === undefined || identity.kind === 'wrapped') {
    msgboxState = {
      status: 'pending',
      url: config.msgbox.url,
      pendingReason: 'root signing key unavailable until wrapped seed is unsealed',
    };
    trace.push({
      step: 'msgbox_connect',
      status: 'pending',
      elapsedMs: Date.now() - msgboxStart,
      pendingReason: msgboxState.pendingReason,
    });
  } else {
    try {
      await disconnectMsgBox();
      const derivations = deriveIdentity({ masterSeed: identity.seed });
      const did = config.msgbox.homeNodeDid ?? deriveDIDKey(derivations.root.publicKey);
      await bootstrapMsgBox({
        did,
        privateKey: derivations.root.privateKey,
        msgboxURL: config.msgbox.url,
        wsFactory: options.msgboxWsFactory ?? makeNodeWebSocketFactory(),
        coreRouter,
        resolveSender:
          options.resolveMsgBoxSender ??
          (async () => ({
            keys: [],
            trust: 'unknown',
          })),
        readyTimeoutMs: options.msgboxReadyTimeoutMs ?? 10_000,
      });
      msgboxState = {
        status: 'connected',
        url: config.msgbox.url,
        did,
      };
      trace.push({
        step: 'msgbox_connect',
        status: 'ok',
        elapsedMs: Date.now() - msgboxStart,
      });
    } catch (err) {
      const pendingReason = `MsgBox connect failed; relay retry/degraded mode active: ${
        (err as Error).message
      }`;
      msgboxState = {
        status: 'pending',
        url: config.msgbox.url,
        pendingReason,
      };
      trace.push({
        step: 'msgbox_connect',
        status: 'pending',
        elapsedMs: Date.now() - msgboxStart,
        pendingReason,
      });
      logger.warn({ err: (err as Error).message, url: config.msgbox.url }, pendingReason);
    }
  }

  const bootTrace: BootTrace = {
    steps: trace,
    totalMs: Date.now() - start,
    ok: trace.every((s) => s.status !== 'failed'),
  };

  logger.info(
    {
      steps: bootTrace.steps.map((s) => ({ step: s.step, status: s.status })),
      totalMs: bootTrace.totalMs,
    },
    'boot sequence complete',
  );

  return identity !== undefined
    ? {
        config,
        logger,
        app,
        coreRouter,
        routesBound,
        trace: bootTrace,
        msgbox: msgboxState,
        identity,
      }
    : {
        config,
        logger,
        app,
        coreRouter,
        routesBound,
        trace: bootTrace,
        msgbox: msgboxState,
      };
}
