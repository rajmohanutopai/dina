/**
 * App-level boot service — composes a `DinaNode` from whatever
 * dependencies the React Native app has on hand, then starts it.
 *
 * Issue #4: before this module existed, no non-test path called
 * `startDinaNode()`. The Expo entrypoint (`_layout.tsx`) uses
 * `useNodeBootstrap()` to kick this off once identity is loaded and
 * the user has unlocked their persona.
 *
 * Inputs are partitioned into three layers:
 *
 *   1. **Identity** (`did` + `signingKeypair`) — always required; loaded
 *      from Keychain via `loadOrGenerateSeeds`.
 *   2. **Capability layers** (SQLite adapter, AppView client, PDS
 *      publisher, MsgBox transport, LLM agentic-ask tools, capability
 *      runner) — provided by the app as each layer matures. Each is
 *      optional: the function falls back to an explicit degraded mode
 *      and LOGS prominently instead of silently pretending everything
 *      is connected. Issue #20.
 *   3. **Policy** (role, initialServiceConfig, deviceRoleResolver,
 *      onPublishSyncFailure) — settings the app owner supplies.
 *
 * This file used to hide "we haven't wired X yet" behind empty stubs.
 * Now every missing dependency surfaces as a `degradation` entry in
 * the returned handle's bootReport so the caller can decide whether to
 * proceed, warn, or block.
 */

import { configureRateLimiter } from '@dina/core/src/auth/middleware';
import { createCoreRouter } from '@dina/core/src/server/core_server';
import { createInProcessDispatch } from '@dina/core/src/server/in_process_dispatch';
import { InProcessTransport } from '@dina/core/src/client/in-process-transport';
import {
  InMemoryWorkflowRepository,
  SQLiteWorkflowRepository,
  type WorkflowRepository,
} from '@dina/core/src/workflow/repository';
import {
  InMemoryServiceConfigRepository,
  SQLiteServiceConfigRepository,
  type ServiceConfigRepository,
} from '@dina/core/src/service/service_config_repository';
import { MemoryService, setMemoryService } from '@dina/core/src/memory/service';
import {
  getTopicRepository,
  listTopicRepositoryPersonas,
} from '@dina/core/src/memory/repository';
import type { ServiceResponseBody } from '@dina/core/src/d2d/service_bodies';
import type { AppViewClient } from '@dina/brain/src/appview_client/http';
import type { PDSPublisher } from '@dina/brain/src/pds/publisher';
import type { IdentityKeypair } from '@dina/core/src/identity/keypair';
import type { PDSSession } from '@dina/brain/src/pds/account';
import type { DatabaseAdapter } from '@dina/core/src/storage/db_adapter';
import type { WSFactory } from '@dina/core/src/relay/msgbox_ws';
import type { CoreRouter } from '@dina/core/src/server/router';
import type { LLMProvider } from '@dina/brain/src/llm/adapters/provider';
import type { AgenticAskHandlerOptions } from '@dina/brain/src/reasoning/ask_handler';
import type { ToolRegistry } from '@dina/brain/src/reasoning/tool_registry';
import type { LocalCapabilityRunner } from '@dina/core/src/workflow/local_delegation_runner';
import { createNode, type DinaNode, type NodeRole, type CreateNodeOptions } from './bootstrap';
import { buildStagingEnrichment } from './staging_enrichment';
import { emitRuntimeWarning, clearRuntimeWarning } from './runtime_warnings';

export type BootLogger = (entry: Record<string, unknown>) => void;

/** Reason a capability dependency was degraded. Surfaced to the UI. */
export interface BootDegradation {
  /** Stable short tag, e.g. `'transport.msgbox.missing'`. */
  code: string;
  /** One-line operator-facing explanation. */
  message: string;
}

export interface BootResult {
  node: DinaNode;
  degradations: BootDegradation[];
}

/**
 * Thrown when `bootAppNode` fails partway through. Carries the
 * degradations list that was collected up to the failure so the caller
 * (useNodeBootstrap) can still surface them in the error-state banner
 * — dropping them meant the user saw "Dina failed to start" with no
 * hint at which missing dependency triggered it (review #14).
 */
