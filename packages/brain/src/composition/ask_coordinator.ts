/**
 * `createAskCoordinator` — single-call composer for the full Pattern A
 * `/api/v1/ask` chain.
 *
 * Packages the four primitives `AskRegistry` + `AskApprovalGateway` +
 * `AskApprovalResumer` + `createAskHandler` with all the cross-wiring
 * the brain-server (and any future mobile build target) would otherwise
 * have to repeat:
 *
 *   - `registry.onEvent` → `resumer.handle`
 *     (so `approval_resumed` events fire the resumer automatically)
 *   - `gateway.askRegistry` = registry
 *   - `resumer.executeFn` = the same Pattern B re-run function the
 *     handler uses (legacy fallback for records without paused state)
 *   - `resumer.resumeFromPausedFn` = a closure over `pipeline.buildToolsForAsk`
 *     + `resumeAgenticTurn` (the Pattern A primary path from 5.21-E)
 *
 * Returns a flat `{handleAsk, handleStatus, gateway, registry}` so a
 * Fastify route binding (or any other consumer) just plugs the four
 * pieces directly into HTTP routes — no wiring left to the caller.
 *
 * **Required**: `pipeline` must have `buildToolsForAsk` populated;
 * that means `buildAgenticAskPipeline` was called with an
 * `approvalManager` (5.21-E). The coordinator validates this at
 * construction time so a misconfigured caller fails loud, not at the
 * first inbound /ask.
 *
 * **The `executeFn` you pass in is what produces the answer** — the
 * coordinator wraps it in a Pattern B re-run path for asks that arrive
 * without paused state (e.g. legacy callers, restored-on-startup
 * records). The Pattern A path uses `resumeAgenticTurn` directly and
 * never calls `executeFn`. Most production setups will pass an
 * `executeFn` built via `buildAgenticExecuteFn` (also in this file).
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md task 5.21-F.
 */

import {
  AskApprovalGateway,
  type ApprovalSource,
  type ApprovalSourceStatus,
} from '../ask/ask_approval_gateway';
import { AskApprovalResumer } from '../ask/ask_approval_resumer';
import {
  createAskHandler,
  createAskStatusHandler,
  type AskAnswer,
  type AskExecuteFn,
  type AskFailure,
  type AskHandlerOptions,
  type AskSubmitResult,
  type AskStatusOutcome,
} from '../ask/ask_handler';
import {
  AskRegistry,
  InMemoryAskAdapter,
  type AskEvent,
  type AskPersistenceAdapter,
} from '../ask/ask_registry';
import {
  resumeAgenticTurn,
  runAgenticTurn,
  type AgenticLoopResult,
} from '../reasoning/agentic_loop';
import { formatCurrentTimeBlock } from '../reasoning/ask_handler';
import {
  applyForcedLanePrompt,
  enforceForcedLaneAnswer,
  forcedLaneIncompleteAnswer,
  scopeToolsForLane,
} from '../reasoning/forced_lane';


import type { AgenticAskPipeline } from './agentic_ask';
import type { PreFlightRetrievalResult } from './ask_retrieval_planner';
import type { VaultApprovalWorkflowClient } from './persona_guard';
import type { PreFlightRetrievalProvider } from '../reasoning/ask_handler';
import type { IntentSource } from '../reasoning/intent_classifier';
import type { WorkflowTask } from '@dina/core';

/** CoreClient surface `createAskCoordinator` needs for the approval gateway. */
export interface AskCoordinatorCoreClient extends VaultApprovalWorkflowClient {
  /** Drive a workflow task from `pending_approval` → `queued`. */
  approveWorkflowTask(id: string): Promise<WorkflowTask>;
  /** Cancel a workflow task from any active state → `cancelled`. */
  cancelWorkflowTask(id: string, reason?: string): Promise<WorkflowTask>;
}

