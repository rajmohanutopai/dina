import {
  ApprovalReconciler,
  D2DDispatcher,
  ServiceQueryOrchestrator,
  WorkflowEventConsumer,
  type OrchestratorAppView,
  type WorkflowEventDeliverer,
} from '@dina/brain';
import { ServiceQueryIngress, createProviderIngressSubmitter } from '@dina/core';

import type {
  ApprovalNotifier,
  CoreClient,
  ProviderIngressSubmitter,
  ServiceDirectResponder,
  ServiceInboundNotifier,
  ServiceReasoningSubmitter,
  WorkflowService,
} from '@dina/core';
import type { ServiceConfig, ServiceResponseStatus } from '@dina/protocol';

export interface HomeNodeServiceRuntimeOptions {
  /**
   * Returns the ServiceConfig for a listing. `rkey` selects WHICH listing
   * (multi-listing per DID — the rkey carried by a query's `service_uri`);
   * omitted ⇒ the default `self` listing. Forwarded verbatim to Core's
   * service-query ingress so a query for `…/route-7` executes against route-7.
   */
  readConfig: (rkey?: string) => ServiceConfig | null;
  directResponder: ServiceDirectResponder;
  deliver: WorkflowEventDeliverer;
  approvalNotifier?: ApprovalNotifier;
  /**
   * Optional: fires once per accepted inbound query (auto-execution or
   * approval task). Mobile wires this to the operator's chat thread so
   * they see who is asking what; server callers usually omit it.
   */
  inboundNotifier?: ServiceInboundNotifier;
  /** Optional shared connected-Brain execution strategy. */
  reasoningSubmitter?: ServiceReasoningSubmitter;
  /**
   * Optional override for the §11.2a plugin plane. Defaulted from the
   * node's `workflow`, so both boots get it without remembering to pass it —
   * the alternative is a plane that exists, validates, publishes, and then
   * answers `unavailable` on the one node where somebody forgot the line.
   * (It was read from the global once, which the phone installs only at
   * `start()`, after this runtime is built: the phone's plugin plane
   * answered `unavailable` to every query.) Tests pass their own.
   */
  providerIngressSubmitter?: ProviderIngressSubmitter;
  workflowEventIntervalMs?: number;
  approvalReconcileIntervalMs?: number;
  nowMsFn?: () => number;
  nowSecFn?: () => number;
  generateUUID?: () => string;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  logger?: (entry: Record<string, unknown>) => void;
  onWorkflowError?: (err: unknown) => void;
  onApprovalError?: (err: unknown) => void;
}

export interface BuildHomeNodeServiceRuntimeOptions extends HomeNodeServiceRuntimeOptions {
  core: CoreClient;
  /**
   * The node's workflow service. Core's ingress creates every task an
   * inbound query needs through it, and the plugin plane hands off through
   * it. Passed in, never read from the global: the phone installs the
   * global only at `start()`, after this runtime is built.
   */
  workflow: WorkflowService;
  appView: OrchestratorAppView;
}

export interface HomeNodeServiceRuntime {
  /** Core's ingress for admitted `service.query` traffic (A2A plan §4.2a). */
  ingress: ServiceQueryIngress;
  orchestrator: ServiceQueryOrchestrator;
  dispatcher: D2DDispatcher;
  events: WorkflowEventConsumer;
  approvals: ApprovalReconciler;
  start(): void;
  stop(): void;
  flush(): Promise<void>;
  runOnce(): Promise<void>;
  dispose(): Promise<void>;
}

