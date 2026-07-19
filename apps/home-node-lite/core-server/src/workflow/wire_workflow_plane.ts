/**
 * Thin lite-Core wrapper around `@dina/home-node`'s `wireWorkflowPlane`.
 *
 * The previous version of this file carried a hand-rolled copy of the
 * mobile bootstrap's workflow wiring. Now both targets delegate to
 * the shared composition in `@dina/home-node/workflow_plane.ts` — this
 * module just wires in the lite-specific pieces:
 *
 *   - Builds the in-process `CoreClient` via `InProcessTransport`.
 *   - Builds the outbound `sendD2D` via `makeSendD2D`, attaching an
 *     `AppViewServiceResolver` so cross-Dina `service.query` egress
 *     bypasses the contact gate.
 *   - Builds a stub `OrchestratorAppView` (lite is provider-first;
 *     real AppView search wiring lands in a follow-up).
 *   - Provides log-shaped `deliver` / `approvalNotifier` /
 *     `inboundNotifier` callbacks (no chat surface here).
 *   - Owns the `onBypassedD2D` glue: routes inbound `service.*` D2D
 *     envelopes from the receive pipeline into the local dispatcher.
 *   - Registers the home node's own DID with the public-key resolver
 *     so signed local calls verify.
 *
 * Everything else flows through `wireWorkflowPlane` so changes to the
 * Response Bridge / sweepers / Core sender registry land in one
 * place and both mobile + lite pick them up.
 */

import {
  AppViewServiceResolver,
  InProcessTransport,
  LocalDelegationRunner,
  MsgTypeServiceResponse,
  SQLiteWorkflowRepository,
  getServiceConfig,
  registerPublicKeyResolver,
  registerService,
  setOutboxRedeliverFn,
  startOutboxDrainer,
  wireRunPlaneNode,
  type CoreRouter,
  type ServiceConfig,
} from '@dina/core';

// `setD2DSender` registers the generic D2D egress callback for the
// `/v1/msg/send` route. It lives on the runtime subpath (route module),
// not the main `@dina/core` barrel.
import { setD2DSender } from '@dina/core/runtime';
import {
  makeSendD2D,
  makeOutboxRedeliver,
  makeResolveSender,
  wireWorkflowPlane as wireSharedWorkflowPlane,
  type WiredWorkflowPlane as SharedWiredWorkflowPlane,
} from '@dina/home-node';

import { makeHttpTier1Runner } from './http_tier1_runner';

import type { PdsIdentity } from '../identity/provision_pds';
import type { Logger } from '../logger';
import type {
  ApprovalNotifier,
  OrchestratorAppView,
  ServiceInboundNotifier,
} from '@dina/brain';
import type { DinaMessage } from '@dina/core/runtime';
import type { DatabaseAdapter } from '@dina/core/storage';

export interface WireWorkflowPlaneOptions {
  /** Identity DB adapter from `initializeStorage`. */
  identityDB: DatabaseAdapter;
  /** PDS-provisioned identity — supplies `did:plc` + the relay/signing key. */
  pdsIdentity: PdsIdentity;
  /** Master-seed-derived root keypair — used to sign outbound D2D as ourselves. */
  signingKeypair: { publicKey: Uint8Array; privateKey: Uint8Array };
  /** Default MsgBox endpoint to fall back to when a peer's DID doc omits its own. */
  msgboxURL: string;
  /**
   * AppView URL — wires the public-service resolver so D2D to
   * discoverable service DIDs bypasses the contact gate.
   */
  appViewURL: string;
  /** Core router — used to build the InProcessTransport CoreClient. */
  coreRouter: CoreRouter;
  /**
   * Base URL of the co-located lite Brain. Core claims the reserved
   * `dina.local` Tier-1 lane in-process (it can't be claimed over HTTP) and
   * forwards each claimed capability execution to the Brain (which has the
   * LLM) via `makeHttpTier1Runner`.
   */
  brainUrl: string;
  /** Boot logger; receives structured events from sweepers + runtime. */
  logger: Logger;
}

export interface WiredWorkflowPlane {
  /**
   * Callback the MsgBox bootstrap passes as `onBypassedD2D`. Routes
   * inbound `service.query` / `service.response` D2D envelopes
   * (bypassed past the contact gate) into the local dispatcher,
   * which fans out to `ServiceHandler`. Without this wiring, inbound
   * service traffic is decrypted + validated then silently dropped.
   */
  onBypassedD2D(info: {
    senderDID: string;
    messageType: string;
    body: unknown;
  }): Promise<void>;
  /** Stop sweepers + runtime, deregister singletons. */
  dispose(): Promise<void>;
}

