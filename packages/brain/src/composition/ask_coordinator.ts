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

import { askConversation } from '../a2a/conversation';
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
import { buildTurnHistory, fenceNonce, outsideDataRule, recentTurnsBlock } from '../chat/history';
import { crisisReply, humanConnectionDirective, isCompanyOffer, peoplePointerLine } from '../guardian/anti_her';
import { classifyDeterministic, HUMAN_CONNECTION_KINDS, preScreenMessage, type AntiHerCategory } from '../guardian/anti_her_classify';
import { checkActionClaims, receiptsFromToolCalls } from '../guardian/action_claims';
import { checkRegulated, evidenceFromToolResults } from '../guardian/regulated';
import { removeSentences, scanResponse, splitSentences, stripViolations } from '../guardian/guard_scan';
import { earlierReceipts, storeTurnReceipts } from '../chat/turn_receipts';
import { reloadLoadedThreads } from '../chat/thread';
import {
  resumeAgenticTurn,
  runAgenticTurn,
  type AgenticLoopResult,
} from '../reasoning/agentic_loop';
import { formatCurrentTimeBlock, formatIntentHintBlock } from '../reasoning/ask_handler';
import {
  applyForcedLanePrompt,
  enforceForcedLaneAnswer,
  forcedLaneIncompleteAnswer,
  isReviewsLane,
  isServicesLane,
  scopeToolsForLane,
} from '../reasoning/forced_lane';
import { IntentClassifier } from '../reasoning/intent_classifier';
import { buildComparisonCardSpec } from '../service/comparison_card_spec';

import type { AgenticAskPipeline } from './agentic_ask';
import type { PreFlightRetrievalResult } from './ask_retrieval_planner';
import type { VaultApprovalWorkflowClient } from './persona_guard';
import type { ChatMessage as LLMMessage } from '../llm/adapters/provider';
import type { PreFlightRetrievalProvider } from '../reasoning/ask_handler';
import type { IntentSource } from '../reasoning/intent_classifier';
import type { QuoteRequestDraftWire } from '../reasoning/quote_request_tool';
import type { WorkflowTask } from '@dina/core';

