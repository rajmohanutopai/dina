/**
 * Agentic reasoning loop — multi-turn tool-use.
 *
 * A scoped-down port of main-dina's `ReasoningAgent.reason()` pattern,
 * sufficient for the Bus Driver demo. Per-turn flow:
 *   1. Send history + system prompt + tool list to the LLM.
 *   2. If the response has zero tool calls → return the final text.
 *   3. Otherwise execute each tool serially via the registry.
 *   4. Append the assistant turn (with toolCalls) + one role='tool'
 *      message per result to the transcript.
 *   5. Repeat, bounded by `maxIterations` + `maxToolCalls`.
 *
 * Full DINA_AGENT_KERNEL.md § A is a bigger effort (streaming, hooks,
 * sanitization, cancellation, budgets, compaction). We ship the minimum
 * necessary to classify and dispatch a natural-language service query.
 * The simpler loop is a deliberate stepping stone — extending it to
 * match the full kernel spec is Phase-2 work.
 *
 * Source: DINA_AGENT_KERNEL.md Pattern 1 (Turn Loop), main-dina's
 *         `brain/src/service/vault_context.py:ReasoningAgent.reason`.
 */

import type {
  ChatMessage,
  ChatResponse,
  LLMProvider,
  ToolCall,
  ToolDefinition,
} from '../llm/adapters/provider';
import type { ToolRegistry } from './tool_registry';

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

export interface AgenticLoopResult {
  /** Final user-visible text from the LLM. */
  answer: string;
  /** Every tool call made during the turn, in order. */
  toolCalls: Array<{
    name: string;
    arguments: Record<string, unknown>;
    outcome: { success: true; result: unknown } | { success: false; error: string };
  }>;
  /** How the loop terminated. */
  finishReason: 'completed' | 'max_iterations' | 'max_tool_calls' | 'cancelled' | 'provider_error';
  /** Total tokens used (sum across iterations). */
  usage: { inputTokens: number; outputTokens: number };
  /** Full transcript including tool round-trips — useful for debugging / telemetry. */
  transcript: ChatMessage[];
}

const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_MAX_TOOL_CALLS = 12;

/**
 * Run one agentic turn. Extends the transcript with the user query, runs
 * the loop to completion, returns the final answer + metadata.
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

  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const toolDefs = tools.toDefinitions();

  const transcript: ChatMessage[] = [...initialMessages, { role: 'user', content: userMessage }];
  const toolLog: AgenticLoopResult['toolCalls'] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolCallCount = 0;
  let answer = '';

  for (let iteration = 0; iteration < maxIterations; iteration++) {
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
      // Surface the actual provider error so simulator / CI logs show
      // WHY the agentic loop bailed (wrong model id, API-key scope,
      // unsupported tool-use, network). Previously swallowed silently
      // which made `Sorry — the reasoning service is unreachable right
      // now` an uninvestigable dead-end.
      // eslint-disable-next-line no-console
      console.warn(
        `[agentic_loop] provider.chat threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return done('provider_error');
    }

    totalInputTokens += resp.usage.inputTokens;
    totalOutputTokens += resp.usage.outputTokens;

    // Model returned a final answer (no tool calls) — we're done.
    if (resp.toolCalls.length === 0) {
      answer = resp.content;
      transcript.push({ role: 'assistant', content: resp.content });
      return done('completed');
    }

    // Model wants to call tools. Commit the assistant turn carrying the
    // tool calls, then execute them serially.
    transcript.push({
      role: 'assistant',
      content: resp.content,
      toolCalls: resp.toolCalls,
    });

    for (const call of resp.toolCalls) {
      if (options.signal?.aborted) return done('cancelled');
      if (toolCallCount >= maxToolCalls) {
        // Surface a final message telling the user we hit the budget.
        answer =
          resp.content !== ''
            ? resp.content
            : `I've hit the tool-call budget for this request. Try again with a simpler question.`;
        return done('max_tool_calls');
      }
      toolCallCount++;
      const outcome = await tools.execute(call.name, call.arguments);
      toolLog.push({
        name: call.name,
        arguments: call.arguments,
        outcome: outcome.success
          ? { success: true, result: outcome.result }
          : { success: false, error: outcome.error },
      });

      // Feed the tool result back as a role='tool' message. The
      // provider adapter translates that into the right wire shape.
      const resultPayload = outcome.success ? { result: outcome.result } : { error: outcome.error };
      transcript.push({
        role: 'tool',
        content: JSON.stringify(resultPayload),
        toolCallId: call.id,
        toolName: call.name,
      });
    }
  }

  return done('max_iterations');

  function done(finishReason: AgenticLoopResult['finishReason']): AgenticLoopResult {
    return {
      answer,
      toolCalls: toolLog,
      finishReason,
      usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      transcript,
    };
  }
}

// Re-export for convenience.
export type { ToolCall, ToolDefinition };
