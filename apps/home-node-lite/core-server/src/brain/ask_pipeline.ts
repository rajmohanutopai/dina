/**
 * Ask pipeline — /api/v1/ask orchestrator (non-streaming).
 *
 * Composes the existing primitive set into a single function that
 * turns a user query into an LLM answer:
 *
 *   1. **Vault search** via `CoreClient.queryVault`.
 *   2. **Tier classification** on the query text — gates cloud
 *      providers via the ModelRouter's CloudGate.
 *   3. **Context assembly** via `assembleVaultContext` — produces the
 *      structured sections the prompt template consumes.
 *   4. **Model routing** via `ModelRouter.route(taskType, personaTier)`
 *      → `{provider, model}`. Uses the TIER from step 2 as the
 *      persona-tier signal (conservative: sensitive content forces
 *      on-device providers).
 *   5. **LLM call** via the injected `llmFn` — a pure async function
 *      that takes `{provider, model, prompt}` and returns text.
 *   6. **Format** — wrap the raw text in an `AskOutcome` with the
 *      citation ids of the vault items that fed the prompt.
 *
 * **Pure orchestration** — every IO + crypto step is injected. No
 * HTTP, no streaming (streaming is `stream_buffer.ts`'s domain).
 *
 * **Failure taxonomy** (tagged, never throws):
 *
 *   - `vault_query_failed` — the CoreClient returned `ok:false`.
 *   - `no_llm_available` — router rejected every provider preference.
 *   - `llm_call_failed` — injected llmFn threw / returned empty.
 *   - `invalid_input` — request shape validation.
 *
 * **Persona-tier mapping** from content tier:
 *
 *   content `local_only` → persona tier `locked` (cloud blocked)
 *   content `sensitive`  → persona tier `sensitive` (cloud blocked)
 *   content `elevated`   → persona tier `standard`
 *   content `general`    → persona tier `default`
 *
 * Callers who already know the persona tier can pass it via
 * `personaTier` and the content-derived tier is used only for
 * context enrichment, not for routing.
 */

import type { CoreClient, VaultItem } from './core_client';
import type { PersonaTier } from '@dina/core';
import type { ModelRouter, TaskType } from './model_router';
import {
  type AssembledContext,
  type AssembleVaultContextOptions,
  assembleVaultContext,
  renderContextAsPrompt,
  type VaultContextItem,
} from './vault_context';
import { classifyTier, type Tier } from './tier_classifier';

export interface AskRequest {
  persona: string;
  /** User's natural-language query. */
  query: string;
  /** Overrides the tier-derived persona tier. */
  personaTier?: PersonaTier;
  /** Defaults to `reasoning`. */
  taskType?: TaskType;
  /** Max vault items to retrieve. Default 10. */
  maxItems?: number;
  /** Optional context-assembly overrides. */
  contextOptions?: AssembleVaultContextOptions;
}

export interface LlmCallInput {
  provider: string;
  model: string;
  prompt: string;
}

export type LlmCallOutcome =
  | { ok: true; text: string }
  | { ok: false; error: string };

export type LlmCallFn = (input: LlmCallInput) => Promise<LlmCallOutcome>;

export interface AskPipelineOptions {
  core: CoreClient;
  router: ModelRouter;
  llmFn: LlmCallFn;
}

export type AskFailureReason =
  | 'invalid_input'
  | 'vault_query_failed'
  | 'no_llm_available'
  | 'llm_call_failed';

export interface AskSuccess {
  ok: true;
  answer: string;
  provider: string;
  model: string;
  tier: Tier;
  citationIds: string[];
  context: AssembledContext;
}

export interface AskFailure {
  ok: false;
  reason: AskFailureReason;
  detail?: string;
}

export type AskOutcome = AskSuccess | AskFailure;

export const DEFAULT_MAX_ITEMS = 10;

/**
 * Build the orchestrator. Returns a function the handler invokes
 * per request.
 */
