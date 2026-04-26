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

import type { ApprovalManager } from '@dina/core/src/approval/manager';
import {
  AskApprovalGateway,
  type ApprovalSource,
  type ApprovalSourceStatus,
} from '../ask/ask_approval_gateway';
import { AskApprovalResumer } from '../ask/ask_approval_resumer';
import {
  createAskHandler,
  createAskStatusHandler,
  type AskExecuteFn,
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
import type { AgenticAskPipeline } from './agentic_ask';

export interface CreateAskCoordinatorOptions {
  /**
   * Pipeline produced by `buildAgenticAskPipeline({approvalManager, ...})`.
   * MUST have `buildToolsForAsk` populated (i.e. an `approvalManager`
   * was passed). The coordinator throws if not.
   */
  pipeline: AgenticAskPipeline;
  /**
   * Same `ApprovalManager` instance the pipeline was built with.
   * Coordinator wraps it as the `ApprovalSource` the gateway needs.
   */
  approvalManager: ApprovalManager;
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
  handleStatus: (id: string) => Promise<AskStatusOutcome>;
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
      'createAskCoordinator: pipeline.buildToolsForAsk is missing — pass approvalManager to buildAgenticAskPipeline',
    );
  }
  if (!opts.approvalManager) {
    throw new TypeError('createAskCoordinator: approvalManager is required');
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
      const tools = buildToolsForAsk({
        askId: ctx.askId,
        requesterDid: ctx.requesterDid,
      });
      return resumeAgenticTurn({
        provider,
        tools,
        systemPrompt,
        pausedState,
      });
    },
  });

  const gateway = new AskApprovalGateway({
    askRegistry: registry,
    approvalSource: approvalManagerAsSource(opts.approvalManager),
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
}): AskExecuteFn {
  const buildToolsForAsk = args.pipeline.buildToolsForAsk;
  if (!buildToolsForAsk) {
    throw new TypeError(
      'buildAgenticExecuteFn: pipeline.buildToolsForAsk is missing — pass approvalManager to buildAgenticAskPipeline',
    );
  }
  const { pipeline, systemPrompt } = args;
  return async (input) => {
    const tools = buildToolsForAsk({ askId: input.id, requesterDid: input.requesterDid });
    let result: AgenticLoopResult;
    try {
      const turnArgs: Parameters<typeof runAgenticTurn>[0] = {
        provider: pipeline.provider,
        tools,
        systemPrompt,
        userMessage: input.question,
      };
      if (input.signal !== undefined) {
        turnArgs.options = { signal: input.signal };
      }
      result = await runAgenticTurn(turnArgs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'failure', failure: { kind: 'execute_crashed', message } };
    }
    return translateLoopResult(result);
  };
}

/**
 * Adapter — `ApprovalManager` (in-memory) → `ApprovalSource`
 * (gateway's interface). Same pattern used in
 * `ask_locked_persona_e2e.test.ts`; lifted here so callers don't have
 * to reimplement it.
 */
export function approvalManagerAsSource(mgr: ApprovalManager): ApprovalSource {
  return {
    getStatus(id: string): ApprovalSourceStatus {
      const r = mgr.getRequest(id);
      if (!r) return 'unknown';
      if (r.status === 'pending') return 'pending';
      if (r.status === 'approved') return 'approved';
      return 'denied';
    },
    approve(id: string): void {
      mgr.approveRequest(id, 'single', 'operator');
    },
    deny(id: string): void {
      mgr.denyRequest(id);
    },
  };
}

function translateLoopResult(result: AgenticLoopResult): ReturnType<AskExecuteFn> extends Promise<infer R> ? R : never {
  if (result.finishReason === 'completed') {
    return { kind: 'answer', answer: { text: result.answer } };
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
  return {
    kind: 'failure',
    failure: {
      kind: result.finishReason,
      message: `agentic loop terminated with ${result.finishReason}`,
    },
  };
}
