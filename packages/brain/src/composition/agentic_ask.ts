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

import { ToolRegistry } from '../reasoning/tool_registry';
import {
  createGeocodeTool,
  createSearchProviderServicesTool,
  createQueryServiceTool,
  createFindPreferredProviderTool,
} from '../reasoning/bus_driver_tools';
import {
  createVaultSearchTool,
  createListPersonasTool,
  createBrowseVaultTool,
  createGetFullContentTool,
} from '../reasoning/vault_tool';
import { createSearchTrustNetworkTool } from '../reasoning/trust_tool';
import { LLMRouter, RoutedLLMProvider } from '../llm/router_dispatch';
import type { ProviderName } from '../llm/router';
import { IntentClassifier } from '../reasoning/intent_classifier';
import { createGuardScanner } from '../reasoning/guard_scanner';
import { getMemoryService } from '../../../core/src/memory/service';
import { registerReminderLLM } from '../pipeline/reminder_planner';
import { registerIdentityExtractor } from '../pipeline/identity_extraction';
import type { LLMProvider } from '../llm/adapters/provider';
import type { AgenticAskHandlerOptions } from '../reasoning/ask_handler';
import type { TaskType } from '../llm/router';

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
}

/**
 * Output: the full agentic-ask bundle. `provider` + `tools` are what
 * `makeAgenticAskHandler` expects directly; `router` is exposed for
 * callers that want to bind additional `RoutedLLMProvider` instances
 * against the same router (e.g. the LLM-backed persona classifier).
 * `handlerOptions` carries the intent classifier + guard scanner so
 * the production /ask path always runs the full Python-parity pipeline.
 */
export interface AgenticAskPipeline {
  provider: RoutedLLMProvider;
  tools: ToolRegistry;
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
  registerReminderLLM(buildLightweightLLMCall(router, 'summarize'));
  registerIdentityExtractor(buildLightweightLLMCall(router, 'classify'));

  // Tool registry — 9 tools matching the Python `VaultContextAssembler`
  // surface + bus-driver demo tools.
  const tools = new ToolRegistry();
  tools.register(createListPersonasTool());
  tools.register(createVaultSearchTool());
  tools.register(createBrowseVaultTool());
  tools.register(createGetFullContentTool());
  tools.register(createGeocodeTool());
  tools.register(
    createSearchTrustNetworkTool({
      appViewClient: input.appViewClient,
      logger: input.logger,
    }),
  );
  tools.register(createSearchProviderServicesTool({ appViewClient: input.appViewClient }));
  tools.register(
    createQueryServiceTool({
      orchestrator: input.orchestratorHandle,
      // WM-BRAIN-06d: same AppView client so `query_service` can
      // auto-fetch `schema_hash` on SHORTCUT dispatches. Fail-soft.
      appViewClient: input.appViewClient,
      logger: input.logger,
    }),
  );
  tools.register(
    createFindPreferredProviderTool({
      core: input.coreClient,
      appViewClient: input.appViewClient,
      logger: input.logger,
    }),
  );

  return {
    provider: routedForAsk,
    tools,
    router,
    handlerOptions: { intentClassifier, guardScanner },
  };
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
