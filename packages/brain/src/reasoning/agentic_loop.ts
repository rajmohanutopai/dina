/**
 * Agentic reasoning loop — multi-turn tool-use with suspend/resume.
 *
 * Per-turn flow:
 *   1. Send history + system prompt + tool list to the LLM.
 *   2. If the response has zero tool calls → return the final text.
 *   3. Otherwise execute each tool serially via the registry.
 *   4. Append the assistant turn (with toolCalls) + one role='tool'
 *      message per result to the transcript.
 *   5. Repeat, bounded by `maxIterations` + `maxToolCalls`.
 *
 * **Pattern A — suspend on approval_required**:
 *
 * When a tool returns `{success: false, code: 'approval_required'}`
 * (via `ApprovalRequiredError` from the tool body), the loop bails
 * IMMEDIATELY and returns a `PausedAgenticState` that captures
 * everything needed to resume:
 *
 *   - The transcript at the moment of bail (includes already-completed
 *     tool results from the same batch but NOT the tool that bailed).
 *   - The current iteration index + tool-call counter.
 *   - The bailing tool call (id, name, args) so resume can re-run it.
 *   - Sibling tool calls in the same batch that hadn't run yet, so
 *     resume can fan them out before the next LLM iteration.
 *   - The approvalId + persona so the operator-facing layers can
 *     show the right prompt.
 *
 * `resumeAgenticTurn(pausedState)` re-enters the loop: it re-executes
 * the bailing tool (with the now-consumed approval, the tool body
 * returns real data), then any remaining sibling tools, then continues
 * the outer iteration loop. The LLM never knows there was a gap — it
 * sees one continuous transcript.
 *
 * **Why a single approval per resume cycle**: if multiple tools in
 * one batch want approval, we only park on the first; the remaining
 * approvals are discovered on resume. Bounding to one approval at a
 * time keeps the suspend state minimal and matches the `AskRecord`
 * shape (one `approvalId` per pending_approval).
 *
 * Source: DINA_AGENT_KERNEL.md Pattern 1 (Turn Loop). The earlier
 * one-shot version of this loop noted itself as "a scoped-down port
 * — extending it to match the full kernel spec is Phase-2 work";
 * Pattern A suspend/resume is that Phase-2 extension.
 */

import type {
  ChatMessage,
  ChatResponse,
  LLMProvider,
  ToolCall,
  ToolDefinition,
} from '../llm/adapters/provider';
import type { ToolExecutionOutcome, ToolRegistry } from './tool_registry';

export interface AgenticLoopOptions {
  /** Hard cap on LLM iterations. Default 8 (matches kernel's Dina-Mobile tier). */
  maxIterations?: number;
  /** Hard cap on total tool calls per turn. Default 12. */
  maxToolCalls?: number;
  /** Model override (provider decides default otherwise). */
  model?: string;
  /** Temperature override. */
  temperature?: number;
  /** Optional cancellation signal. */
  signal?: AbortSignal;
}

/**
 * Snapshot of in-progress loop state at an `approval_required` bail.
 * Carries everything `resumeAgenticTurn` needs to continue the same
 * turn after the operator approves the gated action.
 *
 * `version` is bumped when the shape changes — older paused states
 * fail the resume gracefully (the resumer surfaces a structured
 * error rather than crashing).
 */
