/**
 * Home-node bootstrap — composes Core + Brain + runners + MsgBox transport
 * into a `DinaNode` handle. One call on app unlock.
 *
 * The factory's contract:
 *   - Caller supplies pre-built clients (`CoreClient`, `AppViewClient`,
 *     optional `PDSPublisher`) + a storage backend (`WorkflowRepository`)
 *     + a `ServiceConfig` accessor.
 *   - Bootstrap owns: constructing `WorkflowService` with the Response
 *     Bridge wired, `ServiceHandler` (inbound), orchestrator
 *     (outbound), `WorkflowEventConsumer` (delivers chat + dispatches
 *     approvals), `ApprovalReconciler` (TTL sweeper).
 *   - Chat-orchestrator globals (`setServiceCommandHandler` et al) are
 *     installed when `globalWiring !== false`. Integration tests that
 *     run multiple nodes in one process should pass `globalWiring: false`
 *     and interact with the node's direct handles instead.
 *
 * `start()` connects MsgBox + (if provider) publishes the service profile
 * + starts the polling runners. `stop()` halts them in reverse order.
 */

import type { HomeNodeLifecycle } from '@dina/home-node';

import {
  BridgePendingSweeper,
  LeaseExpirySweeper,
  LocalDelegationRunner,
  MsgTypeCoordinationRequest,
  MsgTypeCoordinationResponse,
  MsgTypeSafetyAlert,
  MsgTypeSocialUpdate,
  MsgTypeTrustVouchRequest,
  MsgTypeTrustVouchResponse,
  TaskExpirySweeper,
  WatchPollSweeper,
  WatchService,
  WorkflowService,
  defaultPluginCompletionHandler,
  getPluginHostRuntime,
  getPluginInstallRepository,
  transformInboundOrderResult,
  bootstrapMsgBox,
  buildWatchPollHandler,
  getWatchService,
  disconnectMsgBox,
  getReviewPublishRepository,
  getSessionRegistry,
  getServiceConfig,
  listServiceConfigs,
  hydrateServiceConfig,
  isMsgBoxAuthenticated,
  onMsgBoxAuthenticated,
  makeServiceResponseBridgeSender,
  onGrantRequestPending,
  onServiceOfferReceived,
  onServiceConfigChanged,
  registerDevice as registerDeviceDID,
  registerPublicKeyResolver,
  registerService,
  resetCallerTypeState,
  resetMiddlewareState,
  resetServiceConfigState,
  setD2DSender,
  setDeviceRoleResolver,
  setDeviceScopeResolver,
  setNodeDID,
  setReviewPublishRepository,
  setServiceConfig,
  setServiceConfigRepository,
  setServiceQuerySender,
  setServiceRespondSender,
  setWatchService,
  setWorkflowRepository,
  setWorkflowService,
  getWorkflowService,
  setWSDeliverFn,
  type CoreClient,
  type CoreRouter,
  type DinaMessage,
  type LocalCapabilityRunner,
  type MsgBoxBootConfig,
  type ServiceConfig,
  type ReviewPublishRepository,
  type ServiceConfigRepository,
  type ServiceQueryBody,
  type ServiceResponseBody,
  type WorkflowRepository,
  type WSFactory,
} from '@dina/core/runtime';

// Wire MsgBox WS authentication to clear any pending offline warning.
// Fires on initial connect AND on every reconnect cycle, so a user
// action that surfaced "relay offline" inline gets a silent
// background recovery once the relay is reachable again — no
// "everything is fine now" banner needed.
onMsgBoxAuthenticated(() => {
  clearRuntimeWarning('transport.msgbox.offline');
});

/**
 * App-layer D2D egress shape. Every outbound D2D route in bootstrap.ts
 * funnels through one of these, so the app gets a single place to
 * resolve recipients + push bytes onto the WebSocket.
 *
 * `messageType` is one of the V1 family members (see
 * core/d2d/families.ts) or the reserved `service.query` /
 * `service.response` sentinels. The app uses it to pick
 * `serviceType` + any per-type audit tags; it must not mutate
 * `body`.
 */
export type AppD2DSender = (
  to: string,
  messageType: string,
  body: Record<string, unknown>,
) => Promise<unknown>;
import {
  createCoordinatorAskHandler,
  classifyInternalBrainError,
  createInternalBrainExecutor,
  createProviderReasoningLLM,
  createReasoningOutputGuard,
  makeAgenticAskHandler,
  makeServiceApproveHandler,
  makeServiceDenyHandler,
  ServicePublisher,
  toPublisherConfig,
  validateAgainstSchema,
  wireServiceOrchestrator,
  type AgenticAskHandlerOptions,
  type ApprovalNotifier,
  type ApprovalReconciler,
  type AskCoordinator,
  type CreateCoordinatorAskHandlerOptions,
  type D2DDispatcher,
  type LLMProvider,
  type OrchestratorAppView,
  type PDSPublisher,
  type PDSSession,
  type ServiceHandler,
  type ServiceInboundNotifier,
  type ServiceQueryOrchestrator,
  type ToolRegistry,
  type WorkflowEventConsumer,
  type WorkflowEventDeliverer,
  AppViewClient,
} from '@dina/brain';
import {
  setServiceApproveCommandHandler,
  resetServiceApproveCommandHandler,
  setServiceDenyCommandHandler,
  resetServiceDenyCommandHandler,
  setAskCommandHandler,
  resetAskCommandHandler,
  setContactServiceHandler,
  resetContactServiceHandler,
  addApprovalMessage,
  addMessage,
  addSystemMessage,
  hydrateThread,
  createServiceQueryDeliverer,
} from '@dina/brain/chat';
import { deliverWatchResult } from '@dina/brain/notifications';
import {
  installWorkflowApprovalInboxBridge,
  installWorkflowApprovalChatBridge,
  StagingDrainScheduler,
  type StagingDrainOptions,
} from '@dina/brain/runtime';
import {
  CoreReasoningBroker,
  ReasoningBackendSupervisor,
  ReasoningBackendWorker,
  createReasoningCommitBridge,
  createReasoningPolicySnapshotResolver,
  createServiceReasoningCommitter,
  createServiceReasoningSubmitter,
  deriveLocalServiceIdentity,
  ensureReasoningBackendForBoot,
  getContact,
  getReasoningBackendRepository,
  getReasoningBroker,
  getReasoningContextRepository,
  markReasoningBackendPresent,
  clearReasoningBackendPresence,
  MsgTypeServiceResponse,
  setReasoningBroker,
  stagingGetItem,
  composeInviteService,
  installInviteService,
  sign as ed25519Sign,
  verify as ed25519Verify,
} from '@dina/core';
import { makeResolveSender } from '@dina/home-node';
import { wireChatRememberRuntime } from '@dina/home-node/chat-runtime';
import {
  buildHomeNodeServiceRuntime,
  toServiceResponseBody,
} from '@dina/home-node/service-runtime';
import { resolveSearchableCapability } from '@dina/protocol';

import { peekActiveProvider } from '../ai/active_provider';
import { reportKeyHealthIncident } from '../ai/key_health';
import {
  setServiceConfigCoreClient,
  resetServiceConfigCoreClient,
} from '../hooks/useServiceConfigForm';
import { setInboxCoreClient, resetInboxCoreClient } from '../hooks/useServiceInbox';
import { openPersonaDB, isPersistenceReady } from '../storage/init';

import { setServiceQueryDispatcher, sendServiceQuery, sendGrantRequest } from './chat_d2d';
import { postGrantPromptOnce } from './grant_prompt';
import { resolveInboxCoreClient } from './inbox_client_resolver';
import {
  resetPendingPreflights,
  stashPendingPreflight,
  takePendingPreflight,
} from './pending_preflight';
import { clearRuntimeWarning } from './runtime_warnings';
import { installServerNotifications } from './server_notifications';
import { resolveServiceConfigCoreClient } from './service_config_resolver';

import type { IdentityKeypair } from '@dina/core';

export type NodeRole = 'requester' | 'provider' | 'both';

export interface CreateNodeOptions {
  // --- Identity -----------------------------------------------------------
  did: string;
  signingKeypair: IdentityKeypair;
  pdsSession: PDSSession;

  // --- Transport plumbing --------------------------------------------------
  /** MsgBox WebSocket URL. Omit for nodes that don't hit the wire. */
  msgboxURL?: string;
  wsFactory?: WSFactory;
  /**
   * D2D send — single egress seam used by EVERY outbound D2D route:
   * the Response Bridge, the service.query orchestrator, the
   * service.respond path, and the generic `/v1/msg/send` D2DSender
   * that chat_d2d.ts leans on.
   *
   * We pass `messageType` through explicitly (rather than peeking at
   * the body shape) so the app-layer implementation can pick the right
   * `serviceType` + audit category without parsing bodies. For the
   * Response Bridge we wrap this sender in an adapter that hardcodes
   * `'service.response'` as the type (see makeServiceResponseBridgeSender
   * call below).
   */
  sendD2D: AppD2DSender;
  /** Inbound receive pipeline sender-resolver. */
  resolveSender?: (did: string) => Promise<{ keys: Uint8Array[]; trust: string }>;
  /** CoreRouter — receives inbound MsgBox RPC envelopes via in-process dispatch. */
  coreRouter?: CoreRouter;
  /**
   * ISVC-10 — the interactive-run pull loop (built in `boot_service.ts`, which
   * holds the identity DB). A run-correlated provider `service.response` is
   * consumed by `handleServiceResponse` FIRST inside `onBypassedD2D` (it verifies
   * at the §6.2 trust boundary + ingests, or rejects — either way returns `true`
   * so it never falls through to the requester dispatcher). `stop` is registered
   * as a disposer so the pacer/sweeper timers clear on node teardown. Structural
   * subset of `RunPlaneNode` so the caller can pass it directly.
   */
  runPlane?: {
    handleServiceResponse: (senderDID: string, body: unknown) => Promise<boolean>;
    stop: () => void | Promise<void>;
  };

