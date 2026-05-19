/**
 * Wire the workflow + service-query plane into a lite Home Node.
 *
 * Mirrors the chunk of `apps/mobile/src/services/bootstrap.ts:createNode`
 * that turns a "just storage + a router" Core into a fully operational
 * Home Node capable of:
 *
 *   1. Accepting inbound `service.query` D2D envelopes (mints a
 *      `service_query` workflow task that a paired dina-agent claims
 *      via `/v1/workflow/tasks/claim`).
 *   2. Bridging task completion back to the requester via an outbound
 *      `service.response` D2D (the Response Bridge inside
 *      `WorkflowService.complete`).
 *   3. Running the requester-side orchestrator + workflow-event
 *      consumer (so this same Home Node can also call out to public
 *      services and get answers delivered into chat).
 *   4. Running the expiry / lease / bridge-retry sweepers so stuck
 *      tasks don't accumulate forever.
 *
 * Lite-specific simplifications vs the mobile path:
 *   - No chat-thread integration (lite has no chat surface). The
 *     `deliver` callback is a structured logger.
 *   - No approval notifier (lite doesn't yet have an approvals UI;
 *     auto-execute everything the gatekeeper lets through).
 *   - No demo BusDriver short-circuit (lite never runs against the
 *     in-memory AppView stub).
 *
 * Wiring sequence (matching mobile order so the matrix of side-effect
 * setters stays comprehensible):
 *
 *   storage init   →  builds SQLiteWorkflowRepository
 *   PDS provision  →  exposes did:plc + the matching signing keypair
 *   ─ this module fires here ─
 *     A. registerPublicKeyResolver  (verifyRequest can resolve self)
 *     B. setDIDResolver-equivalent (sendD2D resolves recipients)
 *     C. WorkflowService with Response Bridge → setWorkflowService
 *     D. setWorkflowRepository (so routes find the repo)
 *     E. setD2DSender + setServiceQuerySender + setServiceRespondSender
 *     F. buildHomeNodeServiceRuntime (handler, dispatcher, orchestrator,
 *        events, approvals) — start()ed
 *     G. TaskExpirySweeper + LeaseExpirySweeper + BridgePendingSweeper
 *        — start()ed
 *
 * Returns a `dispose()` the caller wires into the global teardown
 * stack (alongside `disconnectMsgBox()` from boot.ts).
 *
 * Why this module exists (vs inlining into boot.ts): boot.ts already
 * orchestrates eight steps; pushing the workflow-plane wiring inline
 * would double its size and make the boot trace harder to read. The
 * module also exposes a single integration surface, which keeps the
 * test gap with the mobile path narrow.
 */

import {
  AppViewServiceResolver,
  InProcessTransport,
  SQLiteWorkflowRepository,
  WorkflowService,
  getServiceConfig,
  makeServiceResponseBridgeSender,
  multibaseToPublicKey,
  registerPublicKeyResolver,
  registerService,
  setWorkflowRepository,
  setWorkflowService,
  type CoreRouter,
  type ServiceConfig,
  type WorkflowRepository,
} from '@dina/core';
import {
  BridgePendingSweeper,
  DIDResolver,
  LeaseExpirySweeper,
  TaskExpirySweeper,
  sendD2D as coreSendD2D,
  setD2DSender,
  setServiceQuerySender,
  setServiceRespondSender,
  type ServiceQueryBody,
  type ServiceResponseBody,
} from '@dina/core/runtime';
import { buildHomeNodeServiceRuntime } from '@dina/home-node/service-runtime';
import {
  validateAgainstSchema,
  type ApprovalNotifier,
  type OrchestratorAppView,
  type ServiceInboundNotifier,
} from '@dina/brain';
import type { DinaMessage } from '@dina/core/runtime';
import type { DatabaseAdapter } from '@dina/core/storage';

import type { Logger } from '../logger';
import type { PdsIdentity } from '../identity/provision_pds';