export class BootStartupError extends Error {
  readonly degradations: BootDegradation[];
  readonly cause: unknown;
  constructor(cause: unknown, degradations: BootDegradation[]) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message);
    this.name = 'BootStartupError';
    this.degradations = degradations;
    this.cause = cause;
  }
}

export interface BootServiceInputs {
  // --- Identity (required) ---------------------------------------------
  did: string;
  signingKeypair: IdentityKeypair;
  /**
   * Optional PDS session for provider publishing + did:plc continuity.
   * When omitted the node still boots, but ServicePublisher is not
   * constructed (no AppView discoverability). Issue #3.
   */
  pdsSession?: PDSSession;

  // --- Persistence (issues #6, #7) -------------------------------------
  /**
   * SQLite adapter for durable workflow + service_config storage. When
   * omitted the node boots with in-memory repos and records a
   * `persistence.in_memory` degradation (tasks/config vanish on
   * reload).
   */
  databaseAdapter?: DatabaseAdapter;

  // --- Discovery + publishing (issues #8, #15, #16) --------------------
  /**
   * Real AppView client. When omitted /service queries return
   * `no_candidate` and a `discovery.stub` degradation is recorded.
   *
   * Surface covers every mobile tool that reaches AppView:
   *   - `searchServices` — public discovery (`search_provider_services`
   *     + `query_service` auto-fetch path)
   *   - `isDiscoverable` — per-capability check (`find_preferred_provider`)
   *   - `resolveTrust` + `searchTrust` — Trust Network peer data
   *     (`search_trust_network`)
   *
   * Both `AppViewClient` (real) and `AppViewStub` (demo) implement
   * all four so either can be passed.
   */
  appViewClient?: Pick<
    AppViewClient,
    'searchServices' | 'isDiscoverable' | 'resolveTrust' | 'searchTrust'
  >;
  /**
   * PDS publisher. Required for providers that want AppView
   * discoverability; ignored otherwise.
   */
  pdsPublisher?: PDSPublisher;
  /**
   * Seed config for provider nodes — matches Core's
   * `setServiceConfig` shape. Without it a provider node boots
   * invisible (no capabilities advertised).
   */
  initialServiceConfig?: CreateNodeOptions['initialServiceConfig'];

  // --- Transport (issues #1, #2) ---------------------------------------
  /**
   * MsgBox relay URL. Supplying this bootstraps WS transport. The three
   * transport inputs — `msgboxURL`, `wsFactory`, `resolveSender` — must
   * be present together; `coreRouter` is NOT required from the caller
   * because bootAppNode already builds one for in-process dispatch and
   * reuses it for MsgBox ingress (issue #13).
   */
  msgboxURL?: string;
  wsFactory?: WSFactory;
  resolveSender?: (did: string) => Promise<{ keys: Uint8Array[]; trust: string }>;
  /**
   * Override the in-process CoreRouter used for both signed-dispatch and
   * MsgBox ingress. Tests pass a pre-seeded router here; production code
   * should omit this — bootAppNode builds one and feeds it through so
   * the MsgBox receive path hits the same routes as internal calls.
   */
  coreRouter?: CoreRouter;
  /**
   * Direct D2D sender override. When omitted we install a logged
   * no-op sender AND record a `transport.sendd2d.noop` degradation.
   * The no-op path is ONLY safe for local dev — a real node with
   * requester or provider role needs a real sender.
   */
  sendD2D?: CreateNodeOptions['sendD2D'];

  // --- Agentic LLM (issue #5) ------------------------------------------
  /**
   * When supplied, the /ask handler routes through the multi-turn
   * agentic tool-use loop instead of the single-shot fallback.
   */
  agenticAsk?: {
    provider: LLMProvider;
    tools: ToolRegistry;
    /**
     * Optional behaviour hooks forwarded verbatim to
     * `makeAgenticAskHandler` — intent classifier, loop budgets,
     * custom system prompt, onTurn telemetry sink. Kept permissive
     * (`Omit<AgenticAskHandlerOptions, 'provider' | 'tools'>`) so
     * new handler options flow through without plumbing churn here.
     */
    options?: Omit<AgenticAskHandlerOptions, 'provider' | 'tools'>;
  };

