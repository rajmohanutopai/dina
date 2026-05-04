/**
 * Brain-side agentic-`/ask` pipeline composition.
 *
 * Assembles the full Python-parity `/ask` stack from an already-resolved
 * `LLMProvider` + AppView + Core handles:
 *
 *   1. Central `LLMRouter` (PII scrub + cloud-consent gate + per-task
 *      tier selection) wrapping the caller's provider.
 *   2. `RoutedLLMProvider(taskType: 'reason')` — the surface the
 *      agentic loop consumes.
 *   3. Intent classifier — runs on every /ask before the loop, emits
 *      the routing hint that `formatIntentHintBlock` appends to the
 *      system prompt. Fail-open.
 *   4. Guard-scan post-processor (Laws 1 + 4) under `taskType: 'guard_scan'`.
 *   5. Post-publish refinement LLMs (reminder planner, identity
 *      extractor) registered on the shared router.
 *   6. Tool registry — 5 vault tools + geocode + trust-network +
 *      search-provider-services + query-service + find-preferred-provider.
 *
 * **Why this lives in `packages/brain/`**: everything here is
 * Brain-scoped logic that both the mobile app (RN / Expo) and the
 * future home-node-lite brain-server (Node / Fastify) need. The only
 * runtime differences between the two build targets are upstream of
 * this call:
 *
 *   - WHERE the `LLMProvider` comes from (mobile: keychain + AI-SDK;
 *     server: env var + AI-SDK / `@google/genai`).
 *   - WHERE the AppView client comes from (mobile: BYOK or stub;
 *     server: configured URL + HTTP client).
 *   - HOW `orchestratorHandle` / `coreClient` are resolved (mobile:
 *     lazy module-globals populated by `createNode`; server: direct
 *     HttpCoreTransport).
 *
 * Callers do the target-specific resolution and hand this builder
 * fully-resolved handles. Returned bundle feeds `makeAgenticAskHandler`
 * verbatim.
 *
 * Source: task 1.32 / cleanup #490 (mobile ↔ home-node-lite drift
 * prevention — extracted from `apps/mobile/src/services/boot_capabilities.ts`
 * tryBuildAgenticAsk).
 */

import { getMemoryService } from '@dina/core';
import { LLMRouter, RoutedLLMProvider } from '../llm/router_dispatch';
import { registerPersonLinkProvider } from '../person/linking';
import { registerIdentityExtractor } from '../pipeline/identity_extraction';
import { registerReminderLLM } from '../pipeline/reminder_planner';
import {
  createGeocodeTool,
  createSearchProviderServicesTool,
  createQueryServiceTool,
  createFindPreferredProviderTool,
} from '../reasoning/bus_driver_tools';
import { createGuardScanner } from '../reasoning/guard_scanner';
import { IntentClassifier } from '../reasoning/intent_classifier';
import { createClassifyIntentTool } from '../reasoning/classify_intent_tool';
import { createDraftReviewTool } from '../reasoning/draft_review_tool';
import { createDelegateToAgentTool } from '../reasoning/delegate_agent_tool';
import { ToolRegistry } from '../reasoning/tool_registry';
import { createSearchTrustNetworkTool } from '../reasoning/trust_tool';
import {
  createVaultSearchTool,
  createListPersonasTool,
  createBrowseVaultTool,
  createGetFullContentTool,
  type VaultPersonaGuard,
} from '../reasoning/vault_tool';

import { createPersonaGuard } from './persona_guard';

import type { LLMProvider } from '../llm/adapters/provider';
import type { ProviderName , TaskType } from '../llm/router';
import type { AgenticAskHandlerOptions } from '../reasoning/ask_handler';
import type { ApprovalManager } from '@dina/core';


/**
 * Input: fully-resolved target-agnostic handles. The caller
 * (mobile boot or home-node-lite brain-server) constructs these using
 * its own DI before invoking this builder.
 */