/** Inputs the boot script supplies to the wiring layer. */
export interface WireWorkflowPlaneOptions {
  /** Identity DB adapter from `initializeStorage`. */
  identityDB: DatabaseAdapter;
  /** PDS-provisioned identity — supplies `did:plc` + the relay/signing key. */
  pdsIdentity: PdsIdentity;
  /** Master-seed-derived root keypair — used to sign outbound D2D as ourselves. */
  signingKeypair: { publicKey: Uint8Array; privateKey: Uint8Array };
  /** Default MsgBox endpoint to fall back to when a peer's DID doc omits its own. */
  msgboxURL: string;
  /** AppView URL — wires the public-service resolver so D2D to discoverable
   *  service DIDs bypasses the contact gate. */
  appViewURL: string;
  /** Core router — used to build the InProcessTransport CoreClient. */
  coreRouter: CoreRouter;
  /** Boot logger; receives structured events from sweepers + runtime. */
  logger: Logger;
}

export interface WiredWorkflowPlane {
  /**
   * Callback the MsgBox bootstrap passes as `onBypassedD2D`. Routes
   * inbound `service.query` / `service.response` D2D envelopes (the
   * ones the receive pipeline bypasses past the contact gate) into
   * the local dispatcher, which fans out to `ServiceHandler`.
   * Without this wiring inbound service traffic is decrypted +
   * validated then silently discarded.
   */
  onBypassedD2D(info: {
    senderDID: string;
    messageType: string;
    body: unknown;
  }): Promise<void>;
  /** Stop sweepers + runtime, deregister singletons. */
  dispose(): Promise<void>;
}

/**
 * Run the workflow-plane wiring. Idempotent within a single process —
 * caller invokes once per boot after storage + PDS identity are
 * available. Throws if any prerequisite is missing (callers should
 * have validated those before reaching us).
 */