export function buildHomeNodeServiceRuntime(
  options: BuildHomeNodeServiceRuntimeOptions,
): HomeNodeServiceRuntime {
  validateServiceRuntimeOptions(options);

  // §11.2a plugin plane. Resolved HERE rather than at each boot: the
  // capability is a property of the node, not a decision each composition
  // root should make differently.
  const workflow = options.workflow;
  const providerIngressSubmitter =
    options.providerIngressSubmitter ??
    createProviderIngressSubmitter({
      workflow,
      ...(options.nowMsFn !== undefined ? { nowMs: options.nowMsFn } : {}),
    });

  // The ingress is Core's (A2A plan §4.2a): Brain no longer validates an
  // admitted query or creates its tasks. This runtime only routes the
  // dispatcher's `service.query` and the consumer's `approved` event to it.
  const ingress = new ServiceQueryIngress({
    workflow,
    readConfig: options.readConfig,
    directResponder: options.directResponder,
    ...(options.approvalNotifier !== undefined ? { notifier: options.approvalNotifier } : {}),
    ...(options.inboundNotifier !== undefined ? { inboundNotifier: options.inboundNotifier } : {}),
    ...(options.reasoningSubmitter !== undefined
      ? { reasoningSubmitter: options.reasoningSubmitter }
      : {}),
    providerIngressSubmitter,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.nowSecFn !== undefined ? { nowSecFn: options.nowSecFn } : {}),
    ...(options.generateUUID !== undefined ? { generateUUID: options.generateUUID } : {}),
  });

  const dispatcher = new D2DDispatcher();
  const unregisterQuery = dispatcher.register('service.query', async (fromDID, body) => {
    await ingress.admitQuery(fromDID, body);
  });

  const orchestrator = new ServiceQueryOrchestrator({
    appViewClient: options.appView,
    coreClient: options.core,
  });

  const events = new WorkflowEventConsumer({
    coreClient: options.core,
    deliver: options.deliver,
    // Core re-reads the card and its payload itself, and starts nothing
    // unless the owner's approve moved it out of `pending_approval`.
    onApproved: async ({ task }) => {
      await ingress.executeApproved(task.id);
    },
    ...(options.workflowEventIntervalMs !== undefined
      ? { intervalMs: options.workflowEventIntervalMs }
      : {}),
    ...(options.setInterval !== undefined ? { setInterval: options.setInterval } : {}),
    ...(options.clearInterval !== undefined ? { clearInterval: options.clearInterval } : {}),
    ...(options.onWorkflowError !== undefined ? { onError: options.onWorkflowError } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });

  const approvals = new ApprovalReconciler({
    coreClient: options.core,
    ...(options.approvalReconcileIntervalMs !== undefined
      ? { intervalMs: options.approvalReconcileIntervalMs }
      : {}),
    ...(options.nowMsFn !== undefined ? { nowMsFn: options.nowMsFn } : {}),
    ...(options.setInterval !== undefined ? { setInterval: options.setInterval } : {}),
    ...(options.clearInterval !== undefined ? { clearInterval: options.clearInterval } : {}),
    ...(options.onApprovalError !== undefined ? { onError: options.onApprovalError } : {}),
  });

  let disposed = false;

  const runtime: HomeNodeServiceRuntime = {
    ingress,
    orchestrator,
    dispatcher,
    events,
    approvals,
    start(): void {
      if (disposed) throw new Error('HomeNodeServiceRuntime.start: runtime is disposed');
      events.start();
      approvals.start();
    },
    stop(): void {
      events.stop();
      approvals.stop();
    },
    async flush(): Promise<void> {
      await Promise.all([events.flush(), approvals.flush()]);
    },
    async runOnce(): Promise<void> {
      await Promise.all([events.runTick(), approvals.runTick()]);
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      runtime.stop();
      unregisterQuery();
      await runtime.flush();
    },
  };

  return runtime;
}

function validateServiceRuntimeOptions(options: BuildHomeNodeServiceRuntimeOptions): void {
  if (options.core === undefined) {
    throw new Error('buildHomeNodeServiceRuntime: core is required');
  }
  if (options.workflow === undefined) {
    throw new Error('buildHomeNodeServiceRuntime: workflow is required');
  }
  if (options.appView === undefined) {
    throw new Error('buildHomeNodeServiceRuntime: appView is required');
  }
  if (options.readConfig === undefined) {
    throw new Error('buildHomeNodeServiceRuntime: readConfig is required');
  }
  if (options.directResponder === undefined) {
    throw new Error('buildHomeNodeServiceRuntime: directResponder is required');
  }
  if (options.deliver === undefined) {
    throw new Error('buildHomeNodeServiceRuntime: deliver is required');
  }
}

/**
 * Build the `service.response` D2D body a `ServiceDirectResponder` sends.
 *
 * ONE builder, because there were two and they had already drifted: the lite
 * default spread its optional fields, mobile passed them through as
 * `undefined`. Harmless while both carried the same fields — and precisely
 * the shape in which a field added to one gets missed by the other. When
 * WS-4.6 added `result` (a §12.7 answer compiled Core produced with no task
 * behind it), forgetting it in either place would drop the answer silently:
 * the responder's TYPE would still be satisfied, so nothing would complain,
 * and the buyer would wait out its TTL for a reply that was already computed.
 *
 * Every root calls this, so a new field is added here once.
 */
export function toServiceResponseBody(body: {
  query_id: string;
  capability: string;
  /**
   * THE PROTOCOL'S TYPE. This was the THIRD hand-written copy of the same
   * union, and all three said `ok` — a value `ServiceResponseStatus` has never
   * contained and `validateServiceResponseBody` refuses. Copies of a contract
   * cannot notice when they stop matching it; the one place that decides is
   * `@dina/protocol`.
   */
  status: ServiceResponseStatus;
  error?: string;
  result?: unknown;
  ttl_seconds: number;
}): Record<string, unknown> {
  return {
    query_id: body.query_id,
    capability: body.capability,
    status: body.status,
    ...(body.error === undefined ? {} : { error: body.error }),
    ...(body.result === undefined ? {} : { result: body.result }),
    ...(body.ttl_seconds === undefined ? {} : { ttl_seconds: body.ttl_seconds }),
  };
}
