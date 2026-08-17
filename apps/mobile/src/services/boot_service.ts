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

import { buildRememberRuntime, createAppViewReasoningEvidenceSource } from '@dina/brain';
import { addMessage, postReminderCard } from '@dina/brain/chat';
import { notifyRunMessageClassified, notifyRunResponseLost } from '@dina/brain/runtime';
import { listPersonas } from '@dina/core';
import {
  MemoryService,
  InMemoryReviewPublishRepository,
  InMemoryServiceConfigRepository,
  InMemoryWorkflowRepository,
  InProcessTransport,
  RunService,
  SQLiteClassificationJobRepository,
  SQLiteCommandReceiptRepository,
  ExtensionOperationRegistry,
  registerCommerceHostOperations,
  SQLiteDrainAuthorizationRepository,
  createCommerceRuntime,
  getNodeDID,
  installCommerceRuntime,
  getCommerceEpochService,
  SQLiteCompletionReceiptRepository,
  SQLiteErasureKeyStore,
  SQLiteMessageRepository,
  SQLiteReservationRepository,
  SQLiteReviewPublishRepository,
  SQLiteRunRepository,
  SQLiteServiceConfigRepository,
  SQLiteWorkflowRepository,
  configureRateLimiter,
  setClassificationJobRepository,
  setCommandReceiptRepository,
  setDrainAuthorizationRepository,
  setUpdateRebindCoordinator,
  UpdateRebindCoordinator,
  getDrainAuthorizationRepository,
  getPluginInstallRepository,
  getCommerceRuntime,
  rebindListingsForUpdate,
  tier0TxRunner,
  createPluginHostRuntime,
  installPluginHostRuntime,
  setExtensionOperationRegistry,
  setCommandTxRunner,
  setCompletionReceiptRepository,
  setErasureKeyStore,
  setMessageRepository,
  setReservationRepository,
  setRunRepository,
  setRunService,
  wireRunPlaneNode,
  InProcessOwnerCommerceClient,
  InProcessOwnerRunClient,
  createCoreRouter,
  createConnectedBrainAgentFacades,
  createInProcessDispatch,
  getTopicRepository,
  listTopicRepositoryPersonas,
  setMemoryService,
  setAskRouteHandler,
  type CoreRouter,
  type DatabaseAdapter,
  type LocalCapabilityRunner,
  type ReviewPublishRepository,
  type ServiceConfigRepository,
  type ServiceResponseBody,
  type WorkflowRepository,
  type WSFactory,
} from '@dina/core/runtime';

/**
 * Per-persona hints for the agentic /remember loop on mobile. Matches
 * the lite brain-server's `PERSONA_DESCRIPTIONS` so both stacks route
 * a "$25 toy budget" memory to `finance` rather than `general`. Also
 * fed into the `/ask` pre-flight retrieval planner so the planner's
 * persona menu carries the same descriptions across both stacks —
 * exported for `boot_capabilities.ts` to consume.
 */
export const MOBILE_PERSONA_DESCRIPTIONS: Record<string, string> = {
  general: "Everyday notes. Anything that doesn't clearly fit a more specific vault.",
  work: 'Job, projects, colleagues, work calendar items, professional context.',
  health: 'Medical, fitness, symptoms, medications, doctors, allergies.',
  finance: 'Money, budgets, spending, income, bills, debt, investments, taxes.',
};
import { isAppViewStub } from './appview_stub';
import { createNode, type DinaNode, type NodeRole, type CreateNodeOptions } from './bootstrap';
import { startMobileCommercePlane } from './commerce_plane';
import { createDemoServiceResponder } from './demo_service_responder';
import { setOwnerCommerceClient } from './owner_commerce_client';
import { setOwnerRunClient } from './owner_run_client';
import { emitRuntimeWarning, clearRuntimeWarning } from './runtime_warnings';
import { buildStagingEnrichment } from './staging_enrichment';
import { talkThreadResolver } from './talk_thread_routing';

