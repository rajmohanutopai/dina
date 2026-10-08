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

import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

import {
  AppViewClient,
  classifyAttestationPublishError,
  createAppViewReasoningEvidenceSource,
  createReasoningOutputGuard,
  PDSPublisherError,
  publishAttestationToPDS,
  type PDSPublisher,
} from '@dina/brain';
import {
  authenticateOwnerDeviceCore,
  namesOwnerDevice,
  getUpdateRebindCoordinator,
  getDrainAuthorizationRepository,
  configureRateLimiter,
  CoreReasoningBroker,
  createReasoningCommitBridge,
  createReasoningPolicySnapshotResolver,
  createServiceReasoningCommitter,
  createCoreRouter,
  deriveDIDKey,
  ensureReasoningBackendForBoot,
  getReasoningBackendRepository,
  getReasoningBroker,
  getReasoningContextRepository,
  getReviewPublishRepository,
  getSessionRegistry,
  getNodeDID,
  HEALTHZ_PATH,
  getWorkflowRepository,
  getCommerceRuntime,
  getCommerceEpochService,
  getCommerceServiceQueryDispatch,
  makeServiceQueryReconcileSend,
  installCatalogRecordReader,
  installCatalogRecordWriter,
  installCommerceObserver,
  installImageEgressBroker,
  installImageReencoder,
  installOwnerPresenceVerifier,
  readWrappedSeed,
  verifyPassphrase,
  startCommerceSweepers,
  type CommerceSweepers,
  getWorkflowService,
  composeWorkflowHooks,
  A2AStore,
  a2aWorkflowHooks,
  buildInboundCard,
  cardPublicKey,
  getA2ACardConfig,
  getA2ARuntime,
  getA2AStore,
  installA2A,
  installA2ACardConfig,
  A2ACardKeyRotation,
  installA2ACardKeyRotation,
  getA2ACardKeyRotation,
  bootA2ACardKeys,
  startA2ACardKeySchedule,
  installA2ADidResolver,
  installA2APublisher,
  installA2ADirectoryEvidence,
  newA2AId,
  sign as ed25519Sign,
  verify as ed25519Verify,
  installCoreServiceDid,
  deriveP256SigningKey,
  setA2AHostTransport,
  setUcpPolicySocket,
  installUcpIdentity,
  setUcpSigningGeneration,
  installUcpPublication,
  installUcpSearchRuntime,
  installUcpCheckoutRuntime,
  installUcpSettingsListener,
  installUcpWebhookOrigin,
  installUcpMerchantTrust,
  createUcpSearchRuntime,
  createUcpCheckoutRuntime,
  ucpWorkflowHooks,
  deriveUcpIdentity,
  UcpPublisher,
  startPublisherSchedule,
  type PublisherSchedule,
  coordinationWorkflowHooks,
  integrationWorkflowHooks,
  negotiationWorkflowHooks,
  orderAttachmentWorkflowHooks,
  wireGroupCoordinationOfferReplay,
  defaultPluginCompletionHandler,
  getPluginHostRuntime,
  getPluginInstallRepository,
  registerService,
  tier0TxRunner,
  SQLiteWorkflowRepository,
  TaskExpirySweeper,
  setCodingPermitAuthority,
  setNodeDID, setNodeSigningPublicKey,
  setReasoningBroker,
  setWorkflowRepository,
  setWorkflowService,
  WorkflowService,
  type CoreRouter,
} from '@dina/core';
import { DIDResolver } from '@dina/core/runtime';
import {
  bootstrapMsgBox,
  disconnectMsgBox,
  isMsgBoxAuthenticated,
  onMsgBoxAuthenticated,
  type MsgBoxBootConfig,
  type WSFactory,
} from '@dina/core/runtime';
import {
  A2ADispatchRunner,
  currentA2ACardKey,
  ensureA2ACardKey,
  kvPresenceStateStore,
  makeCatalogRepoAccess,
  makeResolveSender,
  ServicePresenceWriter,
} from '@dina/home-node';
import { kvGet, kvSet } from '@dina/core/kv';
import { createA2AHostTransport, createNodePolicySocket, makeNodeWebSocketFactory } from '@dina/net-node';

import { createAgentFacades } from './agent/facades';
import { makeHttpAskHandler } from './agent/http_ask_handler';
import { PhoneApprovalManager } from './approval/phone_approval_manager';
import { A2ACardPublisher, cardKeyCheck, cardRepoOverPds } from './appview/a2a_card_publisher';
import { wireServiceProfilePublisher, type WiredServicePublisher } from './appview/wire_publisher';
import { createSignedBrainFetch } from './brain_link';
import { wireCommerceEpoch } from './commerce/wire_epoch';
import { acquireLock, releaseLock, writeLock } from './core_lock';
import { createCodingGate } from './gate/coding_gate_impl';
import { deriveIdentity } from './identity/derivations';
import { loadOrGenerateSeed, wrappedSeedPathOf, type SeedSource } from './identity/master_seed';
import { loadOrProvisionPdsIdentity, type PdsIdentity } from './identity/provision_pds';
import { createOpenAiVisionBroker, createSharpReencoder } from './image_pipeline';
import { createLogger } from './logger';
import { deliverBootstrapCapability, resolveHandoffFromEnv } from './pair/bootstrap_capability';
import { ReviewPublishSupervisor } from './peerlens/review_publish_supervisor';
import { ReasoningCommitSupervisor } from './reasoning/reasoning_commit_supervisor';
import { createServer } from './server';
import { phoneStatusForOwnerSetup, registerApprovalPhoneRoutes } from './server/approval_phone_routes';
import { bindCoreRouter } from './server/bind_core_router';
import { registerDebugDispatch } from './server/debug_dispatch';
import { resolveOwnerCapability } from './server/owner_capability';
import { registerOwnerConsoleRoute } from './server/owner_console';
import {
  DEFAULT_WEB_BUNDLE_DIR,
  WEB_APP_PREFIX,
  parseBrainOrigin,
  registerWebAppRoutes,
} from './server/web_app';
import { initializeStorage } from './storage/init';
import { wireWorkflowPlane, type WiredWorkflowPlane } from './workflow/wire_workflow_plane';

