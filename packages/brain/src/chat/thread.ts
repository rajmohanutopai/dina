/**
 * Chat message model + thread — in-memory conversation storage.
 *
 * Message types:
 *   user     — user's text input
 *   dina     — Dina's response (vault-grounded answer)
 *   approval — approval request card
 *   nudge    — context-aware suggestion
 *   briefing — daily briefing card
 *   system   — system event ("Persona unlocked", "Reminder set")
 *   error    — error message
 *
 * Messages are stored in chronological order per conversation thread.
 * The thread ID is typically the persona or session.
 *
 * Source: ARCHITECTURE.md Task 4.6
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { getChatMessageRepository } from '../../../core/src/chat/repository';

export type MessageType =
  | 'user'
  | 'dina'
  | 'approval'
  | 'nudge'
  | 'briefing'
  | 'reminder'
  | 'system'
  | 'error';

/**
 * Terminal states for a lifecycle-tracked operation. `pending` is the
 * initial state; the other three are terminal. (`in_flight` was
 * proposed but had no trigger — collapsed into `pending` until a
 * provider-acknowledged event lands.)
 */
export type ServiceQueryStatus = 'pending' | 'resolved' | 'failed' | 'expired';

/**
 * `service_query` lifecycle metadata. Attached to a regular `'dina'`
 * message under `metadata.lifecycle` — keyed by `taskId` so the
 * `WorkflowEventConsumer` can find and patch the same message in place
 * when the response arrives. Mirrors the approval-card pattern
 * (`metadata.kind` discriminator) instead of inventing a new
 * `MessageType`, so any future async flow can reuse the same primitive
 * by adding another `kind` to `MessageLifecycle`.
 */
export interface ServiceQueryLifecycle {
  kind: 'service_query';
  status: ServiceQueryStatus;
  taskId: string;
  queryId: string;
  capability: string;
  serviceName: string;
  /** Validated capability result — present iff `status === 'resolved'`. */
  result?: Record<string, unknown>;
  /** Error explanation — present on `failed` / `expired`. */
  error?: string;
}

/**
 * Discriminated union for `metadata.lifecycle`. Today only
 * `service_query` is wired; future kinds (long vault search, async
 * trust resolution, peer pairing) extend by adding members.
 */
export type MessageLifecycle = ServiceQueryLifecycle;

export interface ChatMessage {
  id: string;
  threadId: string;
  type: MessageType;
  content: string;
  metadata?: Record<string, unknown>;
  sources?: string[];
  timestamp: number;
}

/** Per-thread message stores. */
const threads = new Map<string, ChatMessage[]>();

/**
 * Per-thread subscribers. Fire synchronously after each `addMessage`
 * write so UI layers (Chat screen) can re-render when async workflow
 * events land via `addDinaResponse`. Used for issue #2 — the chat
 * tab must surface responses that arrive AFTER the user's original
 * message, not just the synchronous reply to their send.
 */
const subscribers = new Map<string, Set<(msg: ChatMessage) => void>>();

/**
 * Subscribe to every message appended to `threadId`. The returned
 * disposer unsubscribes. Fires synchronously — no microtask — so the
 * caller can rely on ordering. Subscriber exceptions are swallowed to
 * prevent one faulty observer from breaking thread writes.
 */