/** CoreClient surface `createAskCoordinator` needs for the approval gateway. */
export interface AskCoordinatorCoreClient extends VaultApprovalWorkflowClient {
  /** Drive a workflow task from `pending_approval` → `queued`. */
  approveWorkflowTask(id: string, opts?: { scope?: 'single' | 'session' }): Promise<WorkflowTask>;
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
      // An ask from anyone but the owner reads only under Core's authority
      // (REAL_LIFE_FIXES §0.1 B); a record that lost it never resumes as
      // the owner.
      if (refusesWithoutAuthority(opts.pipeline, ctx.requesterDid, ctx.askAuthority)) {
        throw new Error('missing_ask_authority');
      }
      const tools = scopeToolsForLane(
        buildToolsForAsk({
          askId: ctx.askId,
          requesterDid: ctx.requesterDid,
          ...(ctx.sessionId !== undefined && ctx.sessionId !== '' ? { sessionId: ctx.sessionId } : {}),
          ...(ctx.askAuthority !== undefined && ctx.askAuthority !== ''
            ? { askAuthority: ctx.askAuthority }
            : {}),
          ...askConversation(ctx.askId, ctx.conversation),
        }),
        ctx.forcedSources,
      );
      // MT-15-I3 — same time-block prepend as the initial-turn path.
      // The resume goes back to the LLM with the previously-completed
      // tool result already in transcript, so a stale `now_iso` here
      // would mislead any follow-up tool call (e.g. a second
      // `schedule_reminder` after the user re-confirms).
      const result = await resumeAgenticTurn({
        provider,
        tools,
        systemPrompt: await buildPromptForTurn(
          opts.pipeline,
          systemPrompt,
          ctx.question,
          ctx.forcedSources,
          askConversation(ctx.askId, ctx.conversation).releaseSession,
          ctx.askAuthority,
        ),
        pausedState,
      });
      return guardCompletedResult(opts.pipeline, result, ctx.question, classifyDeterministic(ctx.question).category, ctx.conversation);
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
    // Law 4 must run before classification, retrieval, tools, or the main LLM.
    // The legacy/direct Ask path already does this in chat_reasoning; mobile and
    // Home Node use this coordinator path in production, so enforce the same
    // invariant here rather than relying on the model to redirect itself.
    const conversation = askConversation(input.id, input.conversation);
    // An ask from anyone but the owner must carry Core's ask authority
    // (REAL_LIFE_FIXES §0.1 B). Without it, refuse before any read: a
    // missing authority must never mean owner access.
    if (refusesWithoutAuthority(pipeline, input.requesterDid, input.askAuthority)) {
      return {
        kind: 'failure',
        failure: { kind: 'missing_ask_authority', message: 'agent ask has no Core authority' },
      };
    }
    // Conversation memory (REAL_LIFE_FIXES §1): the owner's chat turns carry
    // the thread's earlier turns. Agent asks (Core authority) get none: they
    // have sessions, not the owner's conversation.
    let history: LLMMessage[] = [];
    let fence = '';
    const isOwnerChat =
      input.conversation !== undefined &&
      input.conversation !== '' &&
      (input.askAuthority === undefined || input.askAuthority === '') &&
      (pipeline.ownerDid === undefined || input.requesterDid === pipeline.ownerDid);
    if (isOwnerChat) {
      // REAL_LIFE_FIXES_2 §4.4: after a forget, Brain's thread copies still
      // hold what Core deleted; reload them before reading history.
      await syncForgetEpoch(pipeline);
      fence = fenceNonce();
      try {
        history = await buildTurnHistory(input.conversation!, {
          excludeQuestion: input.question,
          nonce: fence,
        });
      } catch {
        return {
          kind: 'failure',
          failure: {
            kind: 'history_unavailable',
            message: 'could not load this conversation; try again',
          },
        };
      }
    }
    const recentTurns = recentTurnsBlock(history);

    // Law 4 (REAL_LIFE_FIXES §8). Acute risk gets a fixed crisis reply,
    // never model text. Other emotional messages go ahead with warmth and an
    // instruction to help the user reach real people, named from their own
    // contacts — a canned reply that ends the talk is a known failure mode.
    const preScreen = await preScreenMessage(input.question);
    let humanDirective = '';
    if (preScreen.category === 'acute_risk' || HUMAN_CONNECTION_KINDS.has(preScreen.category)) {
      const names = await closeContactNames(pipeline);
      if (preScreen.category === 'acute_risk') {
        return { kind: 'answer', answer: { text: crisisReply(names) } };
      }
      humanDirective = humanConnectionDirective(preScreen.category, names);
    }

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
        ...(input.askAuthority !== undefined && input.askAuthority !== ''
          ? { askAuthority: input.askAuthority }
          : {}),
        ...conversation,
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
    let relevantPersonas: string[] = [];
    let promptForTurn = await buildPromptForTurn(
      pipeline,
      systemPrompt,
      input.question,
      input.forcedSources,
      conversation.releaseSession,
      input.askAuthority,
      recentTurns,
      (p) => {
        relevantPersonas = p;
      },
    );
    if (history.length > 0) promptForTurn = `${promptForTurn}\n\n${outsideDataRule(fence)}`;
    if (humanDirective !== '') promptForTurn = `${promptForTurn}\n\n${humanDirective}`;
    // REAL_LIFE_FIXES_2 §7.2: an agent's question is answered from the
    // owner's vault before general knowledge, so a question about the
    // owner's work reaches the vault (and Core asks the owner for a persona
    // the agent may not read) instead of a confident public answer.
    if (input.askAuthority !== undefined && input.askAuthority !== '') {
      promptForTurn = `${promptForTurn}\n\n${AGENT_VAULT_FIRST_RULE}`;
    }

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
          ...(input.askAuthority !== undefined && input.askAuthority !== ''
            ? { askAuthority: input.askAuthority }
            : {}),
          ...(recentTurns !== '' ? { recentTurns } : {}),
          releaseSession: conversation.releaseSession,
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
        ...(history.length > 0 ? { initialMessages: history } : {}),
      };
      // REAL_LIFE_FIXES_2 §7.2: an agent's question searches the owner's
      // vault first, deterministically: one search across what the agent may
      // read; only if that finds nothing, a named search of each vault the
      // classifier judged relevant (a vault the agent may not read raises the
      // owner's card).
      if (input.askAuthority !== undefined && input.askAuthority !== '') {
        turnArgs.seedToolCalls = [
          { name: 'vault_search', arguments: { query: input.question } },
          ...relevantPersonas
            .filter((p) => typeof p === 'string' && p !== '')
            .slice(0, 2)
            .map((persona) => ({ name: 'vault_search', arguments: { query: input.question, persona }, onlyIfNothingFound: true })),
        ];
      }
      if (input.signal !== undefined) {
        turnArgs.options = { signal: input.signal };
      }
      result = await runAgenticTurn(turnArgs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'failure', failure: { kind: 'execute_crashed', message } };
    }
    // Evidence for the regulated check (REAL_LIFE_FIXES_2 §6.2): the owner's
    // own turns and the retrieval block, never Dina's earlier replies.
    const evidence = [
      ...userMessage.split('\n'),
      ...history.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : '')),
    ];
    result = await guardCompletedResult(pipeline, result, input.question, preScreen.category, isOwnerChat ? input.conversation : undefined, evidence);
    return translateLoopResult(result, input.question, input.forcedSources);
  };
}

