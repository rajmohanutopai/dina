/**
 * LLM router — decision tree for provider selection.
 *
 * Routing logic:
 *   1. FTS-only task → skip LLM entirely (provider: 'none')
 *   2. Cloud consent gate → sensitive persona + cloud → reject unless consented
 *   3. Local LLM available → use local (no PII scrubbing needed)
 *   4. Lightweight task → prefer lite/local model
 *   5. Sensitive persona + cloud → mandatory PII scrub
 *   6. Fallback chain: local → first cloud provider → FTS-only
 *   7. No providers available → graceful degradation to FTS
 *
 * Token usage tracking: records per-model call counts and token usage
 * for cost monitoring (matching Python's token accumulator).
 *
 * Source: brain/src/service/llm_router.py
 */

import { CloudConsentError } from '../../../core/src/errors';

export type TaskType =
  | 'classify'
  | 'summarize'
  | 'reason'
  | 'embed'
  | 'keyword_search'
  | 'fts_lookup'
  // Extended task types (matching Python's 6 lightweight types)
  | 'intent_classification'
  | 'guard_scan'
  | 'silence_classify'
  | 'multi_step';

export type ProviderName = 'claude' | 'openai' | 'gemini' | 'openrouter' | 'local' | 'none';

export interface RoutingDecision {
  provider: ProviderName;
  model?: string;
  requiresScrubbing: boolean;
  reason: string;
}

export interface RouterConfig {
  localAvailable: boolean;
  cloudProviders: ProviderName[];
  sensitivePersonas: string[];
  /** Cloud consent has been granted for sensitive persona data. */
  cloudConsentGranted?: boolean;
}

/** Default config when none provided. */
const DEFAULT_CONFIG: RouterConfig = {
  localAvailable: false,
  cloudProviders: [],
  sensitivePersonas: ['health', 'financial'],
};

/** Task types that need no LLM — pure full-text search. */
const FTS_ONLY_TASKS = new Set<TaskType>(['keyword_search', 'fts_lookup']);

/**
 * Task types that are lightweight (small/cheap model sufficient).
 *
 * Extended from Python's 6 lightweight types:
 *   classify, summarize, intent_classification, guard_scan, silence_classify
 */
const LIGHTWEIGHT_TASKS = new Set<TaskType>([
  'classify',
  'summarize',
  'intent_classification',
  'guard_scan',
  'silence_classify',
]);

/**
 * Route a task to the optimal LLM provider.
 *
 * @param taskType - What kind of work needs doing
 * @param persona - Which persona's data is involved (affects scrub + consent)
 * @param config - Available providers and sensitivity configuration
 * @throws CloudConsentError if sensitive persona data going to cloud without consent
 */
export function routeTask(
  taskType: TaskType,
  persona?: string,
  config?: RouterConfig,
): RoutingDecision {
  const cfg = config ?? DEFAULT_CONFIG;

  // 1. FTS-only tasks skip LLM entirely
  if (isFTSOnly(taskType)) {
    return {
      provider: 'none',
      requiresScrubbing: false,
      reason: `Task "${taskType}" is FTS-only — no LLM needed`,
    };
  }

  // 2. If local LLM is available, prefer it (no scrubbing ever needed)
  if (cfg.localAvailable) {
    return {
      provider: 'local',
      requiresScrubbing: false,
      reason: 'Local LLM available — no PII leaves device',
    };
  }

  // 3. No local — try cloud providers
  if (cfg.cloudProviders.length > 0) {
    const provider = cfg.cloudProviders[0];
    const isSensitive = isSensitivePersona(persona ?? '', cfg.sensitivePersonas);

    // Cloud consent gate: sensitive persona → cloud requires explicit consent
    if (isSensitive && !cfg.cloudConsentGranted) {
      throw new CloudConsentError(
        persona ?? '',
        `Cloud LLM consent required: persona "${persona}" is sensitive and no local LLM is available`,
      );
    }

    // Cloud-wide scrub: ALL cloud calls get PII scrubbing (matching Python)
    return {
      provider,
      requiresScrubbing: true,
      reason: isSensitive
        ? `Cloud "${provider}" with mandatory PII scrubbing (sensitive persona "${persona}")`
        : `Cloud "${provider}" with PII scrubbing (cloud-wide policy)`,
    };
  }

  // 4. No providers at all — graceful degradation to FTS
  return {
    provider: 'none',
    requiresScrubbing: false,
    reason: 'No LLM providers available — falling back to FTS-only',
  };
}

/** Check if a task type can skip LLM entirely (FTS-only). */
export function isFTSOnly(taskType: TaskType): boolean {
  return FTS_ONLY_TASKS.has(taskType);
}

/** Check if a task is lightweight (small model sufficient). */
export function isLightweightTask(taskType: TaskType): boolean {
  return LIGHTWEIGHT_TASKS.has(taskType);
}

/**
 * Check if PII scrubbing is required for a provider.
 *
 * Cloud-wide scrub policy (matching Python):
 * - Local provider → never scrub (data stays on device)
 * - 'none' provider → never scrub (no LLM call)
 * - ANY cloud provider → ALWAYS scrub, regardless of persona
 *
 * Python scrubs ALL prompts when any cloud LLM exists. The persona
 * sensitivity check is separate (CloudConsentError gate) — scrubbing
 * is universal for cloud to prevent structured PII leaks.
 */
export function requiresScrubbing(
  persona: string,
  provider: ProviderName | string,
  sensitivePersonas?: string[],
): boolean {
  if (provider === 'local' || provider === 'none') {
    return false;
  }
  // Cloud-wide: ALL cloud calls require scrubbing
  return true;
}

/** Check if a persona is in the sensitive list. */
function isSensitivePersona(persona: string, sensitivePersonas?: string[]): boolean {
  if (!persona) return false;
  const sensitive = sensitivePersonas ?? ['health', 'financial'];
  return sensitive.includes(persona);
}

// ---------------------------------------------------------------
// Token usage accumulator (matching Python's per-model tracking)
// ---------------------------------------------------------------

export interface ModelUsage {
  calls: number;
  tokensIn: number;
  tokensOut: number;
}

/** Per-model usage tracking. */
const usageMap = new Map<string, ModelUsage>();

/**
 * Record token usage from an LLM call.
 *
 * Accumulates per-model: call count, input tokens, output tokens.
 * Used for cost monitoring and reporting.
 */
export function recordUsage(model: string, tokensIn: number, tokensOut: number): void {
  const existing = usageMap.get(model);
  if (existing) {
    existing.calls++;
    existing.tokensIn += tokensIn;
    existing.tokensOut += tokensOut;
  } else {
    usageMap.set(model, { calls: 1, tokensIn, tokensOut });
  }
}

/** Get accumulated usage for a specific model. Returns null if no calls recorded. */
export function getModelUsage(model: string): ModelUsage | null {
  return usageMap.get(model) ?? null;
}

/** Get all accumulated usage. Returns a copy. */
export function getAllUsage(): Map<string, ModelUsage> {
  return new Map(usageMap);
}

/** Get total tokens across all models. */
export function getTotalTokens(): { tokensIn: number; tokensOut: number; totalCalls: number } {
  let tokensIn = 0;
  let tokensOut = 0;
  let totalCalls = 0;
  for (const usage of usageMap.values()) {
    tokensIn += usage.tokensIn;
    tokensOut += usage.tokensOut;
    totalCalls += usage.calls;
  }
  return { tokensIn, tokensOut, totalCalls };
}

/** Reset all usage tracking (for testing). */
export function resetUsage(): void {
  usageMap.clear();
}
