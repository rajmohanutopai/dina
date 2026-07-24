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

import {
  configureRateLimiter,
  createCoreRouter,
  deriveServiceKey,
  deriveDIDKey,
  getNodeDID,
  HEALTHZ_PATH,
  getWorkflowService,
  registerService,
  SQLiteWorkflowRepository,
  TaskExpirySweeper,
  setCodingPermitAuthority,
  setNodeDID,
  setWorkflowRepository,
  setWorkflowService,
  WorkflowService,
  type CoreRouter,
} from '@dina/core';
import { kvGet, kvSet } from '@dina/core/kv';
import { listServiceConfigs } from '@dina/core';
import {
  bootstrapMsgBox,
  disconnectMsgBox,
  isMsgBoxAuthenticated,
  type MsgBoxBootConfig,
  type WSFactory,
} from '@dina/core/runtime';
import { makeResolveSender } from '@dina/home-node';
import { makeNodeWebSocketFactory } from '@dina/net-node';

import {
  wireServiceProfilePublisher,
  publishOnce,
  shouldPublishListing,
  type WiredServicePublisher,
} from './appview/wire_publisher';
import { deriveIdentity } from './identity/derivations';
import { loadOrGenerateSeed, type SeedSource } from './identity/master_seed';
import { loadOrProvisionPdsIdentity, type PdsIdentity } from './identity/provision_pds';
import { createLogger } from './logger';
import { deliverBootstrapCapability, resolveHandoffFromEnv } from './pair/bootstrap_capability';
import { acquireLock, releaseLock, writeLock } from './core_lock';
import { createCodingGate } from './gate/coding_gate_impl';
import { createAgentFacades } from './agent/facades';
import { makeHttpAskHandler } from './agent/http_ask_handler';
import { PhoneApprovalMsgBoxClient, parsePhoneSetupCode } from './approval/phone_approval_msgbox';
import { PhoneApprovalSyncWorker } from './approval/phone_approval_sync';
import { createServer } from './server';
import { bindCoreRouter } from './server/bind_core_router';
import { registerDebugDispatch } from './server/debug_dispatch';
import { resolveOwnerCapability } from './server/owner_capability';
import { registerOwnerConsoleRoute } from './server/owner_console';
import { initializeStorage } from './storage/init';
import { wireWorkflowPlane, type WiredWorkflowPlane } from './workflow/wire_workflow_plane';