export interface CreateAskCoordinatorOptions {
  /**
   * Pipeline produced by `buildAgenticAskPipeline({coreClient, ...})`.
   * MUST have `buildToolsForAsk` populated. The coordinator throws if not.
   */
  pipeline: AgenticAskPipeline;
  /**
   * CoreClient subset used as the `ApprovalSource` backing the gateway.
   * Vault-read approvals are workflow tasks — this replaces the old
   * in-memory `ApprovalManager`.
   */
  coreClient: AskCoordinatorCoreClient;
  /**
   * The Pattern B re-run path. Called when a record has no paused
   * state (e.g. an HTTP-path persona-resolver bail, or a record
   * restored after a crash). For Pattern A flows this never fires.
   *
   * Most callers build this via `buildAgenticExecuteFn(pipeline)`.
   */
  executeFn: AskExecuteFn;
  /**
   * System prompt for the agentic loop on resume. Same prompt
   * the handler used on the first turn; the resume continues with
   * the SAME prompt so the LLM transcript stays coherent.
   */
  systemPrompt: string;
  /** Persistence adapter — defaults to in-memory for tests. */
  adapter?: AskPersistenceAdapter;
  /** Pass-through to `createAskHandler` — fast-path window. */
  fastPathMs?: number;
  /** Pass-through to `AskRegistry` — TTL ceiling. */
  defaultTtlMs?: number;
  /** Diagnostic hook for the inner handler events. */
  onHandlerEvent?: AskHandlerOptions['onEvent'];
}

export interface AskCoordinator {
  handleAsk: (req: Parameters<ReturnType<typeof createAskHandler>>[0]) => Promise<AskSubmitResult>;
  handleStatus: (
    id: string,
    requesterDid?: string,
    sessionId?: string,
  ) => Promise<AskStatusOutcome>;
  gateway: AskApprovalGateway;
  registry: AskRegistry;
  resumer: AskApprovalResumer;
  /**
   * Subscribe to the registry's event stream. Returns an unsubscribe
   * disposer. Subscriber exceptions are swallowed so a misbehaving
   * listener can't block the resumer's wired callback.
   *
   * Why on the coordinator (not the registry): the registry's
   * `onEvent` is a single constructor callback already bound to the
   * resumer. Adding fan-out at the coordinator layer keeps the
   * registry simple while letting external bridges (e.g. the chat
   * orchestrator → late-answer delivery in 5.21-H) observe the same
   * events.
   */
  subscribe: (listener: (event: AskEvent) => void) => () => void;
}

