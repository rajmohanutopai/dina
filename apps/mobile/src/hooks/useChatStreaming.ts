/**
 * Chat streaming hook — token-by-token rendering for LLM responses.
 *
 * Features:
 *   - Accumulates tokens into a growing text buffer
 *   - Guard scan on complete response (detect anti-her / PII / hallucination)
 *   - Abort support (user cancels mid-stream)
 *   - Tool use chunks surface inline
 *   - Done signal triggers thread storage
 *
 * The hook wraps the LLM adapter's `stream()` AsyncIterable interface
 * and provides a synchronous snapshot of the current stream state.
 *
 * Source: ARCHITECTURE.md Task 4.10
 */

import type { StreamChunk } from '@dina/brain/src/llm/adapters/provider';

export type StreamStatus = 'idle' | 'streaming' | 'scanning' | 'complete' | 'aborted' | 'error';

export interface StreamState {
  status: StreamStatus;
  text: string;
  tokens: string[];
  tokenCount: number;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  guardPassed: boolean | null;
}

/** Injectable guard scanner — scans complete response for violations. */
export type GuardScanner = (text: string) => { passed: boolean; violations: string[] };

let guardScanner: GuardScanner | null = null;

/** Current stream state. */
let state: StreamState = createInitialState();

function createInitialState(): StreamState {
  return {
    status: 'idle',
    text: '',
    tokens: [],
    tokenCount: 0,
    toolCalls: [],
    startedAt: null,
    completedAt: null,
    error: null,
    guardPassed: null,
  };
}

/**
 * Register the guard scanner (for production + testing).
 */
export function setGuardScanner(scanner: GuardScanner): void {
  guardScanner = scanner;
}

/**
 * Start a new stream. Resets all state.
 */
export function startStream(): void {
  state = createInitialState();
  state.status = 'streaming';
  state.startedAt = Date.now();
}

/**
 * Feed a chunk into the stream (called for each token/event from the LLM).
 */
export function feedChunk(chunk: StreamChunk): void {
  if (state.status !== 'streaming') return;

  switch (chunk.type) {
    case 'text':
      if (chunk.text) {
        state.tokens.push(chunk.text);
        state.text += chunk.text;
        state.tokenCount++;
      }
      break;

    case 'tool_use':
      if (chunk.toolCall) {
        state.toolCalls.push({
          name: chunk.toolCall.name,
          arguments: chunk.toolCall.arguments,
        });
      }
      break;

    case 'done':
      completeStream();
      break;

    case 'error':
      state.status = 'error';
      state.error = chunk.error ?? 'Stream error';
      state.completedAt = Date.now();
      break;
  }
}

/**
 * Process a full async iterable stream.
 * Convenience method that calls startStream + feedChunk for each chunk.
 */
export async function processStream(chunks: AsyncIterable<StreamChunk>): Promise<StreamState> {
  startStream();

  try {
    for await (const chunk of chunks) {
      if (state.status === 'aborted') break;
      feedChunk(chunk);
    }
  } catch (err) {
    state.status = 'error';
    state.error = err instanceof Error ? err.message : String(err);
    state.completedAt = Date.now();
  }

  return getStreamState();
}

/**
 * Abort the current stream.
 */
export function abortStream(): void {
  if (state.status === 'streaming') {
    state.status = 'aborted';
    state.completedAt = Date.now();
  }
}

/**
 * Get the current stream state snapshot.
 */
export function getStreamState(): StreamState {
  return { ...state, tokens: [...state.tokens], toolCalls: [...state.toolCalls] };
}

/**
 * Get the accumulated text (for progressive rendering).
 */
export function getStreamText(): string {
  return state.text;
}

/**
 * Check if a stream is active.
 */
export function isStreaming(): boolean {
  return state.status === 'streaming';
}

/**
 * Get stream duration in milliseconds.
 */
export function getStreamDuration(): number | null {
  if (!state.startedAt) return null;
  const end = state.completedAt ?? Date.now();
  return end - state.startedAt;
}

/**
 * Reset all streaming state (for testing).
 */
export function resetStreamState(): void {
  state = createInitialState();
  guardScanner = null;
}

/** Complete the stream — run guard scan if configured. */
function completeStream(): void {
  if (guardScanner) {
    state.status = 'scanning';
    const result = guardScanner(state.text);
    state.guardPassed = result.passed;
  } else {
    state.guardPassed = true;
  }

  state.status = 'complete';
  state.completedAt = Date.now();
}
