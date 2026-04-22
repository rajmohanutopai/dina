/**
 * Bootstrap-layer helper for wiring the staging drain's topic-touch +
 * preference-binder pipeline (GAP-RT-02 / PC-BRAIN-13).
 *
 * The drain itself ships with a `topicTouch` option that accepts a
 * pre-built `TopicTouchPipelineOptions`. Wiring those deps involves
 * three moving parts:
 *
 *   1. `TopicExtractor` — needs an LLM callable of shape
 *      `(system, userPrompt) => Promise<string>`. The `LLMProvider`
 *      from `brain/src/llm/adapters/provider.ts` has a richer `chat`
 *      surface; this helper adapts between them so the caller doesn't
 *      have to.
 *
 *   2. `PreferenceExtractor` — regex-based, no LLM dependency. Safe
 *      to `new` directly.
 *
 *   3. `ContactResolver` — a synchronous name → contact lookup.
 *      Core's in-process directory has `resolveByName(name)`; we wrap
 *      it so the pipeline sees the compact `ResolvedContact` shape.
 *
 * The returned options can be passed into `createNode(...)` as
 * `stagingDrain: { topicTouch: buildStagingEnrichment({...}) }`.
 *
 * Tests can swap each dep independently — see
 * `staging_enrichment.test.ts`. Production just calls this with the
 * core-client + LLM provider already wired elsewhere.
 */

import type { BrainCoreClient } from '../../../brain/src/core_client/http';
import type { LLMProvider } from '../../../brain/src/llm/adapters/provider';
import {
  TopicExtractor,
  type TopicExtractorLLM,
} from '../../../brain/src/enrichment/topic_extractor';
import { PreferenceExtractor } from '../../../brain/src/enrichment/preference_extractor';
import type {
  TopicTouchPipelineOptions,
  ContactResolver,
} from '../../../brain/src/enrichment/topic_touch_pipeline';
import { resolveByName } from '../../../core/src/contacts/directory';

export interface BuildStagingEnrichmentOptions {
  /**
   * Core HTTP client — used for `memoryTouch` (topic write) and
   * `updateContact` (preference-binder write). Both are already on
   * `BrainCoreClient`, so most callers just pass their existing
   * client here.
   */
  core: BrainCoreClient;
  /**
   * LLM provider for `TopicExtractor`. Typically the same instance
   * wired into `options.agenticAsk.provider` in `createNode`. Omit
   * to skip topic extraction entirely — the returned options will
   * lack `extractor`, and the drain's touchTopicsForItem call will
   * fail fast (as intended — topic touch requires an extractor).
   *
   * When set, we adapt it into the extractor's compact
   * `(system, prompt) => Promise<string>` shape.
   */
  llm?: LLMProvider;
  /**
   * Override the `ContactResolver`. Defaults to Core's in-process
   * `resolveByName`. Tests inject a fake resolver so they don't need
   * to prime the global directory.
   */
  resolveContact?: ContactResolver;
  /** Structured-log sink — forwarded into the pipeline. */
  logger?: (entry: Record<string, unknown>) => void;
}

/**
 * Adapt an `LLMProvider` into the extractor's `(system, prompt) =>
 * Promise<string>` callable. `temperature: 0` for deterministic
 * topic extraction — we want the same text to produce the same
 * topics across runs.
 */
export function providerToExtractorLLM(provider: LLMProvider): TopicExtractorLLM {
  return async (system, prompt) => {
    const response = await provider.chat([{ role: 'user', content: prompt }], {
      systemPrompt: system,
      temperature: 0,
    });
    return response.content;
  };
}

/**
 * Default `ContactResolver` — wraps Core's in-process
 * `resolveByName`. Returns the compact `ResolvedContact` shape the
 * preference-binder expects.
 */
export const defaultContactResolver: ContactResolver = (name) => {
  const contact = resolveByName(name);
  if (contact === null) return null;
  return {
    did: contact.did,
    preferredFor: contact.preferredFor ?? [],
  };
};

/**
 * Build the `TopicTouchPipelineOptions` bundle for the staging drain.
 * Wires topic extraction (when `llm` supplied) + preference binding
 * (regex-based, always) + the default contact resolver.
 */
export function buildStagingEnrichment(
  options: BuildStagingEnrichmentOptions,
): TopicTouchPipelineOptions {
  const extractor =
    options.llm !== undefined
      ? new TopicExtractor({ llm: providerToExtractorLLM(options.llm) })
      : // When no LLM is wired we still need a non-undefined `extractor`
        // to satisfy the pipeline's type. A no-op extractor returns empty
        // topics so touchTopicsForItem becomes a preference-binder-only
        // pipeline — useful for callers that want preference tracking
        // without incurring LLM cost per ingested item.
        new TopicExtractor({
          llm: async () => '{"entities":[],"themes":[]}',
        });

  return {
    extractor,
    core: options.core,
    preferenceExtractor: new PreferenceExtractor(),
    resolveContact: options.resolveContact ?? defaultContactResolver,
    logger: options.logger,
  };
}
