/**
 * Compose-context runner — fetches vault items relevant to a subject
 * and runs the LLM-driven inferer to produce form prefills.
 *
 * Stays local on device: queries `queryVault` directly (lite stack
 * has Core + Brain + keystore in-process); the LLM call goes via the
 * user's BYOK provider (`createLLMProvider`) — Loyalty Law-clean,
 * AppView is never in the path.
 *
 * **Controlled vs uncontrolled.** `enabled: false` short-circuits the
 * effect — used by tests to render the form pure (no vault read).
 * Production routes pass `enabled: true`.
 *
 * **No provider configured?** Quiet failure: runner returns an empty
 * result so the form opens at its baseline. The Settings screen is
 * the right surface to nag the user about a missing key — not the
 * trust write form.
 *
 * **Provider injection.** Tests pass a `llmProvider` to bypass the
 * default `loadActiveProvider`/`createLLMProvider` plumbing without
 * having to mock the keychain. Production omits this.
 */

import { useEffect, useState } from 'react';

import { queryVault } from '@dina/core';
import type { LLMProvider } from '@dina/brain/llm';

import { loadActiveProvider } from '../../ai/active_provider';
import { createLLMProvider } from '../../ai/provider';
import {
  inferComposeContext,
  type ComposeContextResult,
  type ComposeVaultItem,
} from '../compose_context';
import { useCasesForCategory } from '../write_form_data';

export interface UseComposeContextOptions {
  /** Subject the user is reviewing — drives the vault search query. */
  readonly subjectName: string | null;
  /**
   * Personas to search for prefill source items. Pass every currently
   * open persona — closed personas have no DEK in RAM so their
   * `queryVault` calls fail silently and contribute nothing (the
   * crypto wall enforces the boundary, not this list). Single-string
   * is accepted for back-compat; resolves to `[s]` internally. `null`
   * / empty array → no fetch, empty result.
   *
   * Why a list, not just one name: Dina is acting on behalf of the
   * user inside their own device. The user opened these personas;
   * pulling from any of them when assembling a review is the user's
   * own action, not a third-party leak. The closed-vocab output of
   * the inferer + the user-visible ✨ markers + explicit Publish step
   * are the load-bearing safeguards. See conversation pin re: the
   * Loyalty Law's wall protecting against third parties, not the
   * user reading their own data.
   */
  readonly persona: string | readonly string[] | null;
  /**
   * Subject category, used to pick the use-case vocabulary. Falls
   * back to the default vocabulary when null/unknown.
   */
  readonly category: string | null;
  /** Test/uncontrolled gate: false → no fetch, returns empty state. */
  readonly enabled: boolean;
  /**
   * Test injection point. Production passes `Date.now`; tests pin a
   * fixed value so the response can stay deterministic against a
   * mocked LLM that echoes back a known value.
   */
  readonly nowMs?: number;
  /**
   * Test injection point — provide a ready-made LLMProvider (or
   * `null` to simulate "no provider configured"). When omitted, the
   * runner resolves the BYOK active provider on its own.
   */
  readonly llmProvider?: LLMProvider | null;
}

export interface UseComposeContextState {
  /** Inferred values + sources. `null` while loading or when disabled. */
  readonly result: ComposeContextResult | null;
  readonly isLoading: boolean;
}

const EMPTY_RESULT: ComposeContextResult = { values: {}, sources: {} };

async function defaultProvider(): Promise<LLMProvider | null> {
  try {
    const active = await loadActiveProvider();
    if (active === null) return null;
    // Compose-context is a closed-vocab classification call — small
    // prompt, structured-output JSON response, no tool round-trip.
    // The 'lite' tier (Gemini → flash-lite-preview, OpenAI → gpt-5-mini)
    // is the right fit: ~10× cheaper, faster, and avoids the
    // thinking-model `thought_signature` schema fragility on
    // `gemini-3.1-pro-preview`. Tier mapping is single-sourced from
    // `models.json` via `getProviderTiers`.
    return await createLLMProvider(active, { tier: 'lite' });
  } catch {
    return null;
  }
}

export function useComposeContext(
  opts: UseComposeContextOptions,
): UseComposeContextState {
  const [state, setState] = useState<UseComposeContextState>({
    result: null,
    isLoading: false,
  });

  useEffect(() => {
    if (!opts.enabled) {
      setState({ result: null, isLoading: false });
      return;
    }
    if (opts.subjectName === null || opts.subjectName.trim().length === 0) {
      setState({ result: EMPTY_RESULT, isLoading: false });
      return;
    }
    // Normalise persona arg to a list. Empty list / null / empty
    // string → no fetch.
    const personas: readonly string[] =
      opts.persona === null
        ? []
        : typeof opts.persona === 'string'
          ? opts.persona.trim().length === 0
            ? []
            : [opts.persona]
          : opts.persona.filter((p) => p.trim().length > 0);
    if (personas.length === 0) {
      setState({ result: EMPTY_RESULT, isLoading: false });
      return;
    }
    let cancelled = false;
    const ac = new AbortController();
    setState({ result: null, isLoading: true });

    (async () => {
      try {
        // Fan out across every open persona. queryVault is sync
        // (better-sqlite3) and throws on closed/missing personas —
        // wrap each call so a single closed compartment doesn't
        // tank the whole search. The crypto wall (DEK in RAM)
        // remains load-bearing: closed personas contribute nothing.
        const allItems: ComposeVaultItem[] = [];
        const seenIds = new Set<string>();
        for (const persona of personas) {
          let items: ReturnType<typeof queryVault>;
          try {
            items = queryVault(persona, {
              mode: 'fts5',
              text: opts.subjectName as string,
              limit: 50,
            });
          } catch {
            continue; // locked / missing persona — skip silently
          }
          for (const it of items) {
            if (seenIds.has(it.id)) continue; // dedup across personas
            seenIds.add(it.id);
            allItems.push({
              id: it.id,
              body: [it.content_l0, it.content_l1, it.summary, it.body]
                .filter((s): s is string => typeof s === 'string' && s.length > 0)
                .join(' '),
              timestamp: it.timestamp,
            });
          }
        }
        const vaultItems: ComposeVaultItem[] = allItems;
        const vocabulary = useCasesForCategory(opts.category);
        const nowMs = opts.nowMs ?? Date.now();

        const llm =
          opts.llmProvider !== undefined
            ? opts.llmProvider
            : await defaultProvider();
        if (cancelled) return;

        const result = await inferComposeContext({
          llm,
          subjectName: opts.subjectName as string,
          category: opts.category,
          items: vaultItems,
          vocabulary,
          nowMs,
          signal: ac.signal,
        });
        if (!cancelled) setState({ result, isLoading: false });
      } catch {
        if (!cancelled) setState({ result: EMPTY_RESULT, isLoading: false });
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
    // llmProvider is reference-stable in tests (mock provider passed
    // once); production resolves it inside the effect, so it isn't a
    // dep. Subject/persona/category/nowMs trigger refetches.
    // The persona dep uses a stable string key so an array prop
    // (new reference each render) doesn't re-fire the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    opts.enabled,
    opts.subjectName,
    typeof opts.persona === 'string'
      ? opts.persona
      : opts.persona === null
        ? null
        : [...opts.persona].sort().join('|'),
    opts.category,
    opts.nowMs,
  ]);

  return state;
}
