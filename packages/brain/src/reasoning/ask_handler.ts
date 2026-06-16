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

import {
  makeMissingCapabilityNotice,
  type AskCommandHandler,
  type MissingCapabilityNotice,
} from '../chat/orchestrator';
import { VAULT_CONTEXT } from '../llm/prompts';

import { runAgenticTurn, type AgenticLoopOptions } from './agentic_loop';
import {
  applyForcedLanePrompt,
  enforceForcedLaneAnswer,
  isReviewsLane,
  isServicesLane,
  scopeToolsForLane,
  PROVIDER_SERVICES_ROUTING_BLOCK,
} from './forced_lane';
import {
  IntentClassifier,
  type IntentClassification,
} from './intent_classifier';

import type { GuardScanner } from './guard_scanner';
import type { ToolRegistry } from './tool_registry';
import type { PreFlightRetrievalResult } from '../composition/ask_retrieval_planner';
import type { LLMProvider } from '../llm/adapters/provider';

/**
 * Pre-flight retrieval provider — runs ONCE per ask before the
 * agentic loop. The host wires it (see
 * `composition/ask_retrieval_planner.ts` for shape + builders).
 * Resolves to a formatted `[Retrieved context]` block + the
 * underlying plan; the handler prepends the block to the user
 * message. Fail-soft: implementations should never throw; they
 * return `null` (or an empty block) when planning fails.
 */
/**
 * Per-ask context the coordinator passes so the pre-flight planner can
 * gate sensitive-vault pre-fetch the same way the on-demand vault tool
 * does (F-AGENT-VAULT-GATE round-3). Absent on the legacy
 * `makeAgenticAskHandler` path, which has no per-ask DID → allow-all.
 */
export interface PreFlightContext {
  /** DID of whoever is asking (agent did:key, or the owner's did:plc). */
  requesterDid?: string;
  /** dina-agent CLI session id, for the session-grant shortcut. */
  sessionId?: string;
}

export type PreFlightRetrievalProvider = (
  question: string,
  ctx?: PreFlightContext,
) => Promise<PreFlightRetrievalResult | null>;