export function wireWorkflowPlane(options: WireWorkflowPlaneOptions): WiredWorkflowPlane {
  const {
    identityDB,
    pdsIdentity,
    signingKeypair,
    msgboxURL,
    appViewURL,
    coreRouter,
    brainUrl,
    logger,
  } = options;

  // Self-key resolver — every signed request that lands locally
  // (Response Bridge outbound, dina-agent calling /v1/workflow/...)
  // needs to verify against our pubkey. Without this, verifyRequest
  // treats the home node's own DID as unknown and 401s.
  registerPublicKeyResolver((did) =>
    did === pdsIdentity.did ? signingKeypair.publicKey : null,
  );
  // Register ourselves as a brain-class caller so signed internal
  // calls pass the authz allowlist.
  registerService(pdsIdentity.did, 'brain');

  // Outbound D2D — `makeSendD2D` shares the heuristic with mobile.
  // The AppView resolver bypasses the contact gate for cross-Dina
  // `service.query` egress to published service DIDs.
  const providerServiceResolver = new AppViewServiceResolver({ appViewURL });
  const sendD2D = makeSendD2D({
    senderDID: pdsIdentity.did,
    senderPrivateKey: signingKeypair.privateKey,
    defaultMsgboxEndpoint: msgboxURL,
    providerServiceResolver,
  });

  // Register the generic D2D sender so `POST /v1/msg/send` works on the
  // lite Core. Without this the route 503s ("D2D sender not wired") and a
  // lite Home Node — which is a *full* node, not just a service provider —
  // can only emit `service.*` traffic through the workflow plane, never a
  // plain `social.update` "Talk" message. Mobile wires the same callback in
  // `bootstrap.ts`; lite was missing it. Sharing the one `sendD2D` keeps a
  // single signed/gated/audited egress path (WS-first via the live MsgBox
  // session, HTTP `/forward` fallback) for every message type.
  setD2DSender(sendD2D);

  // issues.txt §1 — wire the durable-outbox drainer's re-delivery function
  // from the same identity, then start the periodic worker. The SQL repo +
  // crash recovery were installed in storage init; the drainer re-resolves
  // each queued recipient and re-seals per attempt. The timer is unref'd so
  // it never holds the process open.
  setOutboxRedeliverFn(
    makeOutboxRedeliver({
      senderDID: pdsIdentity.did,
      senderPrivateKey: signingKeypair.privateKey,
      defaultMsgboxEndpoint: msgboxURL,
      providerServiceResolver,
    }),
    pdsIdentity.did,
  );
  startOutboxDrainer();

  // ISVC-10 — the interactive-run pull loop, live. `wireRunPlaneNode` composes
  // the run drivers (pacer/sweeper/classify/completion) over the Tier-0 run
  // stores registered in storage init, using the SAME signed `sendD2D` egress
  // for its `service.query` pulls. The trust-boundary verifier (§6.2) resolves
  // the runtime issuer's Ed25519 key through the SHARED `resolveSender` — the
  // exact key the receive pipeline verified the D2D envelope against — so a run
  // message is admitted only if it is re-signed by the provider over its own
  // signed projection. `recoverOnBoot()` re-arms in-flight runs + re-shreds
  // terminal payloads; `start()` runs the four background loops (timers unref'd
  // inside the drivers). Its receive hook is consulted in `onBypassedD2D` below.
  const resolveRunSender = makeResolveSender({
    selfDID: pdsIdentity.did,
    selfPublicKey: signingKeypair.publicKey,
  });
  const runPlaneNode = wireRunPlaneNode({
    db: identityDB,
    sendD2D,
    resolveVerificationKey: async (issuerDid, _keyId, _issuedAtSec) => {
      // V1: the runtime issuer IS the provider (verifyRunMessage binds this), so
      // we resolve the provider's current signing key from its DID doc. `key_id`/
      // `issued_at` are plumbed for a future rotation-history-aware resolver; a
      // rotated-out key simply fails to resolve here → fail-closed.
      const { keys } = await resolveRunSender(issuerDid);
      return keys[0] ?? null;
    },
    log: (entry) => logger.info(entry, 'run-plane'),
  });
  runPlaneNode.plane.recoverOnBoot();
  runPlaneNode.start();

  // AppView client — discovery surface for service.query egress.
  // Lite operates as a provider node first, so the requester path is
  // less critical; stubbed to "no candidates" until a real AppView
  // search client is wired.
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

  const workflowRepository = new SQLiteWorkflowRepository(identityDB);
  const shared: SharedWiredWorkflowPlane = wireSharedWorkflowPlane({
    workflowRepository,
    sendD2D,
    runtime: {
      core: new InProcessTransport(coreRouter),
      appView,
      readConfig: (rkey?: string): ServiceConfig | null => getServiceConfig(rkey),
      deliver: async ({ text, event, task, details }) => {
        // Metadata-only: `text` is rendered user/service response content and
        // must never hit the logs (PII rule). Log its length, not its body.
        logger.info(
          {
            task_id: task.id,
            kind: task.kind,
            event_kind: event.event_kind,
            capability: details.capability,
            response_status: details.response_status,
            text_len: typeof text === 'string' ? text.length : 0,
          },
          'workflow event delivered',
        );
        // Split-lite chat delivery: the requester's chat thread lives in the
        // BRAIN process, but Core owns the workflow-event consumer (it must —
        // for provider-side approval dispatch). So Core forwards each
        // requester-side `service_query` delivery to the Brain, which grafts it
        // onto the chat thread via the shared `createServiceQueryDeliverer`
        // (one card per query, patched in place). Mobile does this in-process;
        // only the split stack needs the hop. Provider-side execution tasks
        // (`service_query_execution`) have no requester chat card here → skip.
        // Throw on failure so the consumer backs off + retries (the Brain
        // endpoint is idempotent by task id).
        if (task.kind !== 'service_query') return;
        const res = await fetch(`${brainUrl}/api/v1/chat/service-result`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, event, task, details }),
        });
        if (!res.ok) {
          throw new Error(
            `forward service-result to brain failed: ${res.status} ${await res.text().catch(() => '')}`,
          );
        }
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
    },
    logger: (entry) => logger.info(entry, 'workflow-plane'),
  });

  const dispatcher = shared.runtime.dispatcher;

  // Tier-1 ("My Dina answers") execution lane. Core owns the reserved
  // `dina.local` lane in-process — it's EXACT-match and can never be claimed
  // over HTTP (the workflow claim route 403s it by design), so the runner
  // lives here, next to the workflow repo. Core has no LLM, so its run
  // callback forwards each claimed capability execution to the co-located
  // Brain (`makeHttpTier1Runner`), which runs the SHARED
  // `makeTier1CapabilityRunner` runtime — the same code mobile runs
  // in-process. Inert until a `dina.local` task (an inbound service.query for
  // a My-Dina-lane capability) is claimed.
  const tier1Runner = new LocalDelegationRunner({
    repository: workflowRepository,
    workflowService: shared.workflowService,
    agentDID: pdsIdentity.did,
    runner: makeHttpTier1Runner({ brainUrl, logger }),
    // runnerFilter defaults to the reserved 'dina.local' lane.
  });
  tier1Runner.start();

  return {
    async onBypassedD2D(info): Promise<void> {
      // ISVC-10 — a run-correlated provider `service.response` (the reply to a
      // pacer-emitted `service.query`) is consumed by the run plane's trust
      // boundary FIRST. `handleServiceResponse` returns true iff the body was a
      // live run response (verified-and-ingested or rejected); either way it
      // must NOT fall through to the requester dispatcher, which would mint a
      // spurious workflow task. A non-run `service.response` returns false and
      // continues to the normal dispatcher path below.
      if (info.messageType === MsgTypeServiceResponse) {
        if (await runPlaneNode.handleServiceResponse(info.senderDID, info.body)) return;
      }
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
      // Stop the run-plane loops first so no pacer tick races the teardown, and
      // await tick quiescence before the shared stores are torn down (§13).
      await runPlaneNode.stop();
      // stop() only clears the claim timer; an in-flight Tier-1 capability
      // execution may still be running. flush() awaits it so we don't tear
      // down the workflow plane (shared.dispose) out from under a live run.
      tier1Runner.stop();
      await tier1Runner.flush();
      await shared.dispose();
    },
  };
}
