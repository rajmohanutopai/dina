/**
 * `wireWorkflowPlane` — shared composition of the Home Node's workflow
 * + service-query plane.
 *
 * This helper owns the chunk both mobile and the lite Core re-wire
 * identically: WorkflowService construction with the Response Bridge,
 * the three sweepers (TaskExpiry / LeaseExpiry / BridgePending), the
 * service-query runtime (handler + dispatcher + orchestrator + events
 * + approvals), and the registration of Core's D2D sender hooks
 * (`setD2DSender`, `setServiceQuerySender`, `setServiceRespondSender`).
 *
 * What's *not* in here, by design:
 *   - The repo, CoreClient, AppView client, and sendD2D — every form
 *     factor builds them differently. They flow in as options.
 *   - The `deliver`, `approvalNotifier`, `inboundNotifier` callbacks —
 *     mobile patches chat-lifecycle cards, lite logs structured
 *     events. Caller picks the implementation.
 *   - Mobile-specific surfaces (chat-orchestrator globals, ask
 *     coordinator, staging drain, local delegation runner) — those
 *     live in `apps/mobile/src/services/bootstrap.ts` and run
 *     alongside this helper, not inside it.
 *
 * Why this lives in `@dina/home-node`: this is the runtime-agnostic
 * core that any Home Node form factor needs. Keeping a single
 * implementation here means a bug fix to the response-bridge wiring
 * or a sweeper interval change lands in one place and both targets
 * pick it up.
 *
 * Both apps/mobile (`bootstrap.ts:createNode`) and apps/home-node-lite
 * (`workflow/wire_workflow_plane.ts`) used to ship near-identical
 * copies of this composition. Both now consume this module.
 */

import {
  BridgePendingSweeper,
  LeaseExpirySweeper,
  TaskExpirySweeper,
  WorkflowService,
  makeServiceResponseBridgeSender,
  setD2DSender,
  setServiceQuerySender,
  setServiceRespondSender,
  setWorkflowRepository,
  setWorkflowService,
  type ServiceQueryBody,
  type ServiceResponseBody,
  type WorkflowRepository,
} from '@dina/core/runtime';
import type { ResponseBridgeSender, ServiceQueryBridgeContext } from '@dina/core';
import {
  buildHomeNodeServiceRuntime,
  type BuildHomeNodeServiceRuntimeOptions,
  type HomeNodeServiceRuntime,
} from './service_runtime';
import { validateAgainstSchema } from '@dina/brain';

import type { SendD2D } from './send_d2d';

export interface WireWorkflowPlaneOptions {
  /**
   * Persistent workflow store. Mobile passes
   * `SQLiteWorkflowRepository(databaseAdapter)`; the lite Core does
   * the same against its identity SQLite handle; tests inject
   * `InMemoryWorkflowRepository()`.
   */
  workflowRepository: WorkflowRepository;
  /**
   * Outbound D2D sender — used by the Response Bridge to ship
   * `service.response` envelopes AND by `setD2DSender` /
   * `setServiceQuerySender` / `setServiceRespondSender` so Core's
   * route handlers find one common egress path. Build via
   * `makeSendD2D` (also in this package) unless your form factor
   * needs custom routing.
   */
  sendD2D: SendD2D;
  /**
   * Service runtime configuration. The caller supplies the
   * `CoreClient`, AppView client, config reader, plus the chat- or
   * log-bound `deliver` / `approvalNotifier` / `inboundNotifier`
   * callbacks. `rejectResponder` is optional — when omitted we
   * synthesize one over the same `sendD2D` egress path.
   */
  runtime: Omit<BuildHomeNodeServiceRuntimeOptions, 'rejectResponder'> & {
    rejectResponder?: BuildHomeNodeServiceRuntimeOptions['rejectResponder'];
  };
  /**
   * Optional hook fired AFTER the Response Bridge ships a successful
   * `service.response`. Mobile uses this to post a system message
   * into the operator's chat thread so they see evidence the reply
   * went out; the lite Core logs structured events.
   */
  onResponseBridgeSent?: (info: {
    to: string;
    capability: string;
    status: ServiceResponseBody['status'];
    error?: string;
  }) => void;
  /** Optional structured logger. Receives sweep + bridge telemetry. */
  logger?: (entry: Record<string, unknown>) => void;
  /** Override of `Date.now`. Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /** setInterval override for sweepers (tests inject fake timers). */
  setInterval?: BuildHomeNodeServiceRuntimeOptions['setInterval'];
  /** clearInterval override for sweepers. */
  clearInterval?: BuildHomeNodeServiceRuntimeOptions['clearInterval'];
}

export interface WiredWorkflowPlane {
  /** Constructed `WorkflowService`. Already registered globally. */
  workflowService: WorkflowService;
  /** Service runtime — caller may .start() / .stop() / .dispose() it directly. */
  runtime: HomeNodeServiceRuntime;
  /** Stop sweepers + runtime, deregister Core globals. */
  dispose(): Promise<void>;
}

/**
 * Compose the workflow plane. Idempotent within a single process —
 * call once per boot. Returns a `dispose()` the caller pushes onto
 * its teardown stack alongside MsgBox disconnect.
 *
 * Wiring order (mirrors the mobile + lite copies it replaces):
 *   A. Build the response-bridge sender (deflates `ServiceQuery
 *      BridgeContext` into a well-formed `service.response`).
 *   B. Build `WorkflowService` with the bridge attached.
 *   C. `setWorkflowRepository` + `setWorkflowService` — Core routes
 *      consult these via the module globals.
 *   D. Register Core's D2D sender hooks (3 setters, one shared
 *      `sendD2D`).
 *   E. Build the service runtime (handler / dispatcher / orchestrator
 *      / events / approvals) via the shared
 *      `buildHomeNodeServiceRuntime`.
 *   F. Start TaskExpirySweeper + LeaseExpirySweeper +
 *      BridgePendingSweeper.
 */
