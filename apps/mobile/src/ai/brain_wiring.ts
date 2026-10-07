/**
 * Bridge between the Settings-side BYOK provider and Brain's chat
 * orchestrator.
 *
 * The single-shot path is `useChatThread → handleChat → reason()` in
 * `packages/brain/src/chat/orchestrator.ts`, used when no ask handler is
 * installed (for example a node that booted with no provider and got a key
 * later). It picks up reasoning via `registerReasoningLLM` and its provider
 * label from `setDefaultProvider`. This module is the single call site the
 * Settings screen invokes when the user changes provider, so both hooks fire
 * together.
 *
 * Safety (docs/PII_ARCHITECTURE_V2.md §3): the registered function sends the
 * query and context through the PII router (`createScrubbedLLMProvider`), so
 * patterns, known names and strangers' names are hidden through one token
 * table for the call and restored in the answer. `reason()` additionally
 * scrubs sensitive-persona context with `checkCloudGate` and rehydrates its
 * own tokens afterwards; the router never reuses a token already in the text.
 *
 * The function carries a 60-second abort so a stalled cloud request cannot
 * hang the chat UI.
 */

import { setDefaultProvider, resetChatDefaults } from '@dina/brain/chat';
import {
  registerReasoningLLM,
  resetReasoningLLM,
  routedProvider,
  type LLMProvider,
} from '@dina/brain/llm';

import { createScrubbedLLMProvider } from './provider';

import type { ProviderType } from './provider';

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

  const llm = await createScrubbedLLMProvider(provider);
  if (llm === null) {
    // No key stored for this provider — treat as no provider.
    resetReasoningLLM();
    resetChatDefaults();
    return;
  }

  setDefaultProvider(provider);
  registerReasoningLLM(makeTimedReasoningLLM(llm));
}

/**
 * A reasoning function over a provider that is already behind the PII
 * router: the context as system prompt, the query as the user message,
 * aborted after `LLM_TIMEOUT_MS`.
 *
 * Exported so tests can exercise the exact seam without round-tripping
 * through Brain's full `reason()` pipeline.
 */
export function makeTimedReasoningLLM(
  scrubbed: LLMProvider,
): (q: string, ctx: string) => Promise<string> {
  return async (query, context) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      const response = await scrubbed.chat([{ role: 'user', content: query }], {
        systemPrompt: context,
        signal: controller.signal,
      });
      return response.content;
    } finally {
      clearTimeout(timeoutId);
    }
  };
}

/**
 * Convenience for tests that hold an adapter directly instead of a keychain
 * key: the adapter goes behind the PII router first, then through the same
 * 60-second wrapper as the keychain path.
 */
export function registerBrainReasoningLLM(provider: ProviderType, llm: LLMProvider): void {
  setDefaultProvider(provider);
  registerReasoningLLM(
    makeTimedReasoningLLM(routedProvider({ llm, providerName: provider, taskType: 'reason' })),
  );
}