export interface BuildAgenticAskPipelineInput {
  /** Already-instantiated LLM provider (mobile picks via keychain, server via env). */
  llm: LLMProvider;
  /** Provider name for `RoutedLLMProvider` labels + the router's provider map key. */
  providerName: ProviderName;
  /** AppView client handle — any object satisfying the tool-surface subsets. */
  appViewClient: Parameters<typeof createSearchProviderServicesTool>[0]['appViewClient'] &
    Parameters<typeof createSearchTrustNetworkTool>[0]['appViewClient'] &
    Parameters<typeof createQueryServiceTool>[0]['appViewClient'] &
    Parameters<typeof createFindPreferredProviderTool>[0]['appViewClient'];
  /** Lazy orchestrator handle for `query_service` — callers wire a thunk-backed
   *  proxy when the orchestrator is constructed later in the boot sequence. */
  orchestratorHandle: Parameters<typeof createQueryServiceTool>[0]['orchestrator'];
  /** Lazy core client for `find_preferred_provider`. */
  coreClient: Parameters<typeof createFindPreferredProviderTool>[0]['core'];
  /**
   * Workflow surface for `delegate_to_agent` — narrower than the full
   * `BrainCoreClient` so a host that hasn't paired any agents can omit
   * the tool by passing `undefined`. When omitted the agentic loop
   * simply lacks the delegation tool; the rest of the read-path tools
   * still work.
   */
  workflowClient?: Parameters<typeof createDelegateToAgentTool>[0]['core'];
  /** Structured-log sink — propagated to the WM-BRAIN-06d telemetry path. */
  logger?: (entry: Record<string, unknown>) => void;
  /**
   * Sensitive personas the cloud-consent gate guards. Defaults match
   * the Four Laws discrimination: content tagged with these personas
   * never leaves the device without explicit consent.
   */
  sensitivePersonas?: readonly string[];
  /**
   * Has the user granted cloud-consent for sensitive-persona traffic?
   * Mobile sets this from onboarding; home-node-lite presumes true
   * (server operators consented by running the binary).
   */
  cloudConsentGranted?: boolean;
  /**
   * Optional `ApprovalManager` — when supplied, the pipeline exposes
   * `buildToolsForAsk(askContext)` so the ask handler can construct a
   * per-ask `ToolRegistry` with vault tools wired to a
   * `personaGuard` that mints/consumes per-ask approvals (5.21-D /
   * 5.21-E). Without this, `buildToolsForAsk` is undefined and the
   * static `tools` registry continues to work as before — sensitive
   * personas surface as `accessible:false` rather than bailing the
   * agentic loop with `ApprovalRequiredError`.
   */
  approvalManager?: ApprovalManager;
}

/**
 * Output: the full agentic-ask bundle. `provider` + `tools` are what
 * `makeAgenticAskHandler` expects directly; `router` is exposed for
 * callers that want to bind additional `RoutedLLMProvider` instances
 * against the same router (e.g. the LLM-backed persona classifier).
 * `handlerOptions` carries the intent classifier + guard scanner so
 * the production /ask path always runs the full Python-parity pipeline.
 */
/**
 * Per-ask context the handler hands to `buildToolsForAsk` when
 * Pattern A is wired (5.21-E). Carries the registry's `askId` plus
 * the original requester DID so the minted approval record names a
 * real owner.
 */
export interface AskToolContext {
  askId: string;
  requesterDid: string;
}

export interface AgenticAskPipeline {
  provider: RoutedLLMProvider;
  /**
   * Static tool registry — wired without a `personaGuard`. Callers
   * that don't have an `askId` (mobile chat orchestrator path today)
   * keep using this. Sensitive personas surface as `accessible:false`
   * rather than bailing the loop.
   */
  tools: ToolRegistry;
  /**
   * Per-ask tool factory — present iff `approvalManager` was supplied.
   * Builds a fresh `ToolRegistry` on each call with the three
   * content-reading vault tools wired to a `personaGuard` bound to
   * `(askContext.askId, askContext.requesterDid)`. The non-vault
   * tools (geocode, trust network, query service, find preferred
   * provider, list personas) share the static factories — they
   * don't need ask context.
   *
   * The ask handler calls this once per inbound `/ask`:
   * ```ts
   * const tools = pipeline.buildToolsForAsk?.({askId, requesterDid}) ?? pipeline.tools;
   * await runAgenticTurn({provider, tools, ...});
   * ```
   */
  buildToolsForAsk?: (askContext: AskToolContext) => ToolRegistry;
  router: LLMRouter;
  handlerOptions: Omit<AgenticAskHandlerOptions, 'provider' | 'tools'>;
}