export function wireWorkflowPlane(options: WireWorkflowPlaneOptions): WiredWorkflowPlane {
  const { identityDB, pdsIdentity, signingKeypair, msgboxURL, appViewURL, coreRouter, logger } =
    options;

  // (A) Self-key resolver — every signed request that lands locally
  //     (the Response Bridge's own outbound, the dina-agent calling
  //     /v1/workflow/tasks/claim) needs to verify against our pubkey.
  //     Without this, verifyRequest treats the home node's own DID as
  //     unknown and 401s.
  const selfPubKey = signingKeypair.publicKey;
  registerPublicKeyResolver((did) => (did === pdsIdentity.did ? selfPubKey : null));

  // Register ourselves as a brain-class caller so Brain↔Core signed
  // calls (e.g. when an in-process Brain talks to its own Core for
  // vault writes) pass the authz allowlist.
  registerService(pdsIdentity.did, 'brain');

  // (B) DID resolver — one instance shared across the sendD2D pipeline
  //     and any future inbound-key lookups. 10-minute cache amortizes
  //     the PLC round-trip across bursts of service queries.
  const didResolver = new DIDResolver();

  // AppView resolver consulted by `coreSendD2D` to bypass the contact
  // gate when the recipient is a published public-service DID. Without
  // this, the first cross-Dina service.query is denied at contact —
  // even though the recipient advertises the capability on AppView.
  const providerServiceResolver = new AppViewServiceResolver({ appViewURL });

  // Outbound D2D — resolve recipient → seal → sign → forward. Matches
  // the mobile boot_capabilities.ts:sendD2D builder almost verbatim;
  // small heuristic differences are noted inline.
  const sendD2D = async (
    to: string,
    type: string,
    body: Record<string, unknown>,
  ): Promise<void> => {
    const resolved = await didResolver.resolve(to);
    // PLC docs list secp256k1 rotation keys first (#atproto); we need
    // the Ed25519 signing key for sealMessage. Prefer an explicit
    // `#dina_signing` id, fall back to any 32-byte Multikey.
    const vm = pickPeerSigningKey(resolved.document.verificationMethod);
    if (vm === null) {
      throw new Error(`sendD2D: recipient ${to} has no Ed25519 signing key in its DID doc`);
    }
    const recipientPublicKey = multibaseToPublicKey(vm.publicKeyMultibase as string);
    const endpoint = resolved.messagingService?.endpoint ?? msgboxURL;
    const result = await coreSendD2D({
      recipientDID: to,
      messageType: type,
      body: JSON.stringify(body),
      senderDID: pdsIdentity.did,
      senderPrivateKey: signingKeypair.privateKey,
      recipientPublicKey,
      endpoint,
      providerServiceResolver,
    });
    if (!result.sent) {
      throw new Error(
        `sendD2D: ${type} to ${to} denied at ${result.deniedAt ?? 'unknown'}: ${result.error ?? 'no detail'}`,
      );
    }
  };

  // (C) Response Bridge — fires when a `service_query` delegation task
  //     hits `complete`. Translates the runner's resultJSON into a
  //     well-formed `service.response` envelope and ships it via
  //     sendD2D. Throws on transport failure so WorkflowService's
  //     bridge stash logic decides to retry vs clear.
  const responseBridgeSender = makeServiceResponseBridgeSender({
    sendResponse: async (to, responseBody) => {
      await sendD2D(to, 'service.response', responseBody as unknown as Record<string, unknown>);
    },
    validateResult: validateAgainstSchema,
    onMalformedResult: (ctx, err) =>
      logger.warn(
        { query_id: ctx.queryId, error: err.message },
        'response-bridge malformed_result',
      ),
    onSendError: (ctx, err) =>
      logger.warn({ query_id: ctx.queryId, error: err.message }, 'response-bridge send_failed'),
    onResultValidationFailure: (ctx, error) =>
      logger.warn(
        { query_id: ctx.queryId, capability: ctx.capability, error },
        'response-bridge result_validation_failed',
      ),
  });

  // (D) Workflow repository + service. Order matters: install the repo
  //     globally BEFORE the service so anything reaching for the
  //     repo during service construction (the local delegation
  //     pathway, the bridge sweeper) finds it.
  const workflowRepository: WorkflowRepository = new SQLiteWorkflowRepository(identityDB);
  setWorkflowRepository(workflowRepository);

  const workflowService = new WorkflowService({
    repository: workflowRepository,
    responseBridgeSender,
  });
  setWorkflowService(workflowService);

  // (E) Wire D2D senders the route handlers consult. All three share
  //     the same `sendD2D` so we have ONE outbound code path, ONE
  //     set of gates, ONE audit trail — same invariant the mobile
  //     boot guarantees.
  setD2DSender(async (to, type, body) => {
    await sendD2D(to, type, body);
  });
  setServiceQuerySender(async (to, _type, body) => {
    await sendD2D(to, 'service.query', body as unknown as Record<string, unknown>);
  });
  setServiceRespondSender(async (to, _type, body) => {
    await sendD2D(to, 'service.response', body as unknown as Record<string, unknown>);
  });

  // (F) Build the shared service runtime. The in-process CoreClient
  //     dispatches through the same router the HTTP layer uses, so the
  //     orchestrator + handler exercise the production code paths.
  const coreClient = new InProcessTransport(coreRouter);

  // AppView client — discovery surface for `service.query` egress.
  // Lite operates as a provider node first, so the requester path is
  // less critical here. Stubbed to "no candidates" until a real
  // AppView client is wired (lite's own AppView lives at
  // appview.dinakernel.com but the typed client isn't ported yet).
  const appView: OrchestratorAppView = {
    searchServices: async () => [],
  };

  const approvalNotifier: ApprovalNotifier = (notice) => {
    logger.info(
      { task_id: notice.taskId, capability: notice.capability, from: notice.fromDID },
      'service.query awaiting approval (no UI on lite)',
    );
  };
  const inboundNotifier: ServiceInboundNotifier = (notice) => {
    logger.info(
      { from: notice.fromDID, capability: notice.capability },
      'service.query accepted (auto-execute path)',
    );
  };

  const runtime = buildHomeNodeServiceRuntime({
    core: coreClient,
    appView,
    readConfig: (): ServiceConfig | null => getServiceConfig(),
    rejectResponder: async (to, body) => {
      await sendD2D(to, 'service.response', {
        query_id: body.query_id,
        capability: body.capability,
        status: body.status,
        ...(body.error !== undefined ? { error: body.error } : {}),
        ...(body.ttl_seconds !== undefined ? { ttl_seconds: body.ttl_seconds } : {}),
      });
    },
    deliver: ({ text, event, task, details }) => {
      // Lite has no chat surface — log the workflow event so operators
      // see what landed. Mobile uses this to patch lifecycle cards.
      logger.info(
        {
          task_id: task.id,
          kind: task.kind,
          event_kind: event.event_kind,
          capability: details.capability,
          response_status: details.response_status,
          text,
        },
        'workflow event delivered',
      );
    },
    approvalNotifier,
    inboundNotifier,
    logger: (entry) => logger.info(entry, 'service-runtime'),
    onWorkflowError: (err) =>
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'workflow event consumer error',
      ),
    onApprovalError: (err) =>
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'approval reconciler error',
      ),
  });
  runtime.start();

  // (G) Sweepers — each ticks on its own setInterval. Defaults match
  //     mobile (60s task expiry, 10s lease expiry, 30s bridge retry).
  //     The bridge retry sweeper is the critical durability layer for
  //     the Response Bridge: a transient D2D hiccup on a `complete`
  //     leaves a `bridge_pending:` stash that this sweeper drains on
  //     subsequent ticks.
  const taskExpiry = new TaskExpirySweeper({ repository: workflowRepository });
  taskExpiry.start();

  const leaseExpiry = new LeaseExpirySweeper({ repository: workflowRepository });
  leaseExpiry.start();

  const bridgeRetry = new BridgePendingSweeper({ service: workflowService });
  bridgeRetry.start();

  logger.info({}, 'workflow plane wired (repo + service + sweepers + runtime)');

  const dispatcher = runtime.dispatcher;

  return {
    async onBypassedD2D(info): Promise<void> {
      const raw: Partial<DinaMessage> = {
        type: info.messageType,
        from: info.senderDID,
        to: pdsIdentity.did,
      };
      await dispatcher.dispatch(
        info.senderDID,
        raw as DinaMessage,
        info.body as Record<string, unknown>,
      );
    },
    async dispose(): Promise<void> {
      taskExpiry.stop();
      leaseExpiry.stop();
      bridgeRetry.stop();
      await runtime.dispose();
      setWorkflowService(null);
      setWorkflowRepository(null);
      setD2DSender(null);
      setServiceQuerySender(null);
      setServiceRespondSender(null);
    },
  };
}

/**
 * Pick the Ed25519 signing key out of a peer's verificationMethod
 * list. Lifted from mobile boot_capabilities.ts so the lite stack
 * stays consistent with the mobile heuristic on what counts as the
 * `#dina_signing` channel.
 */
function pickPeerSigningKey(
  vms: Array<{ id?: string; type?: string; publicKeyMultibase?: string }>,
): { publicKeyMultibase?: string } | null {
  for (const vm of vms) {
    if (typeof vm.id === 'string' && vm.id.endsWith('#dina_signing')) return vm;
  }
  for (const vm of vms) {
    if (vm.type !== 'Multikey' || typeof vm.publicKeyMultibase !== 'string') continue;
    try {
      if (multibaseToPublicKey(vm.publicKeyMultibase).length === 32) return vm;
    } catch {
      /* malformed — skip */
    }
  }
  return null;
}