  // --- Execution plane (issue #9) --------------------------------------
  /**
   * Optional in-process capability runner. Provider nodes that don't
   * have a paired dina-agent can pass this to actually execute
   * service_query_execution delegations locally.
   */
  localDelegationRunner?: LocalCapabilityRunner;
  /** DID the local runner claims under — defaults to the node's DID. */
  localDelegationAgentDID?: string;
  /**
   * Explicit "a paired dina-agent is wired and will claim delegations"
   * flag. The app sets this when onboarding has registered a real
   * agent DID that can log in over RPC and claim tasks. Previously
   * the code inferred this from `peerPublicKeys.size > 0 ||
   * deviceRoleResolver !== undefined`, which passed for ANY paired
   * device — friend contacts, other home nodes — not just agents.
   * Review #12.
   */
  hasPairedAgent?: boolean;

  // --- Staging drain (GAP-RT-01 / GAP-RT-02) ---------------------------
  /**
   * Preference-binder + topic-touch wiring for the production staging
   * drain. When supplied, the scheduler is constructed with
   * `buildStagingEnrichment({core, llm})` as its topicTouch bundle
   * so ingested items flow through entity/theme extraction and
   * preference binding (`my dentist Dr Carl` → `preferredFor:
   * ['dental']`).
   *
   *   - Omit / pass `undefined` → scheduler still runs but with no
   *     enrichment (classify → enrich → resolve, no topic touches,
   *     no preference binding). A `staging.no_enrichment`
   *     degradation is recorded.
   *   - Pass `false` to disable the drain entirely (tests that
   *     manage `staging_inbox` themselves).
   *   - Pass `{ llm }` (reuses the same `LLMProvider` supplied to
   *     `agenticAsk`) to enable the full pipeline. Omit `llm` for
   *     preference-binding-only.
   */
  stagingEnrichment?:
    | false
    | {
        llm?: LLMProvider;
      };

  // --- Policy ----------------------------------------------------------
  role?: NodeRole;
  /** Agent-role resolver for the auth caller-type registry (#14). */
  deviceRoleResolver?: CreateNodeOptions['deviceRoleResolver'];
  /** Keys for paired peers so their signed D2D + RPC verify. */
  peerPublicKeys?: Map<string, Uint8Array>;
  /** Fired when a post-boot ServicePublisher sync fails (#19). */
  onPublishSyncFailure?: (err: Error) => void;

  // --- Observability ---------------------------------------------------
  logger?: BootLogger;
}

/**
 * Compose + start a DinaNode. Returns the live handle plus a list of
 * boot-time degradations so the UI layer can surface them (banner,
 * toast, settings badge). Every missing dependency gets a
 * `BootDegradation` entry — callers MUST inspect `degradations` before
 * reporting the node as "fully ready."
 *
 * Exceptions from `createNode.start()` are re-thrown (e.g. incomplete
 * MsgBox config, PDS publish failure) so the caller can decide whether
 * to retry or show an error state.
 */