export function buildAgenticAskPipeline(
  input: BuildAgenticAskPipelineInput,
): AgenticAskPipeline {
  // Central LLM router — every call (classify + reason + guard_scan +
  // any future task_type) funnels through here for PII scrub + tier
  // selection + cloud-consent gate.
  const router = new LLMRouter({
    providers: { [input.providerName]: input.llm },
    config: {
      localAvailable: false,
      cloudProviders: [input.providerName],
      // Spread from `readonly string[]` input → the router's mutable
      // `string[]` field. The config object owns its own copy; callers
      // never see it back, so the mutability difference is purely
      // internal.
      sensitivePersonas: [...(input.sensitivePersonas ?? ['health', 'financial'])],
      cloudConsentGranted: input.cloudConsentGranted ?? true,
    },
  });

  // The `/ask` agentic path is `taskType: 'reason'` — the router picks
  // `getProviderTiers(provider).primary`. `runAgenticTurn` talks to
  // this wrapper as a plain `LLMProvider`; it never sees the router.
  const routedForAsk = new RoutedLLMProvider({
    router,
    taskType: 'reason',
    label: `routed:reason:${input.providerName}`,
  });

  // Intent classifier — runs on every /ask before the reasoning loop.
  // Reads the working-memory ToC + emits a routing hint that
  // `formatIntentHintBlock` appends to the system prompt. Fail-open.
  const intentClassifier = buildIntentClassifier(router);

  // Guard-scan post-processor (Laws 1 + 4). Strips Anti-Her /
  // unsolicited / fabricated / consensus sentences. Routes through
  // the router under `taskType: 'guard_scan'` → lite tier.
  const guardScanner = createGuardScanner(
    new RoutedLLMProvider({
      router,
      taskType: 'guard_scan',
      label: `routed:guard_scan:${input.providerName}`,
    }),
  );

  // Post-publish refinement LLMs — fire-and-forget hooks the drain's
  // `handlePostPublish` calls. Both take `(system, prompt) => string`
  // and are fail-open. Wired through the shared router so PII scrub +
  // consent gate + lite-tier selection apply.
  // Reminder planning is the only post-publish task that does real
  // date math + structured JSON output (`due_at` epoch ms, kind enum,
  // future/past filtering). The April 2026 simulator pass found the
  // 'summarize' lite tier emitting 2025 dates — Gemini 1.5 Flash lite
  // defaulting to its training-cutoff year despite `{{today}}` in the
  // prompt. Bump to the primary tier ('reason' → tiers.primary in
  // pickModel) so the planner gets the same model the /ask path
  // already uses for date/time reasoning. Identity extraction is
  // pure entity tagging, lightweight is fine.
  registerReminderLLM(buildLightweightLLMCall(router, 'reason'));
  registerIdentityExtractor(buildLightweightLLMCall(router, 'classify'));
  // People-graph extractor — Phase E pipeline. Same lite tier as the
  // legacy `IdentityExtractor` (entity tagging, no date math). The
  // post-publish step calls `applyPeopleGraphExtraction`, which routes
  // through `extractPersonLinks` → this provider, builds a typed
  // `ExtractionResult`, and applies it to the people-graph repo. The
  // legacy identity extractor still runs in parallel for telemetry on
  // the existing `identityLinksFound` field.
  registerPersonLinkProvider(buildLightweightLLMCall(router, 'classify'));

  // Tool registry — 9 tools matching the Python `VaultContextAssembler`
  // surface + bus-driver demo tools.
  //
  // The vault tools optionally take a `personaGuard`; when an
  // `approvalManager` is wired we expose a per-ask factory that
  // builds a fresh registry with the guard bound to the current
  // (askId, requesterDid). Without an `approvalManager` the static
  // registry has no guard — sensitive personas surface as
  // `accessible:false` rather than bailing the loop.
  const buildToolsWithGuard = (guard?: VaultPersonaGuard): ToolRegistry => {
    const reg = new ToolRegistry();
    reg.register(createListPersonasTool());
    reg.register(createVaultSearchTool(guard ? { personaGuard: guard } : {}));
    reg.register(createBrowseVaultTool(guard ? { personaGuard: guard } : {}));
    reg.register(createGetFullContentTool(guard ? { personaGuard: guard } : {}));
    reg.register(createGeocodeTool());
    reg.register(
      createSearchTrustNetworkTool({
        appViewClient: input.appViewClient,
        logger: input.logger,
      }),
    );
    reg.register(createSearchProviderServicesTool({ appViewClient: input.appViewClient }));
    reg.register(
      createQueryServiceTool({
        orchestrator: input.orchestratorHandle,
        // WM-BRAIN-06d: same AppView client so `query_service` can
        // auto-fetch `schema_hash` on SHORTCUT dispatches. Fail-soft.
        appViewClient: input.appViewClient,
        logger: input.logger,
      }),
    );
    reg.register(
      createFindPreferredProviderTool({
        core: input.coreClient,
        appViewClient: input.appViewClient,
        logger: input.logger,
      }),
    );
    // `classify_intent` — lets the agent re-evaluate routing when the
    // plan has shifted mid-loop (gathered new context, found unexpected
    // results). Pre-loop classification still runs as the soft prime;
    // this tool is the "called multiple times" path.
    reg.register(createClassifyIntentTool({ classifier: intentClassifier }));
    // `draft_review` — LLM-decided trigger for the inline review-draft
    // card flow. Replaces the regex pre-empt that previously short-
    // circuited "/ask write a review of <X>". The actual lifecycle
    // card creation runs in the host (mobile wires
    // `setReviewDraftStarter` at boot); without a registered starter
    // this tool fails soft.
    reg.register(createDraftReviewTool());
    // `delegate_to_agent` — hand a self-contained task to a paired
    // agent (a separate device running `dina-agent`; the agent's
    // runtime owns execution choice, Brain stays unaware). Closes the
    // do-something gap in the existing tool surface (the others are
    // all read paths). Skipped when no workflow client is provided
    // (host has no paired agents). See
    // `reasoning/delegate_agent_tool.ts`.
    if (input.workflowClient !== undefined) {
      reg.register(createDelegateToAgentTool({ core: input.workflowClient }));
    }
    return reg;
  };

  const tools = buildToolsWithGuard();

  const result: AgenticAskPipeline = {
    provider: routedForAsk,
    tools,
    router,
    handlerOptions: { intentClassifier, guardScanner },
  };

  if (input.approvalManager !== undefined) {
    const approvalManager = input.approvalManager;
    result.buildToolsForAsk = (ctx: AskToolContext): ToolRegistry => {
      const guard = createPersonaGuard({
        approvalManager,
        askId: ctx.askId,
        requesterDid: ctx.requesterDid,
      });
      return buildToolsWithGuard(guard);
    };
  }

  return result;
}