/** Up to three close contacts' names, for Law 4 (never fails the turn). */
async function closeContactNames(pipeline: AgenticAskPipeline): Promise<string[]> {
  try {
    return (await pipeline.closeContacts?.()) ?? [];
  } catch {
    return [];
  }
}

/**
 * True when an ask must be refused for lacking Core's ask authority: the
 * pipeline knows the owner, the requester is someone else, and no authority
 * came with the ask (REAL_LIFE_FIXES §0.1 B).
 */
function refusesWithoutAuthority(
  pipeline: AgenticAskPipeline,
  requesterDid: string,
  askAuthority: string | undefined,
): boolean {
  const owner = pipeline.ownerDid;
  if (owner === undefined || owner === '') return false;
  if (requesterDid === owner) return false;
  return askAuthority === undefined || askAuthority === '';
}

/** Build the same per-turn prompt used by the direct agentic Ask handler. */
async function buildPromptForTurn(
  pipeline: AgenticAskPipeline,
  baseSystemPrompt: string,
  question: string,
  forcedSources: readonly IntentSource[] | undefined,
  releaseSession: string,
  askAuthority?: string,
  recentTurns?: string,
  /** Receives the vaults the intent classifier judged relevant. */
  onRelevantPersonas?: (personas: string[]) => void,
): Promise<string> {
  let ownerZone: string | undefined;
  try {
    ownerZone = pipeline.ownerTimeZone !== undefined ? await pipeline.ownerTimeZone() : undefined;
  } catch {
    ownerZone = undefined;
  }
  let prompt = `${formatCurrentTimeBlock(Date.now, ownerZone)}\n\n${baseSystemPrompt}`;

  // Explicit lanes are imperative and skip advisory classification.
  if (isServicesLane(forcedSources) || isReviewsLane(forcedSources)) {
    return applyForcedLanePrompt(prompt, forcedSources);
  }

  const classifier = pipeline.handlerOptions.intentClassifier;
  if (classifier === undefined) return prompt;

  let hint;
  try {
    hint = await classifier.classify(question, {
      releaseSession,
      ...(askAuthority !== undefined && askAuthority !== '' ? { askAuthority } : {}),
      ...(recentTurns !== undefined && recentTurns !== '' ? { recentTurns } : {}),
    });
  } catch {
    hint = IntentClassifier.default();
  }
  onRelevantPersonas?.(Array.isArray(hint.relevant_personas) ? hint.relevant_personas : []);
  const block = formatIntentHintBlock(hint);
  if (block !== '') prompt = `${prompt}\n\n${block}`;
  return prompt;
}