export function createAskPipeline(
  opts: AskPipelineOptions,
): (req: AskRequest) => Promise<AskOutcome> {
  if (!opts?.core) throw new TypeError('createAskPipeline: core required');
  if (!opts.router) throw new TypeError('createAskPipeline: router required');
  if (typeof opts.llmFn !== 'function') {
    throw new TypeError('createAskPipeline: llmFn required');
  }
  const { core, router, llmFn } = opts;

  return async function ask(req: AskRequest): Promise<AskOutcome> {
    const validation = validate(req);
    if (validation !== null) {
      return { ok: false, reason: 'invalid_input', detail: validation };
    }
    const maxItems = req.maxItems ?? DEFAULT_MAX_ITEMS;
    const taskType = req.taskType ?? 'reasoning';

    // 1. Vault search.
    const vault = await core.queryVault({
      persona: req.persona,
      query: req.query,
      maxItems,
      mode: 'hybrid',
    });
    if (!vault.ok) {
      return {
        ok: false,
        reason: 'vault_query_failed',
        detail: vault.error.message,
      };
    }

    // 2. Tier classification.
    const classification = classifyTier(req.query);
    const personaTier = req.personaTier ?? mapTierToPersona(classification.tier);

    // 3. Context assembly.
    const context = assembleVaultContext(
      {
        persona: req.persona,
        query: req.query,
        recentItems: vault.value.map(toVaultContextItem),
        tier: classification.tier,
      },
      req.contextOptions ?? {},
    );

    // 4. Route.
    const route = router.route(taskType, personaTier);
    if (!route.ok) {
      return {
        ok: false,
        reason: 'no_llm_available',
        detail: describeRejection(route.rejection),
      };
    }

    // 5. LLM call.
    const prompt = renderContextAsPrompt(context);
    const llm = await llmFn({
      provider: route.selection.provider,
      model: route.selection.model,
      prompt,
    });
    if (!llm.ok) {
      return { ok: false, reason: 'llm_call_failed', detail: llm.error };
    }
    if (typeof llm.text !== 'string' || llm.text === '') {
      return { ok: false, reason: 'llm_call_failed', detail: 'llm returned empty text' };
    }

    // 6. Format. Citations reflect what the LLM actually saw — if
    // assembleVaultContext truncated to fit the budget, the extra
    // items were never in the prompt + shouldn't appear as citations.
    const citationIds = vault.value
      .slice(0, context.meta.itemsIncluded)
      .map((i) => i.id);
    return {
      ok: true,
      answer: llm.text,
      provider: route.selection.provider,
      model: route.selection.model,
      tier: classification.tier,
      citationIds,
      context,
    };
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validate(req: AskRequest): string | null {
  if (!req || typeof req !== 'object') return 'request required';
  if (typeof req.persona !== 'string' || req.persona === '') return 'persona required';
  if (typeof req.query !== 'string' || req.query.trim() === '') return 'query required';
  if (req.maxItems !== undefined) {
    if (!Number.isInteger(req.maxItems) || req.maxItems < 1) {
      return 'maxItems must be a positive integer';
    }
  }
  return null;
}

function mapTierToPersona(tier: Tier): PersonaTier {
  switch (tier) {
    case 'local_only': return 'locked';
    case 'sensitive':  return 'sensitive';
    case 'elevated':   return 'standard';
    case 'general':    return 'default';
  }
}

function toVaultContextItem(item: VaultItem): VaultContextItem {
  const out: VaultContextItem = {
    id: item.id,
    summary: item.summary,
    timestamp: item.timestamp,
    type: item.type,
    source: item.source,
  };
  if (item.body !== undefined) out.body = item.body;
  else if (item.bodyText !== undefined) out.body = item.bodyText;
  else if (item.contentL1 !== undefined) out.body = item.contentL1;
  else if (item.contentL0 !== undefined) out.body = item.contentL0;
  return out;
}

function describeRejection(
  rejection: Extract<ReturnType<ModelRouter['route']>, { ok: false }>['rejection'],
): string {
  if (rejection.reason === 'no_preferences_for_task') {
    return `no providers configured for task ${rejection.taskType}`;
  }
  const failed = rejection.attempts
    .map((a) => `${a.provider}:${a.reason}`)
    .join(', ');
  return `all providers rejected: ${failed}`;
}