/**
 * Match the `(system, prompt) => Promise<string>` signature that
 * `reminder_planner` + `identity_extraction` expect, backed by the
 * shared router. Fail-open: any router error returns `''` so the
 * pipeline falls back to deterministic-only output.
 */
function buildLightweightLLMCall(
  router: LLMRouter,
  taskType: TaskType,
): (system: string, prompt: string) => Promise<string> {
  return async (system: string, prompt: string): Promise<string> => {
    try {
      const response = await router.chat({
        taskType,
        messages: [{ role: 'user', content: prompt }],
        ...(system !== '' ? { systemPrompt: system } : {}),
        temperature: 0.1,
        maxTokens: 2048,
      });
      return response.content;
    } catch {
      return '';
    }
  };
}

/**
 * Intent classifier factory. The ToC fetcher asks `MemoryService` for
 * the top 20 topics across every unlocked persona; when the service
 * isn't registered (early boot, tests) we short-circuit with an empty
 * ToC so the classifier falls back to the conservative default.
 */
function buildIntentClassifier(router: LLMRouter): IntentClassifier {
  return new IntentClassifier({
    llm: async (systemPrompt: string, userPrompt: string): Promise<string> => {
      const response = await router.chat({
        taskType: 'intent_classification',
        messages: [{ role: 'user', content: userPrompt }],
        systemPrompt,
        temperature: 0.1,
        maxTokens: 1024,
      });
      return response.content;
    },
    tocFetcher: async () => {
      const svc = getMemoryService();
      if (svc === null) return [];
      try {
        return await svc.toc(undefined, 20);
      } catch {
        return [];
      }
    },
  });
}