export function createAskCoordinator(opts: CreateAskCoordinatorOptions): AskCoordinator {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('createAskCoordinator: options object is required');
  }
  if (!opts.pipeline) {
    throw new TypeError('createAskCoordinator: pipeline is required');
  }
  if (!opts.pipeline.buildToolsForAsk) {
    throw new TypeError(
      'createAskCoordinator: pipeline.buildToolsForAsk is missing — ensure buildAgenticAskPipeline received a coreClient',
    );
  }
  if (!opts.coreClient) {
    throw new TypeError('createAskCoordinator: coreClient is required');
  }
  if (typeof opts.executeFn !== 'function') {
    throw new TypeError('createAskCoordinator: executeFn must be a function');
  }
  if (typeof opts.systemPrompt !== 'string' || opts.systemPrompt === '') {
    throw new TypeError('createAskCoordinator: systemPrompt must be a non-empty string');
  }

  const buildToolsForAsk = opts.pipeline.buildToolsForAsk;
  const provider = opts.pipeline.provider;
  const systemPrompt = opts.systemPrompt;

  // Resumer needs both: resumer.handle is wired to registry.onEvent,
  // but the resumer can't be constructed until the registry exists.
  // Late-bind via a let-then-assign pattern (the registry's onEvent
  // closure resolves the resumer at call time, not construction).
  let resumer: AskApprovalResumer | null = null;

  // Fan-out for external subscribers (5.21-H bridge etc). Registry
  // takes a single `onEvent` callback; we dispatch from there to the
  // resumer (always) plus any subscribers added via `subscribe()`.
  const subscribers = new Set<(event: AskEvent) => void>();

  const registryOpts: {
    adapter: AskPersistenceAdapter;
    defaultTtlMs?: number;
    onEvent: (event: AskEvent) => void;
  } = {
    adapter: opts.adapter ?? new InMemoryAskAdapter(),
    onEvent: (event: AskEvent) => {
      void resumer?.handle(event);
      for (const fn of subscribers) {
        try {
          fn(event);
        } catch {
          /* swallow — one bad subscriber must not poison the fan-out */
        }
      }
    },
  };
  if (opts.defaultTtlMs !== undefined) registryOpts.defaultTtlMs = opts.defaultTtlMs;

  const registry = new AskRegistry(registryOpts);

  resumer = new AskApprovalResumer({
    registry,
    executeFn: opts.executeFn,
    resumeFromPausedFn: async (pausedState, ctx) => {
      // Re-apply the forced composer lane across an approval-resume so a forced
      // Services/Reviews ask stays enforced (tool scope + prompt). No-op for
      // plain Ask. forcedSources rides on the ask record (see ask_registry) so
      // it survives the pending_approval round-trip. The result gate + rich
      // answer shaping happen in `shapeCompletedAnswer` below (via the same
      // translateLoopResult the first-turn path uses).
      const tools = scopeToolsForLane(
        buildToolsForAsk({
          askId: ctx.askId,
          requesterDid: ctx.requesterDid,
        }),
        ctx.forcedSources,
      );
      // MT-15-I3 — same time-block prepend as the initial-turn path.
      // The resume goes back to the LLM with the previously-completed
      // tool result already in transcript, so a stale `now_iso` here
      // would mislead any follow-up tool call (e.g. a second
      // `schedule_reminder` after the user re-confirms).
      return resumeAgenticTurn({
        provider,
        tools,
        systemPrompt: applyForcedLanePrompt(
          `${formatCurrentTimeBlock()}\n\n${systemPrompt}`,
          ctx.forcedSources,
        ),
        pausedState,
      });
    },
    // On a completed resume, shape the FULL answer (text + serviceQueries +
    // reviewSource + missingCapabilities) AND apply the forced-lane gate, using
    // the exact same translateLoopResult the executeFn path uses — so a resumed
    // Services/Reviews answer keeps its cards instead of degrading to text-only.
    shapeCompletedAnswer: (result, ctx) => {
      const outcome = translateLoopResult(result, ctx.question, ctx.forcedSources);
      return outcome.kind === 'answer' ? outcome.answer : { text: result.answer };
    },
  });

  const gateway = new AskApprovalGateway({
    askRegistry: registry,
    approvalSource: workflowTaskAsSource(opts.coreClient),
  });

  const handlerOpts: AskHandlerOptions = {
    registry,
    executeFn: opts.executeFn,
  };
  if (opts.fastPathMs !== undefined) handlerOpts.fastPathMs = opts.fastPathMs;
  if (opts.onHandlerEvent !== undefined) handlerOpts.onEvent = opts.onHandlerEvent;
  const handleAsk = createAskHandler(handlerOpts);
  const handleStatus = createAskStatusHandler({ registry });

  const subscribe = (listener: (event: AskEvent) => void): (() => void) => {
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  };

  return { handleAsk, handleStatus, gateway, registry, resumer, subscribe };
}

/**
 * Build an `AskExecuteFn` that runs the agentic loop end-to-end with a
 * per-ask tool registry. The right default for production callers
 * that don't have a custom executeFn.
 *
 * Translation rules from `AgenticLoopResult` → `ExecuteOutcome`:
 *   - `completed`            → `{kind: 'answer', answer: {text}}`
 *   - `approval_required`    → `{kind: 'approval', approvalId,
 *     pausedStateJson}`. The handler persists both via
 *     `markPendingApproval(id, approvalId, pausedStateJson)`. On
 *     resume, the resumer's Pattern A path picks up the serialized
 *     `PausedAgenticState`, deserialises, and calls
 *     `resumeAgenticTurn` — zero re-LLM cost (the LLM continues from
 *     the bail point with the previously-completed tool result in
 *     transcript). Task 5.21-G.
 *   - `max_iterations` / `max_tool_calls` / `cancelled` /
 *     `provider_error` → `{kind: 'failure', failure: {kind, message}}`
 */
