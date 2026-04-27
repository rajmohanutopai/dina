/**
 * Factory that converts the agentic reasoning loop into a chat
 * `/ask`-command handler. Installed by the app-layer bootstrap so that
 * `handleChat('/ask …')` flows through the multi-turn tool-use loop
 * instead of the single-shot reason() fallback.
 *
 * The handler is tool-agnostic — whatever ToolRegistry the bootstrap
 * supplies is what the LLM sees. The LLM learns tool names + parameters
 * from the provider's `tools` channel (Anthropic Messages `tools`,
 * OpenAI `tools`, etc.); the system prompt below carries only BEHAVIOUR
 * rules (when to use tools, how to handle errors, how to handle async
 * dispatch) — never an enumeration of tools. Adding a new capability is
 * a registry insertion, not a prompt edit.
 *
 * The returned handler matches the `AskCommandHandler` signature the
 * chat orchestrator exposes (`setAskCommandHandler`). Task IDs from
 * successful `query_service` tool calls are surfaced as sources so the
 * chat UI can tap through to the corresponding workflow task.
 */

import type { AskCommandHandler } from '../chat/orchestrator';
import type { LLMProvider } from '../llm/adapters/provider';
import { VAULT_CONTEXT } from '../llm/prompts';
import { runAgenticTurn, type AgenticLoopOptions } from './agentic_loop';
import type { ToolRegistry } from './tool_registry';
import { IntentClassifier, type IntentClassification } from './intent_classifier';
import type { GuardScanner } from './guard_scanner';

export interface AgenticAskHandlerOptions {
  provider: LLMProvider;
  tools: ToolRegistry;
  /** Override the default Bus Driver system prompt. */
  systemPrompt?: string;
  /** Pass-through for loop budget / cancellation. */
  loopOptions?: AgenticLoopOptions;
  /**
   * Optional intent classifier (WM-BRAIN-05). When supplied, the
   * handler runs classification BEFORE the reasoning loop and appends
   * the classifier's output as a "Routing hint" block on the system
   * prompt. The classifier is fail-open: any exception bubbles up as
   * `IntentClassifier.default()` so the reasoning loop still runs —
   * just without the hint boost.
   *
   * Tests that don't need the hint can omit this option; behaviour
   * then matches the pre-WM-BRAIN-04 handler exactly.
   */
  intentClassifier?: IntentClassifier;
  /**
   * Optional guard-scan post-processor (Law 4, Law 1). Runs after the
   * reasoning loop lands, flags Anti-Her / unsolicited / fabricated /
   * consensus sentences, strips them, and substitutes an anti-Her
   * redirect when the response collapses to empty for that reason.
   *
   * Fail-open: any scanner error returns the raw response. When
   * omitted the handler behaves exactly as before — no scanning.
   */
  guardScanner?: GuardScanner;
  /** Optional sink for diagnostics — last turn's trace, usage, etc. */
  onTurn?: (trace: {
    query: string;
    answer: string;
    toolCalls: Array<{ name: string; outcome: { success: boolean } }>;
    finishReason: string;
    tokens: { input: number; output: number };
  }) => void;
}

/**
 * Default system prompt for the agentic `/ask` loop. Aliased to
 * `VAULT_CONTEXT` from the prompts registry — the full Python-parity
 * prompt with source-trust rules, tiered content loading, provider-
 * services routing, and the /remember pointer. Preserved as a named
 * export so existing tests + callers importing it keep working; any
 * new code should prefer reading `VAULT_CONTEXT` directly.
 */
export const DEFAULT_ASK_SYSTEM_PROMPT = VAULT_CONTEXT;

/**
 * Provider-services routing guidance appended to the hint block
 * whenever `sources` includes `provider_services`.
 *
 * The classifier's `sources` says "this query touches live
 * provider services" — but does NOT pre-resolve which provider.
 * This guidance tells the agent how to resolve at tool time:
 *
 *   Path 1 — "my dentist", "my lawyer" etc. (established service
 *            relationship). Try `find_preferred_provider(category)`
 *            FIRST. The user has designated a go-to contact; honour
 *            the choice instead of re-ranking each time.
 *
 *   Path 2 — public-facing services (bus, weather, nearby pharmacy).
 *            There is no "my X" — skip `find_preferred_provider`;
 *            go straight to `geocode` (if a place is mentioned) +
 *            `search_provider_services` + `query_service`.
 *            `geocode` + `search_provider_services` can run in
 *            parallel on the first turn when both are needed.
 *
 *   Fall-through — if Path 1 returns no candidates (empty
 *            `providers`), treat it as Path 2 and fall back to the
 *            geocode + search flow. The `find_preferred_provider`
 *            tool's own description + empty-result `message` carry
 *            the same instruction, but surfacing it in the system
 *            prompt makes the decision more reliable under weaker
 *            models that don't carefully re-read tool responses.
 *
 * The wording is load-bearing; see `PROVIDER_SERVICES_ROUTING_BLOCK`
 * below. Exported so tests can assert against stable strings.
 */
