import {
  buildAgenticAskPipeline,
  buildAgenticExecuteFn,
  createAskCoordinator,
  DEFAULT_ASK_SYSTEM_PROMPT,
  ServiceQueryOrchestrator,
  type AppViewClient,
  type AskCoordinator,
  type LLMProvider,
  type ProviderName,
} from '@dina/brain';
import {
  ApprovalManager,
  type CoreClient,
} from '@dina/core';

export interface HomeNodeAskRuntimeOptions {
  llm: LLMProvider;
  providerName: ProviderName;
  approvalManager?: ApprovalManager;
  systemPrompt?: string;
  cloudConsentGranted?: boolean;
  sensitivePersonas?: readonly string[];
}

export interface BuildHomeNodeAskRuntimeOptions extends HomeNodeAskRuntimeOptions {
  core: CoreClient;
  appView: AppViewClient;
  logger?: (entry: Record<string, unknown>) => void;
}

export interface HomeNodeAskRuntime {
  coordinator: AskCoordinator;
  approvalManager: ApprovalManager;
  orchestrator: ServiceQueryOrchestrator;
}

export function buildHomeNodeAskRuntime(
  options: BuildHomeNodeAskRuntimeOptions,
): HomeNodeAskRuntime {
  validateAskRuntimeOptions(options);
  const approvalManager = options.approvalManager ?? new ApprovalManager();
  const orchestrator = new ServiceQueryOrchestrator({
    appViewClient: options.appView,
    coreClient: options.core,
  });
  const pipeline = buildAgenticAskPipeline({
    llm: options.llm,
    providerName: options.providerName,
    appViewClient: options.appView,
    orchestratorHandle: orchestrator,
    coreClient: options.core,
    approvalManager,
    cloudConsentGranted: options.cloudConsentGranted ?? true,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.sensitivePersonas !== undefined
      ? { sensitivePersonas: options.sensitivePersonas }
      : {}),
  });
  const systemPrompt = options.systemPrompt ?? DEFAULT_ASK_SYSTEM_PROMPT;
  const coordinator = createAskCoordinator({
    pipeline,
    approvalManager,
    executeFn: buildAgenticExecuteFn({ pipeline, systemPrompt }),
    systemPrompt,
  });
  return { coordinator, approvalManager, orchestrator };
}

function validateAskRuntimeOptions(options: BuildHomeNodeAskRuntimeOptions): void {
  if (options.core === undefined) {
    throw new Error('buildHomeNodeAskRuntime: core is required');
  }
  if (options.appView === undefined) {
    throw new Error('buildHomeNodeAskRuntime: appView is required');
  }
  if (options.llm === undefined) {
    throw new Error('buildHomeNodeAskRuntime: llm is required');
  }
  if (options.providerName === undefined) {
    throw new Error('buildHomeNodeAskRuntime: providerName is required');
  }
}