export function buildAgenticExecuteFn(args: {
  pipeline: AgenticAskPipeline;
  systemPrompt: string;
  /**
   * Optional pre-flight retrieval planner — same shape the non-
   * coordinator path consumes. When wired, runs once per /ask before
   * the agentic loop and prepends the formatted `[Retrieved context]`
   * block to the user message. Fail-soft: planner errors return
   * `null` and the loop runs unchanged.
   */
  preFlight?: PreFlightRetrievalProvider;
}): AskExecuteFn {
  const buildToolsForAsk = args.pipeline.buildToolsForAsk;
  if (!buildToolsForAsk) {
    throw new TypeError('buildAgenticExecuteFn: pipeline.buildToolsForAsk is missing');
  }
  const { pipeline, systemPrompt, preFlight } = args;
  return async (input) => {
    // Explicit composer lane (Services/Reviews): scope the tools to the lane's
    // allowlist (+ enrichment) so the loop physically cannot wander off-lane.
    // No-op for plain Ask. Shared with `makeAgenticAskHandler` via forced_lane.
    const tools = scopeToolsForLane(
      buildToolsForAsk({
        askId: input.id,
        requesterDid: input.requesterDid,
        ...(input.sessionId !== undefined && input.sessionId !== ''
          ? { sessionId: input.sessionId }
          : {}),
      }),
      input.forcedSources,
    );
    // MT-15-I3 — prepend the current-time block per turn so tools like
    // `schedule_reminder` can resolve relative phrases ("in 3 minutes",
    // "tomorrow at 9am") without forcing an LLM clarification round-
    // trip. Mirrors the same prepend in `makeAgenticAskHandler`. Done
    // here (rather than once at builder time) because a long-running
    // session must stay synced with wall-clock — `now_iso` baked in at
    // `buildAgenticExecuteFn` time would silently age across turns.
    // Then append the imperative forced-lane block when a lane is forced.
    const promptForTurn = applyForcedLanePrompt(
      `${formatCurrentTimeBlock()}\n\n${systemPrompt}`,
      input.forcedSources,
    );

    let userMessage = input.question;
    if (preFlight !== undefined) {
      let result: PreFlightRetrievalResult | null = null;
      try {
        // Pass the per-ask requester context so the planner gates
        // sensitive-vault pre-fetch (F-AGENT-VAULT-GATE round-3): an
        // external agent must not have sensitive personas pre-fetched
        // ungated; the owner (requesterDid === ownerDid) is unaffected.
        result = await preFlight(input.question, {
          requesterDid: input.requesterDid,
          ...(input.sessionId !== undefined && input.sessionId !== ''
            ? { sessionId: input.sessionId }
            : {}),
        });
      } catch {
        result = null;
      }
      if (result && result.block !== '') {
        userMessage = `${result.block}\n\nUser's question:\n${input.question}`;
      }
    }

    let result: AgenticLoopResult;
    try {
      const turnArgs: Parameters<typeof runAgenticTurn>[0] = {
        provider: pipeline.provider,
        tools,
        systemPrompt: promptForTurn,
        userMessage,
      };
      if (input.signal !== undefined) {
        turnArgs.options = { signal: input.signal };
      }
      result = await runAgenticTurn(turnArgs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'failure', failure: { kind: 'execute_crashed', message } };
    }
    return translateLoopResult(result, input.question, input.forcedSources);
  };
}

/**
 * Adapter — `AskCoordinatorCoreClient` (workflow tasks) → `ApprovalSource`
 * (gateway's interface).
 *
 * Workflow task status → ApprovalSourceStatus mapping:
 *   pending_approval → pending
 *   queued | running  → approved (operator approved, ready to consume)
 *   cancelled | failed → denied
 *   (not found)        → expired
 *   completed          → expired (already consumed)
 */
export function workflowTaskAsSource(core: AskCoordinatorCoreClient): ApprovalSource {
  return {
    async getStatus(id: string): Promise<ApprovalSourceStatus> {
      const task = await core.getWorkflowTask(id);
      if (task === null) return 'expired';
      const s = task.status;
      if (s === 'pending_approval') return 'pending';
      if (s === 'queued' || s === 'running') return 'approved';
      if (s === 'cancelled' || s === 'failed') return 'denied';
      // completed (already consumed) or other terminal
      return 'expired';
    },
    async approve(id: string): Promise<void> {
      await core.approveWorkflowTask(id);
    },
    async deny(id: string): Promise<void> {
      await core.cancelWorkflowTask(id, 'denied_by_operator');
    },
  };
}

