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

import { validateAgainstSchema } from '@dina/brain';
import { appendNotification } from '@dina/brain/notifications';
import {
  BridgePendingSweeper,
  LeaseExpirySweeper,
  TaskExpirySweeper,
  WatchPollSweeper,
  WatchService,
  WorkflowService,
  defaultPluginCompletionHandler,
  getWorkflowService,
  getPluginHostRuntime,
  getPluginInstallRepository,
  buildWatchPollHandler,
  makeServiceResponseBridgeSender,
  setD2DSender,
  setServiceQuerySender,
  setServiceRespondSender,
  setWatchService,
  setWorkflowRepository,
  setWorkflowService,
  transformInboundOrderResult,
  type ServiceQueryBody,
  type ServiceResponseBody,
  type WorkflowRepository,
} from '@dina/core/runtime';

import {
  buildHomeNodeServiceRuntime,
  toServiceResponseBody,
  type BuildHomeNodeServiceRuntimeOptions,
  type HomeNodeServiceRuntime,
} from './service_runtime';

import type { SendD2D } from './send_d2d';
import type { ResponseBridgeSender, ServiceQueryBridgeContext, WorkflowTask } from '@dina/core';

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
   * callbacks. `directResponder` is optional — when omitted we
   * synthesize one over the same `sendD2D` egress path.
   */
  runtime: Omit<BuildHomeNodeServiceRuntimeOptions, 'directResponder'> & {
    directResponder?: BuildHomeNodeServiceRuntimeOptions['directResponder'];
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
  /** Release any reasoning session reservation after deadline expiry. */
  onTaskExpired?: (task: WorkflowTask) => void;
  /** Release any reasoning session reservation after claim lease loss. */
  onLeaseReverted?: (task: WorkflowTask) => void;
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
  /**
   * The exact service-response egress used by delegation completion. Other
   * Core-owned executors, such as connected-Brain service reasoning, must reuse
   * this sender rather than inventing a second D2D response path.
   */
  responseBridgeSender: ResponseBridgeSender;
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
    // §9.9 — a completed `submit_order` is answered with the acknowledgement
    // Core signed, not the runner's JSON. Passed here rather than at each boot
    // so neither can forget it; the transform answers `passthrough` for every
    // capability it does not own, and `withhold` when it owns the answer and
    // cannot record one.
    ingressResultTransformer: transformInboundOrderResult,
    // A withheld answer is the one bridge outcome with no other trace: no
    // stash, no send, nothing for the sweeper. Without this line an operator
    // sees orders lapse and nothing says why.
    onIngressResultWithheld: (args) =>
      log({
        event: 'response_bridge.result_withheld',
        task_id: args.taskId,
        capability: args.capability,
        reason: args.reason,
      }),
    // §3.4 — a plugin runner asks for a host operation by COMPLETING its claim
    // with a typed proposal. Composed through the ONE factory both roots call,
    // for the reason the admission sweep taught: a handler assembled separately
    // at each root drifts, and the half that drifts is the one nobody tests.
    pluginCompletionHandler: defaultPluginCompletionHandler({
      hostRuntime: () => getPluginHostRuntime(),
      installs: () => getPluginInstallRepository(),
      // Resolved per call through the global the plane registers a few lines
      // below: the service is still being constructed on this line, and the
      // REPOSITORY's `create` is a different shape (a whole row) from the
      // service's (a request Core completes).
      workflow: () => getWorkflowService(),
      onError: (err: unknown) =>
        log({
          event: 'plugin.host_operation_error',
          error: err instanceof Error ? err.message : String(err),
        }),
      onOutcome: (outcome: { kind: string }) =>
        log({ event: 'plugin.host_operation', kind: outcome.kind }),
    }),
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
  //     mobile / lite delta. `directResponder` defaults to a passthrough
  //     over the same `sendD2D`.
  const directResponder: BuildHomeNodeServiceRuntimeOptions['directResponder'] =
    opts.runtime.directResponder ??
    (async (to, body) => {
      await opts.sendD2D(to, 'service.response', toServiceResponseBody(body));
    });

  const runtime = buildHomeNodeServiceRuntime({
    ...opts.runtime,
    directResponder,
    ...(opts.setInterval !== undefined ? { setInterval: opts.setInterval } : {}),
    ...(opts.clearInterval !== undefined ? { clearInterval: opts.clearInterval } : {}),
    ...(opts.nowMsFn !== undefined ? { nowMsFn: opts.nowMsFn } : {}),
  });
  runtime.start();

  // (F) Sweepers — task expiry, lease expiry, bridge retry.
  const taskExpiry = new TaskExpirySweeper({
    repository: opts.workflowRepository,
    ...(opts.onTaskExpired === undefined ? {} : { onExpired: opts.onTaskExpired }),
    ...(opts.nowMsFn !== undefined ? { nowMsFn: opts.nowMsFn } : {}),
    ...(opts.setInterval !== undefined ? { setInterval: opts.setInterval } : {}),
    ...(opts.clearInterval !== undefined ? { clearInterval: opts.clearInterval } : {}),
  });
  taskExpiry.start();

  const leaseExpiry = new LeaseExpirySweeper({
    repository: opts.workflowRepository,
    ...(opts.onLeaseReverted === undefined ? {} : { onReverted: opts.onLeaseReverted }),
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

  // (G) Poll-mode watches (PSVC-0). Register the WatchService globally so the
  //     subscription/watch surfaces can create + steer watches, and start the
  //     WatchPollSweeper — it fires each due watch as an ordinary
  //     `service.query` through the CoreClient requester lane (the same
  //     correlation + response-bridge path everything else uses).
  const watchService = new WatchService({
    repository: opts.workflowRepository,
    ...(opts.nowMsFn !== undefined ? { nowMsFn: opts.nowMsFn } : {}),
  });
  setWatchService(watchService);
  const watchPoll = new WatchPollSweeper({
    repository: opts.workflowRepository,
    onPoll: buildWatchPollHandler(opts.runtime.core),
    // R5-06 — a malformed watch is PAUSED by the sweeper (so it can't starve the
    // due queue); this makes that owner-visible: an idempotent inbox entry
    // explaining the pause. On mobile the append is live (same VM); in the split
    // server's Core process the dual-write lands in the durable log, which the
    // browser inbox picks up on hydrate/reconnect. Metadata only — the corrupt
    // payload itself is never included.
    onMalformed: (task) => {
      appendNotification({
        kind: 'push',
        title: 'Subscription paused',
        body: 'A subscription could not be read and was paused. Cancel it and create it again.',
        id: `watch-malformed-${task.id}`,
        sourceId: task.id,
        deepLink: 'dina://subscriptions',
      });
    },
    onError: (err) => log({ event: 'watch_poll.error', error: String(err) }),
    ...(opts.nowMsFn !== undefined ? { nowMsFn: opts.nowMsFn } : {}),
    ...(opts.setInterval !== undefined ? { setInterval: opts.setInterval } : {}),
    ...(opts.clearInterval !== undefined ? { clearInterval: opts.clearInterval } : {}),
  });
  watchPoll.start();

  // (H) The commerce background ticks are NOT wired here.
  //
  // Admission recovery (§9.9 step 3) used to be, with a comment claiming both
  // boots got it from one place. They did not: the phone composes its own
  // background work and never calls this plane, so no reservation on a phone
  // ever timed out and no quote capacity was ever refunded there. The comment
  // described the intent and the wiring did something else.
  //
  // Both commerce ticks now live in `startCommerceSweepers` (@dina/core),
  // called once by each composition root — see `boundary.test.ts`, which
  // fails if either root stops calling it.

  log({ event: 'workflow_plane.wired' });

  return {
    workflowService,
    responseBridgeSender,
    runtime,
    async dispose(): Promise<void> {
      taskExpiry.stop();
      leaseExpiry.stop();
      bridgeRetry.stop();
      watchPoll.stop();
      // R2-06 — await the single-flight sweeper's in-flight tick BEFORE tearing the
      // runtime + clearing shared globals, so no watch poll/send keeps running (and
      // possibly reschedules against dismantled state) after teardown (81B-08).
      await watchPoll.flush();
      await runtime.dispose();
      setWatchService(null);
      setWorkflowService(null);
      setWorkflowRepository(null);
      setD2DSender(null);
      setServiceQuerySender(null);
      setServiceRespondSender(null);
    },
  };
}
