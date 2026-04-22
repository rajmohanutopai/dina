/**
 * Task 5.27 — streaming where LLM supports.
 *
 * LLM providers that stream responses (Anthropic Messages, OpenAI
 * ChatCompletions with `stream: true`, OpenRouter, Google AI) emit
 * incremental "delta" chunks — partial tokens that must be assembled
 * into the final answer. Brain's reasoning handler needs to:
 *
 *   1. Route each delta to the SSE / WebSocket consumer immediately
 *      (for UX responsiveness).
 *   2. Buffer the full text so it can be written to the vault + the
 *      ask registry (task 5.19) on completion.
 *   3. Handle tool-use deltas (partial JSON that only validates once
 *      the block is complete).
 *   4. Detect + surface mid-stream provider errors without leaving a
 *      half-baked buffer in the final state.
 *
 * This module is the transport-agnostic assembler: provider adapters
 * feed `pushTextDelta(chunk)` / `pushToolUseDelta(toolCallId, chunk)`
 * / `markComplete()` / `markFailed(reason)`, and the consumer (SSE
 * handler, WebSocket route) reads the assembled state via `snapshot()`
 * or subscribes to `onEvent`.
 *
 * **State machine** (pinned by tests):
 *
 *   streaming ──► complete    (markComplete; terminal)
 *             ──► failed      (markFailed;    terminal)
 *             ──► aborted     (markAborted;   terminal)
 *
 * Every other transition throws. Post-terminal deltas are silently
 * dropped (we log a `late_delta` event so ops can spot buggy
 * providers that keep emitting after sending `stop` / `done`).
 *
 * **Tool-use buffers**: a single stream may interleave text deltas
 * with partial JSON for one or more tool calls. We track each tool
 * call by its id — when the LLM sends `tool_use_end`, the tool call's
 * JSON is parsed + validated; parse failures transition the call (not
 * the whole stream) to `tool_call_failed` so text continues to flow.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5d task 5.27.
 */

export type StreamState = 'streaming' | 'complete' | 'failed' | 'aborted';

export type ToolCallState =
  | { status: 'in_progress'; rawJson: string }
  | { status: 'complete'; rawJson: string; parsed: Record<string, unknown> }
  | { status: 'failed'; rawJson: string; error: string };

export interface StreamBufferSnapshot {
  state: StreamState;
  /** Accumulated text — may lag the latest delta by one event tick. */
  text: string;
  /** Tool calls keyed by id, insertion order preserved. */
  toolCalls: Array<{ id: string; state: ToolCallState }>;
  /** Set on state=failed. */
  error?: string;
  /** Set when state=complete + caller supplied optional metadata. */
  meta?: Record<string, unknown>;
}

export type StreamEvent =
  | { kind: 'text_delta'; delta: string; total: number }
  | { kind: 'tool_use_start'; toolCallId: string }
  | { kind: 'tool_use_delta'; toolCallId: string; delta: string }
  | { kind: 'tool_use_end'; toolCallId: string; ok: boolean; parsed?: Record<string, unknown>; error?: string }
  | { kind: 'complete'; text: string; meta?: Record<string, unknown> }
  | { kind: 'failed'; error: string }
  | { kind: 'aborted' }
  | { kind: 'late_delta'; stage: 'text' | 'tool_use' };

export interface StreamBufferOptions {
  /** Per-event diagnostic hook. */
  onEvent?: (event: StreamEvent) => void;
}

export class StreamBuffer {
  private state: StreamState = 'streaming';
  private textChunks: string[] = [];
  private readonly toolCalls = new Map<
    string,
    { rawChunks: string[]; status: 'in_progress' | 'complete' | 'failed'; parsed?: Record<string, unknown>; error?: string }
  >();
  private errorMsg?: string;
  private completionMeta?: Record<string, unknown>;
  private readonly onEvent?: (event: StreamEvent) => void;

  constructor(opts: StreamBufferOptions = {}) {
    this.onEvent = opts.onEvent;
  }

  /** Push a text delta. No-op (+ late_delta event) after terminal. */
  pushTextDelta(delta: string): void {
    if (typeof delta !== 'string') {
      throw new Error('StreamBuffer.pushTextDelta: delta must be a string');
    }
    if (this.state !== 'streaming') {
      this.onEvent?.({ kind: 'late_delta', stage: 'text' });
      return;
    }
    this.textChunks.push(delta);
    this.onEvent?.({ kind: 'text_delta', delta, total: this.textLength() });
  }

  /** Open a new tool-call buffer for incoming JSON deltas. */
  startToolUse(toolCallId: string): void {
    if (!toolCallId) {
      throw new Error('StreamBuffer.startToolUse: toolCallId is required');
    }
    this.requireStreaming('startToolUse');
    if (this.toolCalls.has(toolCallId)) {
      throw new Error(
        `StreamBuffer.startToolUse: duplicate toolCallId ${JSON.stringify(toolCallId)}`,
      );
    }
    this.toolCalls.set(toolCallId, { rawChunks: [], status: 'in_progress' });
    this.onEvent?.({ kind: 'tool_use_start', toolCallId });
  }