export function translateLoopResult(
  result: AgenticLoopResult,
  query: string,
  forcedSources?: readonly IntentSource[],
): ReturnType<AskExecuteFn> extends Promise<infer R> ? R : never {
  if (result.finishReason === 'completed') {
    // Surface successful `query_service` dispatches alongside the
    // narrative so the chat-bridge (`coordinator_ask_handler`) can
    // post lifecycle-tracked messages instead of duplicating the
    // narrative + workflow-event push (the racey two-message pattern).
    const serviceQueries = extractServiceQueriesFromToolCalls(result.toolCalls);
    const missingCapabilities = extractMissingCapabilitiesFromToolCalls(
      result.toolCalls,
      query,
      serviceQueries.length > 0,
    );
    // Forced-lane result gate (Services/Reviews): the answer MUST come from the
    // lane or be a clean no-result/outage reply, never general knowledge. Shared
    // with `makeAgenticAskHandler` so both ask paths enforce identically. No-op
    // for plain Ask. This bakes the gated text into the PERSISTED answer, so the
    // fast-path 200 AND the deferred/async delivery both carry it.
    const gatedText = enforceForcedLaneAnswer({
      forcedSources,
      answer: result.answer,
      serviceQueryCount: serviceQueries.length,
      toolCalls: result.toolCalls,
    });
    const answer: AskAnswer = { text: gatedText };
    if (serviceQueries.length > 0) {
      answer.serviceQueries = serviceQueries;
    } else if (missingCapabilities.length > 0) {
      answer.missingCapabilities = missingCapabilities;
    }
    // Provenance for the chat source pill: how many network ("ranked") reviews
    // from other Dinas informed this answer. The mobile bubble turns the count
    // into a label (Ranked reviews ≥ 3, Network reviews 1–2). 0 ⇒ no pill.
    const reviewCount = extractReviewCountFromToolCalls(result.toolCalls);
    if (reviewCount > 0) {
      answer.reviewSource = `reviewsrc:${reviewCount}`;
    }
    return { kind: 'answer', answer };
  }
  if (result.finishReason === 'approval_required') {
    if (!result.pausedState) {
      return {
        kind: 'failure',
        failure: {
          kind: 'paused_state_missing',
          message: 'agentic loop returned approval_required without pausedState',
        },
      };
    }
    return {
      kind: 'approval',
      approvalId: result.pausedState.approvalId,
      pausedStateJson: JSON.stringify(result.pausedState),
    };
  }
  // For provider_error specifically, surface the underlying message
  // the loop captured so the chat-bridge can render a diagnostic
  // line instead of the generic "I ran into a problem reaching the AI
  // provider" string. Lets operators on platforms where JS console
  // logs aren't reachable (iOS sim) see WHY the call failed without
  // a custom debug build.
  if (result.finishReason === 'provider_error' && result.providerErrorMessage) {
    return {
      kind: 'failure',
      failure: withMissingCapabilityDetail(
        {
          kind: 'provider_error',
          message: result.providerErrorMessage,
          // Structured classification (credits / key / …) so downstream
          // consumers (mobile key-health pill) can react without
          // string-matching the human template.
          ...(result.providerErrorKind !== undefined
            ? { detail: { providerErrorKind: result.providerErrorKind } }
            : {}),
        },
        result.toolCalls,
        query,
      ),
    };
  }
  // Forced-lane budget bail. When a forced Services/Reviews turn runs out of
  // iterations or tool calls (the model kept searching instead of deciding —
  // see forced_lane PROVIDER_SERVICES_ROUTING_BLOCK "DECIDE after discovery"),
  // return a lane-framed "couldn't finish" answer instead of the generic
  // "Try a simpler query" failure. We do NOT mint a missing_capability card:
  // discovery may have succeeded (non-empty provider results), so this is a
  // convergence failure, not a "no such capability" case. Plain Ask is
  // unaffected — forcedLaneIncompleteAnswer returns null for a non-forced turn.
  if (result.finishReason === 'max_iterations' || result.finishReason === 'max_tool_calls') {
    const laneText = forcedLaneIncompleteAnswer(forcedSources);
    if (laneText !== null) {
      return { kind: 'answer', answer: { text: laneText } };
    }
  }

  return {
    kind: 'failure',
    failure: withMissingCapabilityDetail(
      {
        kind: result.finishReason,
        message: `agentic loop terminated with ${result.finishReason}`,
      },
      result.toolCalls,
      query,
    ),
  };
}

/**
 * Mine successful `query_service` tool calls out of the agentic loop's
 * tool-call log. Each successful invocation contributes one
 * `ServiceQueryDispatch` — `taskId`, `queryId`, capability, and the
 * provider's display name — keyed off the orchestrator's response so
 * the chat surface can post a lifecycle-tracked card per dispatch.
 *
 * Mirrors the logic in `reasoning/ask_handler.ts` (the legacy
 * non-coordinator path); both surfaces converge on the same
 * `ServiceQueryDispatch` shape so downstream consumers stay
 * single-typed.
 */
