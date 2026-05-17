import {
  buildAgenticAskPipeline,
  buildAgenticExecuteFn,
  createAskCoordinator,
  DEFAULT_ASK_SYSTEM_PROMPT,
  registerCloudProvider as registerCloudEmbeddingProvider,
  ServiceQueryOrchestrator,
  type AgenticAskPipeline,
  type AppViewClient,
  type AskCoordinator,
  type AskCoordinatorCoreClient,
  type BuildAgenticAskPipelineInput,
  type EmbeddingProvider,
  type LLMProvider,
  type ProviderName,
} from '@dina/brain';
import {
  type CoreClient,
} from '@dina/core';

export interface HomeNodeAskRuntimeOptions {
  llm: LLMProvider;
  providerName: ProviderName;
  systemPrompt?: string;
  cloudConsentGranted?: boolean;
  sensitivePersonas?: readonly string[];
  /**
   * Optional embedding provider — when supplied, registered via the
   * shared `registerCloudProvider` so the enrichment pipeline embeds
   * stored items and `gatherVaultContext` can switch to hybrid
   * (FTS5 + cosine) retrieval. Wiring lives here so mobile boot and
   * the home-node-lite brain-server share one registration site
   * instead of duplicating it.
   *
   * Without an embedding provider the system falls back to FTS5-only
   * retrieval — query expansion still bridges most semantic gaps,
   * but rare phrasings that share no tokens with prior facts won't
   * surface.
   */
  embedding?: {
    /** Human-readable model name recorded on each embedding for
     *  provenance — surfaces in `embedding_meta.model`. */
    name: string;
    generate: EmbeddingProvider;
  };
}

interface BuildHomeNodeAskRuntimeCommon extends HomeNodeAskRuntimeOptions {
  logger?: (entry: Record<string, unknown>) => void;
  /**
   * Workflow client for the `delegate_to_agent` tool. Optional —
   * a host that hasn't paired any agents simply omits it and the
   * agentic loop drops the delegation tool from the registry.
   */
  workflowClient?: BuildAgenticAskPipelineInput['workflowClient'];
}

/**
 * Server-style invocation: caller hands us a full `CoreClient` and
 * `AppViewClient`, and we build a fresh `ServiceQueryOrchestrator`
 * internally. Used by home-node-lite brain-server, where the runtime
 * is composed once at boot and outlives the process.
 */
export interface BuildHomeNodeAskRuntimeServerOptions extends BuildHomeNodeAskRuntimeCommon {
  core: CoreClient;
  appView: AppViewClient;
  orchestratorHandle?: undefined;
}

/**
 * Mobile-style invocation: caller owns the `ServiceQueryOrchestrator`
 * inside its `DinaNode` lifecycle (so D2D dispatch and the LLM tool
 * share one instance) and supplies a lazy handle that proxies to that
 * owner. The `core` and `appView` handles only need the narrower
 * pipeline tool-surfaces — orchestrator construction is skipped.
 */
export interface BuildHomeNodeAskRuntimeWithHandleOptions extends BuildHomeNodeAskRuntimeCommon {
  core: BuildAgenticAskPipelineInput['coreClient'] & AskCoordinatorCoreClient;
  appView: BuildAgenticAskPipelineInput['appViewClient'];
  orchestratorHandle: BuildAgenticAskPipelineInput['orchestratorHandle'];
}

export type BuildHomeNodeAskRuntimeOptions =
  | BuildHomeNodeAskRuntimeServerOptions
  | BuildHomeNodeAskRuntimeWithHandleOptions;

export interface HomeNodeAskRuntime {
  coordinator: AskCoordinator;
  /** The constructed orchestrator. `null` when the caller injected an
   * `orchestratorHandle`; otherwise the freshly-built instance the
   * pipeline is using internally. */
  orchestrator: ServiceQueryOrchestrator | null;
  /** Full pipeline bundle for callers that wire additional surfaces
   * (mobile chat tools, `makeAgenticAskHandler` direct registration). */
  pipeline: AgenticAskPipeline;
}

export function buildHomeNodeAskRuntime(
  options: BuildHomeNodeAskRuntimeOptions,
): HomeNodeAskRuntime {
  validateAskRuntimeOptions(options);

  // Register the embedding provider before anything else so the
  // enrichment pipeline + vault context retrieval see a live
  // provider on the very first /remember. Order matters — the
  // pipeline reads `isEmbeddingAvailable()` at item-enqueue time.
  if (options.embedding !== undefined) {
    registerCloudEmbeddingProvider(options.embedding.name, options.embedding.generate);
  }

  // When the caller injects a handle (mobile's lazy proxy to a
  // node-owned orchestrator), use it directly and skip constructing
  // our own. Otherwise stand up a fresh orchestrator and use it as
  // the handle for the pipeline's query_service tool.
  let orchestrator: ServiceQueryOrchestrator | null;
  let orchestratorHandle: BuildAgenticAskPipelineInput['orchestratorHandle'];
  if (options.orchestratorHandle !== undefined) {
    orchestrator = null;
    orchestratorHandle = options.orchestratorHandle;
  } else {
    orchestrator = new ServiceQueryOrchestrator({
      appViewClient: options.appView,
      coreClient: options.core,
    });
    orchestratorHandle = orchestrator;
  }

  const pipeline = buildAgenticAskPipeline({
    llm: options.llm,
    providerName: options.providerName,
    appViewClient: options.appView,
    orchestratorHandle,
    coreClient: options.core,
    cloudConsentGranted: options.cloudConsentGranted ?? true,
    ...(options.workflowClient !== undefined
      ? { workflowClient: options.workflowClient }
      : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.sensitivePersonas !== undefined
      ? { sensitivePersonas: options.sensitivePersonas }
      : {}),
  });
  const systemPrompt = options.systemPrompt ?? DEFAULT_ASK_SYSTEM_PROMPT;
  const coordinator = createAskCoordinator({
    pipeline,
    coreClient: options.core,
    executeFn: buildAgenticExecuteFn({ pipeline, systemPrompt }),
    systemPrompt,
  });
  return { coordinator, orchestrator, pipeline };
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
