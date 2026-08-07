import {
  ApprovalReconciler,
  D2DDispatcher,
  ServiceHandler,
  ServiceQueryOrchestrator,
  WorkflowEventConsumer,
  type ApprovalNotifier,
  type OrchestratorAppView,
  type ServiceInboundNotifier,
  type ServiceRejectResponder,
  type WorkflowEventDeliverer,
} from '@dina/brain';
import { createProviderIngressSubmitter, getWorkflowService } from '@dina/core';

import type { CoreClient, ProviderIngressSubmitter, ServiceReasoningSubmitter } from '@dina/core';
import type { ServiceConfig } from '@dina/protocol';

export interface HomeNodeServiceRuntimeOptions {
  /**
   * Returns the ServiceConfig for a listing. `rkey` selects WHICH listing
   * (multi-listing per DID — the rkey carried by a query's `service_uri`);
   * omitted ⇒ the default `self` listing. Forwarded verbatim to the
   * ServiceHandler so a query for `…/route-7` executes against route-7.
   */
  readConfig: (rkey?: string) => ServiceConfig | null;
  rejectResponder: ServiceRejectResponder;
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
   * Optional override for the §11.2a plugin plane. Defaulted from the wired
   * `WorkflowService`, so both boots get it without remembering to pass it —
   * the alternative is a plane that exists, validates, publishes, and then
   * answers `unavailable` on the one node where somebody forgot the line.
   * Tests pass their own; a node with no workflow service gets null and
   * plugin-bound capabilities refuse.
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
  appView: OrchestratorAppView;
}

export interface HomeNodeServiceRuntime {
  handler: ServiceHandler;
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
  // capability is a property of the node (does it run a workflow service?),
  // not a decision each composition root should make differently.
  const workflow = getWorkflowService();
  const providerIngressSubmitter =
    options.providerIngressSubmitter ??
    (workflow === null
      ? null
      : createProviderIngressSubmitter({
          workflow,
          ...(options.nowMsFn !== undefined ? { nowMs: options.nowMsFn } : {}),
        }));

  const handler = new ServiceHandler({
    coreClient: options.core,
    readConfig: options.readConfig,
    rejectResponder: options.rejectResponder,
    ...(options.approvalNotifier !== undefined ? { notifier: options.approvalNotifier } : {}),
    ...(options.inboundNotifier !== undefined ? { inboundNotifier: options.inboundNotifier } : {}),
    ...(options.reasoningSubmitter !== undefined
      ? { reasoningSubmitter: options.reasoningSubmitter }
      : {}),
    ...(providerIngressSubmitter === null ? {} : { providerIngressSubmitter }),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.nowSecFn !== undefined ? { nowSecFn: options.nowSecFn } : {}),
    ...(options.generateUUID !== undefined ? { generateUUID: options.generateUUID } : {}),
  });

  const dispatcher = new D2DDispatcher();
  const unregisterQuery = dispatcher.register('service.query', async (fromDID, body) => {
    await handler.handleQuery(fromDID, body);
  });

  const orchestrator = new ServiceQueryOrchestrator({
    appViewClient: options.appView,
    coreClient: options.core,
  });

  const events = new WorkflowEventConsumer({
    coreClient: options.core,
    deliver: options.deliver,
    onApproved: async ({ task, payload }) => {
      await handler.executeAndRespond(task.id, payload);
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
    handler,
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
  if (options.appView === undefined) {
    throw new Error('buildHomeNodeServiceRuntime: appView is required');
  }
  if (options.readConfig === undefined) {
    throw new Error('buildHomeNodeServiceRuntime: readConfig is required');
  }
  if (options.rejectResponder === undefined) {
    throw new Error('buildHomeNodeServiceRuntime: rejectResponder is required');
  }
  if (options.deliver === undefined) {
    throw new Error('buildHomeNodeServiceRuntime: deliver is required');
  }
}