function extractServiceQueriesFromToolCalls(toolCalls: AgenticLoopResult['toolCalls']): {
  taskId: string;
  queryId: string;
  capability: string;
  serviceName: string;
  providerDid?: string;
  params?: Record<string, unknown>;
}[] {
  const out: {
    taskId: string;
    queryId: string;
    capability: string;
    serviceName: string;
    providerDid?: string;
    params?: Record<string, unknown>;
  }[] = [];
  for (const call of toolCalls) {
    if (call.name !== 'query_service') continue;
    if (!call.outcome.success) continue;
    const payload = call.outcome.result as {
      task_id?: string;
      query_id?: string;
      to_did?: string;
      service_name?: string;
    } | null;
    if (!payload || typeof payload.task_id !== 'string' || payload.task_id === '') continue;
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
    out.push({
      taskId: payload.task_id,
      queryId: typeof payload.query_id === 'string' ? payload.query_id : '',
      capability,
      serviceName,
      providerDid: typeof payload.to_did === 'string' ? payload.to_did : undefined,
      params,
    });
  }
  return out;
}

/**
 * Count the network reviews that informed the answer, by mining successful
 * `search_peerlens` tool calls. A `resolve` contributes its attestation total;
 * a `search` contributes its returned-row count. Drives the chat source pill
 * (ranked vs network) in `coordinator_ask_handler` → the mobile dina bubble.
 */
function extractReviewCountFromToolCalls(toolCalls: AgenticLoopResult['toolCalls']): number {
  let count = 0;
  for (const call of toolCalls) {
    if (call.name !== 'search_peerlens' || !call.outcome.success) continue;
    const r = call.outcome.result as {
      subject?: { attestationSummary?: { total?: number } | null } | null;
      search?: { results?: unknown[] } | null;
    } | null;
    if (r === null) continue;
    const subjectTotal =
      typeof r.subject?.attestationSummary?.total === 'number'
        ? r.subject.attestationSummary.total
        : 0;
    const searchCount = Array.isArray(r.search?.results) ? r.search.results.length : 0;
    count += subjectTotal + searchCount;
  }
  return count;
}

interface MissingCapabilityPayload {
  capability: string;
  query?: string;
}

function withMissingCapabilityDetail(
  failure: AskFailure,
  toolCalls: AgenticLoopResult['toolCalls'],
  query: string,
): AskFailure {
  const missingCapabilities = extractMissingCapabilitiesFromToolCalls(toolCalls, query, false);
  if (missingCapabilities.length === 0) return failure;
  return {
    ...failure,
    detail: {
      ...(failure.detail ?? {}),
      missingCapabilities,
    },
  };
}

function extractMissingCapabilitiesFromToolCalls(
  toolCalls: AgenticLoopResult['toolCalls'],
  query: string,
  hasServiceQuery: boolean,
): MissingCapabilityPayload[] {
  if (hasServiceQuery) return [];

  const out: MissingCapabilityPayload[] = [];
  const seen = new Set<string>();
  const add = (capability: string | null): void => {
    const normalized = capability?.trim();
    if (normalized === undefined || normalized === '' || seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ capability: normalized, query });
  };

  for (const call of toolCalls) {
    if (call.name === 'search_capabilities' && call.outcome.success) {
      add(missingCapabilityFromDiscoveryCall(call.arguments, call.outcome.result, query));
      continue;
    }
    if (call.name === 'search_provider_services' && call.outcome.success) {
      add(missingCapabilityFromSearchCall(call.arguments, call.outcome.result, query));
      continue;
    }
    if (call.name === 'search_provider_services' && !call.outcome.success) {
      add(
        missingCapabilityFromFailedSearchCall(
          call.arguments,
          'error' in call.outcome ? call.outcome.error : '',
          query,
        ),
      );
    }
  }

  if (out.length === 0 && triedServiceDiscovery(toolCalls)) {
    add(extractNamespacedCapability(query));
  }

  return out;
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

function triedServiceDiscovery(toolCalls: AgenticLoopResult['toolCalls']): boolean {
  return toolCalls.some(
    (call) =>
      call.name === 'search_capabilities' ||
      call.name === 'search_provider_services' ||
      call.name === 'query_service',
  );
}

function extractNamespacedCapability(text: string): string | null {
  const match = text.toLowerCase().match(/\b[a-z0-9]+(?:\.[a-z0-9_]+)+\b/);
  return match?.[0] ?? null;
}