  // --- Clients + stores the caller provides -------------------------------
  /**
   * Transport-agnostic `CoreClient` handle — every brain subsystem
   * wires against this. Mobile boot passes `InProcessTransport(router)`;
   * home-node-lite's brain-server passes `HttpCoreTransport`. Both
   * implement the same `CoreClient` interface so bootstrap code never
   * branches on runtime. The normal runtime exposes one Core client;
   * there is no parallel Brain-owned Core client surface.
   */
  coreClient: CoreClient;
  appViewClient: Pick<AppViewClient, 'searchServices'>;
  pdsPublisher?: PDSPublisher;
  /**
   * Whether the supplied `pdsPublisher`'s session was validated at boot.
   * `false` means the PDS was unreachable (transient outage / offline): the
   * publisher is still passed through for the review-outbox drainer (which
   * retries and never blocks boot), but the provider service-profile
   * `ServicePublisher` is NOT constructed — its initial `sync()` re-auths and
   * would throw out of `start()`, turning a transient outage into a boot
   * failure. Defaults to "reachable" when omitted (test/no-PDS paths).
   */
  pdsSessionReachable?: boolean;
  workflowRepository: WorkflowRepository;
  /**
   * Service-config repository (SQLite-backed in production). When supplied
   * it becomes the durable store Core reads from for capability lookups
   * during D2D ingress; when omitted the config lives only in-process.
   */
  serviceConfigRepository?: ServiceConfigRepository;
  /** Durable PeerLens publish-job store. When present it's registered as the
   *  global so the worker, Outbox screen, and inline card project from it. */
  reviewPublishRepository?: ReviewPublishRepository;
  /**
   * Accessor for the node's ServiceConfig. Kept for injection in tests.
   * When omitted, bootstrap falls back to Core's
   * global `getServiceConfig` (driven by `setServiceConfig` / the config
   * repository).
   */
  readConfig?: (rkey?: string) => ServiceConfig | null;
  /**
   * Initial ServiceConfig to seed into Core's global store. Used so the
   * D2D ingress pipeline can immediately bypass the contact gate for
   * configured capabilities. Callers that manage config through the
   * `/v1/service/config` HTTP endpoint don't need to supply this.
   */
  initialServiceConfig?: ServiceConfig;
  /**
   * Peers whose Ed25519 public keys should be resolvable for D2D
   * signature verification + inbound RPC authentication. Self is
   * registered automatically. Add paired agents + friends here.
   */
  peerPublicKeys?: Map<string, Uint8Array>;
  /**
   * Device-role resolver for agent-pull authorization. Given a DID,
   * return 'agent' / 'rich' / 'thin' / 'cli' / null. When omitted the
   * caller_type module treats all paired DIDs as generic 'device'.
   */
  deviceRoleResolver?: (did: string) => string | null;

  /**
   * Item C — device agent_scope resolver. Given a DID, return 'coding' /
   * 'runner' / null. Lets the auth pipeline derive `req.agentScope` from the
   * signed device record. Omitted ⇒ agents default to 'runner' in middleware.
   */
  deviceScopeResolver?: (did: string) => string | null;

  // --- Role + wiring ------------------------------------------------------
  role: NodeRole;
  chatThreadId?: string;
  /**
   * Optional resolver that maps an incoming workflow event to the
   * chat thread its delivery should land in. Receives the service
   * task's `origin_channel` (as stored in the task payload) + the
   * event + task themselves. Return `null` to fall back to
   * `chatThreadId`.
   *
   * Once multiple threads exist (per-persona chats, a separate
   * Service Inbox thread, etc.) the caller supplies this resolver to
   * route by origin.
   */
  threadResolver?: (ctx: {
    originChannel: string;
    eventKind: string;
    task: { id: string; kind: string };
  }) => string | null;
  /**
   * When provided alongside `globalWiring=true`, installs an agentic
   * `/ask` handler that routes natural-language questions through the
   * multi-turn tool-use loop. The LLM autonomously picks which tools to
   * call based on each tool's registered description. Tools are supplied
   * via the `tools` registry below — adding a new capability is a
   * registry insertion, not a handler rewrite. Omit `agenticAsk` for
   * test/minimal nodes that only speak the explicit `/service` slash
   * command.
   */
  agenticAsk?: {
    provider: LLMProvider;
    tools: ToolRegistry;
    options?: Omit<AgenticAskHandlerOptions, 'provider' | 'tools'>;
  };
  /**
   * Pattern A `/ask` chain (5.21-H). When supplied alongside
   * `globalWiring=true`, installs the chat orchestrator's
   * `AskCommandHandler` via the coordinator bridge — `/ask` then
   * routes through the full Pattern A suspend/resume registry +
   * approval gateway, with deferred answer delivery to the chat
   * thread on operator approval / async completion.
   *
   * Mutually exclusive with `agenticAsk`: when both are set, the
   * coordinator wins (Pattern A subsumes the simpler tool-loop path).
   * Tests / minimal nodes that don't need approval-gated reads can
   * keep using `agenticAsk`; production mobile + brain-server
   * pass this once an `ApprovalManager` + pipeline are wired.
   */
  askCoordinator?: {
    coordinator: AskCoordinator;
    /** DID attributed as the requester for every `/ask` from this node. */
    requesterDid: string;
  } & Pick<
    CreateCoordinatorAskHandlerOptions,
    'defaultThreadId' | 'formatPendingMessage' | 'formatResumeHeader' | 'formatFailureMessage'
  >;
  /**
   * Built-in reasoning provider executed through Core's durable job broker.
   * It is deliberately separate from the direct chat coordinator so revocation,
   * lease fencing, bounded context, output validation, and commit rules apply.
   */
  internalReasoning?: {
    provider: LLMProvider;
  };
  /** Optional approval-operator notifier. Defaults to chat-thread system msg. */
  approvalNotifier?: ApprovalNotifier;
  /**
   * Called when a post-boot ServicePublisher sync fails — lets the
   * app surface a toast/system message so capability changes that
   * failed to propagate don't silently leave AppView stale
   * (issue #19). Receives the error; logger sink ALSO fires.
   */
  onPublishSyncFailure?: (err: Error) => void;
  /**
   * Optional in-process delegation runner. When provided, the node
   * spins up a `LocalDelegationRunner` that claims queued delegation
   * tasks and invokes this callback to produce results.
   *
   * Production topology uses an external `dina-agent` instead — this
   * is the demo / single-process alternative. Issue #5 / #6.
   *
   * `localDelegationAgentDID` is the DID the runner claims under;
   * defaults to the node's own DID when omitted, which is only
   * appropriate for demos.
   */
  localDelegationRunner?: LocalCapabilityRunner;
  localDelegationAgentDID?: string;
  /**
   * Install chat-orchestrator globals (`/service` handler, approve/deny,
   * inbox + config hook clients). Default true; tests with multiple
   * nodes in one process must opt out so only one node installs the
   * chat handlers.
   */
  globalWiring?: boolean;
  /**
   * Install Core module-level singletons (workflow service + repository,
   * service-query + service-respond + D2D senders, public-key resolver,
   * caller-type registry, service-config repository + initial config).
   * Default true.
   *
   * Multi-node tests running two `createNode()` instances in one process
   * MUST set this to false on one of them to prevent the second call
   * from clobbering the first node's singletons (issue #2). When
   * disabled, the caller is responsible for wiring those singletons
   * directly via the public setters in core/src/*.
   */
  coreGlobals?: boolean;

  /**
   * GAP-RT-01 / GAP-RT-02: staging-drain configuration. Omit or pass
   * `true` to run with defaults (10 s cadence, no topicTouch). Pass
   * `false` to disable (tests that manage `staging_inbox` themselves).
   * Pass a `StagingDrainOptions` object to configure the drain —
   * typical production wiring passes the topicTouch pipeline deps
   * (`{extractor, core, resolveContact, preferenceExtractor}`) so the
   * preference binder runs end-to-end.
   */
  stagingDrain?: boolean | StagingDrainOptions;
  /** Override the drain tick cadence (ms). Default 10_000. */
  stagingDrainIntervalMs?: number;

  // --- Testing overrides --------------------------------------------------
  nowMsFn?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  logger?: (entry: Record<string, unknown>) => void;
}

export interface DinaNode extends HomeNodeLifecycle {
  did: string;
  /**
   * The role this node started under. The UI reads this to decide
   * whether to expose provider-only tabs (Approvals + Service
   * Sharing) — a `requester`-only node shouldn't (review #16).
   */
  role: NodeRole;
  coreClient: CoreClient;
  /**
   * Authed PDS publisher (lazy session). Present for every role when PDS
   * credentials exist — providers use it for the service profile; every node
   * uses it to publish PeerLens reviews (attestation records) to AppView.
   * `undefined` when no PDS handle/password is configured.
   */
  pdsPublisher?: PDSPublisher;
  workflowService: WorkflowService;
  orchestrator: ServiceQueryOrchestrator;
  handler: ServiceHandler;
  /** D2D dispatcher — service.query + service.response routed here. */
  dispatcher: D2DDispatcher;
  runners: {
    events: WorkflowEventConsumer;
    approvals: ApprovalReconciler;
    taskExpiry: TaskExpirySweeper;
    leaseExpiry: LeaseExpirySweeper;
    /** Retries `bridge_pending` stashes that failed to send on first
     *  attempt. Runs unconditionally — no-op when nothing is stashed. */
    bridgeRetry: BridgePendingSweeper;
    /** PSVC-0: fires due poll-mode `watch` tasks as `service.query`. */
    watchPoll: WatchPollSweeper;
    /** GAP-RT-01: drains Core's `staging_inbox` on a cadence. `null`
     *  only when explicitly disabled via `options.stagingDrain === false`. */
    stagingDrain: StagingDrainScheduler | null;
    /** Present only when `localDelegationRunner` was supplied. */
    localRunner: LocalDelegationRunner | null;
    /** Built-in Brain worker cadence, present only when its binding is active. */
    reasoningBackend: ReasoningBackendSupervisor | null;
  };
  /** Connect MsgBox, publish profile (if provider), start runners. */
  start(): Promise<void>;
  /** Stop runners, disconnect MsgBox. Safe to call multiple times. */
  stop(): Promise<void>;
  /** Force one poll cycle each on events + approvals. Tests use this. */
  drainOnce(): Promise<void>;
  /** Release all resources and undo global wiring. */
  dispose(): Promise<void>;
}