/**
 * Apply the output guard before result/lane shaping. The model-based guard
 * fails open; the fixed Law 4 phrase suites (therapy talk, engagement hooks,
 * simulated intimacy) then run on every completed answer as a deterministic
 * net, and removing any of them adds one line pointing to people
 * (REAL_LIFE_FIXES §8).
 */
async function guardCompletedResult(
  pipeline: AgenticAskPipeline,
  result: AgenticLoopResult,
  question: string,
  verdict: AntiHerCategory,
  /** The owner's thread; undefined for an agent ask (no thread receipts). */
  conversation?: string,
  /** What the model was given besides tool results (§6.2), line by line. */
  evidence: readonly string[] = [],
): Promise<AgenticLoopResult> {
  // A wrap-up written when the step budget ran out is delivered as the
  // answer, so it passes every guard an ordinary answer does.
  const delivered = result.finishReason === 'completed' || result.wrappedUp === true;
  if (!delivered || result.answer === '') return result;
  let out = result;
  const scanner = pipeline.handlerOptions.guardScanner;
  if (scanner !== undefined) {
    try {
      const decision = await scanner({
        userPrompt: question,
        response: result.answer,
        toolsCalled: result.toolCalls.map((call) => call.name),
      });
      out = { ...result, answer: decision.content };
      // Metadata only: which categories were flagged, never the text.
      console.log('[ask_coordinator] guard scan', {
        reason: decision.reason,
        mutated: decision.mutated,
        flagged: Object.keys(decision.flagged),
      });
    } catch {
      console.log('[ask_coordinator] guard scan threw');
      out = result;
    }
  }
  try {
    const scan = await scanResponse(out.answer, { userPrompt: question });
    const lawFour = scan.violations.filter((v) => v.category === 'anti_her');
    if (lawFour.length > 0) {
      const stripped = stripViolations(out.answer, {
        ...scan,
        violations: lawFour,
        flaggedSentences: lawFour.flatMap((v) => v.sentenceIndices ?? []),
      });
      const names = await closeContactNames(pipeline);
      out = { ...out, answer: `${stripped.trim()} ${peoplePointerLine(names)}`.trim() };
    }
  } catch {
    /* the net never fails a turn */
  }
  // REAL_LIFE_FIXES_2 §6.1: on a turn judged emotional, Dina never offers
  // herself as company ("I'm here.", "talk to me about…"), not even as a
  // fallback. The sentence goes and the people line takes its place.
  if (HUMAN_CONNECTION_KINDS.has(verdict) || verdict === 'venting') {
    try {
      const offers = splitSentences(out.answer).filter((sentence) => isCompanyOffer(sentence));
      if (offers.length > 0) {
        const names = await closeContactNames(pipeline);
        const line = peoplePointerLine(names);
        const body = removeSentences(out.answer, offers);
        out = { ...out, answer: body.includes(line) ? body : `${body}\n\n${line}`.trim() };
      }
    } catch {
      /* the net never fails a turn */
    }
  }
  // REAL_LIFE_FIXES_2 §6.2: no verdict about the owner, and no figure, that
  // the evidence does not hold. Report mode logs counts only.
  try {
    const toolEvidence = evidenceFromToolResults(
      out.toolCalls.map((c) => (c.outcome.success === true ? c.outcome.result : undefined)),
    );
    const checked = checkRegulated(out.answer, {
      question,
      evidence: [...evidence.filter((e) => e.trim() !== ''), ...toolEvidence],
      nowMs: Date.now(),
    });
    if (checked.removed + checked.quoted > 0) {
      const modes = pipeline.guardModes !== undefined ? await pipeline.guardModes() : { regulated: 'report' as const };
      console.log('[guard] regulated', { mode: modes.regulated, removed: checked.removed, quoted: checked.quoted });
      if (modes.regulated === 'enforce') out = { ...out, answer: checked.text };
    }
  } catch {
    /* the net never fails a turn */
  }
  // REAL_LIFE_FIXES_2 §3: a claimed action is rewritten from its receipt, or
  // replaced when nothing backs it. Report mode logs counts only.
  try {
    const thisTurn = receiptsFromToolCalls(out.toolCalls);
    const thread = conversation !== undefined && conversation !== '' ? conversation : undefined;
    const earlier = thread !== undefined ? earlierReceipts(thread, question) : [];
    if (thread !== undefined) storeTurnReceipts(thread, question, thisTurn);
    const timeZone = pipeline.ownerTimeZone !== undefined ? await pipeline.ownerTimeZone() : undefined;
    const checked = checkActionClaims(out.answer, { thisTurn, earlier }, timeZone);
    if (checked.rewritten > 0) {
      const modes = pipeline.guardModes !== undefined ? await pipeline.guardModes() : { action_claims: 'report' as const };
      console.log('[guard] action claims', { mode: modes.action_claims, rewritten: checked.rewritten, unbacked: checked.unbacked });
      if (modes.action_claims === 'enforce') out = { ...out, answer: checked.text };
    }
  } catch {
    /* the net never fails a turn */
  }
  return out;
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
    async approve(id: string, opts?: { scope?: 'single' | 'session' }): Promise<void> {
      await core.approveWorkflowTask(id, opts?.scope !== undefined ? { scope: opts.scope } : undefined);
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
    // PLUGIN_ARCHITECTURE §6/§15.5 — `invoke_plugin` is terminal: the loop ends
    // on the tool's success with whatever prose the model wrote BEFORE the
    // call, which in the usual function-call shape is nothing. The owner must
    // still learn that a card is waiting (or that a grant ran the ask), so the
    // tool's plain-words note becomes the answer when the model said nothing,
    // and follows the model's line when it did.
    const pluginNote = extractPluginInvocationNote(result.toolCalls);
    const answer: AskAnswer = {
      text:
        pluginNote === undefined
          ? gatedText
          : gatedText.trim() === ''
            ? pluginNote
            : `${gatedText.trim()}\n\n${pluginNote}`,
    };
    if (serviceQueries.length > 0) {
      answer.serviceQueries = serviceQueries;
    } else if (missingCapabilities.length > 0) {
      answer.missingCapabilities = missingCapabilities;
    }
    // A money-free where-to-buy card from the product-research loop
    // (§5.A4/A5). Lifted out of the `search_products` tool result and carried
    // beside the narrative so the chat bridge can post a structured card; unlike
    // a service query it does NOT suppress the narrative — the loop's prose is
    // the answer, the card is the evidence. Rides in the persisted answer so
    // both the fast-path 200 and the deferred delivery surface it.
    const commerceCard = extractCommerceCardFromToolCalls(result.toolCalls);
    if (commerceCard !== undefined) {
      answer.commerceCard = commerceCard;
    }
    // GROUP_COORDINATION §9 — a plan `coordinate_group` opened rides beside
    // the narrative so the chat bridge can post the organizer's plan card. Like
    // the comparison card it does not suppress the prose: the model's one-line
    // ack is the answer, the card is where the replies land.
    const groupPlan = extractGroupPlanFromToolCalls(result.toolCalls);
    if (groupPlan !== undefined) {
      answer.groupPlan = groupPlan;
    }
    // ASK_FOR_QUOTES_PLAN §2 — a request for quotes `draft_quote_request`
    // drafted rides beside the one-line ack, so the chat bridge can post the
    // card that opens the Ask for quotes screen prefilled.
    const quoteRequestDraft = extractQuoteRequestDraftFromToolCalls(result.toolCalls);
    if (quoteRequestDraft !== undefined) {
      answer.quoteRequestDraft = quoteRequestDraft;
    }
    // REAL_LIFE_FIXES_2 §5 — the readable export's card (manifest + id only).
    for (let i = result.toolCalls.length - 1; i >= 0; i--) {
      const call = result.toolCalls[i]!;
      if (call.name !== 'export_my_data' || !call.outcome.success) continue;
      const r = call.outcome.result as { export_id?: unknown; manifest?: unknown } | null;
      if (typeof r?.export_id === 'string' && typeof r.manifest === 'object' && r.manifest !== null) {
        answer.exportCard = { exportId: r.export_id, manifest: r.manifest };
      }
      break;
    }
    // UCP plan §4.2 U1 — a merchant search's comparison card rides beside the
    // narrative, like the where-to-buy card: the prose answers, the card shows.
    const ucpComparison = extractUcpComparisonFromToolCalls(result.toolCalls);
    if (ucpComparison !== undefined) {
      answer.ucpComparison = ucpComparison;
    }
    // Provenance for the chat source pill: how many network ("ranked") reviews
    // from other Dinas informed this answer. The mobile bubble turns the count
    // into a label (Ranked reviews ≥ 3, Network reviews 1–2). 0 ⇒ no pill.
    const reviewCount = extractReviewCountFromToolCalls(result.toolCalls);
    if (reviewCount > 0) {
      answer.reviewSource = `reviewsrc:${reviewCount}`;
    }
    // REAL_LIFE_FIXES_2 §2: the owner is never handed silence. A card (service,
    // missing capability, comparison, plan, quote draft) can be the reply on
    // its own; with no card and no text, say so plainly.
    const carriesCard =
      answer.serviceQueries !== undefined ||
      answer.missingCapabilities !== undefined ||
      answer.commerceCard !== undefined ||
      answer.groupPlan !== undefined ||
      answer.quoteRequestDraft !== undefined ||
      answer.exportCard !== undefined ||
      answer.ucpComparison !== undefined;
    if (String(answer.text ?? '').trim() === '' && !carriesCard) {
      answer.text = EMPTY_ANSWER_FALLBACK;
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

  const failure = withMissingCapabilityDetail(
    {
      kind: result.finishReason,
      message: `agentic loop terminated with ${result.finishReason}`,
    },
    result.toolCalls,
    query,
  );
  // Out of steps with a written wrap-up (what was found, what is missing, at
  // most one question): that is the answer, unless the turn showed a missing
  // capability, which keeps its own notice.
  if (result.wrappedUp === true && result.answer.trim() !== '' && failure.detail?.missingCapabilities === undefined) {
    return { kind: 'answer', answer: { text: result.answer } };
  }
  return { kind: 'failure', failure };
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
/**
 * The last successful `invoke_plugin` outcome's note (§6): what the owner is
 * told about the card or the dispatch. Undefined when the loop never asked a
 * plugin, or every ask was refused (a refusal is a thrown tool error).
 */
let seenForgetEpoch: number | null = null;

/** Reload Brain's thread copies when Core's forget counter has moved. */
async function syncForgetEpoch(pipeline: AgenticAskPipeline): Promise<void> {
  if (pipeline.forgetEpoch === undefined) return;
  try {
    const epoch = await pipeline.forgetEpoch();
    if (seenForgetEpoch !== null && epoch !== seenForgetEpoch) await reloadLoadedThreads();
    seenForgetEpoch = epoch;
  } catch {
    /* a missed reload costs one stale turn; never fail the turn */
  }
}

/** Agent asks search the owner's vault before answering from general knowledge (§7.2). */
export const AGENT_VAULT_FIRST_RULE =
  'This question comes from an agent acting for the user. Before answering from general knowledge, search the user\'s vault (vault_search) for it: names, projects and plans may be the user\'s own, not public ones. A persona marked "closed to this requester" in the Table of Contents can still be searched: Dina will ask the user to approve. Answer from general knowledge only when the vault has nothing on it, and say so.';

/** What the owner reads when a turn produced neither text nor a card. */
export const EMPTY_ANSWER_FALLBACK = "I couldn't put a reply together for that. Could you say it another way?";

function extractPluginInvocationNote(
  toolCalls: AgenticLoopResult['toolCalls'],
): string | undefined {
  let note: string | undefined;
  for (const call of toolCalls) {
    if (call.name !== 'invoke_plugin' || !call.outcome.success) continue;
    const payload = call.outcome.result as { note?: unknown } | null;
    if (payload !== null && typeof payload.note === 'string' && payload.note !== '')
      note = payload.note;
  }
  return note;
}

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

/** The two research tools whose result carries the comparison card. */
const COMMERCE_CARD_TOOLS = new Set(['search_products', 'recommend_offer']);

/** The plan a successful `coordinate_group` call opened: its id and intent, for the card. */
function extractGroupPlanFromToolCalls(
  toolCalls: AgenticLoopResult['toolCalls'],
): { planId: string; intent: string } | undefined {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const call = toolCalls[i];
    if (call.name !== 'coordinate_group' || !call.outcome.success) continue;
    const result = call.outcome.result as { plan_id?: unknown; intent?: unknown } | null;
    if (result === null || typeof result !== 'object') continue;
    if (typeof result.plan_id !== 'string' || result.plan_id === '') continue;
    return {
      planId: result.plan_id,
      intent: typeof result.intent === 'string' ? result.intent : '',
    };
  }
  return undefined;
}

const UCP_CARD_TOOLS = new Set(['search_ucp_catalog', 'request_ucp_search_approval']);

/** The last search's comparison card (only its search id: the card reads the rest itself), if any. */
function extractUcpComparisonFromToolCalls(
  toolCalls: AgenticLoopResult['toolCalls'],
): Record<string, unknown> | undefined {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const call = toolCalls[i];
    // Both tools that run a search show its card; a fetch does not.
    if (!UCP_CARD_TOOLS.has(call.name) || !call.outcome.success) continue;
    const card = (call.outcome.result as { card?: unknown } | null)?.card as
      | { kind?: unknown; search_id?: unknown }
      | undefined;
    if (
      card?.kind === 'ucp_comparison' &&
      typeof card.search_id === 'string' &&
      card.search_id !== ''
    )
      return { kind: 'ucp_comparison', search_id: card.search_id };
  }
  return undefined;
}

/** The last successful `draft_quote_request` call's draft, if any. */
function extractQuoteRequestDraftFromToolCalls(
  toolCalls: AgenticLoopResult['toolCalls'],
): QuoteRequestDraftWire | undefined {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const call = toolCalls[i];
    if (call.name !== 'draft_quote_request' || !call.outcome.success) continue;
    const result = call.outcome.result as { draft?: unknown } | null;
    const draft = result?.draft as QuoteRequestDraftWire | undefined;
    if (draft !== undefined && Array.isArray(draft.lines) && draft.lines.length > 0) return draft;
  }
  return undefined;
}

/**
 * Mine the last successful research call for its money-free comparison card
 * and project it to a wire-safe `CardSpec` (§5.A4/A5). The LAST card wins: a
 * `recommend_offer` that followed `search_products` carries the loop's
 * preference-weighed pick (§5.A6), so the owner never sees a card that names
 * one seller under prose that names another; a turn that researched twice
 * surfaces the final result. `undefined` when no research ran or the card did
 * not project.
 */
function extractCommerceCardFromToolCalls(
  toolCalls: AgenticLoopResult['toolCalls'],
): Record<string, unknown> | undefined {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const call = toolCalls[i];
    if (!COMMERCE_CARD_TOOLS.has(call.name)) continue;
    if (!call.outcome.success) continue;
    const result = call.outcome.result as { card?: unknown } | null;
    if (result === null || typeof result !== 'object') continue;
    const spec = buildComparisonCardSpec(result.card);
    if (spec !== null) return spec as unknown as Record<string, unknown>;
  }
  return undefined;
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
