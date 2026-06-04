import {
  buildAgenticAskPipeline,
  buildAgenticExecuteFn,
  buildPreFlightPersonaAllowed,
  createAskCoordinator,
  DEFAULT_ASK_SYSTEM_PROMPT,
  planAskRetrieval,
  runAskPreFlightRetrieval,
  registerCloudProvider as registerCloudEmbeddingProvider,
  ServiceQueryOrchestrator,
  type AgenticAskPipeline,
  type AppViewClient,
  type AskCoordinator,
  type AskCoordinatorCoreClient,
  type AskRetrievalFetchers,
  type BuildAgenticAskPipelineInput,
  type EmbeddingProvider,
  type InstalledPersona,
  type LLMProvider,
  type PreFlightRetrievalProvider,
  type PreFlightRetrievalResult,
  type RunPreFlightOptions,
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
  /**
   * Optional pre-flight retrieval planner — when both
   * `installedPersonas` (a callable returning the user's current
   * persona list with one-line descriptions) and `retrievalFetchers`
   * (vault + people-graph backends) are supplied, the runtime builds
   * a planner that runs once before every /ask and pre-fetches
   * cross-domain context.
   *
   * Either omit both (planner disabled — loop runs with tools only,
   * legacy behaviour) or supply both. Supplying only one is rejected
   * at runtime construction so misconfiguration is caught at boot.
   *
   * The fetchers are typically thin wrappers around the same backends
   * the agentic loop's vault_search / find_person tools use:
   *   - mobile boot:    `executeToolSearch` (in-process queryVault)
   *                     and `getPeopleRepository()` (in-process repo)
   *   - lite brain-srv: HTTP `CoreClient.vaultQuery` /
   *                     `CoreClient.peopleFindByName`
   */
  installedPersonas?: () => readonly InstalledPersona[];
  retrievalFetchers?: AskRetrievalFetchers;
  /**
   * Owner DID — the home node's own `did:plc:...`. Passed straight
   * through to `buildAgenticAskPipeline` so the per-ask persona_guard
   * can short-circuit for owner-on-app calls and gate dina-agent calls
   * (dina_details.md §13.4 + `feedback_user_vs_agent_persona_access`).
   * Omitting it falls back to "every caller untrusted" — fine for
   * tests, wrong for production. Mobile + home-node-lite brain-server
   * both pass it from their boot identity.
   */
  ownerDid?: string;
}

interface BuildHomeNodeAskRuntimeCommon extends HomeNodeAskRuntimeOptions {
  logger?: (entry: Record<string, unknown>) => void;
  /**
   * Workflow client for the `delegate_to_agent` tool. Optional —
   * a host that hasn't paired any agents simply omits it and the
   * agentic loop drops the delegation tool from the registry.
   */
  workflowClient?: BuildAgenticAskPipelineInput['workflowClient'];
  /**
   * How long the AskCoordinator waits for the agentic loop to
   * produce a terminal answer before falling back to async-resume
   * delivery (`kind: 'async'` from `handleAsk`).
   *
   * Mobile leaves this at the default (3 s) because the chat bridge
   * has an in-process listener that grafts the deferred answer into
   * the chat thread later. Home-node-lite's HTTP-shaped chat
   * endpoint is request/response — there's no long-lived listener
   * to deliver a deferred bubble — so the host bumps this to
   * something that comfortably covers the multi-turn Gemini loop
   * (typically 5–15 s).
   */
  fastPathMs?: number;
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

  // Pre-flight planner — opt-in via installedPersonas + retrievalFetchers.
  // We need an LLM call surface; the router lives inside the pipeline,
  // so build the pipeline first, then derive the planner callable
  // from `pipeline.router`. The planner is registered after pipeline
  // construction; both `makeAgenticAskHandler` consumers and the
  // coordinator's `buildAgenticExecuteFn` receive the same
  // `preFlight` callable below.
  const plannerEnabled =
    options.installedPersonas !== undefined &&
    options.retrievalFetchers !== undefined;
  if (
    (options.installedPersonas !== undefined) !==
    (options.retrievalFetchers !== undefined)
  ) {
    throw new Error(
      'buildHomeNodeAskRuntime: installedPersonas and retrievalFetchers must be provided together',
    );
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
    ...(options.ownerDid !== undefined && options.ownerDid !== ''
      ? { ownerDid: options.ownerDid }
      : {}),
  });
  const systemPrompt = options.systemPrompt ?? DEFAULT_ASK_SYSTEM_PROMPT;

  // Build the pre-flight planner callable now that `pipeline.router`
  // exists. The planner LLM call goes through the same router as the
  // rest of the brain — same PII scrub, same consent gate, same tier
  // selection (intent_classification → lite tier).
  let preFlight: PreFlightRetrievalProvider | undefined;
  if (plannerEnabled) {
    const installedPersonas = options.installedPersonas!;
    const fetchers = options.retrievalFetchers!;
    const ownerDid = options.ownerDid;
    const router = pipeline.router;
    const llmCall = async (system: string, prompt: string): Promise<string> => {
      try {
        const response = await router.chat({
          taskType: 'intent_classification',
          messages: [{ role: 'user', content: prompt }],
          ...(system !== '' ? { systemPrompt: system } : {}),
          temperature: 0.1,
          maxTokens: 512,
        });
        return response.content;
      } catch {
        return '';
      }
    };
    preFlight = async (question, ctx): Promise<PreFlightRetrievalResult | null> => {
      try {
        const personas = installedPersonas();
        const plan = await planAskRetrieval(question, { llmCall, personas });
        // F-AGENT-VAULT-GATE round-3: gate the planner's pre-fetch the
        // same way the on-demand vault tool is gated. The coordinator
        // always supplies requesterDid; when it's present we build the
        // owner/tier/session-aware filter (owner → allow-all; external
        // agent → skip sensitive/locked). The legacy handler path has no
        // DID → no filter → allow-all (unchanged).
        const requesterDid = ctx?.requesterDid;
        const runOpts: RunPreFlightOptions | undefined =
          requesterDid !== undefined && requesterDid !== ''
            ? {
                personaAllowed: buildPreFlightPersonaAllowed({
                  requesterDid,
                  ...(ownerDid !== undefined && ownerDid !== '' ? { ownerDid } : {}),
                  ...(ctx?.sessionId !== undefined && ctx.sessionId !== ''
                    ? { sessionId: ctx.sessionId }
                    : {}),
                }),
              }
            : undefined;
        return await runAskPreFlightRetrieval(plan, fetchers, runOpts);
      } catch {
        return null;
      }
    };
  }

  const coordinator = createAskCoordinator({
    pipeline,
    coreClient: options.core,
    executeFn: buildAgenticExecuteFn({
      pipeline,
      systemPrompt,
      ...(preFlight !== undefined ? { preFlight } : {}),
    }),
    systemPrompt,
    ...(options.fastPathMs !== undefined ? { fastPathMs: options.fastPathMs } : {}),
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