export interface AgenticAskHandlerOptions {
  provider: LLMProvider;
  tools: ToolRegistry;
  /** Override the default service-query system prompt. */
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
  /**
   * Optional pre-flight retrieval planner — runs once before the
   * reasoning loop and prepends a `[Retrieved context]` block to the
   * user message so the loop starts with the right vault rows (and
   * `find_person` matches) already in context. Use this to bridge
   * cross-domain gaps (e.g. surfacing a finance-vault budget on a
   * birthday-gift question that never mentions money).
   *
   * Fail-soft: the provider returns `null` or an empty block on any
   * upstream issue; the loop runs unchanged.
   */
  preFlight?: PreFlightRetrievalProvider;
  /** Optional sink for diagnostics — last turn's trace, usage, etc. */
  onTurn?: (trace: {
    query: string;
    answer: string;
    toolCalls: { name: string; outcome: { success: boolean } }[];
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

// Forced-lane enforcement (system-prompt block, tool allowlist, result gate)
// lives in `./forced_lane` — the SINGLE source of truth shared with the
// production coordinator path (composition/ask_coordinator.ts). Re-exported here
// so existing importers (tests, callers) keep resolving them from ask_handler.
export {
  PROVIDER_SERVICES_ROUTING_BLOCK,
  PEERLENS_ROUTING_BLOCK,
  formatForcedLaneBlock,
} from './forced_lane';

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

/**
 * Render the "Current context" block prepended to every agentic-loop
 * system prompt (MT-15-I3).
 *
 * Why this exists: tools like `schedule_reminder` push date/time
 * resolution onto the LLM ("convert 'in 3 minutes' to a concrete
 * `due_at` BEFORE calling"). Without an injected reference time, the
 * LLM has no anchor — it correctly responds with "I don't know what
 * time it is right now" and forces the user into a clarification
 * round-trip. Surfacing `now` at the system-prompt level fixes that
 * for every tool that needs temporal grounding (reminders, geocode-
 * with-time-of-day, "is it past business hours" judgements, etc.).
 *
 * Format mirrors the rest of the system prompt: short, scannable,
 * key/value pairs the LLM can quote when justifying a time choice.
 *
 * Pure for testability — accepts an injected clock (defaults to
 * `Date.now`) so tests can assert deterministic output.
 */
export function formatCurrentTimeBlock(nowMsFn: () => number = Date.now): string {
  const now = new Date(nowMsFn());
  let timezone = 'UTC';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    // Some hosts (older Hermes) don't expose `resolvedOptions().timeZone` —
    // fall back to UTC. The `now_iso` value still uses the host's offset
    // so all three lines stay self-consistent.
  }
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  return [
    'Current context (use these when the user mentions a relative time):',
    `- now_iso: ${now.toISOString()}`,
    `- timezone: ${timezone}`,
    `- weekday: ${weekday}`,
  ].join('\n');
}

export function makeAgenticAskHandler(options: AgenticAskHandlerOptions): AskCommandHandler {
  const baseSystemPrompt = options.systemPrompt ?? DEFAULT_ASK_SYSTEM_PROMPT;
  return async (query, context) => {
    // MT-15-I3: prepend the current time so tools like
    // `schedule_reminder` can resolve relative phrases ("in 3 minutes",
    // "tomorrow at 9am") without forcing the user into a clarification
    // round-trip. Recomputed per turn so a long-running session stays
    // synced with wall-clock — the LLM should never anchor against a
    // stale "now". Pure helper, easy to mock in tests.
    const timeBlock = formatCurrentTimeBlock();
    let systemPrompt = `${timeBlock}\n\n${baseSystemPrompt}`;

    // Explicit composer lane (Services/Reviews): force the source, SKIP the
    // classifier, and append the IMPERATIVE lane block. The lane is bound below
    // by the per-mode tool allowlist + the result-validation gate. When there
    // is no forced source, run the classifier (advisory nudge) as before.
    const forcedSources = context?.forcedSources;
    const isServicesMode = isServicesLane(forcedSources);
    const isReviewsMode = isReviewsLane(forcedSources);
    if (isServicesMode || isReviewsMode) {
      systemPrompt = applyForcedLanePrompt(systemPrompt, forcedSources);
    } else if (options.intentClassifier !== undefined) {
      // WM-BRAIN-05: run the classifier first (fail-open) so the
      // reasoning agent gets a routing nudge. No classifier → skip.
      let hint: IntentClassification;
      try {
        hint = await options.intentClassifier.classify(query);
      } catch {
        hint = IntentClassifier.default();
      }
      const block = formatIntentHintBlock(hint);
      if (block !== '') {
        systemPrompt = `${systemPrompt}\n\n${block}`;
      }
    }

    // Pre-flight retrieval planner — turn the question into a
    // structured plan (which personas + people to pre-fetch), execute
    // the plan in parallel, and prepend the result to the user
    // message. Fail-soft: any error swallowed at the provider, returns
    // `null`, loop runs unchanged.
    let userMessage = query;
    if (options.preFlight !== undefined) {
      let preFlight: PreFlightRetrievalResult | null = null;
      try {
        preFlight = await options.preFlight(query);
      } catch {
        preFlight = null;
      }
      if (preFlight && preFlight.block !== '') {
        userMessage = `${preFlight.block}\n\nUser's question:\n${query}`;
      }
    }

    // Lane tool policy: scope the loop to the lane's tools + enrichment helpers
    // for explicit modes, so it physically cannot wander off-lane. Enrichment
    // tools stay in scope (invariant 6.6). Ask (no forced source) gets the full
    // registry unchanged.
    const toolsForTurn = scopeToolsForLane(options.tools, forcedSources);

    const result = await runAgenticTurn({
      provider: options.provider,
      tools: toolsForTurn,
      systemPrompt,
      userMessage,
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
    const missingCapabilities: MissingCapabilityNotice[] = [];
    const seenMissingCapabilities = new Set<string>();
    for (const call of result.toolCalls) {
      if (call.name === 'search_capabilities' && call.outcome.success) {
        const capability = missingCapabilityFromDiscoveryCall(
          call.arguments,
          call.outcome.result,
          query,
        );
        if (capability !== null && !seenMissingCapabilities.has(capability)) {
          seenMissingCapabilities.add(capability);
          missingCapabilities.push(makeMissingCapabilityNotice(capability, query));
        }
        continue;
      }
      if (call.name === 'search_provider_services' && call.outcome.success) {
        const capability = missingCapabilityFromSearchCall(
          call.arguments,
          call.outcome.result,
          query,
        );
        if (capability !== null && !seenMissingCapabilities.has(capability)) {
          seenMissingCapabilities.add(capability);
          missingCapabilities.push(makeMissingCapabilityNotice(capability, query));
        }
        continue;
      }
      if (call.name === 'search_provider_services' && !call.outcome.success) {
        const error = 'error' in call.outcome ? call.outcome.error : '';
        const capability = missingCapabilityFromFailedSearchCall(call.arguments, error, query);
        if (capability !== null && !seenMissingCapabilities.has(capability)) {
          seenMissingCapabilities.add(capability);
          missingCapabilities.push(makeMissingCapabilityNotice(capability, query));
        }
        continue;
      }
      if (!call.outcome.success) continue;
      if (call.name !== 'query_service') continue;
      const payload = call.outcome.result as {
        task_id?: string;
        query_id?: string;
        to_did?: string;
        service_name?: string;
      } | null;
      if (!payload || typeof payload.task_id !== 'string' || payload.task_id === '') continue;
      sources.push(payload.task_id);
      const args = call.arguments as { capability?: string; params?: unknown } | null;
      const capability = typeof args?.capability === 'string' ? args.capability : '';
      const params =
        args?.params !== undefined && args.params !== null && typeof args.params === 'object'
          ? (args.params as Record<string, unknown>)
          : undefined;
      const serviceName =
        typeof payload.service_name === 'string' && payload.service_name !== ''
          ? payload.service_name
          : (payload.to_did ?? 'service');
      serviceQueries.push({
        taskId: payload.task_id,
        queryId: typeof payload.query_id === 'string' ? payload.query_id : '',
        capability,
        serviceName,
        providerDid: typeof payload.to_did === 'string' ? payload.to_did : undefined,
        params,
      });
    }

    // Handle empty answers (e.g. budget-exceeded with no final text).
    let answer = result.answer !== '' ? result.answer : fallbackAnswer(result.finishReason);

    // Guard-scan post-process (Laws 1 + 4). Strips Anti-Her sentences
    // unconditionally; strips fabricated/consensus/unsolicited only
    // when the reasoning loop didn't call a verified-trust tool
    // (PeerLens data has already been vetted — over-redacting
    // paints legit attestations as hallucinated). If every sentence
    // gets stripped because of Anti-Her, the scanner substitutes the
    // human-redirect message. Fail-open — any exception returns the
    // raw answer.
    if (
      options.guardScanner !== undefined &&
      answer !== '' &&
      result.finishReason === 'completed'
    ) {
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

    if (missingCapabilities.length === 0 && serviceQueries.length === 0) {
      const capability = missingCapabilityFromAskFallback(query, result.toolCalls);
      if (capability !== null) {
        missingCapabilities.push(makeMissingCapabilityNotice(capability, query));
      }
    }

    // Lane enforcement (explicit composer modes): the answer MUST come from the
    // chosen lane, never general knowledge (docs/COMPOSER_MODES_DESIGN.md 6.5).
    // The tool allowlist + imperative directive bias the loop; this gate is the
    // hard guarantee. Shared with the production coordinator path so both enforce
    // identically (incl. outage-vs-absence). No-op when no lane is forced.
    answer = enforceForcedLaneAnswer({
      forcedSources,
      answer,
      serviceQueryCount: serviceQueries.length,
      toolCalls: result.toolCalls,
    });

    return { response: answer, sources, serviceQueries, missingCapabilities };
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
  /** The provider Dina's DID (`to_did`). Surfaced in the handoff card. */
  providerDid?: string;
  /** Capability params the query carried — summarised in the card. */
  params?: Record<string, unknown>;
}

function missingCapabilityFromSearchCall(
  args: Record<string, unknown>,
  result: unknown,
  query: string,
): string | null {
  if (!Array.isArray(result) || result.length !== 0) return null;
  const explicit = extractNamespacedCapability(query);
  if (explicit !== null) return explicit;
  const raw = args.capability;
  if (typeof raw !== 'string') return null;
  const capability = raw.trim();
  return capability !== '' ? capability : null;
}

function missingCapabilityFromFailedSearchCall(
  args: Record<string, unknown>,
  error: string,
  query: string,
): string | null {
  if (!/AppView responded 400/i.test(error)) return null;
  const explicit = extractNamespacedCapability(query);
  if (explicit !== null) return explicit;
  const raw = args.capability;
  if (typeof raw !== 'string') return null;
  const capability = raw.trim();
  return extractNamespacedCapability(capability) ?? (capability !== '' ? capability : null);
}

function missingCapabilityFromDiscoveryCall(
  args: Record<string, unknown>,
  result: unknown,
  query: string,
): string | null {
  if (!isEmptyCapabilityDiscovery(result)) return null;
  const intent = typeof args.intent === 'string' ? args.intent : '';
  return extractNamespacedCapability(`${intent} ${query}`);
}

function isEmptyCapabilityDiscovery(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const capabilities = (result as { capabilities?: unknown }).capabilities;
  return Array.isArray(capabilities) && capabilities.length === 0;
}

function extractNamespacedCapability(text: string): string | null {
  const match = text.toLowerCase().match(/\b[a-z0-9]+(?:\.[a-z0-9_]+)+\b/);
  return match?.[0] ?? null;
}

function missingCapabilityFromAskFallback(
  query: string,
  toolCalls: { name: string; outcome: { success: boolean } }[],
): string | null {
  const triedServiceDiscovery = toolCalls.some(
    (call) =>
      call.name === 'search_capabilities' ||
      call.name === 'search_provider_services' ||
      call.name === 'query_service',
  );
  if (!triedServiceDiscovery) return null;
  return extractNamespacedCapability(query);
}

function fallbackAnswer(reason: string): string {
  switch (reason) {
    case 'max_iterations':
    case 'max_tool_calls':
      return `I've hit my reasoning budget for this request. Try again with a more specific question.`;
    case 'cancelled':
      return `Request cancelled.`;
    case 'provider_error':
      return `Sorry, the reasoning service is unreachable right now. Try again in a moment.`;
    default:
      return `(no answer)`;
  }
}