const DEFAULT_THREAD_ID = 'main';
const INTERNAL_REASONING_BACKEND_ID = 'dina.internal-brain';

/**
 * The single, neutral acknowledgement shown to the REQUESTER when a contact
 * (relationship) service has no stored offer yet and a `service.grant_request`
 * preflight is fired. It is deliberately identical across every grantor outcome
 * — auto-grant, ask-to-enable, soft-reject, offline, or a local send error —
 * so the requester can never infer the grantor's decision or their own social
 * rank (CONTACT_SERVICES_ARCHITECTURE.md §2/§10, asymmetric visibility).
 */
export const CONTACT_SERVICE_PREFLIGHT_ACK =
  'Reaching out to set that up — check back in a moment.';

export async function createNode(options: CreateNodeOptions): Promise<DinaNode> {
  validate(options);

  const log =
    options.logger ??
    (() => {
      /* no-op */
    });
  const nowMsFn = options.nowMsFn ?? Date.now;
  const threadId = options.chatThreadId ?? DEFAULT_THREAD_ID;
  const globalWiring = options.globalWiring !== false;
  const coreGlobals = options.coreGlobals !== false;
  const isProvider = options.role === 'provider' || options.role === 'both';

  // Disposer for the workflow→inbox bridge — captured at install-time so
  // the dispose() path can detach cleanly when the node tears down.
  let workflowApprovalBridgeDispose: (() => void) | null = null;

  // Core-globals installation is DEFERRED to start() so an unstarted
  // node doesn't mutate process state. Issue #8. The closure captures
  // everything it needs; start() invokes it; dispose() runs the
  // teardown. Multi-node tests still opt out via `coreGlobals: false`.
  const installCoreGlobals = (): void => {
    if (!coreGlobals) return;
    setWorkflowRepository(options.workflowRepository);

    // Mirror kind=approval workflow tasks into the unified Notifications
    // inbox. `installApprovalInboxBridge` (in boot_capabilities) only
    // covers approvals minted via `ApprovalManager` (the persona-guard
    // path). The two surfaces that go directly to `workflow_tasks` —
    // `/v1/agent/validate` (intent_validation) and service.query review
    // policy — bypass the manager, so without this bridge their cards
    // render in the dedicated /approvals screen but never surface in the
    // unified Notifications screen's "Approvals" filter. Wired only when
    // a workflow repo is present (multi-node tests with workflowRepository:
    // undefined opt out cleanly).
    if (options.workflowRepository !== undefined) {
      workflowApprovalBridgeDispose = installWorkflowApprovalInboxBridge(
        options.workflowRepository,
      );
      // Parallel chat-thread bridge — writes an inline approval bubble
      // to the owner's main chat thread when an agent's vault_read
      // request raises an approval task. Closes the dina_details §13.4
      // "approval will come to dina mobile app … 🔐 claw-agent wants
      // to access health" UX — previously only the Approvals tab +
      // Notifications inbox got the card; the operator's primary
      // surface (chat) showed nothing. Same disposer chain.
      const chatBridgeDispose = installWorkflowApprovalChatBridge(options.workflowRepository);
      const inboxDispose = workflowApprovalBridgeDispose;
      workflowApprovalBridgeDispose = (): void => {
        try {
          chatBridgeDispose();
        } catch {
          /* */
        }
        try {
          inboxDispose();
        } catch {
          /* */
        }
      };
    }

    // issues.txt §4 — only REGISTER the repo here (this closure is sync).
    // Hydration + the env/demo override happen in `createNode`'s async
    // body right after this runs, in the precedence order: register →
    // hydrate persisted → apply initialServiceConfig override.
    if (options.serviceConfigRepository !== undefined) {
      setServiceConfigRepository(options.serviceConfigRepository);
    }
    if (options.reviewPublishRepository !== undefined) {
      setReviewPublishRepository(options.reviewPublishRepository);
    }

    // Ed25519 public-key resolver — self is always resolvable; peers come
    // from the optional map. The resolver is what verifyRequest consults
    // to verify signatures on every signed call (Brain → Core via
    // in-process, and inbound MsgBox RPC).
    const selfPubKey = options.signingKeypair.publicKey;
    const peers = options.peerPublicKeys ?? new Map<string, Uint8Array>();
    registerPublicKeyResolver((did) => {
      if (did === options.did) return selfPubKey;
      return peers.get(did) ?? null;
    });

    // Caller-type registry. Brain (= this node's own DID) is a service,
    // so signed internal calls pass the authz matrix. Paired agent
    // devices (if any) are registered here too.
    registerService(options.did, 'brain');
    if (options.deviceRoleResolver !== undefined) {
      setDeviceRoleResolver(options.deviceRoleResolver);
    }
    if (options.deviceScopeResolver !== undefined) {
      setDeviceScopeResolver(options.deviceScopeResolver);
    }

    // Pairing ceremony — `generatePairingCode` + `completePairing` need
    // the home-node DID to embed in the result envelope so the paired
    // device knows whom it just trusted. The Paired Devices admin
    // screen calls these directly; without this wiring the screen
    // surfaces "node DID not set" and pairing fails before any device
    // sees a code.
    setNodeDID(options.did);

    // Egress senders — Core's route handlers for /v1/service/query,
    // /v1/service/respond, and /v1/msg/send all delegate to these
    // injected callbacks. Without this block the routes return 503.
    // All three bind to the same underlying sendD2D so one code path,
    // one set of gates, one audit trail. Issues #3, #4, #16.
    const serviceQuerySender = async (
      to: string,
      type: 'service.query',
      body: ServiceQueryBody,
    ): Promise<void> => {
      await options.sendD2D(to, type, body as unknown as Record<string, unknown>);
    };
    setServiceQuerySender(serviceQuerySender);

    const serviceRespondSender = async (
      to: string,
      type: 'service.response',
      body: ServiceResponseBody,
    ): Promise<void> => {
      await options.sendD2D(to, type, body as unknown as Record<string, unknown>);
    };
    setServiceRespondSender(serviceRespondSender);

    setD2DSender(async (to, type, body) => {
      await options.sendD2D(to, type, body);
    });

    // §8 — the invite ceremony, composed HERE because its four app facts
    // (signing key, DID resolution, relay route) live at this boot. Core
    // fills its own seams (invite store, D2D sender, contacts, grants).
    const inviteResolveSender = makeResolveSender({
      selfDID: options.did,
      selfPublicKey: options.signingKeypair.publicKey,
    });
    composeInviteService({
      signOfferDigest: (bytes) => ed25519Sign(options.signingKeypair.privateKey, bytes),
      resolveSigningKey: async (did) => {
        const resolved = await inviteResolveSender(did);
        return resolved.keys[0] ?? null;
      },
      verify: (message, signature, publicKey) => ed25519Verify(publicKey, message, signature),
      relayUrl: () => options.msgboxURL ?? null,
    });

    // Workflow service + repository — Core routes consult these via
    // `getWorkflowService()` / `getWorkflowRepository()`. Installed
    // last so every dependent layer above has wired up first.
    setWorkflowService(workflowService);
    if (reasoningBroker !== null) {
      setReasoningBroker(reasoningBroker);
      reasoningBroker.reconcileSessionAuthorities();
    }
  };

  // 1. WorkflowService with Response Bridge — completion on a delegation
  // task with payload.type === 'service_query_execution' auto-emits
  // service.response on the wire.
  const responseBridgeSender = makeServiceResponseBridgeSender({
    // ResponseBridge is service.response-only; inject the type so the
    // app's single sendD2D keeps one signature across all call sites.
    // After a successful send, post a system message into the operator's
    // chat so the service/provider sees evidence the response went out
    // (matches the inbound notification posted on receive — closes the
    // visibility loop end-to-end).
    sendResponse: async (to, body) => {
      await options.sendD2D(to, 'service.response', body as unknown as Record<string, unknown>);
      addSystemMessage(
        threadId,
        formatResponseSentLine({
          toDID: to,
          capability: body.capability,
          status: body.status,
          error: body.error,
        }),
      );
    },
    // GAP-SH-05: wire brain's minimal draft-07 validator so the bridge
    // checks runner output against the frozen `schema_snapshot.result`.
    // A violation becomes a `result_schema_violation` error response
    // rather than a drifted success payload.
    validateResult: validateAgainstSchema,
    onMalformedResult: (ctx, err) =>
      log({
        event: 'bridge.malformed_result',
        query_id: ctx.queryId,
        error: err.message,
      }),
    onSendError: (ctx, err) =>
      log({
        event: 'bridge.send_failed',
        query_id: ctx.queryId,
        error: err.message,
      }),
    onResultValidationFailure: (ctx, error) =>
      log({
        event: 'bridge.result_validation_failed',
        query_id: ctx.queryId,
        capability: ctx.capability,
        error,
      }),
  });
  const workflowService = new WorkflowService({
    repository: options.workflowRepository,
    nowMsFn,
    responseBridgeSender,
    // §9.9 — a completed `submit_order` is answered with the acknowledgement
    // Core signed, not the runner's JSON. The server plane has passed this
    // since WS-3.8; the phone did NOT, so a supplier running on a phone
    // returned the runner's own answer to a buyer. Same divergence class as
    // the missing commerce ticks: the shared plane is server-only and the
    // phone composes its own service.
    ingressResultTransformer: transformInboundOrderResult,
    // Wired on the phone too, and for the reason recorded just above: the
    // divergence between the two boots is the recurring defect here, not the
    // feature itself. A withheld answer leaves no stash, no send and nothing
    // for a sweeper, so without this line an operator watching a phone-hosted
    // supplier sees orders lapse and nothing says why.
    onIngressResultWithheld: (args) =>
      log({
        event: 'bridge.result_withheld',
        task_id: args.taskId,
        capability: args.capability,
        reason: args.reason,
      }),
    // §3.4 — a plugin runner asks for a host operation by COMPLETING its claim
    // with a typed proposal. Composed through the ONE factory both roots call.
    pluginCompletionHandler: defaultPluginCompletionHandler({
      hostRuntime: () => getPluginHostRuntime(),
      installs: () => getPluginInstallRepository(),
      workflow: () => getWorkflowService(),
      onError: (err) =>
        log({
          event: 'plugin.host_operation_error',
          error: err instanceof Error ? err.message : String(err),
        }),
      onOutcome: (outcome) => log({ event: 'plugin.host_operation', kind: outcome.kind }),
    }),
  });
  const reasoningBackendRepository = getReasoningBackendRepository();
  const reasoningContextRepository = getReasoningContextRepository();
  const reasoningBroker =
    reasoningBackendRepository !== null && reasoningContextRepository !== null
      ? new CoreReasoningBroker({
          workflowService,
          workflowRepository: options.workflowRepository,
          backendRepository: reasoningBackendRepository,
          contextRepository: reasoningContextRepository,
          nowMs: nowMsFn,
          resolvePolicySnapshotHash: createReasoningPolicySnapshotResolver({
            nowMs: nowMsFn,
          }),
          isAuthenticatedSessionActive: ({ sessionId, principalDid, authorityOrigin }) =>
            getSessionRegistry().authorizesAuthorityOrigin(
              sessionId,
              principalDid,
              authorityOrigin,
            ),
          activateAuthenticatedSessionAuthority: ({ sessionId, principalDid, authorityOrigin }) =>
            getSessionRegistry().activateAuthorityOrigin(sessionId, principalDid, authorityOrigin),
          releaseAuthenticatedSessionAuthority: ({ sessionId, principalDid, authorityOrigin }) =>
            getSessionRegistry().clearAuthorityOrigin(sessionId, principalDid, authorityOrigin).ok,
          outputGuard: createReasoningOutputGuard(),
          commitValidatedProposal: createReasoningCommitBridge({
            commitServiceResponse: createServiceReasoningCommitter({
              workflowService,
            }),
          }),
        })
      : null;
  let reasoningBackend: ReasoningBackendSupervisor | null = null;
  let reasoningBackendPrincipalDid: string | null = null;
  if (
    options.internalReasoning !== undefined &&
    reasoningBroker !== null &&
    reasoningBackendRepository !== null
  ) {
    const identity = deriveLocalServiceIdentity(
      options.signingKeypair.privateKey,
      'internal-brain',
    );
    const ensured = ensureReasoningBackendForBoot(reasoningBackendRepository, {
      backendId: INTERNAL_REASONING_BACKEND_ID,
      kind: 'internal_brain',
      principalDid: identity.did,
      allowedTaskKinds: ['answer.compose'],
      maxSensitivity: 'sensitive',
      availability: 'always_on',
      modelClass: 'dina-internal-brain',
      selectedByOwnerDid: options.did,
      nowMs: nowMsFn(),
    });
    if (ensured.status === 'created' || ensured.status === 'ready') {
      const provider = options.internalReasoning.provider;
      const worker = new ReasoningBackendWorker({
        broker: reasoningBroker,
        backendId: INTERNAL_REASONING_BACKEND_ID,
        principalDid: identity.did,
        execute: createInternalBrainExecutor({
          provider: provider.name,
          llm: createProviderReasoningLLM(provider),
        }),
        classifyError: (error) => {
          const classified = classifyInternalBrainError(error);
          // This is the bounded, prompt-safe classification, never the raw
          // provider/SDK error or request content.
          log({
            event: 'node.internal_brain_execution_error',
            error: classified.message,
            retryable: classified.retryable,
          });
          return classified;
        },
        setInterval: options.setInterval,
        clearInterval: options.clearInterval,
      });
      reasoningBackend = new ReasoningBackendSupervisor({
        worker,
        setInterval: options.setInterval,
        clearInterval: options.clearInterval,
        onResult: (result) => {
          if (
            result.state === 'failed' ||
            result.state === 'lost' ||
            result.state === 'outcome_unknown'
          ) {
            log({
              event: 'node.internal_brain_result',
              state: result.state,
              task_id: result.taskId,
            });
          }
        },
        onError: () => {
          // Never persist or log raw provider/transport errors; they may
          // contain prompt fragments or credentials from an SDK response.
          log({ event: 'node.internal_brain_worker_error' });
        },
      });
      reasoningBackendPrincipalDid = identity.did;
    } else {
      log({
        event: 'node.internal_brain_not_started',
        status: ensured.status,
        reason: 'reason' in ensured ? ensured.reason : 'backend unavailable',
      });
    }
  }
  // `setWorkflowService` is deferred to start() via installCoreGlobals.

  // ServiceHandler reads config through a thunk. Default to Core's
  // global (shared with the D2D ingress pipeline and the route handler)
  // so the two sides can't diverge.
  const readConfig =
    options.readConfig ?? ((rkey?: string): ServiceConfig | null => getServiceConfig(rkey));

  // Review #6 (partial): route by origin_channel when a resolver is
  // supplied. The service_query task's payload carries the
  // `origin_channel` the requester tagged the query with (e.g.
  // 'ask'); the resolver maps that to a thread. Without a resolver
  // we fall back to the fixed `chatThreadId` — preserving current
  // behaviour while giving multi-thread apps a hook.
  //
  // The reconciliation itself (patch-in-place by task.id, one card per
  // query) lives in the shared `createServiceQueryDeliverer` so mobile
  // and home-node-lite stay byte-identical (no duplication).
  const deliver: WorkflowEventDeliverer = createServiceQueryDeliverer({
    threadId,
    ...(options.threadResolver !== undefined ? { threadResolver: options.threadResolver } : {}),
    // #6 / R2-05 — a WATCH poll result (origin `watch:<id>`) is a standing-
    // subscription arrival, not a chat turn. It runs through the SHARED silence
    // pipeline (`deliverWatchResult`): the R2-04 wake filter (resolved from the
    // watch by subscription id), the silence classifier (ceiling-capped: an
    // owner-created watch is Solicited, never a self-escalated interrupt), the DND /
    // quiet-hours gate, and bounded CardSpec rendering — Tier 1/2 → the Activity
    // `push` inbox, Tier 3 → briefing. Never a blind append, never the main chat.
    notifyWatchInbox: (d) => {
      // R3-02 — resolve the delivery policy (active + filter) by EXACT subscription
      // lookup; a cancelled/unknown watch fails closed (suppressed).
      const policy = getWatchService()?.deliveryPolicyFor(d.subscriptionId) ?? { active: false };
      // R5-04 — RETURN the promise: a failed durable append rejects the delivery,
      // so the workflow event stays unacknowledged and Core retries (the
      // idempotent sourceId append makes the retry an upsert, not a duplicate).
      return deliverWatchResult({
        subscriptionId: d.subscriptionId,
        capability: d.capability,
        serviceName: d.serviceName,
        status: d.status,
        card: d.card,
        text: d.text,
        sourceId: d.sourceId,
        watchActive: policy.active,
        ...(policy.filter !== undefined ? { filter: policy.filter } : {}),
      }).then(() => undefined);
    },
  });
  // 2-5. Shared service runtime — handler + dispatcher (with
  // service.query registered) + orchestrator + workflow-event consumer
  // + approval reconciler. The mobile-specific bits feed in through
  // the option surface (custom `deliver`, `inboundNotifier`,
  // `directResponder` that wraps `options.sendD2D`).
  const serviceRuntime = buildHomeNodeServiceRuntime({
    core: options.coreClient,
    appView: options.appViewClient as OrchestratorAppView,
    readConfig,
    directResponder: async (to, body) => {
      // Shared with the lite default (WS-4.6). Two hand-built copies had
      // already drifted, and a field added to one but not the other drops an
      // answer silently — the responder's type is still satisfied.
      await options.sendD2D(to, 'service.response', toServiceResponseBody(body));
    },
    deliver,
    approvalNotifier: options.approvalNotifier ?? defaultApprovalNotifier(threadId),
    inboundNotifier: defaultInboundNotifier(threadId),
    reasoningSubmitter: createServiceReasoningSubmitter({
      ownerDid: options.did,
      getBroker: () => reasoningBroker,
      getBackendRepository: () => reasoningBackendRepository,
      nowMs: nowMsFn,
    }),
    logger: log,
    nowMsFn,
    ...(options.setInterval !== undefined ? { setInterval: options.setInterval } : {}),
    ...(options.clearInterval !== undefined ? { clearInterval: options.clearInterval } : {}),
  });
  const { handler, dispatcher, orchestrator, events, approvals } = serviceRuntime;

  // 5a. TaskExpirySweeper — requester-side TTL enforcement (issue #9).
  //     Calls WorkflowRepository.expireTasks on a cadence so stuck
  //     service_query tasks past their ttl_seconds flip to `failed`
  //     and emit a workflow_event that reaches the chat surface.
  const taskExpiry = new TaskExpirySweeper({
    repository: options.workflowRepository,
    nowMsFn,
    onExpired: (task) => reasoningBroker?.releaseSessionAuthorityForTask(task),
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
  });

  // 5b. LeaseExpirySweeper — reverts stuck delegation tasks when an
  //     agent's lease expires so another agent can reclaim them.
  //     Required for at-least-once completion on the provider side.
  const leaseExpiry = new LeaseExpirySweeper({
    repository: options.workflowRepository,
    nowMsFn,
    onReverted: (task) => reasoningBroker?.releaseSessionAuthorityForTask(task),
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
  });

  // 5b1. BridgePendingSweeper — main-dina 4848a934 durability layer:
  //      retries stashed `bridge_pending:` entries when the Response
  //      Bridge's first send attempt failed. Without this, a transient
  //      D2D hiccup on a completed delegation leaves the requester
  //      hanging until TTL with no signal.
  const bridgeRetry = new BridgePendingSweeper({
    service: workflowService,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
  });

  // 5b3. Poll-mode watches (PSVC-0). Register the WatchService globally (the
  //      subscription surfaces create + steer watches) and run the
  //      WatchPollSweeper — it fires each due `watch` task as an ordinary
  //      `service.query` through the in-process CoreClient requester lane, so
  //      the provider's `service.response` lands + correlates on the shipping
  //      path. NO inbound push surface (Phase 0).
  const watchService = new WatchService({
    repository: options.workflowRepository,
    nowMsFn,
  });
  const watchPoll = new WatchPollSweeper({
    repository: options.workflowRepository,
    onPoll: buildWatchPollHandler(options.coreClient),
    nowMsFn,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
  });

  // 5b2. StagingDrainScheduler — GAP-RT-01. Polls Core's
  //      `POST /v1/staging/claim` on a cadence and runs each claimed
  //      item through classify → enrich → resolve (via Core). Without
  //      this, items ingested through `/v1/staging/ingest` would sit
  //      in `staging_inbox` forever with no vault row appearing on
  //      the other side. Python's home node runs the equivalent loop.
  //      Opt-in via `options.stagingDrain` so test harnesses that
  //      manage staging themselves can turn it off.
  const drainCfg = options.stagingDrain;
  const stagingDrainEnabled = drainCfg !== false;
  const drainOptions: StagingDrainOptions =
    drainCfg === undefined || drainCfg === true || drainCfg === false ? {} : drainCfg;
  // Owner-direct writes (/remember) must store immediately — owner has
  // unconditional write access to their own vaults (CAPABILITIES.md).
  // Inject openPersonaDB so the drain can open closed sensitive vaults
  // before resolve. Only wired when persistence is ready (mobile context).
  if (!('ownerPersonaOpener' in drainOptions)) {
    drainOptions.ownerPersonaOpener = async (persona: string) => {
      if (isPersistenceReady()) await openPersonaDB(persona);
    };
  }
  // Drain consumes the transport-agnostic `CoreClient` surface directly.
  // `options.coreClient` is an `InProcessTransport` on mobile and an
  // `HttpCoreTransport` on the server — same interface, different wire.
  const stagingDrain = stagingDrainEnabled
    ? new StagingDrainScheduler({
        core: options.coreClient,
        drain: drainOptions,
        intervalMs: options.stagingDrainIntervalMs,
        logger: log,
        onTick: (result) =>
          log({
            event: 'bootstrap.staging_drain_tick',
            claimed: result.claimed,
            stored: result.stored,
            failed: result.failed,
          }),
        onError: (err) =>
          log({
            event: 'bootstrap.staging_drain_error',
            error: err instanceof Error ? err.message : String(err),
          }),
        setInterval: options.setInterval,
        clearInterval: options.clearInterval,
      })
    : null;

  // 5c. LocalDelegationRunner — opt-in in-process executor for demos /
  //     single-process tests. Production uses external dina-agent.
  //     Issue #5 / #6.
  const localRunner =
    options.localDelegationRunner !== undefined
      ? new LocalDelegationRunner({
          repository: options.workflowRepository,
          // Route completions through the service so the Response Bridge
          // fires (issue #6) — writing directly to the repo skipped the
          // D2D emission and left requesters hanging.
          workflowService,
          agentDID: options.localDelegationAgentDID ?? options.did,
          runner: options.localDelegationRunner,
          nowMsFn,
          setInterval: options.setInterval,
          clearInterval: options.clearInterval,
        })
      : null;

  // Chat-orchestrator globals are also deferred to start(). Issue #8.
  // Disposers may be async (e.g. `runPlane.stop()` awaits the in-flight engine
  // tick, E76-10/81B-08); `dispose()` AWAITs each so teardown reaches quiescence
  // before the shared stores/globals they read are unwired.
  const globalDisposers: (() => void | Promise<void>)[] = [];
  // ISVC-10 — stop the interactive-run pull loop (pacer/sweeper/classify/
  // completion timers) when the node tears down, before the run stores it reads
  // are torn down under it.
  if (options.runPlane) {
    const runPlane = options.runPlane;
    globalDisposers.push(() => runPlane.stop());
  }
  const installChatGlobals = (): void => {
    if (!globalWiring) return;
    const disposeWire = wireServiceOrchestrator({ orchestrator });
    globalDisposers.push(() => disposeWire());
    // Contact Services seam 5: expose the orchestrator's direct-to-DID dispatch
    // to the Talk egress (`chat_d2d.sendServiceQuery`), so a scheduling intent
    // in a peer thread fires a `service.query` to THAT contact over the same
    // correlating workflow-task path the main-chat `query_service` tool uses.
    setServiceQueryDispatcher(orchestrator);
    globalDisposers.push(() => setServiceQueryDispatcher(null));
    // Contact Services seam 2: route a scheduling intent in a Talk thread to
    // THAT contact. We resolve the contact's prior `service.offer` (grant +
    // listing) from `contact_service_offers`; with one in hand, fire a
    // correlating `service.query` (seam 5). Without one, the relationship
    // service was never offered to us — surface a soft hint (the grant
    // bootstrap / ask_to_enable lands separately), never a phantom card.
    setContactServiceHandler(async ({ contactDID, capability, intent }) => {
      // Offers are STORED canonically (issue_offer.ts), so look up by the
      // canonical name — otherwise a canonical-name request wouldn't match an
      // alias-stored offer (P3-a). Unknown/custom capability → use as-is.
      const lookupCapability = resolveSearchableCapability(capability) ?? capability;
      const offers = await options.coreClient.listServiceOffers({
        providerDid: contactDID,
        capability: lookupCapability,
      });
      const offer = offers[0];
      if (offer === undefined) {
        // No stored offer → run the §5.2 BOOTSTRAP: send a `service.grant_request`
        // preflight (capability + requested_surface:'talk', no rkey). The peer's
        // handler resolves the talk listing + closeness policy and replies with a
        // `service.offer` (auto_grant) or surfaces an ask_to_enable prompt; the
        // offer is stored on receive, so a later retry can fire the query.
        //
        // ASYMMETRIC VISIBILITY (CONTACT_SERVICES_ARCHITECTURE.md §2/§10): the
        // requester ack is IDENTICAL whether the preflight sent cleanly or threw,
        // and whatever the grantor later decides (auto-grant / ask-to-enable /
        // soft-reject / offline). It must never imply the grantor got a prompt or
        // that the service was "not offered" — either would leak the requester's
        // social rank. So we swallow the send error and return one neutral,
        // collapsed outcome.
        try {
          const { requestId } = await sendGrantRequest(contactDID, lookupCapability, intent);
          // Remember the original intent, keyed by the preflight's request_id, so
          // the auto-grant offer (which echoes that id) can replay this exact
          // query (reviews #1/#2). Stash ONLY after a clean send — a throw means
          // nothing went out, so no offer will come and there's nothing to replay.
          stashPendingPreflight(requestId, contactDID, intent ?? '');
        } catch {
          // Indistinguishable from a soft-reject to the requester (collapsed
          // failure). No negative reply, no tier leak.
        }
        return { ack: CONTACT_SERVICE_PREFLIGHT_ACK, dispatched: false };
      }
      const params: Record<string, unknown> = {};
      if (intent !== '') params.intent = intent;
      await sendServiceQuery(contactDID, lookupCapability, params, {
        offer: {
          grantId: offer.grantId,
          serviceUri: offer.serviceUri,
          serviceName: offer.serviceName,
          ...(offer.schemaHash !== '' ? { schemaHash: offer.schemaHash } : {}),
          ...(offer.defaultTtlSeconds !== undefined
            ? { defaultTtlSeconds: offer.defaultTtlSeconds }
            : {}),
        },
      });
      return { ack: '', dispatched: true };
    });
    globalDisposers.push(resetContactServiceHandler);

    // Contact Services `ask_to_enable` prompt: Core decided "ask the owner" for
    // a friend's grant-request; surface a ONE-TIME "Allow <contact> to use your
    // <service>?" card in that contact's Talk thread. The card's Allow tap
    // issues the grant via `coreClient.issueServiceOffer`. `postGrantPromptOnce`
    // is idempotent on (requesterDID, capability) by SCANNING the (rehydrated)
    // thread — so a restart + the requester's normal grant_request retry never
    // stacks a second card, and a previously-dismissed prompt rehydrates
    // terminal (the scan treats it as handled). Durable, not an in-memory Set.
    const unsubscribeGrantPrompt = onGrantRequestPending(
      ({ requesterDID, capability, rkey, closeness }) => {
        // Fire-and-forget — `postGrantPromptOnce` is async (it hydrates the
        // peer thread first to stay idempotent across a lazy-hydrate restart).
        // A UI fan-out failure must never break the receive path, so swallow.
        // `closeness` is threaded through so the owner-private `prompt_shown`
        // row (written when the card actually posts) carries the policy tier.
        void postGrantPromptOnce(requesterDID, capability, rkey, closeness).catch(() => {
          /* UI fan-out only — the receive pipeline already did its job */
        });
      },
    );
    globalDisposers.push(unsubscribeGrantPrompt);

    // Contact Services review #2: auto-replay a first-run request the instant the
    // grant lands. When a relationship service had no stored offer, the handler
    // above sent a `service.grant_request` + stashed the owner's intent. For a
    // close contact the peer auto-grants and a `service.offer` comes back — this
    // subscriber drains the matching stash and fires the original `service.query`
    // against the fresh grant, so the owner never has to ask twice. No stash (or
    // an expired one) → no replay, consistent with the collapsed-failure rule.
    const unsubscribeOfferReplay = onServiceOfferReceived((offer) => {
      // Correlate by request_id (review #1): only an offer that echoes the exact
      // preflight we sent replays — never an unrelated/proactive one. `take` also
      // binds to the transport-authed sender DID (confused-deputy guard).
      if (offer.requestId === undefined || offer.requestId === '') return;
      const pending = takePendingPreflight(offer.requestId, offer.providerDID);
      if (pending === null) return;
      const cap = resolveSearchableCapability(offer.capability) ?? offer.capability;
      const params: Record<string, unknown> = {};
      if (pending.intent !== '') params.intent = pending.intent;
      void sendServiceQuery(offer.providerDID, cap, params, {
        offer: {
          grantId: offer.grantId,
          serviceUri: offer.serviceUri,
          serviceName: offer.serviceName,
          ...(offer.schemaHash !== '' ? { schemaHash: offer.schemaHash } : {}),
          ...(offer.defaultTtlSeconds !== undefined
            ? { defaultTtlSeconds: offer.defaultTtlSeconds }
            : {}),
        },
      }).catch(() => {
        // Dispatch hiccup (review #2): re-stash so the intent isn't lost — a
        // redelivered offer (or the same request_id) can replay it instead of
        // the owner silently having to ask again.
        stashPendingPreflight(offer.requestId as string, offer.providerDID, pending.intent);
      });
    });
    globalDisposers.push(unsubscribeOfferReplay);
    // Cross-identity hygiene: drop any stashed intent on teardown so a stale
    // preflight can never auto-fire under a different identity after a switch.
    globalDisposers.push(() => resetPendingPreflights());
    setServiceApproveCommandHandler(makeServiceApproveHandler(options.coreClient));
    globalDisposers.push(resetServiceApproveCommandHandler);
    setServiceDenyCommandHandler(makeServiceDenyHandler(options.coreClient));
    globalDisposers.push(resetServiceDenyCommandHandler);
    // On web the in-process Core store is empty (Core runs server-side), so
    // the resolver swaps in an HTTP client to the brain's workflow-task proxy
    // (F4). On native it returns the in-process client unchanged.
    setInboxCoreClient(resolveInboxCoreClient(options.coreClient));
    globalDisposers.push(resetInboxCoreClient);
    // On web the in-process Core store is empty, so the resolver swaps in an
    // HTTP client to the brain's `/api/v1/service/config` proxy (so the
    // My-Services publish form actually reaches Core). On native it returns the
    // in-process client unchanged.
    const serviceConfigCoreClient = resolveServiceConfigCoreClient(options.coreClient);
    setServiceConfigCoreClient(serviceConfigCoreClient);
    globalDisposers.push(() => resetServiceConfigCoreClient(serviceConfigCoreClient));
    // R4-03 — on web, wire the notification inbox to the split server's durable
    // log (`/api/v1/notifications` + SSE) so watch/push results surface in the
    // browser Activity inbox. A no-op on native (the in-process SQLite log backs
    // the inbox directly).
    globalDisposers.push(installServerNotifications());
    // Pattern A coordinator wins over the simpler agenticAsk path —
    // coordinator subsumes the tool-loop and adds the suspend/resume
    // chain. Tests / minimal nodes that don't need approval gating
    // can still pass `agenticAsk` instead.
    if (options.askCoordinator !== undefined) {
      const cfg = options.askCoordinator;
      const bridgeOpts: CreateCoordinatorAskHandlerOptions = {
        coordinator: cfg.coordinator,
        requesterDid: cfg.requesterDid,
      };
      if (cfg.defaultThreadId !== undefined) bridgeOpts.defaultThreadId = cfg.defaultThreadId;
      if (cfg.formatPendingMessage !== undefined)
        bridgeOpts.formatPendingMessage = cfg.formatPendingMessage;
      if (cfg.formatResumeHeader !== undefined)
        bridgeOpts.formatResumeHeader = cfg.formatResumeHeader;
      if (cfg.formatFailureMessage !== undefined)
        bridgeOpts.formatFailureMessage = cfg.formatFailureMessage;
      // Chat → Settings pill bridge: when an /ask fails on a CLASSIFIED
      // provider error (credits exhausted / invalid key), record the
      // incident in the key-health store immediately — the pill is lit
      // before the user ever visits Settings, instead of waiting for the
      // next screen-mount probe. Other kinds (rate-limit/timeout/network)
      // are transient and deliberately NOT surfaced as key problems.
      bridgeOpts.onProviderFailure = ({ kind, message }) => {
        if (kind !== 'credits_exhausted' && kind !== 'invalid_key') return;
        const provider = peekActiveProvider();
        if (provider === null) return;
        reportKeyHealthIncident(provider, kind, message);
      };
      const { handler, dispose } = createCoordinatorAskHandler(bridgeOpts);
      setAskCommandHandler(handler);
      globalDisposers.push(resetAskCommandHandler);
      // Bridge subscribed to the coordinator's event stream — release
      // that subscription on dispose so re-bootstrapping doesn't leak.
      globalDisposers.push(dispose);
      // Reconcile loop: poll the gateway every 3 s so out-of-band
      // operator decisions (Approve/Deny in the mobile Approvals tab)
      // propagate into the ask state machine. The workflow task status
      // changes when the operator taps, but nothing reads that change
      // back into the registry without a reconcile sweep.
      const _siReconcile: (fn: () => void, ms: number) => unknown =
        options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
      const _ciReconcile: (h: unknown) => void =
        options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
      const reconcileHandle = _siReconcile(() => {
        void cfg.coordinator.gateway.reconcile().catch(() => {});
      }, 3_000);
      globalDisposers.push(() => _ciReconcile(reconcileHandle));
    } else if (options.agenticAsk !== undefined) {
      setAskCommandHandler(
        makeAgenticAskHandler({
          provider: options.agenticAsk.provider,
          tools: options.agenticAsk.tools,
          ...options.agenticAsk.options,
        }),
      );
      globalDisposers.push(resetAskCommandHandler);
    }

    // /remember orchestrator wiring — Core transport + drain hook —
    // delegated to the shared `@dina/home-node/chat-runtime` helper
    // so this module and the home-node-lite brain-server boot stay
    // in lock-step (no duplicate retry budgets / status branches).
    // The mobile-specific bit is `lookupPendingApproval`: we read
    // the staging row in-process to surface the approval id when
    // the classifier routes to a closed persona. Brain-server can't
    // do that (Core lives in another process) and omits the lookup.
    if (stagingDrain !== null) {
      const chatRuntime = wireChatRememberRuntime({
        core: options.coreClient,
        stagingDrain,
        lookupPendingApproval: stagingGetItem,
      });
      globalDisposers.push(() => chatRuntime.dispose());
    }
  };

  // 7. ServicePublisher — publishes service profile record to PDS when
  // provider+isDiscoverable. Instantiated lazily; caller supplies the publisher
  // so we don't duplicate credentials. Skipped when the PDS session couldn't be
  // validated at boot: the initial sync() below is LOAD-BEARING (it re-auths and
  // throws out of start()), so constructing it against an unreachable PDS would
  // turn a transient outage into a boot failure. The review-outbox drainer still
  // gets the lazy `node.pdsPublisher` and retries independently.
  let publisher: ServicePublisher | null = null;
  if (isProvider && options.pdsPublisher !== undefined && options.pdsSessionReachable !== false) {
    publisher = new ServicePublisher({
      pds: options.pdsPublisher,
      expectedDID: options.did,
      nowFn: nowMsFn,
    });
  }

  // --- Lifecycle ---------------------------------------------------------

  let started = false;
  let disposed = false;

  const node: DinaNode = {
    did: options.did,
    role: options.role,
    coreClient: options.coreClient,
    pdsPublisher: options.pdsPublisher,
    workflowService,
    orchestrator,
    handler,
    dispatcher,
    runners: {
      events,
      approvals,
      taskExpiry,
      leaseExpiry,
      bridgeRetry,
      watchPoll,
      stagingDrain,
      localRunner,
      reasoningBackend,
    },

    async start(): Promise<void> {
      if (started) return;

      // Install process-globals FIRST (issue #8: don't touch them in
      // the synchronous constructor). Core singletons go first so
      // route handlers + ingress pipeline can read them as soon as
      // MsgBox starts delivering; chat globals follow.
      installCoreGlobals();
      installChatGlobals();

      // issues.txt §4 — now that the service-config repo is registered,
      // HYDRATE the persisted config into the runtime, then let an explicit
      // env/demo `initialServiceConfig` override on top (precedence:
      // register → hydrate → override). The gap this closes: without the
      // hydrate, `getServiceConfig()` returned null after a mobile restart
      // even though SQL held the provider profile — so inbound service.query
      // was denied at the contact gate + the publisher never republished.
      // Fails soft: a corrupt stored row leaves the runtime null, never
      // crashes boot.
      if (coreGlobals && options.serviceConfigRepository !== undefined) {
        try {
          await hydrateServiceConfig();
        } catch (err) {
          log({ event: 'node.service_config_hydrate_failed', error: (err as Error).message });
        }
      }
      if (coreGlobals && options.initialServiceConfig !== undefined) {
        setServiceConfig(options.initialServiceConfig);
      }

      // Review #14: hydrate the in-memory chat store from the persisted
      // repository. Persistence is wired into the app's storage layer
      // by `initializePersistence` on unlock; this pulls prior messages
      // back into memory so subscribers see the full history on mount.
      // `hydrateThread` is a no-op when no repo has been set, so
      // nodes without persistence wired start with an empty thread.
      try {
        hydrateThread(threadId);
      } catch (err) {
        log({ event: 'node.hydrate_thread_failed', error: (err as Error).message });
      }

      // MsgBox connection — when `msgboxURL` is set, ALL the other
      // MsgBox inputs must be present; partial config is a misconfiguration
      // (the node silently running without a relay is worse than failing
      // loudly). Issue #17.
      if (options.msgboxURL !== undefined) {
        const missing: string[] = [];
        if (options.wsFactory === undefined) missing.push('wsFactory');
        if (options.coreRouter === undefined) missing.push('coreRouter');
        if (options.resolveSender === undefined) missing.push('resolveSender');
        if (missing.length > 0) {
          throw new Error(`createNode.start: msgboxURL set but missing: ${missing.join(', ')}`);
        }
      }
      if (
        options.msgboxURL !== undefined &&
        options.wsFactory !== undefined &&
        options.coreRouter !== undefined &&
        options.resolveSender !== undefined
      ) {
        const bootConfig: MsgBoxBootConfig = {
          did: options.did,
          privateKey: options.signingKeypair.privateKey,
          msgboxURL: options.msgboxURL,
          wsFactory: options.wsFactory,
          coreRouter: options.coreRouter,
          resolveSender: options.resolveSender,
          // Mobile networks + TLS handshake on a cold WS can creep past
          // the default 10 s, especially on the first connect after an
          // app launch when the radio has to wake up. 30 s is still tight
          // enough that a genuinely broken relay surfaces as a soft-fail
          // warning instead of a spinning boot.
          readyTimeoutMs: 30_000,
          // Bypassed D2D traffic → Brain's dispatcher. Issue #5 fix.
          onBypassedD2D: async ({ senderDID, messageType, body }) => {
            // ISVC-10 — a run-correlated provider `service.response` (the reply
            // to a pacer-emitted `service.query`) is consumed by the run plane's
            // trust boundary FIRST. It returns true iff the body was a live run
            // response (verified-and-ingested or rejected); either way it must
            // NOT fall through to the dispatcher, which would mint a spurious
            // workflow task. A non-run `service.response` returns false and
            // continues to the normal dispatcher path below.
            if (messageType === MsgTypeServiceResponse && options.runPlane) {
              if (await options.runPlane.handleServiceResponse(senderDID, body)) return;
            }
            // Minimal DinaMessage for the dispatcher. The only fields it
            // consults off `raw` are `type`, `from`, `to`, `id`; the
            // receive pipeline has already validated signatures + nonces
            // upstream.
            const raw: Partial<DinaMessage> = {
              type: messageType,
              from: senderDID,
              to: options.did,
            };
            await dispatcher.dispatch(
              senderDID,
              raw as DinaMessage,
              body as Record<string, unknown>,
            );
          },
          // Staged non-service D2D → per-peer chat thread so the People
          // screen and /chat/[did] route see the message live. The vault
          // copy is authoritative; this is a UI fan-out only. Only
          // conversational types land here — trust/safety/social come
          // through as free-form text too.
          onStagedD2D: ({ senderDID, messageType, body, senderCreatedTime }) => {
            if (!isChatRenderableType(messageType)) return;
            const text = extractChatText(body);
            if (text === null) return;
            // `type: 'dina'` renders left-aligned; the renderer checks
            // metadata.source === 'd2d' to label with the peer's name
            // instead of "Dina".
            //
            // `senderCreatedTime` (Unix ms) carries the sender's wire
            // timestamp from the verified DinaMessage envelope. When
            // present we use it as the message's `timestamp` so a
            // burst of messages that arrives out-of-order (MsgBox
            // replay-on-reconnect, network jitter) still renders
            // chronologically. Falls back to receive-time only when
            // the sender didn't provide one. MT-19-I2.
            addMessage(senderDID, 'dina', text, {
              metadata: { source: 'd2d', senderDID, messageType },
              ...(senderCreatedTime !== undefined ? { timestamp: senderCreatedTime } : {}),
            });
          },
          // A stranger's message decrypted + verified but isn't from a
          // contact, so the pipeline quarantined it. Surface a review card
          // in the main chat thread so the message doesn't silently vanish
          // — the user taps "Add to contacts" (accept + release + drain) or
          // "Block". The body is intentionally withheld until they decide.
          onQuarantinedD2D: ({ senderDID, messageType, quarantineId }) => {
            addMessage('main', 'dina', `Someone who isn't in your contacts wants to message you.`, {
              metadata: {
                source: 'd2d',
                senderDID,
                lifecycle: {
                  kind: 'quarantine_request',
                  quarantineId,
                  senderDID,
                  messageType,
                },
              },
            });
          },
        };
        // MsgBox handshake failures are soft — a dev install with no
        // internet, a transient relay blip, or a rejected did:key should
        // still land the user on the tabs with a runtime warning rather
        // than a red error screen. The node continues in "relay offline"
        // mode; outbound D2D will throw on send (caught by the UI) and
        // inbound traffic simply never arrives until reconnect.
        try {
          await bootstrapMsgBox(bootConfig);
          log({ event: 'node.msgbox_connected', did: options.did });
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          // Silence First: a failed handshake at boot doesn't warrant
          // a global banner. The relay reconnects in the background,
          // and any actual user action that depends on D2D (Talk
          // send, ask-through-services) surfaces its own inline error
          // at the point of failure. Quietly log so the issue is
          // still recoverable from traces.
          log({ event: 'node.msgbox_connect_failed', error: msg });
        }
      }

      // Publish the service profile record (provider role + isDiscoverable).
      // Initial sync is LOAD-BEARING: a provider that can't publish is
      // undiscoverable via AppView, so start() must surface the
      // failure to the caller rather than marking the node "started"
      // while it sits invisibly broken (issue #18).
      if (publisher !== null) {
        // Multi-listing: publish EVERY persisted listing (one record per rkey),
        // mirroring HNL boot. When a custom `readConfig` was injected (tests)
        // and the store has no listings, fall back to the single-config path so
        // the injected config still publishes.
        const listings = listServiceConfigs();
        if (listings.length > 0) {
          for (const { rkey, config } of listings) {
            await publisher.sync(toPublisherConfig(config), rkey);
            log({
              event: 'node.service_profile_synced',
              is_public: config.isDiscoverable,
              rkey,
            });
          }
        } else {
          const cfg = readConfig();
          if (cfg !== null) {
            await publisher.sync(toPublisherConfig(cfg));
            log({ event: 'node.service_profile_synced', is_public: cfg.isDiscoverable });
          }
        }
        const unsubscribe = onServiceConfigChanged((rkey, next) => {
          const p = publisher;
          if (p === null) return;
          // Multi-listing: publish/unpublish the SPECIFIC listing that changed
          // (one row → one record under its rkey). Fire-and-forget — the
          // listener is synchronous but the publisher's sync is async, so we
          // never block the config-event emission on the PDS round-trip.
          const syncPromise =
            next === null ? p.unpublish(rkey) : p.sync(toPublisherConfig(next), rkey);
          void syncPromise.then(
            () =>
              log({
                event: 'node.service_profile_synced',
                is_public: next?.isDiscoverable ?? false,
                reason: 'config_changed',
                rkey,
              }),
            (err) => {
              log({
                event: 'node.service_profile_sync_failed',
                error: (err as Error).message,
                reason: 'config_changed',
              });
              // Surface to the UI so operators see stale-discovery
              // risk instead of just a silent log line (issue #19).
              if (options.onPublishSyncFailure !== undefined) {
                try {
                  options.onPublishSyncFailure(err as Error);
                } catch {
                  /* swallow — observability mustn't kill the sync path */
                }
              }
            },
          );
        });
        globalDisposers.push(unsubscribe);
      }

      events.start();
      approvals.start();
      taskExpiry.start();
      leaseExpiry.start();
      bridgeRetry.start();
      setWatchService(watchService);
      watchPoll.start();
      if (stagingDrain !== null) stagingDrain.start();
      if (localRunner !== null) localRunner.start();
      if (reasoningBackend !== null && reasoningBackendPrincipalDid !== null) {
        markReasoningBackendPresent(INTERNAL_REASONING_BACKEND_ID, reasoningBackendPrincipalDid);
        try {
          reasoningBackend.start();
        } catch (error) {
          clearReasoningBackendPresence(
            INTERNAL_REASONING_BACKEND_ID,
            reasoningBackendPrincipalDid,
          );
          await reasoningBackend.stop();
          throw error;
        }
      }

      // Only flip the idempotency flag once every boot step has landed
      // so a throw mid-boot does not leave the node half-wired while
      // rejecting subsequent start() calls as "already started".
      started = true;
      log({ event: 'node.started', did: options.did });
    },

    async stop(): Promise<void> {
      if (reasoningBackendPrincipalDid !== null) {
        clearReasoningBackendPresence(INTERNAL_REASONING_BACKEND_ID, reasoningBackendPrincipalDid);
      }
      await reasoningBackend?.stop();
      if (!started) return;
      started = false;
      // Stop scheduling new ticks, then wait for any in-flight ticks
      // to drain before callers can assume shutdown completed.
      if (localRunner !== null) localRunner.stop();
      if (stagingDrain !== null) stagingDrain.stop();
      watchPoll.stop();
      bridgeRetry.stop();
      leaseExpiry.stop();
      taskExpiry.stop();
      approvals.stop();
      events.stop();
      await Promise.all([
        events.flush(),
        approvals.flush(),
        taskExpiry.flush(),
        leaseExpiry.flush(),
        bridgeRetry.flush(),
        // 81B-08 — the watch poll sweeper is single-flight; await its in-flight tick
        // so no watch poll/send is still running after teardown.
        watchPoll.flush(),
        stagingDrain !== null ? stagingDrain.flush() : Promise.resolve(),
        localRunner !== null ? localRunner.flush() : Promise.resolve(),
      ]);
      if (options.msgboxURL !== undefined) {
        try {
          await disconnectMsgBox();
        } catch {
          /* swallow */
        }
        // Review #13: `bootstrapMsgBox` installed a global WS-first
        // deliver hook on the delivery module. Leaving it in place
        // after disconnect would make the next D2D send try to
        // push bytes down a dead WebSocket, fail, and fall through
        // to HTTP — correct but wasted. Clear it so subsequent
        // composites start clean.
        setWSDeliverFn(null);
      }
      log({ event: 'node.stopped', did: options.did });
    },

    async drainOnce(): Promise<void> {
      // Two-phase drain (review #7):
      //
      //   Phase 1 — runners that can CREATE bridge_pending stashes:
      //     * events/approvals/taskExpiry/leaseExpiry may fail
      //       service-query tasks (→ bridge fires via fail())
      //     * localRunner may complete delegation tasks (→ bridge
      //       fires via complete())
      //   Phase 2 — bridgeRetry picks up whatever those runners
      //     stashed.
      //
      // Running them concurrently via a single `Promise.all` meant a
      // stash created in phase 1 could easily land AFTER the bridge
      // sweeper had already scanned for that tick, so one drainOnce
      // didn't deterministically cover "complete then retry." The
      // two-phase form makes the invariant hold.
      await Promise.all([
        events.runTick(),
        approvals.runTick(),
        taskExpiry.runTick(),
        leaseExpiry.runTick(),
        // Issue #11: include the local delegation runner so demo /
        // test nodes that depend on it see a complete deterministic
        // sweep via drainOnce.
        localRunner !== null ? localRunner.runTick() : Promise.resolve(),
      ]);
      // After phase 1 has fully settled, retry any bridge_pending
      // stashes it produced. Await sequentially — not part of the
      // same Promise.all.
      await bridgeRetry.runTick();
      // Also flush any detached initial-send promises the bridge
      // kicked off during phase 1 so a successful clear-stash
      // actually lands before drainOnce returns. Without this a
      // caller asserting on stash state right after drainOnce could
      // see the stash still present even though the send succeeded.
      await workflowService.flushBridgeInFlight();
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await this.stop();
      for (const fn of globalDisposers.reverse()) {
        try {
          // AWAIT — an async disposer (run-plane drain, 81B-08) must complete
          // before the next disposer unwires a store/global it still reads.
          await fn();
        } catch {
          /* swallow */
        }
      }
      // Detach the workflow→inbox bridge first — once the workflow repo
      // is unwired, the bridge has nothing to listen to, but we still
      // explicitly call the disposer so the closure releases its
      // listener-set reference (avoids holding the repo alive past
      // dispose for diagnostics tools that look at retained heap).
      if (workflowApprovalBridgeDispose !== null) {
        try {
          workflowApprovalBridgeDispose();
        } catch {
          /* swallow — observability mustn't break teardown */
        }
        workflowApprovalBridgeDispose = null;
      }

      // Release Core module-level singletons — ONLY the ones this node
      // claimed. A node constructed with `coreGlobals: false` never
      // wrote to the singletons, so tearing them down here would clobber
      // whatever the process actually uses. Issue #2.
      //
      // Ownership guard on workflowService: React StrictMode double-mount
      // can cause a concurrent boot (Boot 2) to install its own
      // workflowService BEFORE this node's dispose() finishes. Without
      // the check, dispose() would clobber Boot 2's singleton with null,
      // leaving its WorkflowEventConsumer permanently failing with 503.
      if (coreGlobals) {
        if (reasoningBroker !== null && getReasoningBroker() === reasoningBroker) {
          setReasoningBroker(null);
        }
        if (getWorkflowService() === workflowService) setWorkflowService(null);
        setWorkflowRepository(null);
        setServiceQuerySender(null);
        setServiceRespondSender(null);
        setD2DSender(null);
        installInviteService(null);
        // Unwire BOTH the in-memory state AND the repository so the next
        // createNode() starts from a clean slate — leaving the repo
        // attached would let getServiceConfig re-hydrate the old config.
        resetServiceConfigState();
        setServiceConfigRepository(null);
        // Clear the review-publish repo ONLY if the global is still ours. Under
        // StrictMode / fast remounts an OLDER node can dispose AFTER a newer
        // createNode already installed its repo; an unconditional clear would
        // wipe the live node's repo and freeze every publish projection.
        if (getReviewPublishRepository() === options.reviewPublishRepository) {
          setReviewPublishRepository(null);
        }
        resetCallerTypeState();
        resetMiddlewareState();
      }
    },
  };

  return node;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validate(o: CreateNodeOptions): void {
  if (!o.did) throw new Error('createNode: did is required');
  if (!o.signingKeypair) throw new Error('createNode: signingKeypair is required');
  if (!o.pdsSession) throw new Error('createNode: pdsSession is required');
  if (!o.sendD2D) throw new Error('createNode: sendD2D is required');
  if (!o.coreClient) throw new Error('createNode: coreClient is required');
  if (!o.appViewClient) throw new Error('createNode: appViewClient is required');
  if (!o.workflowRepository) throw new Error('createNode: workflowRepository is required');
  // readConfig is optional — bootstrap falls back to Core's global
  // getServiceConfig when omitted. Passing one is still useful for tests
  // that want deterministic config mutation without touching globals.
  // Provider role can omit pdsPublisher for nodes that expose services
  // only to known peers (no public discoverability). Runtime handles
  // the absent case by skipping the profile sync in `start()`.
}

/**
 * V1 D2D types whose body is free-form text from a peer (i.e. fits a
 * chat bubble). service.* traffic goes through the orchestrator, not
 * the per-peer chat thread, so it's excluded even though it's valid
 * inbound.
 */
const CHAT_RENDERABLE_TYPES = new Set<string>([
  MsgTypeCoordinationRequest,
  MsgTypeCoordinationResponse,
  MsgTypeSocialUpdate,
  MsgTypeTrustVouchRequest,
  MsgTypeTrustVouchResponse,
  MsgTypeSafetyAlert,
]);

function isChatRenderableType(t: string): boolean {
  return CHAT_RENDERABLE_TYPES.has(t);
}

/**
 * Extract a display string from a staged D2D body. Bodies travel as
 * JSON-encoded strings on the wire. Our chat convention is
 * `{"text": "..."}`; everything else falls back to the raw body so
 * non-chat-shaped payloads from interoperating nodes still render
 * (just verbatim) rather than vanishing.
 */
function extractChatText(body: string): string | null {
  if (typeof body !== 'string' || body === '') return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed !== null && typeof parsed === 'object' && 'text' in parsed) {
      const text = (parsed as { text: unknown }).text;
      if (typeof text === 'string' && text !== '') return text;
    }
  } catch {
    /* fall through — non-JSON body, show verbatim. */
  }
  return body;
}