export function wireWorkflowPlane(opts: WireWorkflowPlaneOptions): WiredWorkflowPlane {
  const log =
    opts.logger ??
    (() => {
      /* silent */
    });

  // (A) Response Bridge.
  const responseBridgeSender: ResponseBridgeSender = makeServiceResponseBridgeSender({
    sendResponse: async (to, body) => {
      await opts.sendD2D(to, 'service.response', body as unknown as Record<string, unknown>);
      if (opts.onResponseBridgeSent !== undefined) {
        opts.onResponseBridgeSent({
          to,
          capability: body.capability,
          status: body.status,
          ...(body.error !== undefined ? { error: body.error } : {}),
        });
      }
    },
    validateResult: validateAgainstSchema,
    onMalformedResult: (ctx: ServiceQueryBridgeContext, err: Error) =>
      log({
        event: 'response_bridge.malformed_result',
        query_id: ctx.queryId,
        error: err.message,
      }),
    onSendError: (ctx: ServiceQueryBridgeContext, err: Error) =>
      log({
        event: 'response_bridge.send_failed',
        query_id: ctx.queryId,
        error: err.message,
      }),
    onResultValidationFailure: (ctx: ServiceQueryBridgeContext, error: string) =>
      log({
        event: 'response_bridge.result_validation_failed',
        query_id: ctx.queryId,
        capability: ctx.capability,
        error,
      }),
  });

  // (B) WorkflowService — repo + bridge + clock.
  const workflowService = new WorkflowService({
    repository: opts.workflowRepository,
    responseBridgeSender,
    ...(opts.nowMsFn !== undefined ? { nowMsFn: opts.nowMsFn } : {}),
  });

  // (C) Register globally — Core routes look up via the module
  //     singletons. Order matters: repo first so anything reaching
  //     for the repo during service construction finds it.
  setWorkflowRepository(opts.workflowRepository);
  setWorkflowService(workflowService);

  // (D) Core's D2D sender registry — all three setters point at the
  //     same `sendD2D` so we have ONE outbound code path, ONE set of
  //     gates, ONE audit trail.
  setD2DSender(async (to, type, body) => {
    await opts.sendD2D(to, type, body);
  });
  setServiceQuerySender(async (to, _type, body: ServiceQueryBody) => {
    await opts.sendD2D(to, 'service.query', body as unknown as Record<string, unknown>);
  });
  setServiceRespondSender(async (to, _type, body: ServiceResponseBody) => {
    await opts.sendD2D(to, 'service.response', body as unknown as Record<string, unknown>);
  });

  // (E) Service runtime — handler / dispatcher / orchestrator / events
  //     / approvals. Caller-supplied `deliver` + notifiers carry the
  //     mobile / lite delta. `rejectResponder` defaults to a passthrough
  //     over the same `sendD2D`.
  const rejectResponder: BuildHomeNodeServiceRuntimeOptions['rejectResponder'] =
    opts.runtime.rejectResponder ??
    (async (to, body) => {
      await opts.sendD2D(to, 'service.response', {
        query_id: body.query_id,
        capability: body.capability,
        status: body.status,
        ...(body.error !== undefined ? { error: body.error } : {}),
        ...(body.ttl_seconds !== undefined ? { ttl_seconds: body.ttl_seconds } : {}),
      });
    });

  const runtime = buildHomeNodeServiceRuntime({
    ...opts.runtime,
    rejectResponder,
    ...(opts.setInterval !== undefined ? { setInterval: opts.setInterval } : {}),
    ...(opts.clearInterval !== undefined ? { clearInterval: opts.clearInterval } : {}),
    ...(opts.nowMsFn !== undefined ? { nowMsFn: opts.nowMsFn } : {}),
  });
  runtime.start();

  // (F) Sweepers — task expiry, lease expiry, bridge retry.
  const taskExpiry = new TaskExpirySweeper({
    repository: opts.workflowRepository,
    ...(opts.nowMsFn !== undefined ? { nowMsFn: opts.nowMsFn } : {}),
    ...(opts.setInterval !== undefined ? { setInterval: opts.setInterval } : {}),
    ...(opts.clearInterval !== undefined ? { clearInterval: opts.clearInterval } : {}),
  });
  taskExpiry.start();

  const leaseExpiry = new LeaseExpirySweeper({
    repository: opts.workflowRepository,
    ...(opts.nowMsFn !== undefined ? { nowMsFn: opts.nowMsFn } : {}),
    ...(opts.setInterval !== undefined ? { setInterval: opts.setInterval } : {}),
    ...(opts.clearInterval !== undefined ? { clearInterval: opts.clearInterval } : {}),
  });
  leaseExpiry.start();

  const bridgeRetry = new BridgePendingSweeper({
    service: workflowService,
    ...(opts.setInterval !== undefined ? { setInterval: opts.setInterval } : {}),
    ...(opts.clearInterval !== undefined ? { clearInterval: opts.clearInterval } : {}),
  });
  bridgeRetry.start();

  log({ event: 'workflow_plane.wired' });

  return {
    workflowService,
    runtime,
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