import type { LoadedCoreServerConfig } from './config';
import type { Logger } from './logger';
import type { DatabaseAdapter } from '@dina/core/storage';

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
  /**
   * Override the logger. Production leaves this unset (built from config).
   * Tests inject a capturing logger — e.g. to assert secrets never reach it.
   */
  logger?: Logger;
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

  const logger = options.logger ?? createLogger(config);
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

  // Per-DID auth rate limiter. The Fastify per-IP limiter (server.ts) already
  // honours DINA_RATE_LIMIT, but the auth middleware has a SEPARATE per-DID
  // limiter that defaults to ~50/min and was never configured here — so the
  // co-located Brain (which legitimately polls Core: the workflow-event
  // consumer @1s, the staging drain, the reminder fire loop, the ask
  // coordinator) trips it within a minute and every signed request 401s with
  // "Rate limit exceeded". Mobile already calls `configureRateLimiter` at boot
  // for exactly this reason; the lite Core server must too. Drive it from the
  // same DINA_RATE_LIMIT knob so one env var controls both layers.
  configureRateLimiter({
    maxRequests: config.runtime.rateLimitPerMinute,
    windowSeconds: 60,
  });
  logger.info(
    { maxRequestsPerMinute: config.runtime.rateLimitPerMinute },
    'per-DID auth rate limiter configured',
  );

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

  // Item 2c — ATOMICALLY acquire the single-owner lock BEFORE opening the vault
  // (two Cores sharing one vault's SQLite would corrupt state). O_EXCL create so
  // only one racing Core wins; a stale/own lock is recovered. Refreshed with the
  // real bound port + node DID after listen (writeLock below).
  acquireLock(config.storage.vaultDir, {
    pid: process.pid,
    host: config.network.host,
    port: 0,
    nodeDid: null,
    startedAtMs: Date.now(),
  });

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
      // First-boot flow: a new master seed was generated. The recovery phrase
      // (the mnemonic) is the seed, so it is NEVER logged — it is written to a
      // 0o600 file (master_seed.ts). Log only the file PATH (metadata) so the
      // operator or install script can surface it and then delete it.
      logger.warn(
        { recoveryPhraseFile: identity.recoveryPhrasePath },
        'first-boot: generated a new master seed. Recovery phrase written to a ' +
          '0600 file — record it offline and delete the file. It is never logged.',
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
    // Identity is FOUNDATIONAL (§8): the node DID must exist from first boot so
    // the pairing/enrolment ceremony (which embeds the node DID in every code)
    // works without a did:plc. Derive the did:key from the seed and set it as
    // the node DID. Previously `setNodeDID` ran only on the PDS path, so a plain
    // did:key boot had no node DID and could not pair.
    if (
      identity !== undefined &&
      (identity.kind === 'loaded_convenience' || identity.kind === 'generated')
    ) {
      const didKey = deriveDIDKey(deriveIdentity({ masterSeed: identity.seed }).root.publicKey);
      setNodeDID(didKey);
      logger.info({ nodeDid: didKey }, 'node identity: using local did:key (no PDS)');
    }
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
        // FAIL CLOSED — never fall back to a did:key identity. When the
        // operator opted into provisioning (`DINA_PDS_PROVISION=1` +
        // handle), this node is meant to be a real did:plc home node /
        // provider. Silently degrading to did:key was actively harmful:
        // a did:key node has no PDS repo, so it publishes nothing to the
        // AppView (invisible to discovery) and its D2D identity diverges
        // from any previously-registered did:plc — the exact failure that
        // left a provider stuck with stale pairings + empty discovery
        // after a disk/`/tmp` wipe. A loud abort forces the operator to
        // fix the root cause (PDS reachability / handle / seed) instead of
        // running a broken provider that looks up but answers nothing.
        trace.push({
          step: 'pds_provision',
          status: 'failed',
          elapsedMs: Date.now() - pdsStart,
          error: (err as Error).message,
        });
        logger.error(
          { error: (err as Error).message },
          'PDS provisioning failed and DINA_PDS_PROVISION=1 — aborting boot (no did:key fallback)',
        );
        throw new Error(
          `PDS provisioning failed for handle "${(process.env.DINA_PDS_HANDLE ?? '').trim()}": ` +
            `${(err as Error).message}. ` +
            'Refusing to fall back to a did:key identity (DINA_PDS_PROVISION=1). ' +
            'Fix PDS reachability / handle / seed and retry, or unset DINA_PDS_PROVISION ' +
            'only for a throwaway dev node.',
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

  // Item 2 — single-use bootstrap enrolment capability. On a genuine first boot
  // (a fresh seed was generated), mint ONE single-use `agent` pairing code and
  // hand it to the spawning plugin over an inherited fd — never a 0600 file,
  // never a log. No handoff fd → this boot was not spawned by an enrolling
  // plugin (dev / standalone), so nothing is minted and devices pair via the
  // normal admin/owner flow. The node DID is set above; the ceremony embeds it
  // in the code so the plugin knows which home node it is joining.
  {
    const bootstrapResult = await deliverBootstrapCapability({
      firstBoot: identity?.kind === 'generated',
      handoff: resolveHandoffFromEnv(process.env),
    });
    // Metadata only — the enrolment code itself is never logged.
    logger.info(
      { delivered: bootstrapResult.delivered, reason: bootstrapResult.reason },
      'bootstrap enrolment capability',
    );
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
  // The local workflow store is available even when PDS provisioning is off or
  // degraded. Coding approvals and other owner-local tasks must not depend on
  // public identity/network setup. The full workflow plane replaces this
  // minimal service below when its PDS prerequisites are available.
  let localWorkflowService: WorkflowService | undefined;
  let localTaskExpiry: TaskExpirySweeper | undefined;
  let phoneApprovalWorker: PhoneApprovalSyncWorker | undefined;

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

      identityDBForWorkflow = result.identityDB;
      const localWorkflowRepository = new SQLiteWorkflowRepository(result.identityDB);
      setWorkflowRepository(localWorkflowRepository);
      localWorkflowService = new WorkflowService({ repository: localWorkflowRepository });
      setWorkflowService(localWorkflowService);
      localTaskExpiry = new TaskExpirySweeper({
        repository: localWorkflowRepository,
        onError: (err) =>
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'local workflow expiry sweep failed',
          ),
      });
      localTaskExpiry.start();

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
          // public + unlisted publish; known_only is local-only (catalog §5.2).
          if (!shouldPublishListing(config)) continue;
          void publishOnce(wiredPublisher.publisher, pdsIdentity, config, logger, rkey);
        }
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
  // Round-A A-07 — the owner capability for the §12.5 run/watch control plane.
  // Minted/loaded by CORE (env or a 0600 file in the vault dir); presented by
  // the OWNER'S BROWSER on every owner call; validated only here. Brain never
  // holds it — the brain-server merely byte-pipes the header through.
  const ownerCap = resolveOwnerCapability(process.env, config.storage.vaultDir);
  logger.info(
    {
      source: ownerCap.source,
      ...(ownerCap.filePath !== undefined ? { file: ownerCap.filePath } : {}),
    },
    'owner capability resolved (value never logged) — paste it into the web UI to control runs',
  );
  // Item 4 — the fs-backed coding gate (`POST /v1/agent/gate`, §12.1). Shares
  // one permit store across requests so a minted permit redeems at execution.
  const codingGateHandle = createCodingGate({ vaultDir: config.storage.vaultDir });
  // Item B — inject the permit authority so approving a coding-gate card (via the
  // workflow approve route, in @dina/core) mints the single-use permit the
  // agent's retry redeems. Same PermitStore the gate consumes from.
  setCodingPermitAuthority(codingGateHandle.authority);
  let coreRouter: CoreRouter;
  try {
    coreRouter = createCoreRouter({
      ownerCapability: ownerCap.capability,
      codingGate: codingGateHandle.gate,
      agentFacades: createAgentFacades(),
      ask: {
        handler: makeHttpAskHandler({
          brainUrl: config.services?.brainUrl ?? 'http://127.0.0.1:8200',
        }),
      },
    });
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
    // The shared workflow plane owns its own expiry sweeper. Stop the minimal
    // degraded-mode instance before replacing the global service.
    localTaskExpiry?.stop();
    localTaskExpiry = undefined;
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
      // Co-located Brain (has the LLM) for the Tier-1 dina.local lane. Defaults
      // to the brain's default host:port when DINA_BRAIN_URL is unset.
      brainUrl: config.services?.brainUrl ?? 'http://127.0.0.1:8200',
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
      } else if (getWorkflowService() === localWorkflowService) {
        localTaskExpiry?.stop();
        setWorkflowService(null);
        setWorkflowRepository(null);
      }
      if (wiredPublisher !== undefined) {
        wiredPublisher.dispose();
      }
      await phoneApprovalWorker?.stop();
      await disconnectMsgBox();
      // Item 2c — drop our discovery lock on clean shutdown (registered here,
      // before listen, since Fastify rejects hooks added post-listen). The
      // lock itself is written after listen with the real bound port.
      releaseLock(config.storage.vaultDir);
    });
    routesBound = bindCoreRouter({
      coreRouter,
      app,
      skipRoutes: [{ method: 'GET', path: HEALTHZ_PATH }],
      // A-07 — the HTTP adapter stamps the owner identity on a timing-safe
      // `x-dina-owner-capability` match, scoped to the run/watch surface.
      ownerCapability: ownerCap.capability,
    });
    // Round-B B-02 (full fix) — the CORE-SERVED owner console. Opt-in
    // (`DINA_CORE_OWNER_CONSOLE=1`); serves a self-contained page at /owner
    // that drives Core's OWN run/watch routes SAME-ORIGIN, so the owner
    // capability lives only on Core's origin and never transits Brain.
    const ownerConsolePath = registerOwnerConsoleRoute(app, {
      enabled: process.env.DINA_CORE_OWNER_CONSOLE === '1',
    });
    if (ownerConsolePath !== null) {
      logger.info(
        { path: ownerConsolePath },
        'owner console served (credential-safe: browser → Core, never Brain)',
      );
    }
    // Debug control channel — TEST/DEV only, off by default. Lets a test
    // harness drive a real booted node over loopback without signing.
    if (process.env.DINA_DEBUG_MODE === '1') {
      // Fail closed: the debug channel bypasses auth entirely, so it must
      // NEVER be reachable on a release-endpoint (production) node — not even
      // behind a local reverse proxy that makes remote requests look loopback.
      // If the flag leaked into a release build, refuse to boot rather than
      // silently expose owner-level dispatch.
      if (config.endpoints.mode === 'release') {
        throw new Error(
          'DINA_DEBUG_MODE=1 is forbidden with release endpoints — refusing to boot (fail-closed).',
        );
      }
      registerDebugDispatch(app, coreRouter, logger);
    }
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

  // Item 2c — write the discovery lock with the REAL bound port (ephemeral when
  // the configured port is 0), pid, and node DID, so a second same-machine
  // agent can find this Core. The onClose hook that removes it is registered at
  // app creation (Fastify rejects hooks added post-listen). Best-effort: a lock
  // write failure must not down a healthy server.
  try {
    const addr = app.server.address();
    const boundPort = typeof addr === 'object' && addr !== null ? addr.port : config.network.port;
    writeLock(config.storage.vaultDir, {
      pid: process.pid,
      host: config.network.host,
      port: boundPort,
      nodeDid: getNodeDID(),
      startedAtMs: Date.now(),
    });
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'core.lock write failed (non-fatal)');
  }

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
        pdsIdentity?.did ?? config.msgbox.homeNodeDid ?? deriveDIDKey(derivations.root.publicKey);
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

  // Optional laptop-Core -> owner-phone approval bridge (§13). A one-time
  // `dina1:` code pairs a dedicated deterministic did:key; only the public
  // relay URL + phone DID are retained. The pairing code is never persisted.
  if (identity !== undefined && identity.kind !== 'wrapped' && getWorkflowService() !== null) {
    try {
      const persisted = await kvGet('target', 'phone_approval_sync');
      const setupRaw = process.env.DINA_APPROVAL_PHONE_SETUP_CODE?.trim() ?? '';
      let target:
        | { msgboxURL: string; phoneDID: string; code?: string; deviceName?: string }
        | undefined;
      if (persisted !== null) {
        const value = JSON.parse(persisted) as Record<string, unknown>;
        if (typeof value.msgbox_url === 'string' && typeof value.phone_did === 'string') {
          target = {
            msgboxURL: value.msgbox_url,
            phoneDID: value.phone_did,
          };
        }
      } else if (setupRaw !== '') {
        const setup = parsePhoneSetupCode(setupRaw);
        target = {
          msgboxURL: setup.msgboxURL,
          phoneDID: setup.phoneDID,
          code: setup.code,
          deviceName: setup.deviceName,
        };
      }

      if (target !== undefined) {
        // Reserved service index 2: Core=0, Brain=1, phone-approval device=2.
        const approvalKey = deriveServiceKey(identity.seed, 2);
        const client = new PhoneApprovalMsgBoxClient({
          msgboxURL: target.msgboxURL,
          phoneDID: target.phoneDID,
          privateKey: approvalKey.privateKey,
        });
        if (target.code !== undefined) {
          await client.pair(target.code, target.deviceName);
          await kvSet(
            'target',
            JSON.stringify({
              v: 1,
              msgbox_url: target.msgboxURL,
              phone_did: target.phoneDID,
            }),
            'phone_approval_sync',
          );
        }
        phoneApprovalWorker = new PhoneApprovalSyncWorker(client);
        phoneApprovalWorker.start();
        logger.info(
          { phoneDid: target.phoneDID, deviceDid: client.did },
          'owner-phone approval synchronization enabled',
        );
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'owner-phone approval synchronization unavailable; local approvals remain pending',
      );
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
