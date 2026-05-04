import {
  ApprovalReconciler,
  D2DDispatcher,
  ServiceHandler,
  ServiceQueryOrchestrator,
  WorkflowEventConsumer,
  type ApprovalNotifier,
  type OrchestratorAppView,
  type ServiceRejectResponder,
  type WorkflowEventDeliverer,
} from '@dina/brain';
import type { CoreClient } from '@dina/core';
import type { ServiceConfig } from '@dina/protocol';

export interface HomeNodeServiceRuntimeOptions {
  readConfig: () => ServiceConfig | null;
  rejectResponder: ServiceRejectResponder;
  deliver: WorkflowEventDeliverer;
  approvalNotifier?: ApprovalNotifier;
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

  const handler = new ServiceHandler({
    coreClient: options.core,
    readConfig: options.readConfig,
    rejectResponder: options.rejectResponder,
    ...(options.approvalNotifier !== undefined ? { notifier: options.approvalNotifier } : {}),
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