  /** Push a JSON-partial delta for a previously-started tool call. */
  pushToolUseDelta(toolCallId: string, delta: string): void {
    if (typeof delta !== 'string') {
      throw new Error('StreamBuffer.pushToolUseDelta: delta must be a string');
    }
    if (this.state !== 'streaming') {
      this.onEvent?.({ kind: 'late_delta', stage: 'tool_use' });
      return;
    }
    const call = this.requireToolCall(toolCallId);
    if (call.status !== 'in_progress') {
      throw new Error(
        `StreamBuffer.pushToolUseDelta: toolCall ${JSON.stringify(toolCallId)} is ${call.status} (need in_progress)`,
      );
    }
    call.rawChunks.push(delta);
    this.onEvent?.({ kind: 'tool_use_delta', toolCallId, delta });
  }

  /**
   * Close a tool-call buffer. Parses the assembled JSON; on success
   * the tool call transitions to `complete` with `parsed` set. On
   * parse failure the tool call transitions to `failed` WITHOUT
   * aborting the whole stream — text deltas continue.
   */
  endToolUse(toolCallId: string): void {
    this.requireStreaming('endToolUse');
    const call = this.requireToolCall(toolCallId);
    if (call.status !== 'in_progress') {
      throw new Error(
        `StreamBuffer.endToolUse: toolCall ${JSON.stringify(toolCallId)} is ${call.status}`,
      );
    }
    const raw = call.rawChunks.join('');
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('tool_use payload must be a JSON object');
      }
      call.status = 'complete';
      call.parsed = parsed as Record<string, unknown>;
      this.onEvent?.({
        kind: 'tool_use_end',
        toolCallId,
        ok: true,
        parsed: call.parsed,
      });
    } catch (err) {
      call.status = 'failed';
      call.error = err instanceof Error ? err.message : String(err);
      this.onEvent?.({
        kind: 'tool_use_end',
        toolCallId,
        ok: false,
        error: call.error,
      });
    }
  }

  /** Terminal transition — successful stream completion. */
  markComplete(meta?: Record<string, unknown>): void {
    this.requireStreaming('markComplete');
    // Any in-progress tool call at completion time is a protocol
    // failure on the provider side — the LLM should have sent
    // tool_use_end. Flip to failed with the specific reason.
    for (const [id, call] of this.toolCalls) {
      if (call.status === 'in_progress') {
        call.status = 'failed';
        call.error = 'stream closed while tool_use still in_progress';
        this.onEvent?.({
          kind: 'tool_use_end',
          toolCallId: id,
          ok: false,
          error: call.error,
        });
      }
    }
    this.state = 'complete';
    if (meta !== undefined) this.completionMeta = meta;
    this.onEvent?.({
      kind: 'complete',
      text: this.textJoined(),
      ...(meta !== undefined ? { meta } : {}),
    });
  }

  /** Terminal transition — mid-stream provider error. */
  markFailed(reason: string): void {
    if (!reason || typeof reason !== 'string') {
      throw new Error('StreamBuffer.markFailed: reason must be a non-empty string');
    }
    this.requireStreaming('markFailed');
    this.state = 'failed';
    this.errorMsg = reason;
    this.onEvent?.({ kind: 'failed', error: reason });
  }

  /** Terminal transition — caller cancelled (AbortSignal fired). */
  markAborted(): void {
    this.requireStreaming('markAborted');
    this.state = 'aborted';
    this.onEvent?.({ kind: 'aborted' });
  }

  /** Current state — useful for route-side probes. */
  getState(): StreamState {
    return this.state;
  }

  /** True when the stream has reached a terminal state. */
  isTerminal(): boolean {
    return this.state !== 'streaming';
  }

  /** Full accumulated text (joined, no extra whitespace). */
  getText(): string {
    return this.textJoined();
  }

  /** Snapshot for the ask-registry / vault writer + SSE consumer. */
  snapshot(): StreamBufferSnapshot {
    const out: StreamBufferSnapshot = {
      state: this.state,
      text: this.textJoined(),
      toolCalls: Array.from(this.toolCalls, ([id, call]) => ({
        id,
        state: this.renderToolCallState(call),
      })),
    };
    if (this.errorMsg !== undefined) out.error = this.errorMsg;
    if (this.completionMeta !== undefined) out.meta = this.completionMeta;
    return out;
  }

  // ── Internals ───────────────────────────────────────────────────────

  private textJoined(): string {
    return this.textChunks.join('');
  }

  private textLength(): number {
    let n = 0;
    for (const c of this.textChunks) n += c.length;
    return n;
  }

  private renderToolCallState(call: {
    rawChunks: string[];
    status: 'in_progress' | 'complete' | 'failed';
    parsed?: Record<string, unknown>;
    error?: string;
  }): ToolCallState {
    const rawJson = call.rawChunks.join('');
    if (call.status === 'complete' && call.parsed !== undefined) {
      return { status: 'complete', rawJson, parsed: call.parsed };
    }
    if (call.status === 'failed') {
      return { status: 'failed', rawJson, error: call.error ?? 'unknown' };
    }
    return { status: 'in_progress', rawJson };
  }

  private requireStreaming(op: string): void {
    if (this.state !== 'streaming') {
      throw new Error(
        `StreamBuffer.${op}: buffer is ${this.state} (need streaming)`,
      );
    }
  }

  private requireToolCall(id: string): {
    rawChunks: string[];
    status: 'in_progress' | 'complete' | 'failed';
    parsed?: Record<string, unknown>;
    error?: string;
  } {
    const call = this.toolCalls.get(id);
    if (call === undefined) {
      throw new Error(
        `StreamBuffer: toolCallId ${JSON.stringify(id)} not started`,
      );
    }
    return call;
  }
}