/**
 * Humanize (validated, stripped) query params for the approval card —
 * "time: 4:30 PM · date: today · service: haircut". This is a
 * SECURITY-DECISION surface fed STRANGER-AUTHORED text, so beyond
 * rendering as plain <Text>: C0/C1 control + Unicode bidi/format
 * characters are stripped (a U+202E override could visually reorder
 * the line the operator approves; newlines would eat the card's
 * 3-line budget and push later params out of view), each value is
 * capped, and non-primitive values surface as a visible placeholder —
 * the operator must SEE that data was omitted, not approve blind.
 */
function humanizeParams(params: unknown): string {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return '';
  const sanitize = (s: string): string =>
    // C0 controls, DEL+C1, bidi embeddings/overrides (U+202A–U+202E),
    // bidi isolates (U+2066–U+2069), zero-width/format (U+200B–U+200F).
    // eslint-disable-next-line no-control-regex
    s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ');
  const capValue = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    const key = capValue(sanitize(k));
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${key}: ${capValue(sanitize(String(v)))}`);
    } else if (Array.isArray(v)) {
      parts.push(`${key}: […]`);
    } else {
      parts.push(`${key}: {…}`);
    }
  }
  const joined = parts.join(' · ');
  return joined.length > 140 ? `${joined.slice(0, 137)}…` : joined;
}

function defaultApprovalNotifier(threadId: string): ApprovalNotifier {
  return ({ taskId, fromDID, serviceName, capability, approveCommand, params }) => {
    // Who's asking: the authenticated sender DID, shown as their contact
    // name when known. NEVER a self-asserted param — the from_did is the
    // identity (same discipline as the D2D envelope rule).
    let requesterLabel = shortDID(fromDID);
    try {
      const contact = getContact(fromDID);
      if (contact !== null && contact.displayName !== '') {
        requesterLabel = contact.displayName;
      }
    } catch {
      /* contact directory not hydrated yet — short DID is fine */
    }
    const paramsPreview = humanizeParams(params);
    const what = paramsPreview !== '' ? `${capability} — ${paramsPreview}` : capability;
    const line =
      serviceName !== ''
        ? `${requesterLabel} asks ${serviceName}: ${what}. Approve? ${approveCommand}`
        : `${requesterLabel} asks: ${what} (${taskId}). ${approveCommand}`;
    // Review #13: emit an `approval`-type message so the Chat UI can
    // render an approval card (approve / deny buttons) rather than a
    // plain dina text line that looks like a normal reply. Metadata
    // carries the fields the card needs.
    addApprovalMessage(threadId, line, {
      taskId,
      capability,
      fromDID,
      serviceName,
      approveCommand,
      requesterLabel,
      ...(paramsPreview !== '' ? { paramsPreview } : {}),
    });
  };
}

/**
 * Provider-side chat visibility hook. When an external Home Node sends a
 * `service.query` and ServiceHandler accepts it, post a system line into
 * the operator's chat so they see the inbound traffic. Pairs with the
 * `sendResponse` wrapper above (which posts a follow-up line when the
 * bridge sends the `service.response`).
 */
function defaultInboundNotifier(threadId: string): ServiceInboundNotifier {
  return ({ kind, fromDID, capability }) => {
    const peer = shortDID(fromDID);
    const verb = kind === 'approval' ? 'awaiting approval' : 'handling';
    addSystemMessage(threadId, `Incoming ${capability} from ${peer}: ${verb}.`);
  };
}

function formatResponseSentLine(args: {
  toDID: string;
  capability: string;
  status: string;
  error?: string;
}): string {
  const peer = shortDID(args.toDID);
  if (args.status === 'success') {
    return `Sent ${args.capability} response to ${peer}.`;
  }
  const reason = args.error !== undefined && args.error !== '' ? ` (${args.error})` : '';
  return `Sent ${args.capability} ${args.status} to ${peer}${reason}.`;
}

/** Compress a `did:plc:abcdef…` to `did:plc:abcdef` for chat display. */
function shortDID(did: string): string {
  if (did.length <= 24) return did;
  return `${did.slice(0, 20)}…`;
}