export async function bootAppNode(inputs: BootServiceInputs): Promise<BootResult> {
  const log: BootLogger = inputs.logger ?? defaultLogger;
  const degradations: BootDegradation[] = [];
  const addDegradation = (code: string, message: string): void => {
    degradations.push({ code, message });
    log({ event: 'boot.degradation', code, message });
  };

  // --- Rate-limit config for in-process Brain↔Core -----------------------
  // The 50/min default (server builds) trips in seconds on mobile: Brain
  // polls workflow events + hydrates ToC + drains staging + etc., and
  // every one of those calls counts against the node's own DID because
  // in-process dispatch still goes through the auth pipeline (same
  // signature check, same DID). Per-DID limiting guards against external
  // abuse — it has no useful meaning when the caller and Core share a
  // process. Raise to 10k/min so boot converges. Server builds continue
  // to use the 50/min default by never calling this.
  configureRateLimiter({ maxRequests: 10_000, windowSeconds: 60 });

  // --- In-process CoreRouter (always local-composed) --------------------
  // MsgBox ingress + signed in-process dispatch share one router so the
  // D2D receive path and Brain→Core calls hit the same route table. Tests
  // can override via `inputs.coreRouter` (pre-seeded with fakes).
  const router = inputs.coreRouter ?? createCoreRouter();
  const coreDispatch = createInProcessDispatch({ router });
  const signedDispatch = async (
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Uint8Array,
  ) => {
    const resp = await coreDispatch(
      method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      path,
      headers,
      body,
    );
    return { status: resp.status, body: resp.body, headers: resp.headers };
  };

  // Single transport-agnostic client — every brain subsystem + every
  // mobile hook now takes `CoreClient`. Mobile wires the in-process
  // dispatch variant (no HTTP hop; Brain + Core share the RN JS VM);
  // home-node-lite brain-server will wire `HttpCoreTransport` against
  // the same router state when that build target lands.
  //
  // Earlier iterations had a transitional `BrainCoreClient` alongside
  // the transport (task 1.14.7 dual-wiring); the A+ cleanup migrated
  // all 4 mobile hooks + the 5 brain subsystems to CoreClient slices,
  // then retired BrainCoreClient entirely. `signedDispatch` stays
  // local because `bootstrap.ts` still forwards it into the MsgBox
  // ingress adapter for the sender-side signed-response path.
  const coreClient = new InProcessTransport(router);
  void signedDispatch; // kept in scope for MsgBox / response-bridge wiring below

  // --- Persistence (issues #6, #7) --------------------------------------
  let workflowRepository: WorkflowRepository;
  let serviceConfigRepository: ServiceConfigRepository;
  if (inputs.databaseAdapter !== undefined) {
    workflowRepository = new SQLiteWorkflowRepository(inputs.databaseAdapter);
    serviceConfigRepository = new SQLiteServiceConfigRepository(inputs.databaseAdapter);
  } else {
    workflowRepository = new InMemoryWorkflowRepository();
    serviceConfigRepository = new InMemoryServiceConfigRepository();
    addDegradation(
      'persistence.in_memory',
      'No SQLite adapter supplied — workflow tasks + service config are not durable across restart.',
    );
  }

  // --- Working-memory service (WM-CORE-10) ------------------------------
  // The MemoryService reads from the per-persona topic repositories
  // populated by `openPersonaDB`. It is resolver-driven, so it picks up
  // new personas as they unlock without re-wiring. Registering it on
  // every boot is idempotent — the module-global just points at the
  // latest instance, so a warm restart replaces the previous service
  // cleanly.
  setMemoryService(
    new MemoryService({
      resolve: getTopicRepository,
      listPersonas: listTopicRepositoryPersonas,
      nowSecFn: () => Math.floor(Date.now() / 1000),
      onWarning: (e) => log({ event: 'memory.service.warning', ...e }),
    }),
  );

  // --- D2D egress sender (issues #1, #2) --------------------------------
  const sendD2D: CreateNodeOptions['sendD2D'] =
    inputs.sendD2D ??
    (async (to, type, body) => {
      // Noop-with-warning. Without a real sender NOTHING reaches the wire
      // — the Response Bridge fires, /v1/msg/send accepts, but the
      // envelope goes to /dev/null. Loud log + degradation so operators
      // notice before their first failed query.
      log({
        event: 'boot.sendD2D.noop',
        to,
        type,
        query_id: (body as Partial<ServiceResponseBody>).query_id,
        status: (body as Partial<ServiceResponseBody>).status,
      });
    });
  if (inputs.sendD2D === undefined) {
    addDegradation(
      'transport.sendd2d.noop',
      'No real D2D sender supplied — service-query egress + Response-Bridge envelopes are dropped silently (dev scaffold only).',
    );
  }

  // --- AppView + PDS (issues #8, #15) -----------------------------------
  // When the composer doesn't supply a client we install a sink stub
  // that returns no candidates AND record `discovery.no_appview` — a
  // more accurate code than the old `discovery.stub` because the issue
  // is "no real AppView was wired," not "a stub was chosen." The demo
  // composer path keeps the old code for the in-memory fixture (review
  // findings #1, #15).
  const appViewClient = inputs.appViewClient ?? {
    searchServices: async () => [],
  };
  if (inputs.appViewClient === undefined) {
    addDegradation(
      'discovery.no_appview',
      'No AppView client supplied — /service queries will always return "no_candidate". Enable demo mode OR wire a real AppView client to make public-service discovery work.',
    );
  } else if (isAppViewStubClient(inputs.appViewClient)) {
    addDegradation(
      'discovery.stub',
      'Running against the in-memory AppView stub (demo mode) — results come from seeded demo profiles, not the real AppView network.',
    );
  }
  const isProvider = inputs.role === 'provider' || inputs.role === 'both';
  if (isProvider && inputs.pdsPublisher === undefined) {
    addDegradation(
      'publisher.stub',
      'Provider role selected but no PDS publisher supplied — the service profile will not reach AppView.',
    );
  }

  // --- MsgBox transport (issue #2) --------------------------------------
  // `coreRouter` is NOT part of the caller-supplied set — bootAppNode
  // reuses the local `router` above (issue #13). Only the real transport
  // inputs (URL + ws factory + sender key resolver) gate the degradation.
  const msgboxConfigured =
    inputs.msgboxURL !== undefined &&
    inputs.wsFactory !== undefined &&
    inputs.resolveSender !== undefined;
  if (!msgboxConfigured) {
    addDegradation(
      'transport.msgbox.missing',
      'No MsgBox inputs supplied — the node is NOT reachable as a Home Node (requester-only / loopback).',
    );
  }

  // --- Agentic /ask (issue #5) ------------------------------------------
  if (inputs.agenticAsk === undefined) {
    addDegradation(
      'ask.single_shot_fallback',
      'No agenticAsk tools supplied — /ask falls back to single-shot reason() instead of the multi-turn tool-use loop.',
    );
  }

  // --- Local delegation runner (issue #9, #20; review #12) ------------
  // The runner is required ONLY when there's no other execution plane:
  //   - `localDelegationRunner` handles it in-process (demo mode), OR
  //   - the app explicitly asserts a paired dina-agent is wired via
  //     `hasPairedAgent: true`. Merely having peer pubkeys or a device
  //     resolver is NOT proof of a runnable agent (those can hold
  //     pubkeys for friend contacts / other home nodes too).
  if (isProvider && inputs.localDelegationRunner === undefined && inputs.hasPairedAgent !== true) {
    addDegradation(
      'execution.no_runner',
      'Provider role selected but no LocalDelegationRunner supplied AND hasPairedAgent is not asserted — inbound queries will be queued without execution.',
    );
  }

  // --- Identity model (issue #3) ----------------------------------------
  if (!inputs.did.startsWith('did:plc:') && !inputs.did.startsWith('did:web:')) {
    addDegradation(
      'identity.did_key',
      'Node is using a did:key identity — suitable for local dev but not discoverable on AppView. Supply a did:plc via PDS onboarding for production.',
    );
  }

  // --- Staging drain enrichment (GAP-RT-01 / GAP-RT-02) ------------------
  // Production ingest drains Core's `staging_inbox` through the scheduler
  // bootstrap wires in. Without an enrichment bundle, the drain still
  // runs but skips topic touches + preference binding — the memory
  // landed in the vault has no ToC footprint and `my dentist Dr Carl`
  // never binds to a contact. Record a degradation so the caller knows.
  let stagingDrainOption: CreateNodeOptions['stagingDrain'];
  if (inputs.stagingEnrichment === false) {
    stagingDrainOption = false;
  } else if (inputs.stagingEnrichment !== undefined) {
    stagingDrainOption = {
      topicTouch: buildStagingEnrichment({
        core: coreClient,
        llm: inputs.stagingEnrichment.llm,
      }),
    };
  } else {
    addDegradation(
      'staging.no_enrichment',
      'No stagingEnrichment wiring supplied — the drain resolves items but does not extract topics or bind preferences. "my dentist Dr Carl" will not surface on the contact. Pass `stagingEnrichment: { llm }` to enable.',
    );
    stagingDrainOption = undefined; // scheduler runs, but no topicTouch
  }

  const node = await createNode({
    did: inputs.did,
    signingKeypair: inputs.signingKeypair,
    pdsSession: inputs.pdsSession ?? makeStubPDSSession(inputs.did),
    sendD2D,
    coreClient,
    appViewClient,
    pdsPublisher: inputs.pdsPublisher,
    workflowRepository,
    serviceConfigRepository,
    initialServiceConfig: inputs.initialServiceConfig,
    role: inputs.role ?? 'requester',
    peerPublicKeys: inputs.peerPublicKeys,
    deviceRoleResolver: inputs.deviceRoleResolver,
    // Review #15: wire publisher-sync failures into the runtime
    // warnings channel so the banner can surface them. Successful
    // syncs clear the warning — the bootstrap's config-change
    // listener fires a log event we intercept on the `logger` call
    // path below.
    onPublishSyncFailure: (err) => {
      emitRuntimeWarning('publisher.sync_failed', `Service profile sync failed: ${err.message}`);
      if (inputs.onPublishSyncFailure !== undefined) {
        try {
          inputs.onPublishSyncFailure(err);
        } catch {
          /* swallow */
        }
      }
    },
    msgboxURL: inputs.msgboxURL,
    wsFactory: inputs.wsFactory,
    // Feed the locally-built router through so MsgBox ingress + signed
    // in-process dispatch share one route table (issue #13).
    coreRouter: router,
    resolveSender: inputs.resolveSender,
    agenticAsk:
      inputs.agenticAsk !== undefined
        ? {
            provider: inputs.agenticAsk.provider,
            tools: inputs.agenticAsk.tools,
            options: inputs.agenticAsk.options,
          }
        : undefined,
    localDelegationRunner: inputs.localDelegationRunner,
    localDelegationAgentDID: inputs.localDelegationAgentDID,
    stagingDrain: stagingDrainOption,
    logger: (entry) => {
      // Clear the publisher-sync warning as soon as bootstrap reports
      // a successful sync (config changed OR first-boot publish).
      if (entry.event === 'node.service_profile_synced') {
        clearRuntimeWarning('publisher.sync_failed');
      }
      log(entry);
    },
  });

  try {
    await node.start();
  } catch (err) {
    // Clean up Core globals that installCoreGlobals may have written
    // before the failure, so a subsequent retry is not hostile.
    // Issue #13.
    try {
      await node.dispose();
    } catch {
      /* swallow — original error is what matters */
    }
    // Preserve the degradations list we gathered before the failure so
    // the caller can still explain the failure context to the operator
    // (review #14). `useNodeBootstrap` unwraps this and surfaces the
    // list on its error state.
    throw new BootStartupError(err, degradations);
  }

  log({
    event: 'boot.ready',
    did: inputs.did,
    role: inputs.role ?? 'requester',
    degradations: degradations.length,
  });

  return { node, degradations };
}

function makeStubPDSSession(did: string): PDSSession {
  return { did, handle: 'stub.local', accessJwt: '', refreshJwt: '' };
}

/**
 * Narrow "is this the demo in-memory AppView stub" check. Uses the
 * symbol-brand from `appview_stub.ts` so bundling / minification
 * can't silently defeat detection (review #20).
 */
function isAppViewStubClient(
  client: AppViewClient | Pick<AppViewClient, 'searchServices'>,
): boolean {
  // Deferred require — avoids pulling the stub module into code paths
  // that don't otherwise need it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isAppViewStub } = require('./appview_stub') as typeof import('./appview_stub');
  return isAppViewStub(client);
}

/** Default logger — surfaces to console so boot-time degradations are visible. */
function defaultLogger(entry: Record<string, unknown>): void {
  if (entry.event === 'boot.degradation' || entry.event === 'boot.sendD2D.noop') {
    // eslint-disable-next-line no-console
    console.warn('[dina:boot]', entry);
  } else {
    // eslint-disable-next-line no-console
    console.log('[dina:boot]', entry);
  }
}
