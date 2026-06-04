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
  SQLiteWorkflowRepository,
  getServiceConfig,
  registerPublicKeyResolver,
  registerService,
  setOutboxRedeliverFn,
  startOutboxDrainer,
  type CoreRouter,
  type ServiceConfig,
} from '@dina/core';
import type { DinaMessage } from '@dina/core/runtime';
// `setD2DSender` registers the generic D2D egress callback for the
// `/v1/msg/send` route. It lives on the runtime subpath (route module),
// not the main `@dina/core` barrel.
import { setD2DSender } from '@dina/core/runtime';
import {
  makeSendD2D,
  makeOutboxRedeliver,
  wireWorkflowPlane as wireSharedWorkflowPlane,
  type WiredWorkflowPlane as SharedWiredWorkflowPlane,
} from '@dina/home-node';
import type {
  ApprovalNotifier,
  OrchestratorAppView,
  ServiceInboundNotifier,
} from '@dina/brain';
import type { DatabaseAdapter } from '@dina/core/storage';

import type { Logger } from '../logger';
import type { PdsIdentity } from '../identity/provision_pds';

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
  const { identityDB, pdsIdentity, signingKeypair, msgboxURL, appViewURL, coreRouter, logger } =
    options;

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

  const shared: SharedWiredWorkflowPlane = wireSharedWorkflowPlane({
    workflowRepository: new SQLiteWorkflowRepository(identityDB),
    sendD2D,
    runtime: {
      core: new InProcessTransport(coreRouter),
      appView,
      readConfig: (rkey?: string): ServiceConfig | null => getServiceConfig(rkey),
      deliver: ({ text, event, task, details }) => {
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
    },
    logger: (entry) => logger.info(entry, 'workflow-plane'),
  });

  const dispatcher = shared.runtime.dispatcher;

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
    dispose: shared.dispose,
  };
}
