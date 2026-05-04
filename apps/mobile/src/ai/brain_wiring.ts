/**
 * Bridge between the Settings-side BYOK provider and Brain's chat
 * orchestrator.
 *
 * The live path is `useChatThread → handleChat → reason()` in
 * `packages/brain/src/chat/orchestrator.ts`; it picks up reasoning via
 * `registerReasoningLLM` and picks up its provider label from
 * `setDefaultProvider`. This module is the single call site the Settings
 * screen invokes when the user changes provider, so both hooks fire
 * together.
 *
 * Safety properties (review findings #6, #11): the registered
 * reasoning function uses belt-and-suspenders scrub/rehydrate behaviour:
 *
 *   1. Brain's `reason()` pipeline passes an already-scrubbed context
 *      (via `checkCloudGate`) AND scans the rehydrated answer
 *      (`scanResponse` + `rehydrateResponse`). Those are the
 *      load-bearing safety guards.
 *   2. This lambda adds an extra PII scrub on BOTH the query AND the
 *      context before generateText, then rehydrates on the way back.
 *      `reason()` passes `req.query` unchanged, so without this
 *      second scrub user-supplied PII in the question text would
 *      reach the cloud LLM untokenised — review #11.
 *
 * The rehydrate step restores the user's original values in the text
 * the lambda returns BEFORE `reason()` sees it; `reason()` will then
 * re-rehydrate against its own entity set, but the operation is
 * idempotent — rehydrating a string that no longer has tokens is a
 * no-op.
 *
 * The lambda also carries a 60-second `AbortController` timeout so a
 * stalled cloud request can't hang the chat UI indefinitely.
 */

import { generateText } from 'ai';

import { setDefaultProvider, resetChatDefaults } from '@dina/brain/chat';
import {
  registerReasoningLLM,
  resetReasoningLLM,
} from '@dina/brain/llm';
import { scrubPII, rehydratePII } from '@dina/core';

import { createModel } from './provider';

import type { ProviderType } from './provider';
import type { LanguageModel } from 'ai';

/** LLM call timeout. Exported so tests can assert on the exact window
 *  instead of hard-coding a magic number. */
export const LLM_TIMEOUT_MS = 60_000;

/**
 * Wire the active provider into Brain's chat orchestrator. Calling this
 * with `null` unregisters both hooks so the orchestrator falls back to
 * the single-shot path.
 */
export async function wireBrainChatProvider(provider: ProviderType | null): Promise<void> {
  if (provider === null) {
    resetReasoningLLM();
    resetChatDefaults();
    return;
  }

  const model = await createModel(provider);
  if (model === null) {
    // No key stored for this provider — treat as no provider.
    resetReasoningLLM();
    resetChatDefaults();
    return;
  }

  setDefaultProvider(provider);
  registerReasoningLLM(makeTimedReasoningLLM(model));
}

/**
 * Build a reasoning-LLM lambda that:
 *   - scrubs PII from the query AND the context before generateText,
 *   - rehydrates PII tokens on the LLM's response,
 *   - applies a 60s AbortController timeout.
 *
 * Exported so tests can exercise the exact seam without round-tripping
 * through Brain's full `reason()` pipeline.
 */
export function makeTimedReasoningLLM(
  model: LanguageModel,
): (q: string, ctx: string) => Promise<string> {
  return async (query, context) => {
    const { scrubbed: scrubbedQuery, entities: qEnts } = scrubPII(query);
    const { scrubbed: scrubbedContext, entities: cEnts } = scrubPII(context);
    const allEntities = [...qEnts, ...cEnts];

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      const { text } = await generateText({
        model,
        system: scrubbedContext,
        prompt: scrubbedQuery,
        abortSignal: controller.signal,
      });
      // Rehydrate ONLY if we actually scrubbed anything — a no-op call
      // allocates pointlessly otherwise.
      return allEntities.length > 0 ? rehydratePII(text, allEntities) : text;
    } finally {
      clearTimeout(timeoutId);
    }
  };
}

/**
 * Convenience for screens that want to pass the Model handle directly —
 * used in tests that don't want to round-trip through keychain. Goes
 * through the same 60-second timeout wrapper as the keychain path so
 * both entry points share identical runtime behaviour.
 */
export function registerBrainReasoningLLM(provider: ProviderType, model: LanguageModel): void {
  setDefaultProvider(provider);
  registerReasoningLLM(makeTimedReasoningLLM(model));
}