import type { LoadedCoreServerConfig } from './config';
import type { Logger } from './logger';
import type { DatabaseAdapter } from '@dina/core/storage';

/** Brain on this host, where `DINA_BRAIN_URL` does not say otherwise. */
const LOCAL_BRAIN_URL = 'http://127.0.0.1:8200';

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
  // A2A Lane 2: the gateway's own service DID, exempt from the per-DID
  // bucket (design §4.1; see config.ts `a2a`). Unset, Lane 2 stays off and
  // no caller is a gateway.
  const a2aGatewayDid = config.a2a?.gatewayDid;
  if (a2aGatewayDid !== undefined) {
    registerService(a2aGatewayDid, 'gateway');
    logger.info({ gatewayDid: a2aGatewayDid }, 'a2a gateway service DID registered');
  }
  configureRateLimiter({
    maxRequests: config.runtime.rateLimitPerMinute,
    windowSeconds: 60,
    ...(a2aGatewayDid === undefined ? {} : { perDidMax: { [a2aGatewayDid]: Number.POSITIVE_INFINITY } }),
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
  }

  // §10 item 9 — HOW THIS NODE ASKS "IS A PERSON HERE?".
  //
  // The catalog lane binds a seller's name to values a model read, so it
  // refuses to confirm or approve unless Core can establish that somebody is
  // present. `ownerPresenceAvailable()` used to answer a hard-coded false,
  // which made the whole lane unreachable on a server: a seller could build a
  // draft and never publish it.
  //
  // The check is whether a passphrase unwraps the master seed. Nothing new is
  // stored, nothing new can drift out of step with the real secret, and the
  // answer means what presence has to mean — somebody who knows the owner's
  // passphrase typed it a moment ago.
  //
  // SECURITY MODE ONLY, and that is the honest boundary rather than a gap. A
  // convenience-mode node keeps its seed in a plain keyfile; there is no
  // secret only the owner knows, so there is nothing to prove and presence
  // stays unavailable. The lane then refuses, which is the correct answer for
  // a node that cannot tell its owner from anyone holding the disk.
  const presenceSeedPath = wrappedSeedPathOf(identity);
  if (presenceSeedPath !== undefined) {
    const wrappedPath = presenceSeedPath;
    installOwnerPresenceVerifier(async (passphrase) => {
      // Read per attempt rather than caching: a passphrase change rewrites
      // this file, and a cached copy would keep accepting the old one.
      const wrapped = readWrappedSeed(wrappedPath);
      return verifyPassphrase(passphrase, wrapped);
    });
  } else {
    installOwnerPresenceVerifier(null);
  }

  // §3/§6 (photo lanes) — the two injected adapters, composed here because
  // Core does no I/O and holds no provider credential. Each installs
  // conditionally and absence is a NAMED degradation: no sharp means the
  // ingest boundary refuses photographs, no OpenAI key means the egress
  // gate refuses extraction. The rest of the node is untouched either way.
  {
    const reencoder = await createSharpReencoder();
    installImageReencoder(reencoder);
    const visionKey = process.env.OPENAI_API_KEY ?? '';
    installImageEgressBroker(
      visionKey === '' ? null : createOpenAiVisionBroker({ apiKey: visionKey }),
    );
    // The degradation is named at the ROUTE boundary (`no_reencoder`,
    // `no_egress_broker`), which is the surface a seller actually sees —
    // the boot trace's step union stays untouched.

    // §8b — the metadata-only commerce event stream, onto the same logger
    // whose tests already assert secrets never reach it. Every field the
    // event type carries is an id, state, count or latency by construction.
    installCommerceObserver((event) => {
      logger.info({ commerce: event }, `commerce:${event.event}`);
    });
  }

  if (identity.kind !== 'wrapped') {
    trace.push({
      step: 'identity',
      status: 'ok',
      elapsedMs: Date.now() - identityStart,
    });
    if (identity.kind === 'generated' && identity.recoveryPhrasePath === undefined) {
      // Security mode from the first boot: no phrase file exists, because a
      // plain copy would undo the wrapping. Say how to print it; never log it.
      logger.warn(
        'first-boot: generated a new master seed, stored wrapped. No recovery-phrase ' +
          'file was written; print the phrase once with ' +
          '`DINA_UNLOCK_PASSPHRASE=… npx tsx src/identity/recovery_phrase_tool.ts <vault_dir>` ' +
          'and record it offline. It is never logged.',
      );
    } else if (identity.kind === 'generated') {
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

  // Core's calls to Brain are signed with Core's service key (A2A design
  // §4.1, plan §3.18): Brain serves no unsigned caller, and learns this DID
  // from Core. Without a seed in hand there is no key, and Brain refuses
  // Core's calls until there is.
  let brainFetch: typeof fetch = fetch;
  if (
    identity !== undefined &&
    (identity.kind === 'loaded_convenience' || identity.kind === 'generated' || identity.kind === 'loaded_wrapped')
  ) {
    const coreService = deriveIdentity({ masterSeed: identity.seed }).services.core;
    const coreServiceDid = deriveDIDKey(coreService.publicKey);
    brainFetch = createSignedBrainFetch({ did: coreServiceDid, privateKey: coreService.privateKey });
    installCoreServiceDid(coreServiceDid);
  }

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
      (identity.kind === 'loaded_convenience' || identity.kind === 'generated' || identity.kind === 'loaded_wrapped')
    ) {
      const rootPub = deriveIdentity({ masterSeed: identity.seed }).root.publicKey;
      const didKey = deriveDIDKey(rootPub);
      setNodeDID(didKey);
      setNodeSigningPublicKey(rootPub);
      logger.info({ nodeDid: didKey }, 'node identity: using local did:key (no PDS)');
    }
  }
  if (pdsProvisionEnabled) {
    const pdsStart = Date.now();
    if (
      identity !== undefined &&
      (identity.kind === 'loaded_convenience' || identity.kind === 'generated' || identity.kind === 'loaded_wrapped')
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
        setNodeSigningPublicKey(deriveIdentity({ masterSeed: identity.seed }).root.publicKey);
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
  let presenceWriter: ServicePresenceWriter | undefined;
  let presenceTimer: ReturnType<typeof setInterval> | undefined;
  let stopPresenceAuthHook: (() => void) | undefined;
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
  let localReasoningBroker: CoreReasoningBroker | undefined;
  let reasoningCommitSupervisor: ReasoningCommitSupervisor | null = null;
  let localTaskExpiry: TaskExpirySweeper | undefined;
  let commerceSweepers: CommerceSweepers | undefined;
  // The reference supplier runner (item 5) reaches this node's own routes in
  // process; the router is built after the sweepers start, so the runner
  // reads it per tick through this holder.
  const inProcessRouter: { current: CoreRouter | null } = { current: null };
  let phoneApprovalManager: PhoneApprovalManager | null = null;
  let a2aRunner: A2ADispatchRunner | null = null;
  let a2aCardPublisher: A2ACardPublisher | null = null;
  let a2aCardKeySchedule: { stop(): void; kick(): void } | null = null;
  let ucpPublication: PublisherSchedule | null = null;
  let reviewPublishSupervisor: ReviewPublishSupervisor | null = null;

  // Step 4 (db_open): SQLite persistence via `@dina/storage-node`. We
  // only do this when the master seed is materialized (convenience or
  // generated mode). Wrapped-seed mode defers until a later unwrap.
  const dbStart = Date.now();
  if (
    identity !== undefined &&
    (identity.kind === 'loaded_convenience' || identity.kind === 'generated' || identity.kind === 'loaded_wrapped')
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
      // A2A Lane 1 (docs/A2A_GATEWAY_ARCHITECTURE.md §4.1, §6.6): the A2A
      // store on the identity connection (its rows commit with workflow rows),
      // and the host transport that resolves, vets and pins before connecting.
      // The runner starts below, once a workflow service exists.
      installA2A({ store: new A2AStore(result.identityDB) });
      setA2AHostTransport(createA2AHostTransport());
      // UCP (docs/UCP_IMPLEMENTATION_PLAN.md §3.1, §3.3): the policy socket every
      // UCP call goes through, and the node's UCP identity (the request-signing
      // key at m/9999'/6'/0' and the profile label), held in memory only.
      setUcpPolicySocket(createNodePolicySocket());
      installUcpIdentity(deriveUcpIdentity(identity.seed));
      // The owner's review of a remote agent shows the directory's PeerLens
      // evidence for the Dina node its card names (§6.1, §8.4), read by this
      // trusted host, never relayed by Brain. Display only.
      const directory = new AppViewClient({ appViewURL: config.endpoints.appViewBaseUrl });
      installA2ADirectoryEvidence(async (did) => {
        const listed = await directory.getA2ACard(did);
        return listed === null
          ? null
          : {
              endpoint: listed.endpoint,
              trustScore: listed.trustScore,
              recommendation: listed.recommendation,
              indexedAt: listed.indexedAt,
              stale: listed.stale,
            };
      });
      // Lane 2's card (§7.1): signed with the ES256 card key from the master
      // seed (plan D4), for the public origin Core is told, never one the
      // gateway names. The key rotates (UCP plan §4.8, U7): the ring says
      // which generation signs; a node without one (new, or restored) reads
      // the generation in use from its DID document first.
      if (config.a2a?.publicOrigin !== undefined) {
        const cardSeed = identity.seed;
        const cardKeyDid = pdsIdentity?.did;
        // The PLC directory, bounded: a slow directory never holds a switch or a read open.
        const plcFetch: typeof fetch = (input, init) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(10_000) });
        const plcURL = config.endpoints.plcDirectoryUrl;
        const cardKeys = new A2ACardKeyRotation({
          keyAt: (generation) => ({ privateKey: deriveP256SigningKey(cardSeed, generation).privateKey, generation }),
          publicOrigin: config.a2a.publicOrigin,
          // No did:plc (no PDS): no document; the card signs with generation 0 and does not rotate.
          document:
            cardKeyDid === undefined
              ? null
              : {
                  readKey: () => currentA2ACardKey({ did: cardKeyDid, plcURL, fetch: plcFetch }),
                  recordKey: (cardPublicKey) =>
                    ensureA2ACardKey({ did: cardKeyDid, cardPublicKey, masterSeed: cardSeed, plcURL, fetch: plcFetch }),
                },
        });
        installA2ACardKeyRotation(cardKeys);
        // A ring on disk installs the card at once, and boot waits on nothing (the schedule's first
        // run checks the DID document). A node without one reads the document first, bounded by the
        // timeout above; if it cannot, the schedule keeps trying and no card is served (or
        // published, or taken down) meanwhile.
        await bootA2ACardKeys(cardKeys);
        a2aCardKeySchedule = startA2ACardKeySchedule(cardKeys);
        // A client binding a did:plc (design §5.1, M4): the host looks its
        // document up, uncached; Core reads the keys and checks the signature.
        const didResolver = new DIDResolver();
        installA2ADidResolver((did) => didResolver.lookup(did));
      }
      const localWorkflowRepository = new SQLiteWorkflowRepository(result.identityDB);
      setWorkflowRepository(localWorkflowRepository);
      localWorkflowService = new WorkflowService({
        // §3.4 — the host-operation lane, on the DEGRADED-mode service too.
        //
        // `wireWorkflowPlane` installs this handler and replaces the service
        // below, so on a fully-booted node the omission here was invisible.
        // But between this line and that one the service is live, and a
        // completion carrying a host-operation proposal took the ordinary
        // path: recorded as a successful result, no broker, no permit, no
        // effect — and nothing in the record to distinguish it from a
        // genuine answer. A runner that reached this window would have
        // "asked" for an effect and been told it succeeded.
        //
        // Every dependency below is a GETTER, so this handler is correct in
        // degraded mode without knowing it is in one: with no host-operation
        // plane installed it reports loudly and brokers nothing, which is the
        // honest answer rather than the silent one.
        pluginCompletionHandler: defaultPluginCompletionHandler({
          hostRuntime: () => getPluginHostRuntime(),
          installs: () => getPluginInstallRepository(),
          workflow: () => getWorkflowService(),
          onError: (err: unknown) =>
            logger.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'plugin host-operation proposal could not be brokered',
            ),
        }),
        repository: localWorkflowRepository,
        // GROUP_COORDINATION §6 — the same gate and release handler the full
        // plane installs, so a disclosure never rides out ungated in the
        // window between this line and `wireWorkflowPlane`.
        ...composeWorkflowHooks(
          coordinationWorkflowHooks(),
          integrationWorkflowHooks(),
          orderAttachmentWorkflowHooks(),
          negotiationWorkflowHooks(),
          a2aWorkflowHooks(getA2ARuntime),
          ucpWorkflowHooks(),
        ),
      });
      setWorkflowService(localWorkflowService);
      // Lane 1's runner reads the CURRENT runtime every tick, so it follows
      // the service the workflow plane installs later in boot.
      a2aRunner = new A2ADispatchRunner({
        runtime: getA2ARuntime,
        runnerDid: `${getNodeDID() ?? 'did:key:local'}#a2a-runner`,
        log: (entry) => logger.info(entry, 'a2a lane 1'),
      });
      a2aRunner.start();
      localTaskExpiry = new TaskExpirySweeper({
        // Through the service, so a lapsed disclosure review still answers.
        repository: localWorkflowService,
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
        // REAL_LIFE_FIXES §14: the node's daily presence record, so AppView
        // can tell this live provider from listings left behind. Written only
        // while MsgBox is up; renewed when over 22 h old; nudged whenever a
        // listing really changes and whenever MsgBox (re)authenticates.
        const pds = (): PDSPublisher => wiredPublisher!.pdsPublisher;
        presenceWriter = new ServicePresenceWriter({
          repo: {
            listRecords: async (collection) =>
              (await pds().listRecords(collection)).map((r) => ({ rkey: r.rkey, cid: r.cid })),
            getRecord: async (collection, rkey) => pds().getRecord(collection, rkey),
            putRecord: async (collection, rkey, record, opts) =>
              pds().putRecord(collection, rkey, record, { swapRecord: opts.swapRecord }),
            deleteRecord: async (collection, rkey, opts) =>
              pds().deleteRecord(collection, rkey, { swapRecord: opts.swapRecord }),
          },
          store: kvPresenceStateStore({ get: (k) => kvGet(k), set: (k, v) => kvSet(k, v) }),
          inboundUp: () => isMsgBoxAuthenticated(),
          randomBytes: (n) => randomBytes(n),
          onOutcome: (o) => {
            if (o.status === 'failed') logger.warn({ error: o.error }, 'service presence write failed');
            else if (o.status === 'written') logger.info({ listings: o.listings, complete: o.complete }, 'service presence renewed');
          },
        });
        const writer = presenceWriter;
        wiredPublisher = wireServiceProfilePublisher({
          pdsIdentity,
          logger,
          onListingsChanged: () => void writer.nudge(),
        });
        stopPresenceAuthHook = onMsgBoxAuthenticated(() => void writer.onInboundUp());
        // Hourly check, up to 1 h of random delay on top of the 22 h age.
        presenceTimer = setInterval(() => {
          setTimeout(() => void writer.renewIfDue(), Math.floor(Math.random() * 60 * 60 * 1000)).unref?.();
        }, 60 * 60 * 1000);
        presenceTimer.unref?.();
        // Lane 3 (A2A design §8.2): the card publisher, a trusted host process
        // beside the profile publisher, on the same repo session. It writes
        // nothing until the owner switches the listing on and activates it.
        // It runs whenever the node can write its repository, gateway or not:
        // a card published while a gateway was configured is taken down once
        // it is not ("predicate-false always drives an unpublish"), across
        // restarts. Without a gateway its activation answers not_configured:
        // no listing can go out without one.
        const a2aStore = getA2AStore();
        if (a2aStore !== null) {
          const signingKey = deriveIdentity({ masterSeed: identity.seed }).root;
          const signingKeyId = Buffer.from(signingKey.publicKey).toString('hex');
          const cardDid = pdsIdentity.did;
          const seed = identity.seed;
          a2aCardPublisher = new A2ACardPublisher({
            store: a2aStore,
            repo: cardRepoOverPds(wiredPublisher.pdsPublisher, cardDid),
            nodeDid: cardDid,
            buildCard: async () => {
              const config = getA2ACardConfig();
              if (config === null) return { ok: false, reason: 'gateway_unconfigured' };
              const built = await buildInboundCard(a2aStore, { nodeDid: cardDid, config });
              return built.ok ? { ok: true, card: built.card } : { ok: false, reason: built.reason };
            },
            gatewayLive: () => getA2ACardConfig() !== null,
            // The card key is still being read from the DID document: judge nothing yet (no
            // listing is taken down for a card that is merely not known yet).
            cardKeyPending: () => getA2ACardKeyRotation()?.ready() === false,
            sign: (message) => ed25519Sign(signingKey.privateKey, message),
            verify: (message, signature) => ed25519Verify(signingKey.publicKey, message, signature),
            signingKeyId: () => signingKeyId,
            // The key that signs the card now: the check follows it, so a new key is put in the document first.
            cardKeyReady: cardKeyCheck(
              (cardPublicKey) =>
                ensureA2ACardKey({ did: cardDid, cardPublicKey, masterSeed: seed, plcURL: config.endpoints.plcDirectoryUrl }),
              () => {
                const current = getA2ACardConfig();
                return current === null ? null : cardPublicKey(current.key);
              },
            ),
            sha256: (bytes) => sha256(bytes),
            isLostSwap: (err) => err instanceof PDSPublisherError && err.casLost,
            newInstance: newA2AId,
            log: (entry) => logger.info(entry, 'a2a lane 3'),
          });
          // The owner's port, whatever the configuration: with no card
          // configuration its activation answers not_configured, and its
          // deactivation still works.
          installA2APublisher(a2aCardPublisher);
          a2aCardPublisher.start();
        }
        // UCP (docs/UCP_IMPLEMENTATION_PLAN.md §3.5): the buyer profile, uploaded
        // to the Dina-run host under the node's did:plc, when UCP is enabled.
        // §3.11, §3.16: merchant search and its guard queue on the identity
        // database, only beside the publisher: a merchant reads the profile it
        // uploads.
        if (config.ucp?.enabled === true) {
          const profileHost = config.ucp.profileHost !== undefined ? { profileHost: config.ucp.profileHost } : {};
          // §3.13, S8: a server whose A2A gateway has a public origin takes signed order
          // webhooks there (unless the owner turns them off); the profile lists that URL.
          installUcpWebhookOrigin(config.a2a?.publicOrigin ?? null);
          const ucpPublisher = new UcpPublisher({ did: pdsIdentity.did, ...profileHost });
          // A rotated key signs from the first merchant call after a restart (U7).
          await ucpPublisher.restoreKeys();
          ucpPublication = startPublisherSchedule(ucpPublisher);
          // The owner's UCP settings: status, key ring, and the four actions (§3.5, §4.8).
          installUcpPublication({ publisher: ucpPublisher, schedule: ucpPublication });
          // A settings save may change the listed webhook URL: upload the profile now.
          const publication = ucpPublication;
          installUcpSettingsListener(() => publication.kick());
          installUcpSearchRuntime(createUcpSearchRuntime(result.identityDB, { client: profileHost }));
          // §3.7, §3.10: checkouts and carts on the same database as the workflow's cards.
          const ucpCheckout = createUcpCheckoutRuntime(result.identityDB, {
            client: profileHost,
            // §3.17: without a public address, a sign-in goes to the phone paired as this
            // node's own (read per call: the phone is paired later in boot, or by the owner).
            phoneReady: () => {
              const phone = phoneApprovalManager?.status();
              return phone?.configured === true && phone.needsServerNodePairing !== true;
            },
          });
          installUcpCheckoutRuntime(ucpCheckout);
          ucpCheckout.start();
          // The comparison card's trust lines, read by this trusted host, never relayed by Brain.
          const peerlens = new AppViewClient({ appViewURL: config.endpoints.appViewBaseUrl });
          installUcpMerchantTrust((subject) =>
            peerlens.resolveTrust({ subject, context: 'before-transaction' }),
          );
        }
        // §10.2/WS-5.1 — how a catalog reaches this node's own repo. Core owns
        // the ORDER (snapshot before pointer, and no pointer if the snapshot
        // did not land); this half only writes. Installed alongside the profile
        // publisher because they share one repo session and one identity.
        // Captured, not re-read from the mutable `wiredPublisher` on every
        // write: the closure outlives this block, and reaching back through a
        // `let` would let a later reassignment silently redirect where this
        // node's catalog is published.
        const catalogPds = wiredPublisher.pdsPublisher;
        const catalogDid = pdsIdentity.did;
        // ONE pair, shared with the phone. The rules are identical and the
        // identity re-check is the load-bearing part, so it lives in one place
        // rather than in each root.
        const catalogRepo = makeCatalogRepoAccess({
          pds: catalogPds,
          ownerDid: catalogDid,
          authenticate: () => catalogPds.authenticate(),
        });
        installCatalogRecordWriter(catalogRepo.writer);
        installCatalogRecordReader(catalogRepo.reader);
        // §16.2 — the commerce restore fence. The epoch record lives in this
        // node's OWN repo, outside every backup, and nothing may be signed
        // until it is published. A node with no PDS has no repo to publish
        // to, so commerce simply stays disabled there; `establish()` is
        // awaited because a partly-established epoch is not a state we want
        // requests arriving into.
        const commerceRuntime = getCommerceRuntime();
        if (commerceRuntime !== null) {
          await wireCommerceEpoch({
            pdsIdentity,
            businessDid: pdsIdentity.did,
            adapter: result.identityDB,
            tx: tier0TxRunner(result.identityDB),
            families: commerceRuntime.families,
            receipts: commerceRuntime.receipts,
            logger,
          }).establish();
          // The commerce background ticks (§9.9 step 3, §16.2, §12.7). Started
          // AFTER `establish()` so the first epoch re-read cannot race the
          // publication, and through the one helper both composition roots
          // call — a tick each root starts separately is a tick one root
          // eventually forgets, which is how both of these came to be built
          // and never run.
          commerceSweepers = startCommerceSweepers({
            admission: {
              engine: () => getCommerceRuntime()?.admission ?? null,
              onTimedOut: (purchaseOrderId) =>
                logger.info({ purchaseOrderId }, 'commerce admission timed out; capacity refunded'),
              onStuck: (skip) => logger.warn(skip, 'commerce admission reservation stuck'),
              onError: (err) =>
                logger.warn(
                  { err: err instanceof Error ? err.message : String(err) },
                  'commerce admission sweep failed',
                ),
            },
            epoch: {
              service: () => getCommerceEpochService(),
              onOutcome: (outcome) => {
                if (outcome.kind === 'current') return;
                // Anything else means this node's right to sign is in
                // question, and a quiet log line is the only place an
                // operator can learn it before a buyer tells them.
                logger.warn({ ...outcome }, 'commerce epoch revalidation');
              },
              onError: (err) =>
                logger.warn(
                  { err: err instanceof Error ? err.message : String(err) },
                  'commerce epoch revalidation failed',
                ),
            },
            // §9.13 — retire a prior manifest's lifecycle lane once its last order
            // is finished. Continuity authorizations carry no expiry, so without
            // this every update leaves another one behind holding authority for
            // ever. `releaseContinuity` re-reads the count and refuses while work
            // remains, so this sweep can only ever be LATE, never early.
            continuity: {
              intervalMs: 15 * 60 * 1000,
              releasable: () =>
                getDrainAuthorizationRepository()?.listLiveContinuity(Date.now()) ?? [],
              release: (installId, previousCid, capabilityId) =>
                getUpdateRebindCoordinator()?.releaseContinuity(
                  installId,
                  previousCid,
                  capabilityId,
                ) ?? {
                  released: false,
                  openOrders: 0,
                },
            },
            reconcile: {
              // §12.7 — ask a supplier again about an order whose outcome this
              // node does not know. Resolved per tick, never captured: the
              // outbound lane is installed with storage and a tick holding a
              // stale sender would ask the wrong node's suppliers.
              send: () => {
                const dispatch = getCommerceServiceQueryDispatch();
                return dispatch === null ? null : makeServiceQueryReconcileSend({ dispatch });
              },
              onSweep: (result) => logger.info(result, 'commerce reconcile sweep'),
              onError: (err) =>
                logger.warn(
                  { err: err instanceof Error ? err.message : String(err) },
                  'commerce reconcile sweep failed',
                ),
            },
            supplierRunner: {
              dispatch: () => {
                const router = inProcessRouter.current;
                if (router === null) return null;
                return async ({ path, body, deviceDid }) => {
                  const res = await router.handle({
                    method: 'POST',
                    path,
                    query: {},
                    // The routes read the authenticated DID from the header
                    // the signed pipeline sets; in process it is stated here.
                    headers: { 'x-did': deviceDid },
                    body,
                    rawBody: new Uint8Array(),
                    params: {},
                    trustedInProcess: true,
                    callerType: 'plugin',
                    callerDID: deviceDid,
                  });
                  return { status: res.status, body: res.body ?? null };
                };
              },
              onError: (err) =>
                logger.warn(
                  { err: err instanceof Error ? err.message : String(err) },
                  'reference supplier runner tick failed',
                ),
            },
          });
        }
        const reviewRepo = getReviewPublishRepository();
        if (reviewRepo !== null) {
          const reviewPds = wiredPublisher.pdsPublisher;
          const reviewOwnerDid = pdsIdentity.did;
          reviewPublishSupervisor = new ReviewPublishSupervisor({
            ownerDid: reviewOwnerDid,
            repo: reviewRepo,
            publish: (job, record) =>
              publishAttestationToPDS(reviewPds, reviewOwnerDid, record, job.rkey),
            classifyError: classifyAttestationPublishError,
            logger,
          });
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
      // WEB_OWNER_SURFACE_PLAN §3.5 — the owner's devices, shared with the
      // phone and the web app; the approval phone joins their status.
      ownerSetup: {
        msgboxURL: () => config.msgbox.url,
        extraStatus: () => phoneStatusForOwnerSetup(phoneApprovalManager),
      },
      codingGate: codingGateHandle.gate,
      onAgentGatingPolicyChanged: (agentDid) => {
        codingGateHandle.permits.revokeForAgent(agentDid);
      },
      reasoningPublicEvidenceSource: createAppViewReasoningEvidenceSource(
        new AppViewClient({
          appViewURL: config.endpoints.appViewBaseUrl,
        }),
      ),
      agentFacades: createAgentFacades({
        brainUrl: config.services?.brainUrl ?? LOCAL_BRAIN_URL,
        brainFetch,
        appViewUrl: config.endpoints.appViewBaseUrl,
        ...(wiredPublisher !== undefined && pdsIdentity !== undefined
          ? {
              pdsPublisher: wiredPublisher.pdsPublisher,
              ownerDid: pdsIdentity.did,
            }
          : {}),
      }),
      ask: {
        handler: makeHttpAskHandler({
          brainUrl: config.services?.brainUrl ?? LOCAL_BRAIN_URL,
          fetchImpl: brainFetch,
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
  inProcessRouter.current = coreRouter;

  // Workflow plane — wired post-core_router (the runtime's
  // InProcessTransport needs the router) but BEFORE fastify_start so
  // every bound HTTP route already sees the singletons set. Without
  // this, /v1/workflow/tasks/* and /v1/service/* return 503 even
  // though they're routable.
  if (
    pdsIdentity !== undefined &&
    identity !== undefined &&
    (identity.kind === 'loaded_convenience' || identity.kind === 'generated' || identity.kind === 'loaded_wrapped') &&
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
      brainUrl: config.services?.brainUrl ?? LOCAL_BRAIN_URL,
      brainFetch,
      logger,
    });
    // GROUP_COORDINATION §5: a guest asked for reach through the 1:1 preflight
    // is queried the moment the offer lands, within the round's window. The
    // read path is the fallback; this is the trigger. Process-lifetime, like
    // every other module singleton this boot installs.
    wireGroupCoordinationOfferReplay();
  }
  // The final workflow service is in place: Lane 1 must share its connection.
  // A mismatch throws here, stopping boot, instead of failing every approval.
  getA2ARuntime();

  const reasoningWorkflowService = getWorkflowService();
  const reasoningWorkflowRepository = getWorkflowRepository();
  const reasoningBackendRepository = getReasoningBackendRepository();
  const reasoningContextRepository = getReasoningContextRepository();
  if (config.services?.internalBrainEnabled === true && reasoningBackendRepository !== null) {
    const ownerDid = getNodeDID();
    const brainDid = config.services.brainDid;
    if (ownerDid === null || brainDid === undefined) {
      logger.warn(
        { ownerIdentityAvailable: ownerDid !== null, brainDidConfigured: brainDid !== undefined },
        'internal Brain backend not provisioned because identity is unavailable',
      );
    } else {
      const ensured = ensureReasoningBackendForBoot(reasoningBackendRepository, {
        backendId: 'dina.internal-brain',
        kind: 'internal_brain',
        principalDid: brainDid,
        allowedTaskKinds: ['answer.compose'],
        maxSensitivity: 'sensitive',
        availability: 'always_on',
        modelClass: 'dina-internal-brain',
        selectedByOwnerDid: ownerDid,
      });
      const details = {
        status: ensured.status,
        backendId: ensured.binding.backendId,
        policyVersion: ensured.binding.policyVersion,
      };
      if (ensured.status === 'created' || ensured.status === 'ready') {
        logger.info(details, 'internal Brain reasoning backend provisioned');
      } else {
        logger.warn(
          { ...details, reason: 'reason' in ensured ? ensured.reason : 'policy unavailable' },
          'internal Brain remains unavailable; boot did not override owner policy',
        );
      }
    }
  }
  if (
    reasoningWorkflowService !== null &&
    reasoningWorkflowRepository !== null &&
    reasoningBackendRepository !== null &&
    reasoningContextRepository !== null
  ) {
    localReasoningBroker = new CoreReasoningBroker({
      workflowService: reasoningWorkflowService,
      workflowRepository: reasoningWorkflowRepository,
      backendRepository: reasoningBackendRepository,
      contextRepository: reasoningContextRepository,
      resolvePolicySnapshotHash: createReasoningPolicySnapshotResolver(),
      isAuthenticatedSessionActive: ({ sessionId, principalDid, authorityOrigin }) =>
        getSessionRegistry().authorizesAuthorityOrigin(sessionId, principalDid, authorityOrigin),
      activateAuthenticatedSessionAuthority: ({ sessionId, principalDid, authorityOrigin }) =>
        getSessionRegistry().activateAuthorityOrigin(sessionId, principalDid, authorityOrigin),
      releaseAuthenticatedSessionAuthority: ({ sessionId, principalDid, authorityOrigin }) =>
        getSessionRegistry().clearAuthorityOrigin(sessionId, principalDid, authorityOrigin).ok,
      outputGuard: createReasoningOutputGuard(),
      commitValidatedProposal: createReasoningCommitBridge({
        ...(wiredWorkflow === undefined
          ? {}
          : {
              commitServiceResponse: createServiceReasoningCommitter({
                workflowService: reasoningWorkflowService,
              }),
            }),
      }),
    });
    setReasoningBroker(localReasoningBroker);
    localReasoningBroker.reconcileSessionAuthorities();
    reasoningCommitSupervisor = new ReasoningCommitSupervisor({
      broker: localReasoningBroker,
      logger,
    });
  }

  if (identity !== undefined && identity.kind !== 'wrapped' && getWorkflowService() !== null) {
    phoneApprovalManager = new PhoneApprovalManager(identity.seed, logger);
    try {
      const setupRaw = process.env.DINA_APPROVAL_PHONE_SETUP_CODE?.trim() ?? '';
      await phoneApprovalManager.initialize(setupRaw === '' ? undefined : setupRaw);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'owner-phone approval synchronization unavailable; local approvals remain pending',
      );
    }
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
      await a2aRunner?.stop();
      await a2aCardPublisher?.stop();
      a2aCardKeySchedule?.stop();
      installA2ACardKeyRotation(null);
      installUcpPublication(null);
      ucpPublication?.stop();
      installA2APublisher(null);
      installA2ADirectoryEvidence(null);
      setA2AHostTransport(null);
      installUcpSearchRuntime(null);
      installUcpCheckoutRuntime(null);
      installUcpSettingsListener(null);
      installUcpWebhookOrigin(null);
      installUcpMerchantTrust(null);
      setUcpPolicySocket(null);
      installUcpIdentity(null);
      setUcpSigningGeneration(null);
      installA2ADidResolver(null);
      installA2A(null);
      installA2ACardConfig(null);
      installCoreServiceDid(null);
      await reasoningCommitSupervisor?.stop();
      if (getReasoningBroker() === localReasoningBroker) {
        setReasoningBroker(null);
      }
      if (wiredWorkflow !== undefined) {
        await wiredWorkflow.dispose();
      } else if (getWorkflowService() === localWorkflowService) {
        localTaskExpiry?.stop();
        setWorkflowService(null);
        setWorkflowRepository(null);
      }
      await reviewPublishSupervisor?.stop();
      commerceSweepers?.stop();
      if (wiredPublisher !== undefined) {
        wiredPublisher.dispose();
      }
      if (presenceTimer !== undefined) clearInterval(presenceTimer);
      stopPresenceAuthHook?.();
      await phoneApprovalManager?.stop();
      await disconnectMsgBox();
      // Item 2c — drop our discovery lock on clean shutdown (registered here,
      // before listen, since Fastify rejects hooks added post-listen). The
      // lock itself is written after listen with the real bound port.
      releaseLock(config.storage.vaultDir);
    });
    // WEB_OWNER_SURFACE_PLAN §3.3 — Core's owner-device checks, shared by the
    // route binder and the Fastify-level approval-phone routes.
    const ownerDeviceAuth = { namesOwnerDevice, authenticate: authenticateOwnerDeviceCore };
    routesBound = bindCoreRouter({
      coreRouter,
      app,
      skipRoutes: [{ method: 'GET', path: HEALTHZ_PATH }],
      // A-07 — the HTTP adapter stamps the owner identity on a timing-safe
      // `x-dina-owner-capability` match, or a verified owner device, scoped
      // to the owner surface.
      ownerCapability: ownerCap.capability,
      ownerDeviceAuth,
    });
    // Round-B B-02 (full fix) — the CORE-SERVED owner console. Opt-in
    // (`DINA_CORE_OWNER_CONSOLE=1`); serves a self-contained page at /owner
    // that drives Core's OWN run/watch routes SAME-ORIGIN, so the owner
    // capability lives only on Core's origin and never transits Brain.
    const ownerConsolePath = registerOwnerConsoleRoute(app, {
      enabled: process.env.DINA_CORE_OWNER_CONSOLE === '1',
    });
    registerApprovalPhoneRoutes(app, {
      // The owner interface (web app) and the console both drive these.
      enabled: process.env.DINA_CORE_OWNER_CONSOLE === '1' || process.env.DINA_CORE_WEB_UI === '1',
      ownerCapability: ownerCap.capability,
      phoneManager: phoneApprovalManager,
      ownerDeviceAuth,
    });
    if (ownerConsolePath !== null) {
      logger.info(
        { path: ownerConsolePath },
        'owner console served (credential-safe: browser → Core, never Brain)',
      );
    }
    // WEB_OWNER_SURFACE_PLAN §3.2 — Core serves the web app at /app/ (opt-in).
    // The page reaches Brain cross-origin, so Core names Brain's origin as the
    // browser sees it (the page's config and CSP carry it): the explicit
    // setting, else Brain's URL, else the local default every other Brain
    // call here assumes. A malformed value fails boot (`parseBrainOrigin`).
    if (process.env.DINA_CORE_WEB_UI === '1') {
      const brainRaw =
        process.env.DINA_CORE_WEB_BRAIN_ORIGIN?.trim() ||
        config.services?.brainUrl?.trim() ||
        LOCAL_BRAIN_URL;
      const bundleDir = process.env.DINA_CORE_WEB_BUNDLE_DIR ?? DEFAULT_WEB_BUNDLE_DIR;
      const brainOrigin = parseBrainOrigin(brainRaw);
      await registerWebAppRoutes(app, { bundleDir, brainOrigin });
      logger.info({ path: WEB_APP_PREFIX, brainOrigin }, 'web app served by Core (owner devices sign; Brain cross-origin)');
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
    reasoningCommitSupervisor?.start();
    reviewPublishSupervisor?.start();
  } catch (err) {
    await reasoningCommitSupervisor?.stop();
    await reviewPublishSupervisor?.stop();
    await phoneApprovalManager?.stop();
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
        // REAL_LIFE_FIXES §6.2: a stranger's message (a safety alert
        // included) waits in quarantine; tell Brain, which owns the chat, to
        // show the review card, as the phone does in-process. The body stays
        // in Core until the owner decides.
        onQuarantinedD2D: ({ senderDID, messageType, quarantineId }) => {
          void brainFetch(`${config.services?.brainUrl ?? LOCAL_BRAIN_URL}/api/v1/chat/quarantine-request`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ quarantine_id: quarantineId, sender_did: senderDID, message_type: messageType }),
          }).catch(() => {
            // Best effort: the item stays in quarantine and in the review list.
          });
        },
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
