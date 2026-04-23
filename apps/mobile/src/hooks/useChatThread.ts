/**
 * Chat conversation thread hook — data layer for the Chat screen.
 *
 * Provides:
 *   - Scrollable message list with typed messages (user, dina, approval, etc.)
 *   - Send a message (routes through Brain orchestrator)
 *   - Typing indicator state
 *   - Thread management (clear, switch threads)
 *   - Message count and unread tracking
 *
 * The hook wraps Brain's thread module + orchestrator for the UI.
 *
 * Source: ARCHITECTURE.md Task 4.6
 */

import { useCallback, useEffect, useState } from 'react';
import {
  getThread,
  getRecentMessages,
  addSystemMessage,
  threadLength,
  listThreads,
  deleteThread,
  resetThreads,
  subscribeToThread,
  type ChatMessage,
  type MessageType,
} from '@dina/brain/src/chat/thread';
import { handleChat, type ChatResponse } from '@dina/brain/src/chat/orchestrator';

const DEFAULT_THREAD = 'main';

export interface ThreadUIState {
  threadId: string;
  messages: ChatMessage[];
  messageCount: number;
  isTyping: boolean;
  lastUserMessageAt: number;
  lastDinaResponseAt: number;
}

/** Typing indicator state per thread. */
const typingState = new Map<string, boolean>();

/** Timestamp tracking. */
const lastUserMessageAt = new Map<string, number>();
const lastDinaResponseAt = new Map<string, number>();

/**
 * Get the current thread state for the UI.
 */
export function getThreadState(threadId?: string): ThreadUIState {
  const tid = threadId ?? DEFAULT_THREAD;
  const messages = getThread(tid);

  return {
    threadId: tid,
    messages,
    messageCount: messages.length,
    isTyping: typingState.get(tid) ?? false,
    lastUserMessageAt: lastUserMessageAt.get(tid) ?? 0,
    lastDinaResponseAt: lastDinaResponseAt.get(tid) ?? 0,
  };
}

/**
 * Get recent messages (for initial render / pagination).
 */
export function getRecentChatMessages(limit: number, threadId?: string): ChatMessage[] {
  return getRecentMessages(threadId ?? DEFAULT_THREAD, limit);
}

/**
 * Send a user message and get the response.
 *
 * Flow:
 *   1. Add user message to thread
 *   2. Set typing indicator
 *   3. Route through Brain orchestrator (/remember, /ask, /search, chat)
 *   4. Add response to thread
 *   5. Clear typing indicator
 *   6. Return the response for UI update
 */
export async function sendMessage(text: string, threadId?: string): Promise<ChatResponse> {
  const tid = threadId ?? DEFAULT_THREAD;

  if (!text.trim()) {
    throw new Error('Message cannot be empty');
  }

  // Track user message time
  lastUserMessageAt.set(tid, Date.now());

  // Set typing indicator
  typingState.set(tid, true);

  try {
    // Route through Brain orchestrator
    const response = await handleChat(text, tid);

    // Track response time
    lastDinaResponseAt.set(tid, Date.now());

    return response;
  } finally {
    // Always clear typing indicator
    typingState.set(tid, false);
  }
}

/**
 * Add a system message to the thread (persona unlocked, reminder set, etc.).
 */
export function addSystemNotification(text: string, threadId?: string): ChatMessage {
  return addSystemMessage(threadId ?? DEFAULT_THREAD, text);
}

/**
 * Get messages filtered by type (for rendering different card styles).
 */
export function getMessagesByType(type: MessageType, threadId?: string): ChatMessage[] {
  const messages = getThread(threadId ?? DEFAULT_THREAD);
  return messages.filter((m) => m.type === type);
}

/**
 * Get the typing indicator state.
 */
export function isTyping(threadId?: string): boolean {
  return typingState.get(threadId ?? DEFAULT_THREAD) ?? false;
}

/**
 * Get all available thread IDs.
 */
export function getThreadList(): string[] {
  return listThreads();
}

/**
 * Clear a thread's messages.
 */
export function clearThread(threadId?: string): boolean {
  const tid = threadId ?? DEFAULT_THREAD;
  typingState.delete(tid);
  lastUserMessageAt.delete(tid);
  lastDinaResponseAt.delete(tid);
  return deleteThread(tid);
}

/**
 * Get total message count across all threads.
 */
export function getTotalMessageCount(): number {
  return listThreads().reduce((sum, tid) => sum + threadLength(tid), 0);
}

/**
 * Reset all chat state (for testing).
 */
export function resetChatState(): void {
  resetThreads();
  typingState.clear();
  lastUserMessageAt.clear();
  lastDinaResponseAt.clear();
}

// ---------------------------------------------------------------------------
// React hook — live-subscribes to the thread store so async workflow-event
// replies surface on-screen without polling. Issues #1 + #2.
// ---------------------------------------------------------------------------

export interface UseLiveThreadResult {
  /** All messages in this thread, chronological order. Re-renders on writes. */
  messages: ChatMessage[];
  /** Route user input through Brain's `handleChat` — /ask / /service / etc. */
  send: (text: string) => Promise<ChatResponse | null>;
  /** True while a send is in flight. */
  sending: boolean;
}

/**
 * Bridge between the Chat screen and Brain's thread store + orchestrator.
 * Subscribes once on mount; updates on every `addMessage` write — including
 * async arrivals from `WorkflowEventConsumer.deliver` (the whole point of
 * issue #2's fix). `send()` routes through `handleChat` so the Chat tab
 * actually uses the installed /ask / /service / /service_approve handlers
 * that createNode wired up (issues #1, #3).
 */
export function useLiveThread(threadId: string = DEFAULT_THREAD): UseLiveThreadResult {
  const [messages, setMessages] = useState<ChatMessage[]>(() => getThread(threadId));
  const [sending, setSending] = useState(false);

  useEffect(() => {
    // Snapshot on mount / thread switch.
    setMessages(getThread(threadId));
    const unsubscribe = subscribeToThread(threadId, () => {
      setMessages(getThread(threadId));
    });
    return unsubscribe;
  }, [threadId]);

  const send = useCallback(
    async (text: string): Promise<ChatResponse | null> => {
      const trimmed = text.trim();
      if (trimmed === '') return null;
      setSending(true);
      try {
        // handleChat persists both the user message AND the orchestrator's
        // synchronous reply into the thread. Our subscription picks up
        // both; async arrivals (workflow events) land the same way.
        return await sendMessage(trimmed, threadId);
      } finally {
        setSending(false);
      }
    },
    [threadId],
  );

  return { messages, send, sending };
}
