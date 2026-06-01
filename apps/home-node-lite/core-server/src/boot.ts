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
import {
  createCoreRouter,
  deriveDIDKey,
  HEALTHZ_PATH,
  registerService,
  setNodeDID,
  type CoreRouter,
} from '@dina/core';
import { makeResolveSender } from '@dina/home-node';
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
import {
  loadOrProvisionPdsIdentity,
  type PdsIdentity,
} from './identity/provision_pds';
import {
  wireServiceProfilePublisher,
  publishOnce,
  type WiredServicePublisher,
} from './appview/wire_publisher';
import {
  wireWorkflowPlane,
  type WiredWorkflowPlane,
} from './workflow/wire_workflow_plane';
import type { DatabaseAdapter } from '@dina/core/storage';
import { listServiceConfigs } from '@dina/core';
import { bindCoreRouter } from './server/bind_core_router';
import { initializeStorage } from './storage/init';

/** The canonical sequence — enumerated once, consulted everywhere. */
export const BOOT_STEPS = [
  'config',
  'identity',
  'keystore',
  // Optional — only present in the trace when DINA_PDS_PROVISION=1
  // is set. Runs between keystore and db_open conceptually; we keep
  // it after keystore in the canonical list so /readyz output stays
  // in chronological order regardless of whether the operator opted
  // in to PDS-backed identity.
  'pds_provision',
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

  // Register configured service DIDs (currently just `brain`) into
  // `@dina/core`'s caller-type registry. Without this, signed
  // requests from brain-server resolve to `callerType: 'unknown'`
  // and Core's auth middleware rejects with 403 "Cannot determine
  // authorization role for unknown/unknown" — which is exactly the
  // staging-ingest failure mode that surfaced when wiring the web
  // UI's /remember end-to-end. install-lite supplies DINA_BRAIN_DID
  // alongside the brain seed it generates; the Playwright paired-
  // stack does the same.
  if (config.services?.brainDid !== undefined) {
    registerService(config.services.brainDid, 'brain');
    logger.info({ brainDid: config.services.brainDid }, 'brain service DID registered');
  }

  // Admin service registration. `/v1/pair/initiate` and other
  // device-management routes are admin-only by authz policy; lite by
  // default ships without an admin key so those routes 403. When
  // DINA_ADMIN_DID is set (operator opts in for ops automation +
  // bus-driver pairing flows), register it so the holder can mint
  // pairing codes etc.
  const adminDid = (process.env.DINA_ADMIN_DID ?? '').trim();
  if (adminDid !== '') {
    registerService(adminDid, 'admin');
    logger.info({ adminDid }, 'admin service DID registered');
  }

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

  // PDS provisioning — analog of mobile onboarding's `provisionIdentity`
  // for the Node runtime. Off by default (DINA_PDS_PROVISION=1 +
  // DINA_PDS_HANDLE required) so existing did:key dev deployments keep
  // working unchanged. When ON, mints (or rehydrates) an atproto
  // account on test-pds.dinakernel.com and persists the did:plc + creds
  // to <vaultDir>/pds_identity.json. Subsequent boots load the file and
  // skip the network call.
  //
  // Why behind a flag: most lite deployments are dev-only and shouldn't
  // create PDS accounts. Operators who want their lite stack to act as
  // a real service provider (publish service.profile to AppView) flip
  // the flag once at install time.
  let pdsIdentity: PdsIdentity | undefined;
  const pdsProvisionEnabled =
    (process.env.DINA_PDS_PROVISION ?? '').trim() === '1' &&
    (process.env.DINA_PDS_HANDLE ?? '').trim() !== '';
  const pdsStartGlobal = Date.now();
  if (!pdsProvisionEnabled) {
    // Always emit a `pds_provision` trace entry so the boot trace
    // shape matches `BOOT_STEPS` exactly. Operators who haven't
    // opted in get a 'pending' status with a clear reason; the boot
    // continues using the locally-derived did:key identity.
    trace.push({
      step: 'pds_provision',
      status: 'pending',
      elapsedMs: Date.now() - pdsStartGlobal,
      pendingReason: 'DINA_PDS_PROVISION not set — using local did:key identity',
    });
  }
  if (pdsProvisionEnabled) {
    const pdsStart = Date.now();
    if (
      identity !== undefined &&
      (identity.kind === 'loaded_convenience' || identity.kind === 'generated')
    ) {
      try {
        const derivations = deriveIdentity({ masterSeed: identity.seed });
        pdsIdentity = await loadOrProvisionPdsIdentity({
          vaultDir: config.storage.vaultDir,
          identity: derivations,
          masterSeed: identity.seed,
          pdsUrl: config.endpoints.pdsBaseUrl,
          handle: (process.env.DINA_PDS_HANDLE ?? '').trim(),
          msgboxEndpoint: config.msgbox.url,
          signingPublicKey: derivations.root.publicKey,
          plcURL: config.endpoints.plcDirectoryUrl,
          ...(process.env.DINA_PDS_EMAIL !== undefined
            ? { email: process.env.DINA_PDS_EMAIL.trim() }
            : {}),
        });
        trace.push({
          step: 'pds_provision',
          status: 'ok',
          elapsedMs: Date.now() - pdsStart,
        });
        logger.info(
          { did: pdsIdentity.did, handle: pdsIdentity.handle, pdsUrl: pdsIdentity.pdsUrl },
          'PDS identity loaded/provisioned',
        );
        // Pairing ceremony embeds the node's DID in every pair code so
        // pairing devices know which home node they're joining. With
        // a PDS-provisioned did:plc, that's our canonical identity.
        setNodeDID(pdsIdentity.did);
      } catch (err) {
        // Don't take down the whole boot if PDS is unreachable — surface
        // it as a degradation so /readyz reports honestly + downstream
        // service publishing reflects the broken state. This keeps the
        // lite stack usable for non-provider duties even when test-pds
        // is offline.
        trace.push({
          step: 'pds_provision',
          status: 'failed',
          elapsedMs: Date.now() - pdsStart,
          error: (err as Error).message,
        });
        logger.warn(
          { error: (err as Error).message },
          'PDS provisioning failed; continuing without a did:plc identity',
        );
      }
    } else {
      trace.push({
        step: 'pds_provision',
        status: 'pending',
        elapsedMs: Date.now() - pdsStart,
        pendingReason: 'master seed not materialized (wrapped-seed mode)',
      });
    }
  }

  // Holds the publisher pipeline (PDS session + ServiceProfilePublisher
  // + onServiceConfigChanged subscriber) when PDS provisioning succeeded.
  // Wired AFTER db_open since the config listener reads from the SQLite
  // KV repo, which db_open initializes.
  let wiredPublisher: WiredServicePublisher | undefined;
  // Workflow + service-query plane (repo + WorkflowService + sweepers +
  // runtime). Wired AFTER core_router because the runtime's
  // InProcessTransport dispatches through the router. Captured during
  // db_open and re-used once the router is ready.
  let wiredWorkflow: WiredWorkflowPlane | undefined;
  // Captured during db_open; consumed in the post-core_router wiring
  // block once the CoreRouter is available.
  let identityDBForWorkflow: DatabaseAdapter | undefined;

  // Step 4 (db_open): SQLite persistence via `@dina/storage-node`. We
  // only do this when the master seed is materialized (convenience or
  // generated mode). Wrapped-seed mode defers until a later unwrap.
  const dbStart = Date.now();
  if (
    identity !== undefined &&
    (identity.kind === 'loaded_convenience' || identity.kind === 'generated')
  ) {
    try {
      const result = await initializeStorage(identity.seed, config.storage.vaultDir, logger);
      trace.push({
        step: 'db_open',
        status: 'ok',
        elapsedMs: Date.now() - dbStart,
      });
      trace.push({
        step: 'adapter_wire',
        status: 'ok',
        elapsedMs: 0,
      });
      logger.info(
        { openedPersonas: result.openedPersonas },
        'SQLite repositories wired into Core service modules',
      );

      // Layer 2: wire the service-profile publisher pipeline. Only
      // runs when PDS provisioning succeeded (`pdsIdentity` set). The
      // publisher subscribes to `onServiceConfigChanged` so every
      // `PUT /v1/service/config` triggers a real PDS write +
      // AppView indexing. If no service config is persisted yet,
      // nothing publishes — the listener fires the first publish
      // when the operator saves a config.
      if (pdsIdentity !== undefined) {
        wiredPublisher = wireServiceProfilePublisher({ pdsIdentity, logger });
        // If listings were already persisted from a prior boot, fire an
        // immediate publish for EACH (multi-listing: one record per rkey) so
        // the AppView reflects current state without waiting for an edit.
        for (const { rkey, config } of listServiceConfigs()) {
          if (!config.isDiscoverable) continue;
          void publishOnce(wiredPublisher.publisher, pdsIdentity, config, logger, rkey);
        }
        // Workflow plane wiring needs the CoreRouter (created in the
        // next boot step), so stash the identityDB now and let the
        // post-core_router block run wireWorkflowPlane.
        identityDBForWorkflow = result.identityDB;
      }
    } catch (err) {
      trace.push({
        step: 'db_open',
        status: 'failed',
        elapsedMs: Date.now() - dbStart,
        error: (err as Error).message,
      });
      throw err;
    }
  } else {
    trace.push({
      step: 'db_open',
      status: 'pending',
      elapsedMs: 0,
      pendingReason: 'wrapped-seed identity not yet unwrapped',
    });
    trace.push({
      step: 'adapter_wire',
      status: 'pending',
      elapsedMs: 0,
      pendingReason: 'waits on identity + db above',
    });
  }

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

  // Workflow plane — wired post-core_router (the runtime's
  // InProcessTransport needs the router) but BEFORE fastify_start so
  // every bound HTTP route already sees the singletons set. Without
  // this, /v1/workflow/tasks/* and /v1/service/* return 503 even
  // though they're routable.
  if (
    pdsIdentity !== undefined &&
    identity !== undefined &&
    (identity.kind === 'loaded_convenience' || identity.kind === 'generated') &&
    identityDBForWorkflow !== undefined
  ) {
    const derivations = deriveIdentity({ masterSeed: identity.seed });
    wiredWorkflow = wireWorkflowPlane({
      identityDB: identityDBForWorkflow,
      pdsIdentity,
      signingKeypair: {
        publicKey: derivations.root.publicKey,
        privateKey: derivations.root.privateKey,
      },
      msgboxURL: config.msgbox.url,
      appViewURL: config.endpoints.appViewBaseUrl,
      coreRouter,
      logger,
    });
  }

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
      if (wiredWorkflow !== undefined) {
        await wiredWorkflow.dispose();
      }
      if (wiredPublisher !== undefined) {
        wiredPublisher.dispose();
      }
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
      // Prefer the PDS-provisioned did:plc when available — that's the
      // DID published in our service profile + the one peers seal to.
      // Falls back to env override, then the local did:key for
      // dev-only setups that never minted a did:plc.
      const did =
        pdsIdentity?.did ??
        config.msgbox.homeNodeDid ??
        deriveDIDKey(derivations.root.publicKey);
      // Build a real resolveSender so the receive pipeline can verify
      // inbound signatures. Without this every D2D arrival fails at
      // step 2 (signature check) — including our own loopbacks, which
      // is why a self-targeted service.query silently drops. Shared
      // helper with mobile's `makeResolveSender`.
      const resolveSender =
        options.resolveMsgBoxSender ??
        makeResolveSender({
          selfDID: did,
          selfPublicKey: derivations.root.publicKey,
        });
      await bootstrapMsgBox({
        did,
        privateKey: derivations.root.privateKey,
        msgboxURL: config.msgbox.url,
        wsFactory: options.msgboxWsFactory ?? makeNodeWebSocketFactory(),
        coreRouter,
        resolveSender,
        // Hand bypassed service.query / service.response D2D envelopes
        // into the workflow plane's local dispatcher. Without this the
        // receive pipeline validates + decrypts inbound queries and
        // then silently discards them — handler never fires, no
        // workflow_task minted.
        ...(wiredWorkflow !== undefined
          ? { onBypassedD2D: wiredWorkflow.onBypassedD2D.bind(wiredWorkflow) }
          : {}),
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
