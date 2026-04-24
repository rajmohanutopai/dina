/**
 * Home-node bootstrap — composes Core + Brain + runners + MsgBox transport
 * into a `DinaNode` handle. One call on app unlock.
 *
 * The factory's contract:
 *   - Caller supplies pre-built clients (`BrainCoreClient`, `AppViewClient`,
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

import type { WorkflowRepository } from '@dina/core/src/workflow/repository';
import { setWorkflowRepository } from '@dina/core/src/workflow/repository';
import type { CoreRouter } from '@dina/core/src/server/router';
import { WorkflowService, setWorkflowService } from '@dina/core/src/workflow/service';
import {
  setServiceConfigRepository,
  type ServiceConfigRepository,
} from '@dina/core/src/service/service_config_repository';
import {
  setServiceConfig,
  resetServiceConfigState,
  onServiceConfigChanged,
  getServiceConfig,
} from '@dina/core/src/service/service_config';
import {
  registerService,
  registerDevice as registerDeviceDID,
  setDeviceRoleResolver,
  resetCallerTypeState,
} from '@dina/core/src/auth/caller_type';
import { registerPublicKeyResolver, resetMiddlewareState } from '@dina/core/src/auth/middleware';
import { bootstrapMsgBox, type MsgBoxBootConfig } from '@dina/core/src/relay/msgbox_boot';
import { D2DDispatcher } from '@dina/brain/src/guardian/d2d_dispatcher';
import type { DinaMessage } from '@dina/core/src/d2d/envelope';
import { setD2DSender } from '@dina/core/src/server/routes/d2d_msg';
import { TaskExpirySweeper } from '@dina/core/src/workflow/task_expiry_sweeper';
import { LeaseExpirySweeper } from '@dina/core/src/workflow/lease_expiry_sweeper';
import { BridgePendingSweeper } from '@dina/core/src/workflow/bridge_pending_sweeper';
import { StagingDrainScheduler } from '@dina/brain/src/staging/scheduler';
import type { StagingDrainOptions } from '@dina/brain/src/staging/drain';
import {
  LocalDelegationRunner,
  type LocalCapabilityRunner,
} from '@dina/core/src/workflow/local_delegation_runner';
import { setServiceQuerySender } from '@dina/core/src/server/routes/service_query';
import { setServiceRespondSender } from '@dina/core/src/server/routes/service_respond';
import { isAuthenticated as isMsgBoxAuthenticated } from '@dina/core/src/relay/msgbox_ws';
import type {
  ServiceQueryBody,
  ServiceResponseBody,
} from '@dina/core/src/d2d/service_bodies';
import { disconnect as disconnectMsgBox, type WSFactory } from '@dina/core/src/relay/msgbox_ws';
import { setWSDeliverFn } from '@dina/core/src/transport/delivery';
import { makeServiceResponseBridgeSender } from '@dina/core/src/workflow/response_bridge_sender';
import { emitRuntimeWarning } from './runtime_warnings';

function emitMsgboxOfflineWarning(detail: string): void {
  emitRuntimeWarning(
    'transport.msgbox.offline',
    `MsgBox relay unreachable: ${detail}. Outbound D2D will fail until the relay reconnects.`,
  );
}

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
) => Promise<void>;
import { validateAgainstSchema } from '@dina/brain/src/service/capabilities/schema_validator';
import type { CoreClient } from '@dina/core/src/client/core-client';
import type { AppViewClient } from '@dina/brain/src/appview_client/http';
import type { PDSPublisher } from '@dina/brain/src/pds/publisher';
import type { IdentityKeypair } from '@dina/core/src/identity/keypair';
import type { PDSSession } from '@dina/brain/src/pds/account';
import type { ServiceConfig } from '@dina/core/src/service/service_config';
import { ServiceHandler, type ApprovalNotifier } from '@dina/brain/src/service/service_handler';
import {
  ServiceQueryOrchestrator,
  type OrchestratorAppView,
} from '@dina/brain/src/service/service_query_orchestrator';
import {
  WorkflowEventConsumer,
  type WorkflowEventDeliverer,
  type ApprovalEventDispatcher,
} from '@dina/brain/src/service/workflow_event_consumer';
import { ApprovalReconciler } from '@dina/brain/src/service/approval_reconciliation';
import { wireServiceOrchestrator } from '@dina/brain/src/service/service_wiring';
import {
  setServiceApproveCommandHandler,
  resetServiceApproveCommandHandler,
  setServiceDenyCommandHandler,
  resetServiceDenyCommandHandler,
  setAskCommandHandler,
  resetAskCommandHandler,
} from '@dina/brain/src/chat/orchestrator';
import type { LLMProvider } from '@dina/brain/src/llm/adapters/provider';
import type { ToolRegistry } from '@dina/brain/src/reasoning/tool_registry';
import {
  makeAgenticAskHandler,
  type AgenticAskHandlerOptions,
} from '@dina/brain/src/reasoning/ask_handler';
import {
  makeServiceApproveHandler,
  makeServiceDenyHandler,
} from '@dina/brain/src/service/approve_command';
import { ServicePublisher } from '@dina/brain/src/service/service_publisher';
import { toPublisherConfig } from '@dina/brain/src/service/config_sync';
import {
  addDinaResponse,
  addApprovalMessage,
  addMessage,
  hydrateThread,
} from '@dina/brain/src/chat/thread';
import {
  MsgTypeCoordinationRequest,
  MsgTypeCoordinationResponse,
  MsgTypeSocialUpdate,
  MsgTypeTrustVouchRequest,
  MsgTypeTrustVouchResponse,
  MsgTypeSafetyAlert,
} from '@dina/core/src/d2d/families';
import { setInboxCoreClient, resetInboxCoreClient } from '../hooks/useServiceInbox';
import {
  setServiceConfigCoreClient,
  resetServiceConfigCoreClient,
} from '../hooks/useServiceConfigForm';

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

  // --- Clients + stores the caller provides -------------------------------
  /**
   * Transport-agnostic `CoreClient` handle — every brain subsystem
   * wires against this. Mobile boot passes `InProcessTransport(router)`;
   * home-node-lite's brain-server passes `HttpCoreTransport`. Both
   * implement the same `CoreClient` interface so bootstrap code never
   * branches on runtime. (Earlier iterations had a transitional
   * `coreClient: BrainCoreClient` + `coreTransport: CoreClient`
   * dual-wiring; task 1.32 finished migrating every consumer onto
   * CoreClient + the hooks onto `Pick<CoreClient, ...>` slices, so
   * the two fields collapse to one.)
   */
  coreClient: CoreClient;
  appViewClient: Pick<AppViewClient, 'searchServices'>;
  pdsPublisher?: PDSPublisher;
  workflowRepository: WorkflowRepository;
  /**
   * Service-config repository (SQLite-backed in production). When supplied
   * it becomes the durable store Core reads from for capability lookups
   * during D2D ingress; when omitted the config lives only in-process.
   */
  serviceConfigRepository?: ServiceConfigRepository;
  /**
   * Accessor for the node's ServiceConfig. Kept for backward-compatible
   * injection in tests. When omitted, bootstrap falls back to Core's
   * global `getServiceConfig` (driven by `setServiceConfig` / the config
   * repository).
   */
  readConfig?: () => ServiceConfig | null;
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
   * Review #6 (partial): previously every async response routed to
   * one fixed `chatThreadId`. Once multiple threads exist (per-
   * persona chats, a separate Service Inbox thread, etc.) the
   * caller supplies this resolver to route by origin.
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