export const PROVIDER_SERVICES_ROUTING_BLOCK = `Provider-services routing — pick the right path on your FIRST tool call. Do NOT waste turns on search_vault when the question is about external live state (ETA, appointment status, stock price, etc.) — the vault does not hold that data.

Path 1: established service relationships ("my dentist", "my lawyer", "my accountant", etc.). Call find_preferred_provider(category) FIRST. The user has designated a go-to contact for that category and it should be honoured before re-searching AppView. Categories are lowercase single tokens: dental, legal, tax, medical, automotive, plumbing, electrical, etc. If it returns candidates, pass the contact_did + a matching capability to query_service.

Path 2: public-facing services ("bus 42 to Castro", "nearest pharmacy", "weather in SF"). There is no "my X" relationship here. Skip find_preferred_provider; go directly to geocode (if a place is mentioned) + search_provider_services(capability, lat, lng, q) + query_service. One first tool turn can call geocode + search_provider_services in parallel.

Fall-through: if Path 1 returns no candidates, treat it as Path 2 and fall back to geocode + search_provider_services.`;

/**
 * Render a classifier-produced `IntentClassification` as a system-prompt
 * addendum. Exported pure for test coverage — the reasoning loop only
 * concatenates it onto the base system prompt.
 *
 * Returns an empty string when the hint is the conservative default
 * (sources=["vault"] and everything else empty) — nothing to add in
 * that case, no point growing the prompt.
 *
 * When `sources` includes `provider_services`, the
 * `PROVIDER_SERVICES_ROUTING_BLOCK` is appended with Path 1 /
 * Path 2 / fall-through guidance. Routing to a specific provider is
 * resolved at tool time via `find_preferred_provider`, not via a
 * pre-stamped classifier field.
 */
export function formatIntentHintBlock(hint: IntentClassification): string {
  if (isDefaultHint(hint)) return '';

  const lines: string[] = ['Routing hint from the intent classifier:'];
  lines.push(`- sources: ${JSON.stringify(hint.sources)}`);
  if (hint.relevant_personas.length > 0) {
    lines.push(`- relevant_personas: ${JSON.stringify(hint.relevant_personas)}`);
  }
  if (hint.temporal !== '') {
    lines.push(`- temporal: ${hint.temporal}`);
  }
  if (hint.reasoning_hint !== '') {
    lines.push(`- reasoning_hint: ${hint.reasoning_hint}`);
  }
  if (hasAnyEvidence(hint.toc_evidence)) {
    lines.push('- toc_evidence:');
    lines.push(indent(JSON.stringify(hint.toc_evidence, null, 2), 4));
  }

  // Path 1 / Path 2 routing block, triggered by
  // `provider_services` in sources.
  if (hint.sources.includes('provider_services')) {
    lines.push('');
    lines.push(PROVIDER_SERVICES_ROUTING_BLOCK);
  }

  lines.push('');
  lines.push('This hint is advisory — you may still call any tool if the query evolves.');
  return lines.join('\n');
}

function isDefaultHint(hint: IntentClassification): boolean {
  return (
    hint.sources.length === 1 &&
    hint.sources[0] === 'vault' &&
    hint.relevant_personas.length === 0 &&
    hint.temporal === '' &&
    hint.reasoning_hint === '' &&
    !hasAnyEvidence(hint.toc_evidence)
  );
}

function hasAnyEvidence(e: IntentClassification['toc_evidence']): boolean {
  return (
    (e.entity_matches?.length ?? 0) > 0 ||
    (e.theme_matches?.length ?? 0) > 0 ||
    Object.keys(e.persona_context ?? {}).length > 0
  );
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => `${pad}${l}`)
    .join('\n');
}