import type {
  AgenticAskHandlerOptions,
  AppViewClient,
  LLMProvider,
  PDSPublisher,
  PDSSession,
  ToolRegistry,
} from '@dina/brain';
import type { IdentityKeypair } from '@dina/core';

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
   *   - `searchCapabilities` — intent→canonical-capability discovery
   *     (`search_capabilities`, Services Layer 4)
   *   - `isDiscoverable` — per-capability check (`find_preferred_provider`)
   *   - `resolveTrust` + `searchTrust` — PeerLens peer data
   *     (`search_peerlens`)
   *
   * Both `AppViewClient` (real) and `AppViewStub` (demo) implement
   * all five so either can be passed.
   */
  appViewClient?: Pick<
    AppViewClient,
    'searchServices' | 'searchCapabilities' | 'isDiscoverable' | 'resolveTrust' | 'searchTrust'
  >;
  /**
   * PDS publisher. Required for providers that want AppView
   * discoverability; ignored otherwise.
   */
  pdsPublisher?: PDSPublisher;
  /**
   * Whether the PDS session was reachable at boot. `false` while a publisher
   * is still present means a transient outage — providers surface the
   * `publisher.stub` degradation, but the review-publish drainer keeps its
   * (lazy) publisher so queued reviews retry once the PDS recovers.
   */
  pdsSessionReachable?: boolean;
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
   * Mutually exclusive with `askCoordinator` — when both are set,
   * the coordinator wins (Pattern A subsumes the simpler tool-loop
   * path). In practice production boots set `askCoordinator` and
   * leave `agenticAsk` undefined; tests / minimal nodes that don't
   * need approval gating still use this.
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
  /**
   * Pattern A `/ask` chain (5.21-H). When supplied, installs the
   * coordinator-bridge `AskCommandHandler` so `/ask` rides the full
   * registry + approval gateway + resumer chain. Forwarded verbatim
   * to `createNode` as `askCoordinator`.
   *
   * Built by `boot_capabilities.tryBuildAgenticAsk` when an LLM
   * provider is wired AND the pipeline has `buildToolsForAsk`
   * populated (i.e. `approvalManager` was passed).
   */
  askCoordinator?: CreateNodeOptions['askCoordinator'];
  /**
   * Optional built-in Brain backend. Unlike `agenticAsk`, this provider runs
   * only behind Core's durable reasoning broker and receives a bounded context
   * projection. Boot creates a stable local service principal and never revives
   * a backend the owner disabled.
   */
  internalReasoning?: {
    provider: LLMProvider;
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
   * agent DID that can log in over RPC and claim tasks. Pairing with
   * a friend contact or another home node is not enough.
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
  /** Item C — agent_scope resolver so the auth layer derives req.agentScope. */
  deviceScopeResolver?: CreateNodeOptions['deviceScopeResolver'];
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
  // Boot-minted OWNER capability (INTERACTIVE_SERVICES §12.5, F15). A fresh 32-byte
  // secret generated here + held in this boot closure, passed to BOTH the router
  // (guard verifies it) and the InProcessOwnerRunClient (stamps it). It stops a
  // prompt-injection-STEERED Brain (no owner client, no secret) from forging owner
  // calls. It is NOT a hard boundary against a Brain running arbitrary hostile JS
  // in this shared VM — such code can patch CoreRouter.prototype.handle to skim the
  // secret off a live owner request (F15 re-review). That threat is out of scope
  // for any in-VM mechanism; the server split is the strong-isolation story. See
  // SECURITY.md. Defense-in-depth, honestly scoped.
  const ownerCapBytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(ownerCapBytes);
  const ownerCapability = Array.from(ownerCapBytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  const router =
    inputs.coreRouter ??
    createCoreRouter({
      ownerCapability,
      agentFacades: createConnectedBrainAgentFacades(),
      ...(inputs.appViewClient === undefined
        ? {}
        : {
            reasoningPublicEvidenceSource: createAppViewReasoningEvidenceSource(
              inputs.appViewClient,
            ),
          }),
    });
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
  // `signedDispatch` stays local because `bootstrap.ts` still forwards
  // it into the MsgBox ingress adapter for the sender-side
  // signed-response path. Normal Brain/Core calls use CoreClient.
  const coreClient = new InProcessTransport(router);
  void signedDispatch; // kept in scope for MsgBox / response-bridge wiring below

  // --- Persistence (issues #6, #7) --------------------------------------
  let workflowRepository: WorkflowRepository;
  let serviceConfigRepository: ServiceConfigRepository;
  let reviewPublishRepository: ReviewPublishRepository;
  if (inputs.databaseAdapter !== undefined) {
    workflowRepository = new SQLiteWorkflowRepository(inputs.databaseAdapter);
    serviceConfigRepository = new SQLiteServiceConfigRepository(inputs.databaseAdapter);
    reviewPublishRepository = new SQLiteReviewPublishRepository(inputs.databaseAdapter);
    // Interactive-run subsystem (INTERACTIVE_SERVICES §5..§13) — the full Tier-0
    // store set + service. Owner run control reaches these via a dedicated
    // owner-marked dispatch (InProcessOwnerRunClient), never Brain's transport.
    const runRepository = new SQLiteRunRepository(inputs.databaseAdapter);
    setRunRepository(runRepository);
    setRunService(new RunService({ repository: runRepository }));
    // The owner-only run/watch control client (§12.5). The run UI reaches every
    // list/steer through THIS (owner-marked dispatch → route guards → durable
    // command receipts), never the raw getRunService()/getWatchService() globals
    // that Brain shares on this same JS VM — "trusted-in-process" is not the
    // owner boundary (§20). Router already has /v1/run/* + /v1/watch/* registered
    // (createCoreRouter).
    setOwnerRunClient(new InProcessOwnerRunClient(router, ownerCapability));
    // §4 (photo lanes) — the seller screens' draft dispatch, same boundary.
    setOwnerCommerceClient(new InProcessOwnerCommerceClient(router, ownerCapability));
    setErasureKeyStore(new SQLiteErasureKeyStore(inputs.databaseAdapter));
    setReservationRepository(new SQLiteReservationRepository(inputs.databaseAdapter));
    setMessageRepository(new SQLiteMessageRepository(inputs.databaseAdapter));
    setClassificationJobRepository(new SQLiteClassificationJobRepository(inputs.databaseAdapter));
    setCompletionReceiptRepository(new SQLiteCompletionReceiptRepository(inputs.databaseAdapter));
    setCommandReceiptRepository(new SQLiteCommandReceiptRepository(inputs.databaseAdapter));
    // Commerce Pack stores (COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md §15.5/§16.2).
    // Composed ONCE (ARCH-0): production code receives aggregate stores and
    // cannot reach the raw mutators. Identity and epoch are thunks because
    // both resolve after storage; commerce signing is fail-closed until they do.
    installCommerceRuntime(
      createCommerceRuntime({
        adapter: inputs.databaseAdapter,
        supplierDid: () => {
          const did = getNodeDID();
          if (did === null) {
            throw new Error('commerce: business identity not established — signing is fail-closed');
          }
          return did;
        },
        currentEpoch: () => {
          const service = getCommerceEpochService();
          if (service === null) {
            throw new Error(
              'commerce: epoch service not installed — signing is fail-closed (§16.2)',
            );
          }
          return service.currentEpoch();
        },
      }),
    );
    // §3.4 host-operation plane: the durable proposal broker + the dispatcher
    // that executes permitted proposals. Composed through ONE helper so both
    // boots get the same object — an option each root must remember to pass
    // is an option one of them forgets.
    const extensionRegistry = new ExtensionOperationRegistry();
    setExtensionOperationRegistry(extensionRegistry);
    // §3.4 — the operations a capability may DECLARE. The registry was built
    // empty and only the DISPATCHER was populated, so every declared operation
    // was refused `operation_unregistered` and the executors below were
    // unreachable: the lane was open on the doing side and closed on the
    // declaring one. Code-shipped, never data-driven (§3.4).
    registerCommerceHostOperations(extensionRegistry);
    installPluginHostRuntime(
      createPluginHostRuntime({ db: inputs.databaseAdapter, registry: extensionRegistry }),
    );
    setDrainAuthorizationRepository(new SQLiteDrainAuthorizationRepository(inputs.databaseAdapter));
    // §9.13/§16.5 (WS-3.7) — the update-rebind coordinator, wired here for the
    // same reason the server wires it in its own root: the composition root is
    // the only place that knows the Tier-0 runner and the listing store. The
    // coordinator resolves its repositories PER USE, so the order of the two
    // lines above and this one cannot leave it holding a null.
    // Captured once: the closures below run LATER, and a deferred read of
    // `inputs.databaseAdapter` loses the narrowing this block already proved.
    const rebindDb = inputs.databaseAdapter;
    setUpdateRebindCoordinator(
      new UpdateRebindCoordinator({
        installs: () => getPluginInstallRepository(),
        drains: () => getDrainAuthorizationRepository(),
        rebindListings: (rebindArgs) =>
          rebindListingsForUpdate(rebindDb, rebindArgs),
        // §9.13 — a prior manifest's lifecycle lane stays open while it still
        // serves an order. Absent commerce reads as zero.
        countOpenOrders: (cid) =>
          // §9.11 — a delivered order stops being work once its dispute window
          // passes, and the count needs a clock to know that. Without one every
          // delivered order blocked continuity release and uninstall for ever.
          getCommerceRuntime()?.orders.countUnfinishedByServingManifest(cid, Date.now()) ?? 0,
        tx: tier0TxRunner(rebindDb),
        now: () => Date.now(),
      }),
    );
    // One atomic commit for each owner command's mutation + its receipt (§5/§12.5).
    const cmdReceiptDb = inputs.databaseAdapter;
    setCommandTxRunner((fn) => cmdReceiptDb.transaction(fn));
    // §16.2 + §9.9 step 3 — the commerce background plane. The phone had
    // neither tick: the shared workflow plane that starts the admission sweep
    // is server-only, and nothing here had ever constructed the epoch service,
    // so `currentEpoch()` threw on every commerce operation. Awaited because a
    // half-established epoch is not a state requests should arrive into.
    await startMobileCommercePlane({
      adapter: cmdReceiptDb,
      pds: inputs.pdsPublisher,
      businessDid: inputs.did,
      tx: (fn) => cmdReceiptDb.transaction(fn),
      log,
    });
  } else {
    workflowRepository = new InMemoryWorkflowRepository();
    serviceConfigRepository = new InMemoryServiceConfigRepository();
    reviewPublishRepository = new InMemoryReviewPublishRepository();
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

  // Demo service loopback — when the in-memory AppView stub is in
  // play, also wrap `sendD2D` so outbound `service.query` envelopes
  // addressed to `did:plc:bus42demo` short-circuit into a synthesized
  // `service.response`. Production builds (real AppView) skip the wrap;
  // bus42demo is only published as a stub profile in demo bootstraps.
  const demoSendD2D: CreateNodeOptions['sendD2D'] = isAppViewStub(appViewClient)
    ? createDemoServiceResponder({ log }).wrap(sendD2D)
    : sendD2D;

  // ISVC-10 — the interactive-run pull loop, live on-device. `wireRunPlaneNode`
  // composes the run drivers (pacer/sweeper/classify/completion) over the Tier-0
  // run stores registered above, pulling via the SAME signed `demoSendD2D` egress
  // and encrypting payloads under the live persona DEK. Requires the identity DB
  // (the in-memory fallback can't back the plane's tx/erasure), so it's inert on
  // the degraded no-SQLite path. The §6.2 trust boundary resolves a provider's
  // Ed25519 key through the SAME inbound `resolveSender` the receive pipeline
  // uses; without a sender-resolver (no MsgBox transport) no provider response
  // can arrive, so a null-returning resolver is the correct fail-closed default.
  // Its receive hook + `stop` are handed to `createNode` (below), which consults
  // the hook in `onBypassedD2D` and stops the loop on node teardown.
  const runPlaneNode =
    inputs.databaseAdapter !== undefined
      ? wireRunPlaneNode({
          db: inputs.databaseAdapter,
          sendD2D: demoSendD2D,
          resolveVerificationKey: async (issuerDid, _keyId, _issuedAtSec) => {
            // V1: runtime issuer IS the provider (verifyRunMessage binds this);
            // resolve the provider's current signing key. `key_id`/`issued_at`
            // are plumbed for a future rotation-aware resolver (fail-closed today).
            if (inputs.resolveSender === undefined) return null;
            const { keys } = await inputs.resolveSender(issuerDid);
            return keys[0] ?? null;
          },
          // R5-02 — every classified run message lands a retained `run`-kind
          // Activity entry (in-process append; dual-writes the durable log).
          onMessageClassified: notifyRunMessageClassified,
          // R5-01 — the locked-arrival lane (§7): a lock-raced verified response
          // is device-sealed into the durable SQLite spool + `held_by_lock`,
          // then admitted exactly-once on unlock. The device's identity signing
          // keypair IS its device key; a held response detected lost on replay
          // lands a `run`-kind entry.
          deviceKeypair: {
            publicKey: inputs.signingKeypair.publicKey,
            secretKey: inputs.signingKeypair.privateKey,
          },
          onResponseLost: notifyRunResponseLost,
          log: (entry) => log(entry),
        })
      : undefined;
  if (runPlaneNode !== undefined) {
    runPlaneNode.plane.recoverOnBoot();
    runPlaneNode.start();
  }

  const isProvider = inputs.role === 'provider' || inputs.role === 'both';
  if (isProvider && (inputs.pdsPublisher === undefined || inputs.pdsSessionReachable === false)) {
    addDegradation(
      'publisher.stub',
      'Provider role: the PDS is unreachable or not configured, so the service profile will not reach AppView. (Queued reviews still retry once the PDS recovers.)',
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
  // The coordinator path (Pattern A) is preferred over the agenticAsk
  // tools-only path. Either is fine; only flag the degradation when
  // BOTH are missing.
  if (inputs.agenticAsk === undefined && inputs.askCoordinator === undefined) {
    addDegradation(
      'ask.single_shot_fallback',
      'Neither askCoordinator nor agenticAsk supplied — /ask falls back to single-shot reason() instead of the multi-turn tool-use loop.',
    );
  }

  // --- Local delegation runner (issue #9, #20; review #12) ------------
  // Since Tier 1 (docs/SERVICE_PROVIDER_TIERS.md) the boot path ALWAYS
  // supplies a `localDelegationRunner` claiming the reserved
  // 'dina.local' lane, so instruction-backed capabilities always have an
  // execution plane. What can still go dark is the AGENT lane: a
  // capability bound to an mcpServer with no paired dina-agent daemon
  // queues its tasks to expiry. Boot can only see the env-seeded config
  // here (UI-saved configs hydrate later), so flag the env-provider rig
  // case; UI-configured agent capabilities surface per-task instead
  // (queued task + requester-visible expiry).
  if (isProvider && inputs.localDelegationRunner === undefined && inputs.hasPairedAgent !== true) {
    addDegradation(
      'execution.no_runner',
      'Provider role selected but no LocalDelegationRunner supplied AND hasPairedAgent is not asserted — inbound queries will be queued without execution.',
    );
  }
  const envAgentLaneCaps = Object.entries(inputs.initialServiceConfig?.capabilities ?? {})
    .filter(([, cap]) => typeof cap.mcpServer === 'string' && cap.mcpServer !== '')
    .map(([name]) => name);
  if (isProvider && envAgentLaneCaps.length > 0 && inputs.hasPairedAgent !== true) {
    addDegradation(
      'execution.agent_lane_unmanned',
      `Agent-bound capabilities (${envAgentLaneCaps.join(', ')}) are configured but hasPairedAgent is not asserted — their tasks will queue until a dina-agent daemon claims them.`,
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
  // Dina is LLM-driven: the staging drain REQUIRES the per-item agentic
  // `rememberRuntime` (it throws per item without one — there is no
  // non-LLM fallback). So the drain is enabled ONLY when we can build
  // that runtime; otherwise it's disabled (fail-closed) rather than
  // claiming items and marking every one failed.
  let stagingDrainOption: CreateNodeOptions['stagingDrain'];
  if (inputs.stagingEnrichment === false) {
    // Caller explicitly disabled the drain (e.g. test harness manages it).
    stagingDrainOption = false;
  } else if (inputs.stagingEnrichment !== undefined && inputs.stagingEnrichment.llm !== undefined) {
    const llm = inputs.stagingEnrichment.llm;
    let rememberRuntime: ReturnType<typeof buildRememberRuntime> | undefined;
    try {
      // LIVE getter (not a boot snapshot): a vault the user creates
      // mid-session must be a routing target on the very next /remember.
      // Builtins use the canonical mobile descriptions; user-created vaults
      // fall back to their own stored description.
      const personas = (): { name: string; description: string }[] =>
        listPersonas().map((p) => ({
          name: p.name,
          description: MOBILE_PERSONA_DESCRIPTIONS[p.name] ?? p.description ?? '',
        }));
      rememberRuntime = buildRememberRuntime({ llm, personas, defaultPersona: 'general' });
    } catch (err) {
      addDegradation(
        'staging.remember_runtime_failed',
        `Remember runtime construction failed: ${err instanceof Error ? err.message : String(err)}. Staging drain disabled until a working AI provider is configured.`,
      );
    }
    if (rememberRuntime === undefined) {
      stagingDrainOption = false;
    } else {
      stagingDrainOption = {
        rememberRuntime,
        topicTouch: buildStagingEnrichment({ core: coreClient, llm }),
        // When an inbound D2D message plans a reminder, surface it as a
        // scheduled card in the chat the moment it lands (the drain is
        // headless and just emits — the host decides to render it here).
        onD2DReminderCreated: (reminder) => {
          postReminderCard('main', reminder, { scheduled: true });
        },
        // Surface the peer's actual message as a left-aligned bubble in the
        // main chat the moment it lands (known contacts only — unknown
        // senders go through the quarantine card). Renders via type='dina' +
        // metadata.source='d2d', attributed to the sender (not "Dina"). The
        // sender's wire time orders a burst correctly (MT-19-I2).
        onD2DMessage: ({ senderDid, senderName, body, messageType, timestamp }) => {
          addMessage('main', 'dina', body, {
            metadata: { source: 'd2d', senderDID: senderDid, senderName, messageType },
            ...(timestamp > 0 ? { timestamp } : {}),
          });
        },
      };
    }
  } else {
    // No AI provider configured — disable the drain (fail-closed).
    // Remembered items stay queued in staging until a provider is set up
    // and the node re-boots; Dina can't enrich/route without an LLM.
    addDegradation(
      'staging.disabled_no_llm',
      'No AI provider configured — staging drain disabled. Remembered items stay queued until you set up a provider; Dina is LLM-driven and cannot enrich or route without one.',
    );
    stagingDrainOption = false;
  }

  // Wire the ask coordinator into the CoreRouter's /api/v1/ask surface so
  // external agents (via MsgBox) can call `dina ask` against this node.
  // The singleton is cleared on dispose so a re-boot with a different
  // coordinator doesn't bleed the old one. MT-38.
  if (inputs.askCoordinator !== undefined) {
    setAskRouteHandler(inputs.askCoordinator.coordinator);
  }

  const node = await createNode({
    did: inputs.did,
    signingKeypair: inputs.signingKeypair,
    pdsSession: inputs.pdsSession ?? makeStubPDSSession(inputs.did),
    sendD2D: demoSendD2D,
    coreClient,
    appViewClient,
    pdsPublisher: inputs.pdsPublisher,
    pdsSessionReachable: inputs.pdsSessionReachable,
    workflowRepository,
    serviceConfigRepository,
    reviewPublishRepository,
    initialServiceConfig: inputs.initialServiceConfig,
    role: inputs.role ?? 'requester',
    peerPublicKeys: inputs.peerPublicKeys,
    deviceRoleResolver: inputs.deviceRoleResolver,
    deviceScopeResolver: inputs.deviceScopeResolver,
    // Contact Services seam 4: route an inbound `service.response` back to the
    // Talk thread the query was launched from. `talkThreadResolver` returns the
    // peer DID for a `did:`-shaped origin (seam 5 stamps `origin_channel =
    // peerDID`) and null otherwise (main-chat `query_service` origins: 'ask' /
    // 'chat' / '') so those fall back to the default 'main' thread. Extracted to
    // a named, tested function so the suite pins the REAL routing.
    threadResolver: talkThreadResolver,
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
    // ISVC-10 — the interactive-run pull loop's receive hook + stop, consulted
    // in `onBypassedD2D` (verify-and-ingest run responses) and stopped on
    // teardown. `undefined` on the in-memory (no-SQLite) degraded path.
    runPlane: runPlaneNode,
    agenticAsk:
      inputs.agenticAsk !== undefined
        ? {
            provider: inputs.agenticAsk.provider,
            tools: inputs.agenticAsk.tools,
            options: inputs.agenticAsk.options,
          }
        : undefined,
    askCoordinator: inputs.askCoordinator,
    internalReasoning: inputs.internalReasoning,
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
    setAskRouteHandler(null);
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

/**
 * Codes that represent expected demo-build defaults. Logged at
 * `console.log` level (not `.warn`) so RN's LogBox stays empty on a
 * clean demo launch — these aren't issues a user can fix and the
 * banner suppression in `app/_layout.tsx` already hides them from
 * the UI. Mirror of `BANNER_SUPPRESS_CODES` in the layout: any code
 * that's user-visible-suppressed should be log-level-suppressed too,
 * so the two stay in sync.
 */
const DEMO_EXPECTED_CODES: ReadonlySet<string> = new Set(['discovery.stub']);

/** Default logger — surfaces to console so boot-time degradations are visible. */
function defaultLogger(entry: Record<string, unknown>): void {
  const isDegradation = entry.event === 'boot.degradation' || entry.event === 'boot.sendD2D.noop';
  const isDemoExpected = typeof entry.code === 'string' && DEMO_EXPECTED_CODES.has(entry.code);
  if (isDegradation && !isDemoExpected) {
    console.warn('[dina:boot]', entry);
  } else {
    console.log('[dina:boot]', entry);
  }
}