export function subscribeToThread(
  threadId: string,
  listener: (msg: ChatMessage) => void,
): () => void {
  let set = subscribers.get(threadId);
  if (!set) {
    set = new Set();
    subscribers.set(threadId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

function fireSubscribers(msg: ChatMessage): void {
  const listeners = subscribers.get(msg.threadId);
  if (!listeners) return;
  for (const fn of listeners) {
    try {
      fn(msg);
    } catch {
      /* swallow */
    }
  }
}

/**
 * Add a message to a thread.
 *
 * Review #14: dual-writes to the chat-message repository when one is
 * installed (via `setChatMessageRepository` on unlock). Persistence
 * failures are logged but DO NOT propagate — the in-memory store is
 * the primary surface that subscribers see, so a transient SQLite
 * error mustn't break the chat UI. On next boot `hydrateThread(id)`
 * replays whatever the repo has.
 */
export function addMessage(
  threadId: string,
  type: MessageType,
  content: string,
  options?: { metadata?: Record<string, unknown>; sources?: string[] },
): ChatMessage {
  let thread = threads.get(threadId);
  if (!thread) {
    thread = [];
    threads.set(threadId, thread);
  }

  const msg: ChatMessage = {
    id: `cm-${bytesToHex(randomBytes(6))}`,
    threadId,
    type,
    content,
    metadata: options?.metadata,
    sources: options?.sources,
    timestamp: Date.now(),
  };

  thread.push(msg);
  persistMessage(msg);
  fireSubscribers(msg);
  return msg;
}

/**
 * Hydrate a thread's in-memory cache from the persisted repository.
 * Called by the app layer after unlock (when persistence is wired) so
 * the chat UI shows prior history on first render. Idempotent —
 * re-hydrating an already-populated thread is a no-op unless `force`
 * is passed.
 */
export async function hydrateThread(
  threadId: string,
  opts: { force?: boolean } = {},
): Promise<number> {
  const repo = getChatMessageRepository();
  if (repo === null) return 0;
  if (!opts.force && (threads.get(threadId)?.length ?? 0) > 0) return 0;
  const rows = await repo.listByThread(threadId);
  const thread: ChatMessage[] = rows.map((r) => ({
    id: r.id,
    threadId: r.threadId,
    type: r.type as MessageType,
    content: r.content,
    metadata: Object.keys(r.metadata).length > 0 ? r.metadata : undefined,
    sources: r.sources.length > 0 ? r.sources : undefined,
    timestamp: r.timestamp,
  }));
  threads.set(threadId, thread);
  return thread.length;
}

/** Write-through helper — fire-and-forget since Phase 2.3 (task 2.3).
 *  The in-memory `threads` Map is authoritative for reads; repo persists
 *  for restart durability but a transient write failure doesn't break
 *  the current session. Preserves addMessage()'s sync signature.
 *
 *  Double-guarded: `.catch()` handles rejected Promises; the outer
 *  `try` handles non-conforming repo impls that throw synchronously
 *  (e.g. test mocks) before returning a Promise. Both fall through
 *  to the same warn. */
function persistMessage(msg: ChatMessage): void {
  const repo = getChatMessageRepository();
  if (repo === null) return;
  try {
    void repo
      .append({
        id: msg.id,
        threadId: msg.threadId,
        type: msg.type,
        content: msg.content,
        metadata: msg.metadata ?? {},
        sources: msg.sources ?? [],
        timestamp: msg.timestamp,
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[chat] persist failed:', err);
      });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[chat] persist failed:', err);
  }
}

/**
 * Get all messages in a thread, chronological order.
 */
export function getThread(threadId: string): ChatMessage[] {
  return [...(threads.get(threadId) ?? [])];
}

/**
 * Get the most recent N messages from a thread.
 */
export function getRecentMessages(threadId: string, limit: number): ChatMessage[] {
  const thread = threads.get(threadId) ?? [];
  return thread.slice(-limit);
}

/**
 * Get messages filtered by type.
 */
export function getMessagesByType(threadId: string, type: MessageType): ChatMessage[] {
  return (threads.get(threadId) ?? []).filter((m) => m.type === type);
}

/**
 * Get a single message by ID.
 */
export function getMessage(messageId: string): ChatMessage | null {
  for (const thread of threads.values()) {
    const msg = thread.find((m) => m.id === messageId);
    if (msg) return msg;
  }
  return null;
}

/**
 * Count messages in a thread.
 */
export function threadLength(threadId: string): number {
  return threads.get(threadId)?.length ?? 0;
}

/**
 * List all thread IDs.
 */
export function listThreads(): string[] {
  return [...threads.keys()];
}

/**
 * Delete a thread — including any subscribers registered against it
 * (review #15). Leaving the subscriber set behind was a silent leak:
 * next time the same threadId was recreated, stale listeners would
 * fire for messages they weren't meant to see.
 */
export function deleteThread(threadId: string): boolean {
  subscribers.delete(threadId);
  const repo = getChatMessageRepository();
  if (repo !== null) {
    try {
      void repo.deleteThread(threadId).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[chat] persist delete failed:', err);
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[chat] persist delete failed:', err);
    }
  }
  return threads.delete(threadId);
}

/**
 * Add a user message (convenience).
 */
export function addUserMessage(threadId: string, content: string): ChatMessage {
  return addMessage(threadId, 'user', content);
}

/**
 * Add a Dina response (convenience).
 */
export function addDinaResponse(
  threadId: string,
  content: string,
  sources?: string[],
): ChatMessage {
  return addMessage(threadId, 'dina', content, { sources });
}

/**
 * Add a system event message.
 */
export function addSystemMessage(threadId: string, content: string): ChatMessage {
  return addMessage(threadId, 'system', content);
}

/**
 * Add an approval-request card to the thread. Use this instead of
 * `addDinaResponse` for pending-approval prompts so the UI can render
 * a distinct card (approve / deny buttons) instead of a plain text
 * reply. Metadata carries the fields the card needs: taskId,
 * capability, fromDID, serviceName, and the slash-command the
 * operator can paste if they prefer text entry (review #13).
 */
export function addApprovalMessage(
  threadId: string,
  content: string,
  metadata: {
    taskId: string;
    capability: string;
    fromDID: string;
    serviceName: string;
    approveCommand: string;
  },
): ChatMessage {
  // `kind: 'service_approval'` discriminates this from the
  // ask-coordinator's `'ask_approval'` cards (5.21-H-i) so the chat
  // tab's renderer can dispatch to the right inline component.
  return addMessage(threadId, 'approval', content, {
    metadata: { ...metadata, kind: 'service_approval' },
    sources: [metadata.taskId, metadata.capability],
  });
}

/**
 * Add a `'dina'` message tagged with lifecycle metadata. The orchestrator
 * calls this when the LLM dispatches a `query_service` tool call (or a
 * `/service` slash command does the same): the message starts at
 * `status: 'pending'` and is patched in place by the
 * `WorkflowEventConsumer` when the response lands. Mirrors the
 * approval-card pattern — the renderer dispatches on
 * `message.metadata.lifecycle.kind`, no new `MessageType` required.
 */
export function addLifecycleMessage(
  threadId: string,
  content: string,
  lifecycle: MessageLifecycle,
  extraSources: string[] = [],
): ChatMessage {
  return addMessage(threadId, 'dina', content, {
    metadata: { lifecycle: lifecycle as unknown as Record<string, unknown> },
    sources: [lifecycle.taskId, ...extraSources],
  });
}

/**
 * Read the lifecycle block from a chat message, or return `null` when
 * the message has no lifecycle attached. Validates the discriminator
 * so callers get a typed view back.
 */
export function readLifecycle(msg: ChatMessage): MessageLifecycle | null {
  const raw = msg.metadata?.lifecycle;
  if (raw === undefined || raw === null || typeof raw !== 'object') return null;
  const lc = raw as Record<string, unknown>;
  if (lc.kind !== 'service_query') return null;
  if (typeof lc.taskId !== 'string' || lc.taskId === '') return null;
  if (typeof lc.status !== 'string') return null;
  return lc as unknown as MessageLifecycle;
}

/**
 * Find a thread message keyed by `taskId` on its lifecycle metadata.
 * Returns `null` when no matching message is present.
 */
export function findMessageByTaskId(threadId: string, taskId: string): ChatMessage | null {
  const thread = threads.get(threadId);
  if (!thread) return null;
  for (const msg of thread) {
    const lc = readLifecycle(msg);
    if (lc !== null && lc.taskId === taskId) return msg;
  }
  return null;
}

/**
 * Patch the lifecycle metadata of the message identified by `taskId`,
 * optionally rewriting `content` (e.g. swapping the LLM ack for the
 * formatted result). The message is replaced (not mutated) so
 * subscribers see a fresh `ChatMessage` reference and inline components
 * re-render reliably. Returns the patched message, or `null` if no
 * matching message exists in the thread.
 */
export function updateMessageLifecycle(
  threadId: string,
  taskId: string,
  patch: Partial<Omit<ServiceQueryLifecycle, 'kind' | 'taskId'>>,
  newContent?: string,
): ChatMessage | null {
  const thread = threads.get(threadId);
  if (!thread) return null;
  const idx = thread.findIndex((msg) => {
    const lc = readLifecycle(msg);
    return lc !== null && lc.taskId === taskId;
  });
  if (idx === -1) return null;

  const old = thread[idx];
  const oldLc = readLifecycle(old);
  if (oldLc === null) return null;
  const newLc: ServiceQueryLifecycle = { ...oldLc, ...patch, kind: 'service_query', taskId };

  const newMsg: ChatMessage = {
    ...old,
    content: newContent ?? old.content,
    metadata: {
      ...(old.metadata ?? {}),
      lifecycle: newLc as unknown as Record<string, unknown>,
    },
  };
  thread[idx] = newMsg;
  persistMessage(newMsg);
  fireSubscribers(newMsg);
  return newMsg;
}

/** Reset all threads (for testing). */
export function resetThreads(): void {
  threads.clear();
  subscribers.clear();
  const repo = getChatMessageRepository();
  if (repo !== null) {
    try {
      void repo.reset().catch(() => {
        /* swallow — tests proceed regardless */
      });
    } catch {
      /* swallow sync-throw variants too */
    }
  }
}