export function makeAgenticAskHandler(options: AgenticAskHandlerOptions): AskCommandHandler {
  const baseSystemPrompt = options.systemPrompt ?? DEFAULT_ASK_SYSTEM_PROMPT;
  return async (query) => {
    // WM-BRAIN-05: run the classifier first (fail-open) so the
    // reasoning agent gets a routing nudge. No classifier → skip.
    let systemPrompt = baseSystemPrompt;
    if (options.intentClassifier !== undefined) {
      let hint: IntentClassification;
      try {
        hint = await options.intentClassifier.classify(query);
      } catch {
        hint = IntentClassifier.default();
      }
      const block = formatIntentHintBlock(hint);
      if (block !== '') {
        systemPrompt = `${baseSystemPrompt}\n\n${block}`;
      }
    }

    const result = await runAgenticTurn({
      provider: options.provider,
      tools: options.tools,
      systemPrompt,
      userMessage: query,
      options: options.loopOptions,
    });

    if (options.onTurn !== undefined) {
      options.onTurn({
        query,
        answer: result.answer,
        toolCalls: result.toolCalls.map((c) => ({
          name: c.name,
          outcome: { success: c.outcome.success },
        })),
        finishReason: result.finishReason,
        tokens: { input: result.usage.inputTokens, output: result.usage.outputTokens },
      });
    }

    // Sources: task_ids from successful query_service calls let the chat
    // UI link to the corresponding workflow task (pending delivery).
    // serviceQueries: full dispatch metadata so the orchestrator can post
    // a status-tracked `service_query` chat card instead of the racey
    // "LLM narrative + workflow-event push" pair (Option D).
    const sources: string[] = [];
    const serviceQueries: ServiceQueryDispatch[] = [];
    for (const call of result.toolCalls) {
      if (!call.outcome.success) continue;
      if (call.name !== 'query_service') continue;
      const payload = call.outcome.result as
        | {
            task_id?: string;
            query_id?: string;
            to_did?: string;
            service_name?: string;
          }
        | null;
      if (!payload || typeof payload.task_id !== 'string' || payload.task_id === '') continue;
      sources.push(payload.task_id);
      const args = call.arguments as { capability?: string } | null;
      const capability = typeof args?.capability === 'string' ? args.capability : '';
      const serviceName =
        typeof payload.service_name === 'string' && payload.service_name !== ''
          ? payload.service_name
          : (payload.to_did ?? 'service');
      serviceQueries.push({
        taskId: payload.task_id,
        queryId: typeof payload.query_id === 'string' ? payload.query_id : '',
        capability,
        serviceName,
      });
    }

    // Handle empty answers (e.g. budget-exceeded with no final text).
    let answer = result.answer !== '' ? result.answer : fallbackAnswer(result.finishReason);

    // Guard-scan post-process (Laws 1 + 4). Strips Anti-Her sentences
    // unconditionally; strips fabricated/consensus/unsolicited only
    // when the reasoning loop didn't call a verified-trust tool
    // (Trust Network data has already been vetted — over-redacting
    // paints legit attestations as hallucinated). If every sentence
    // gets stripped because of Anti-Her, the scanner substitutes the
    // human-redirect message. Fail-open — any exception returns the
    // raw answer.
    if (options.guardScanner !== undefined && answer !== '' && result.finishReason === 'completed') {
      try {
        const decision = await options.guardScanner({
          userPrompt: query,
          response: answer,
          toolsCalled: result.toolCalls.map((c) => c.name),
        });
        answer = decision.content;
      } catch {
        // Scanner outage. Keep the raw answer rather than block /ask.
      }
    }

    return { response: answer, sources, serviceQueries };
  };
}

/**
 * Metadata captured from a successful `query_service` tool call. The chat
 * orchestrator turns each dispatch into a status-tracked `service_query`
 * chat card; the WorkflowEventConsumer then patches the same card in
 * place when the response arrives. Replaces the prior pattern where the
 * LLM narrative + the workflow-event push produced two messages for one
 * query (race condition / clutter — Option D).
 */
export interface ServiceQueryDispatch {
  taskId: string;
  queryId: string;
  capability: string;
  serviceName: string;
}

function fallbackAnswer(reason: string): string {
  switch (reason) {
    case 'max_iterations':
    case 'max_tool_calls':
      return `I've hit my reasoning budget for this request. Try again with a more specific question.`;
    case 'cancelled':
      return `Request cancelled.`;
    case 'provider_error':
      return `Sorry — the reasoning service is unreachable right now. Try again in a moment.`;
    default:
      return `(no answer)`;
  }
}