export interface DinaNode {
  did: string;
  /**
   * The role this node started under. The UI reads this to decide
   * whether to expose provider-only tabs (Approvals + Service
   * Sharing) — a `requester`-only node shouldn't (review #16).
   */
  role: NodeRole;
  coreClient: CoreClient;
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
    /** GAP-RT-01: drains Core's `staging_inbox` on a cadence. `null`
     *  only when explicitly disabled via `options.stagingDrain === false`. */
    stagingDrain: StagingDrainScheduler | null;
    /** Present only when `localDelegationRunner` was supplied. */
    localRunner: LocalDelegationRunner | null;
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

  // Core-globals installation is DEFERRED to start() so an unstarted
  // node doesn't mutate process state. Issue #8. The closure captures
  // everything it needs; start() invokes it; dispose() runs the
  // teardown. Multi-node tests still opt out via `coreGlobals: false`.
  const installCoreGlobals = (): void => {
    if (!coreGlobals) return;
    setWorkflowRepository(options.workflowRepository);
    if (options.serviceConfigRepository !== undefined) {
      setServiceConfigRepository(options.serviceConfigRepository);
    }
    if (options.initialServiceConfig !== undefined) {
      setServiceConfig(options.initialServiceConfig);
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

    // Workflow service + repository — Core routes consult these via
    // `getWorkflowService()` / `getWorkflowRepository()`. Installed
    // last so every dependent layer above has wired up first.
    setWorkflowService(workflowService);
  };

  // 1. WorkflowService with Response Bridge — completion on a delegation
  // task with payload.type === 'service_query_execution' auto-emits
  // service.response on the wire.
  const responseBridgeSender = makeServiceResponseBridgeSender({
    // ResponseBridge is service.response-only; inject the type so the
    // app's single sendD2D keeps one signature across all call sites.
    sendResponse: (to, body) =>
      options.sendD2D(to, 'service.response', body as unknown as Record<string, unknown>),
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
  });
  // `setWorkflowService` is deferred to start() via installCoreGlobals.

  // ServiceHandler reads config through a thunk. Default to Core's
  // global (shared with the D2D ingress pipeline and the route handler)
  // so the two sides can't diverge.
  const readConfig = options.readConfig ?? ((): ServiceConfig | null => getServiceConfig());

  // 2. ServiceHandler — inbound service.query → delegation/approval task.
  // `rejectResponder` bridges task-less rejections (unknown capability,
  // schema mismatch, bad params) to Core's D2D egress so the requester
  // gets a real `service.response` instead of a silent TTL expiry
  // (issue #9).
  const handler = new ServiceHandler({
    coreClient: options.coreClient,
    readConfig,
    notifier: options.approvalNotifier ?? defaultApprovalNotifier(threadId),
    rejectResponder: async (to, body) => {
      await options.sendD2D(to, 'service.response', {
        query_id: body.query_id,
        capability: body.capability,
        status: body.status,
        error: body.error,
        ttl_seconds: body.ttl_seconds,
      });
    },
    logger: log,
  });

  // D2DDispatcher — Brain's registry that routes parsed inbound bodies
  // to the right handler. service.query → provider handler. (Requester-
  // side service.response correlation is handled by Core's receive
  // pipeline + workflow event consumer, not a dispatcher handler.)
  const dispatcher = new D2DDispatcher();
  dispatcher.register('service.query', async (fromDID, body, _raw) => {
    await handler.handleQuery(fromDID, body);
  });

  // 3. Orchestrator — outbound service.query dispatch.
  const orchestrator = new ServiceQueryOrchestrator({
    appViewClient: options.appViewClient as OrchestratorAppView,
    coreClient: options.coreClient,
  });

  // 4. WorkflowEventConsumer — deliver service_query completions to the
  // chat thread, dispatch `approved` events to `executeAndRespond`.
  //
  // Review #6 (partial): route by origin_channel when a resolver is
  // supplied. The service_query task's payload carries the
  // `origin_channel` the requester tagged the query with (e.g.
  // 'ask'); the resolver maps that to a thread. Without a resolver
  // we fall back to the fixed `chatThreadId` — preserving current
  // behaviour while giving multi-thread apps a hook.
  const threadResolver = options.threadResolver;
  const deliver: WorkflowEventDeliverer = ({ text, event, task, details }) => {
    const sources: string[] = [];
    if (event.task_id !== '') sources.push(event.task_id);
    if (details.capability !== undefined && details.capability !== '') {
      sources.push(details.capability);
    }
    let target = threadId;
    if (threadResolver !== undefined) {
      const originChannel = extractOriginChannel(task.payload);
      const resolved = threadResolver({
        originChannel,
        eventKind: event.event_kind,
        task: { id: task.id, kind: task.kind },
      });
      if (resolved !== null && resolved !== '') target = resolved;
    }
    addDinaResponse(target, text, sources.length > 0 ? sources : undefined);
  };
  const onApproved: ApprovalEventDispatcher = async ({ task, payload }) => {
    await handler.executeAndRespond(task.id, payload);
  };
  const events = new WorkflowEventConsumer({
    coreClient: options.coreClient,
    deliver,
    onApproved,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
    logger: log,
  });

  // 5. ApprovalReconciler — provider-side TTL expiry sweeper.
  const approvals = new ApprovalReconciler({
    coreClient: options.coreClient,
    nowMsFn,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
  });

  // 5a. TaskExpirySweeper — requester-side TTL enforcement (issue #9).
  //     Calls WorkflowRepository.expireTasks on a cadence so stuck
  //     service_query tasks past their ttl_seconds flip to `failed`
  //     and emit a workflow_event that reaches the chat surface.
  const taskExpiry = new TaskExpirySweeper({
    repository: options.workflowRepository,
    nowMsFn,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
  });

  // 5b. LeaseExpirySweeper — reverts stuck delegation tasks when an
  //     agent's lease expires so another agent can reclaim them.
  //     Required for at-least-once completion on the provider side.
  const leaseExpiry = new LeaseExpirySweeper({
    repository: options.workflowRepository,
    nowMsFn,
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
  const globalDisposers: Array<() => void> = [];
  const installChatGlobals = (): void => {
    if (!globalWiring) return;
    const disposeWire = wireServiceOrchestrator({ orchestrator });
    globalDisposers.push(() => disposeWire());
    setServiceApproveCommandHandler(makeServiceApproveHandler(options.coreClient));
    globalDisposers.push(resetServiceApproveCommandHandler);
    setServiceDenyCommandHandler(makeServiceDenyHandler(options.coreClient));
    globalDisposers.push(resetServiceDenyCommandHandler);
    setInboxCoreClient(options.coreClient);
    globalDisposers.push(resetInboxCoreClient);
    setServiceConfigCoreClient(options.coreClient);
    globalDisposers.push(resetServiceConfigCoreClient);
    if (options.agenticAsk !== undefined) {
      setAskCommandHandler(
        makeAgenticAskHandler({
          provider: options.agenticAsk.provider,
          tools: options.agenticAsk.tools,
          ...options.agenticAsk.options,
        }),
      );
      globalDisposers.push(resetAskCommandHandler);
    }
  };

  // 7. ServicePublisher — publishes service profile record to PDS when
  // provider+isDiscoverable. Instantiated lazily; caller supplies the publisher
  // so we don't duplicate credentials.
  let publisher: ServicePublisher | null = null;
  if (isProvider && options.pdsPublisher !== undefined) {
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
    workflowService,
    orchestrator,
    handler,
    dispatcher,
    runners: { events, approvals, taskExpiry, leaseExpiry, bridgeRetry, stagingDrain, localRunner },

    async start(): Promise<void> {
      if (started) return;

      // Install process-globals FIRST (issue #8: don't touch them in
      // the synchronous constructor). Core singletons go first so
      // route handlers + ingress pipeline can read them as soon as
      // MsgBox starts delivering; chat globals follow.
      installCoreGlobals();
      installChatGlobals();

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
          onStagedD2D: ({ senderDID, messageType, body }) => {
            if (!isChatRenderableType(messageType)) return;
            const text = extractChatText(body);
            if (text === null) return;
            // `type: 'dina'` renders left-aligned; the renderer checks
            // metadata.source === 'd2d' to label with the peer's name
            // instead of "Dina".
            addMessage(senderDID, 'dina', text, {
              metadata: { source: 'd2d', senderDID, messageType },
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
          log({ event: 'node.msgbox_connect_failed', error: msg });
          emitMsgboxOfflineWarning(msg);
        }
      }

      // Publish the service profile record (provider role + isDiscoverable).
      // Initial sync is LOAD-BEARING: a provider that can't publish is
      // undiscoverable via AppView, so start() must surface the
      // failure to the caller rather than marking the node "started"
      // while it sits invisibly broken (issue #18).
      if (publisher !== null) {
        const cfg = readConfig();
        if (cfg !== null) {
          await publisher.sync(toPublisherConfig(cfg));
          log({ event: 'node.service_profile_synced', is_public: cfg.isDiscoverable });
        }
        const unsubscribe = onServiceConfigChanged((next) => {
          const p = publisher;
          if (p === null) return;
          // Fire-and-forget — the listener is synchronous but the
          // publisher's sync is async. We never block the config-event
          // emission on the PDS round-trip.
          const syncPromise = next === null ? p.unpublish() : p.sync(toPublisherConfig(next));
          void syncPromise.then(
            () =>
              log({
                event: 'node.service_profile_synced',
                is_public: next?.isDiscoverable ?? false,
                reason: 'config_changed',
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
      if (stagingDrain !== null) stagingDrain.start();
      if (localRunner !== null) localRunner.start();

      // Only flip the idempotency flag once every boot step has landed.
      // Previously this was set at the top, so a throw mid-boot left
      // the node half-wired AND rejected subsequent start() calls as
      // "already started". Issue #9.
      started = true;
      log({ event: 'node.started', did: options.did });
    },

    async stop(): Promise<void> {
      if (!started) return;
      started = false;
      // Stop scheduling new ticks, then wait for any in-flight ticks
      // to drain before callers can assume shutdown completed. Issue
      // #10 — previously stop() returned while events/approvals/
      // runner ticks were still mid-flight, leading to reset-globals-
      // while-still-running races.
      if (localRunner !== null) localRunner.stop();
      if (stagingDrain !== null) stagingDrain.stop();
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
          fn();
        } catch {
          /* swallow */
        }
      }
      // Release Core module-level singletons — ONLY the ones this node
      // claimed. A node constructed with `coreGlobals: false` never
      // wrote to the singletons, so tearing them down here would clobber
      // whatever the process actually uses. Issue #2.
      if (coreGlobals) {
        setWorkflowService(null);
        setWorkflowRepository(null);
        setServiceQuerySender(null);
        setServiceRespondSender(null);
        setD2DSender(null);
        // Unwire BOTH the in-memory state AND the repository so the next
        // createNode() starts from a clean slate — leaving the repo
        // attached would let getServiceConfig re-hydrate the old config.
        resetServiceConfigState();
        setServiceConfigRepository(null);
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
 * Best-effort extract of `origin_channel` from a workflow task's
 * JSON payload. Returns `''` when the payload is malformed or the
 * field is missing — the caller falls back to the fixed thread id
 * (review #6 partial).
 */
function extractOriginChannel(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { origin_channel?: unknown };
    return typeof parsed.origin_channel === 'string' ? parsed.origin_channel : '';
  } catch {
    return '';
  }
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

function defaultApprovalNotifier(threadId: string): ApprovalNotifier {
  return ({ taskId, fromDID, serviceName, capability, approveCommand }) => {
    const line =
      serviceName !== ''
        ? `${serviceName} wants to run ${capability}. Approve? ${approveCommand}`
        : `Pending approval: ${capability} (${taskId}). ${approveCommand}`;
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
    });
  };
}