export interface PausedAgenticState {
  readonly version: 1;
  /**
   * Transcript at the bail point. Includes all already-completed tool
   * results from the same batch BUT NOT the bailing tool's result —
   * the resume function pushes that one.
   */
  readonly transcript: ChatMessage[];
  /** Outer-loop iteration index when the bail happened. */
  readonly iteration: number;
  /** Total tool calls made so far this turn (already incremented for the bailing tool). */
  readonly toolCallCount: number;
  /** The tool call that needs approval — re-executed verbatim on resume. */
  readonly pendingToolCall: {
    readonly id: string | undefined;
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  };
  /**
   * Sibling tool calls in the same LLM batch that hadn't been
   * executed when the bail happened. Resume fans them out before
   * advancing to the next iteration.
   */
  readonly remainingToolCalls: readonly ToolCall[];
  /** Approval id the operator must approve via `AskApprovalGateway`. */
  readonly approvalId: string;
  /** Persona name — informational, used for notification text. */
  readonly persona: string;
  /** Token totals accumulated so far this turn. */
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export type AgenticFinishReason =
  | 'completed'
  | 'max_iterations'
  | 'max_tool_calls'
  | 'cancelled'
  | 'provider_error'
  | 'approval_required';

export interface AgenticLoopResult {
  /** Final user-visible text from the LLM. Empty when bailed early. */
  answer: string;
  /** Every tool call made during the turn, in order. */
  toolCalls: Array<{
    name: string;
    arguments: Record<string, unknown>;
    outcome:
      | { success: true; result: unknown }
      | { success: false; error: string }
      | { success: false; code: 'approval_required'; approvalId: string; persona: string };
  }>;
  /** How the loop terminated. */
  finishReason: AgenticFinishReason;
  /** Total tokens used (sum across iterations). */
  usage: { inputTokens: number; outputTokens: number };
  /** Full transcript including tool round-trips — useful for debugging / telemetry. */
  transcript: ChatMessage[];
  /**
   * Present iff `finishReason === 'approval_required'`. Pass to
   * `resumeAgenticTurn` once the operator approves.
   */
  pausedState?: PausedAgenticState;
}

const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_MAX_TOOL_CALLS = 12;

/**
 * Run one agentic turn from a fresh user message.
 *
 * `initialMessages` lets the caller seed conversation history (prior
 * turns). The new user message is appended before the loop starts.
 */
export async function runAgenticTurn(args: {
  provider: LLMProvider;
  tools: ToolRegistry;
  systemPrompt: string;
  initialMessages?: ChatMessage[];
  userMessage: string;
  options?: AgenticLoopOptions;
}): Promise<AgenticLoopResult> {
  const { provider, tools, systemPrompt, initialMessages = [], userMessage, options = {} } = args;
  const transcript: ChatMessage[] = [...initialMessages, { role: 'user', content: userMessage }];
  return runLoopBody({
    provider,
    tools,
    systemPrompt,
    transcript,
    iteration: 0,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolLog: [],
    options,
  });
}

/**
 * Resume a previously-paused turn after the operator approved the
 * gated tool call. Re-executes the pending tool (now with consumed
 * approval), drains any sibling tools that hadn't run, then continues
 * the outer loop.
 *
 * If the same — or another — tool call requires approval again
 * mid-resume, the function returns another `approval_required`
 * outcome with a fresh `pausedState`. This is correct behaviour:
 * a multi-persona ask might need multiple approvals, each granted
 * through its own pending → approved cycle.
 */
export async function resumeAgenticTurn(args: {
  provider: LLMProvider;
  tools: ToolRegistry;
  systemPrompt: string;
  pausedState: PausedAgenticState;
  options?: AgenticLoopOptions;
}): Promise<AgenticLoopResult> {
  const { provider, tools, systemPrompt, pausedState, options = {} } = args;
  if (pausedState.version !== 1) {
    throw new Error(
      `resumeAgenticTurn: paused state version ${pausedState.version} not supported by this build`,
    );
  }

  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  let transcript: ChatMessage[] = [...pausedState.transcript];
  let toolCallCount = pausedState.toolCallCount;
  let inputTokens = pausedState.usage.inputTokens;
  let outputTokens = pausedState.usage.outputTokens;
  const toolLog: AgenticLoopResult['toolCalls'] = [];

  // Re-execute the bailing tool — approval is now consumed.
  const pending = pausedState.pendingToolCall;
  if (options.signal?.aborted) {
    return {
      answer: '',
      toolCalls: toolLog,
      finishReason: 'cancelled',
      usage: { inputTokens, outputTokens },
      transcript,
    };
  }
  const pendingOutcome = await tools.execute(pending.name, pending.arguments);
  toolLog.push(buildToolLogEntry(pending.name, pending.arguments, pendingOutcome));

  if (isApprovalRequired(pendingOutcome)) {
    // The pending tool wants approval AGAIN (operator approved a stale
    // grant, or the gate moved tier under us). Park again with the new id.
    return {
      answer: '',
      toolCalls: toolLog,
      finishReason: 'approval_required',
      usage: { inputTokens, outputTokens },
      transcript,
      pausedState: {
        version: 1,
        transcript,
        iteration: pausedState.iteration,
        toolCallCount,
        pendingToolCall: pending,
        remainingToolCalls: pausedState.remainingToolCalls,
        approvalId: pendingOutcome.approvalId,
        persona: pendingOutcome.persona,
        usage: { inputTokens, outputTokens },
      },
    };
  }
  transcript = pushToolResult(transcript, pending.id, pending.name, pendingOutcome);

  // Drain sibling tools that hadn't been executed when the bail happened.
  for (const call of pausedState.remainingToolCalls) {
    if (options.signal?.aborted) {
      return {
        answer: '',
        toolCalls: toolLog,
        finishReason: 'cancelled',
        usage: { inputTokens, outputTokens },
        transcript,
      };
    }
    if (toolCallCount >= maxToolCalls) {
      return {
        answer: 'I hit the tool-call budget while resuming — try again with a simpler question.',
        toolCalls: toolLog,
        finishReason: 'max_tool_calls',
        usage: { inputTokens, outputTokens },
        transcript,
      };
    }
    toolCallCount++;
    const outcome = await tools.execute(call.name, call.arguments);
    toolLog.push(buildToolLogEntry(call.name, call.arguments, outcome));
    if (isApprovalRequired(outcome)) {
      // A sibling needs approval. Park with the remaining tail (after this one)
      // so the next resume picks up from there.
      const idx = pausedState.remainingToolCalls.indexOf(call);
      const tail = idx >= 0 ? pausedState.remainingToolCalls.slice(idx + 1) : [];
      return {
        answer: '',
        toolCalls: toolLog,
        finishReason: 'approval_required',
        usage: { inputTokens, outputTokens },
        transcript,
        pausedState: {
          version: 1,
          transcript,
          iteration: pausedState.iteration,
          toolCallCount,
          pendingToolCall: { id: call.id, name: call.name, arguments: call.arguments },
          remainingToolCalls: tail,
          approvalId: outcome.approvalId,
          persona: outcome.persona,
          usage: { inputTokens, outputTokens },
        },
      };
    }
    transcript = pushToolResult(transcript, call.id, call.name, outcome);
  }

  // All tools in the paused batch are now drained. Re-enter the outer
  // loop body at iteration + 1.
  return runLoopBody({
    provider,
    tools,
    systemPrompt,
    transcript,
    iteration: pausedState.iteration + 1,
    toolCallCount,
    inputTokens,
    outputTokens,
    toolLog,
    options,
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface LoopBodyInput {
  provider: LLMProvider;
  tools: ToolRegistry;
  systemPrompt: string;
  transcript: ChatMessage[];
  iteration: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  toolLog: AgenticLoopResult['toolCalls'];
  options: AgenticLoopOptions;
}

async function runLoopBody(state: LoopBodyInput): Promise<AgenticLoopResult> {
  const { provider, tools, systemPrompt, options } = state;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const toolDefs = tools.toDefinitions();

  let transcript = state.transcript;
  let iteration = state.iteration;
  let toolCallCount = state.toolCallCount;
  let inputTokens = state.inputTokens;
  let outputTokens = state.outputTokens;
  const toolLog = state.toolLog;
  let answer = '';

  // eslint-disable-next-line no-console
  console.log('[agentic_loop] start', {
    iteration,
    maxIterations,
    toolCount: toolDefs.length,
    toolNames: toolDefs.map((t) => t.name),
  });

  for (; iteration < maxIterations; iteration++) {
    if (options.signal?.aborted) {
      return done('cancelled');
    }

    let resp: ChatResponse;
    try {
      resp = await provider.chat(transcript, {
        systemPrompt,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        model: options.model,
        temperature: options.temperature,
        signal: options.signal,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[agentic_loop] provider.chat threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return done('provider_error');
    }

    inputTokens += resp.usage.inputTokens;
    outputTokens += resp.usage.outputTokens;

    // eslint-disable-next-line no-console
    console.log('[agentic_loop] iter', iteration, {
      contentSnippet: resp.content.slice(0, 200),
      toolCalls: resp.toolCalls.map((c) => ({ name: c.name, args: c.arguments })),
    });

    if (resp.toolCalls.length === 0) {
      answer = resp.content;
      transcript = [...transcript, { role: 'assistant', content: resp.content }];
      return done('completed');
    }

    transcript = [
      ...transcript,
      { role: 'assistant', content: resp.content, toolCalls: resp.toolCalls },
    ];

    for (let i = 0; i < resp.toolCalls.length; i++) {
      const call = resp.toolCalls[i]!;
      if (options.signal?.aborted) return done('cancelled');
      if (toolCallCount >= maxToolCalls) {
        answer =
          resp.content !== ''
            ? resp.content
            : `I've hit the tool-call budget for this request. Try again with a simpler question.`;
        return done('max_tool_calls');
      }
      toolCallCount++;
      const outcome = await tools.execute(call.name, call.arguments);
      // eslint-disable-next-line no-console
      console.log('[agentic_loop] tool', call.name, {
        args: call.arguments,
        outcomeKind: outcome.kind ?? typeof outcome,
        outcomeSnippet: JSON.stringify(outcome).slice(0, 400),
      });
      toolLog.push(buildToolLogEntry(call.name, call.arguments, outcome));

      if (isApprovalRequired(outcome)) {
        // Pattern A: bail immediately, capture state for resume.
        const remaining = resp.toolCalls.slice(i + 1);
        return {
          answer: '',
          toolCalls: toolLog,
          finishReason: 'approval_required',
          usage: { inputTokens, outputTokens },
          transcript,
          pausedState: {
            version: 1,
            transcript,
            iteration,
            toolCallCount,
            pendingToolCall: { id: call.id, name: call.name, arguments: call.arguments },
            remainingToolCalls: remaining,
            approvalId: outcome.approvalId,
            persona: outcome.persona,
            usage: { inputTokens, outputTokens },
          },
        };
      }

      transcript = pushToolResult(transcript, call.id, call.name, outcome);
    }
  }

  // eslint-disable-next-line no-console
  console.log('[agentic_loop] HIT max_iterations', {
    iterations: iteration,
    toolCallCount,
    lastTranscriptSnippet: JSON.stringify(transcript.slice(-3)).slice(0, 600),
  });
  return done('max_iterations');

  function done(finishReason: AgenticFinishReason): AgenticLoopResult {
    return {
      answer,
      toolCalls: toolLog,
      finishReason,
      usage: { inputTokens, outputTokens },
      transcript,
    };
  }
}

function isApprovalRequired(
  outcome: ToolExecutionOutcome,
): outcome is Extract<ToolExecutionOutcome, { code: 'approval_required' }> {
  return outcome.success === false && outcome.code === 'approval_required';
}

function buildToolLogEntry(
  name: string,
  args: Record<string, unknown>,
  outcome: ToolExecutionOutcome,
): AgenticLoopResult['toolCalls'][number] {
  if (outcome.success) {
    return { name, arguments: args, outcome: { success: true, result: outcome.result } };
  }
  if (outcome.code === 'approval_required') {
    return {
      name,
      arguments: args,
      outcome: {
        success: false,
        code: 'approval_required',
        approvalId: outcome.approvalId,
        persona: outcome.persona,
      },
    };
  }
  return { name, arguments: args, outcome: { success: false, error: outcome.error } };
}

function pushToolResult(
  transcript: ChatMessage[],
  toolCallId: string | undefined,
  toolName: string,
  outcome: Exclude<ToolExecutionOutcome, { code: 'approval_required' }>,
): ChatMessage[] {
  const payload = outcome.success ? { result: outcome.result } : { error: outcome.error };
  const msg: ChatMessage = {
    role: 'tool',
    content: JSON.stringify(payload),
    toolName,
  };
  if (toolCallId !== undefined) msg.toolCallId = toolCallId;
  return [...transcript, msg];
}

// Re-export for convenience.
export type { ToolCall, ToolDefinition };
