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

import { getChatMessageRepository } from '@dina/core';

import type { CardSpec } from '@dina/protocol';

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
  /** The provider Dina's DID (`to_did` from the dispatch). Surfaced in
   *  the handoff card so the user sees *which* other Dina was queried —
   *  the "you're talking to someone else" signal. Optional: absent on
   *  paths that don't carry it (the card degrades gracefully). */
  providerDid?: string;
  /** Capability params the query carried — rendered as a short summary
   *  on the handoff card. Opaque to brain; the renderer formats it. */
  params?: Record<string, unknown>;
  /** Validated capability result — present iff `status === 'resolved'`. */
  result?: Record<string, unknown>;
  /**
   * Declarative display-card spec (the fixed-vocabulary `CardSpec` from
   * `@dina/protocol`), present when resolved. Built by the brain
   * (deterministically from `result`, or — later — by the LLM) so the
   * client renders the card from data, not per-capability code. When
   * absent, the renderer derives one from `result` on the fly, then falls
   * back to the generic text card.
   */
  cardSpec?: CardSpec;
  /** Error explanation — present on `failed` / `expired`. */
  error?: string;
  /** Epoch ms when the response landed (set on the resolve/fail patch).
   *  The card derives "replied in Ns" from this minus the message's
   *  creation timestamp (which is dispatch time). */
  resolvedAt?: number;
  /**
   * True when this query targets a CONTACT (relationship / `surface:'talk'`,
   * `known_only`) service rather than a public one. It gates the
   * collapsed-failure rule (CONTACT_SERVICES_ARCHITECTURE.md §2/§10):
   * for a relationship service every negative path — refused, not-offered,
   * timed-out, ignored, offline — must render as ONE generic "couldn't
   * complete" with NO reason, so the requester can never infer their social
   * rank or the grantor's decision. Public-service cards keep showing the
   * real reason (no trust tier to leak), so the flag is absent there.
   */
  relationship?: boolean;
}

/**
 * `missing_capability` lifecycle metadata. Posted when service discovery
 * truthfully returns zero live providers for a requested capability. It is a
 * first-party Dina card, not a fake provider listing, so PeerLens/AppView
 * discovery remains honest while the UI can still show a developer path for
 * filling the gap.
 */
export interface MissingCapabilityLifecycle {
  kind: 'missing_capability';
  status: 'ready';
  noticeId: string;
  capability: string;
  /** Optional raw user query or slash-command payload for context. */
  query?: string;
}

/**
 * Terminal states for an `ask_pending` placeholder. The bridge
 * (`createCoordinatorAskHandler`) posts the placeholder when the
 * coordinator's fast-path window elapses (or pending_approval is
 * deferred), then patches the same message in place when the
 * registry event stream settles. Mirrors `ServiceQueryStatus`.
 */
export type AskPendingStatus = 'pending' | 'complete' | 'failed' | 'expired';

/**
 * `ask_pending` lifecycle metadata. Attached to a regular `'dina'`
 * message so the user sees a single bubble that morphs from
 * "Working on it…" into the resolved answer (or failure note),
 * instead of two stacked bubbles. Keyed by the registry's `askId`
 * so the bridge can locate and patch the same row when its event
 * stream fires.
 */
export interface AskPendingLifecycle {
  kind: 'ask_pending';
  status: AskPendingStatus;
  askId: string;
  /** Approval id when the deferral is driven by pending_approval. */
  approvalId?: string;
  /** Persona under approval, surfaced in the inline placeholder UI. */
  persona?: string;
  /** Error explanation — present on failed / expired. */
  error?: string;
}

/**
 * Terminal states for a `/ask write a review of <X>` draft. The mobile
 * chat handler posts the card at `drafting`, flips to `ready` once the
 * inferer settles, and `published` / `discarded` are terminal.
 * `failed` covers inferer errors so the user sees something other than
 * a perpetual spinner.
 */
export type ReviewDraftStatus =
  | 'drafting'
  | 'ready'
  | 'publishing'
  | 'published'
  | 'discarded'
  | 'failed';

/**
 * `review_draft` lifecycle metadata. Posted by the mobile chat layer
 * (not the brain orchestrator) when the user types
 * `/ask write a review of <X>` — the brain stays a thread-and-text
 * orchestrator, the mobile owns the BYOK LLM key + vault access for
 * drafting. Renderer dispatches on `metadata.lifecycle.kind`, same as
 * the service_query / ask_pending cards. Keyed by `draftId` so the
 * card can be patched in place as the user edits / publishes.
 *
 * `subject` mirrors the form's SubjectRef shape (kept loose as
 * `Record<string, unknown>` so brain doesn't depend on mobile's
 * subject types). `values` carries the LLM-drafted fields the inline
 * card renders; `null` while drafting. `attestation` is set once the
 * record is published — used to deep-link to the published review.
 */
export interface ReviewDraftLifecycle {
  kind: 'review_draft';
  status: ReviewDraftStatus;
  draftId: string;
  /** Free-text headline shown when the card is in `published` /
   *  `failed` terminal state — the message body becomes the user's
   *  receipt. */
  /** Subject reference (`{kind, name, did?, identifier?}`). Kept as a
   *  generic object so this type stays free of mobile-side imports. */
  subject: Record<string, unknown>;
  /** Drafted form-state snapshot — the inline card renders editable
   *  fields off this. `null` while still drafting / on error. */
  values: Record<string, unknown> | null;
  /** AT-Protocol attestation reference set once the user publishes. */
  attestation?: { uri: string; cid: string };
  /** Error explanation — present on `failed`. */
  error?: string;
}

/**
 * Discriminated union for `metadata.lifecycle`. Four kinds today:
 *   - `service_query` — workflow tasks for D2D capability calls.
 *   - `missing_capability` — empty service-discovery result with a
 *                            first-party developer onboarding card.
 *   - `ask_pending`   — async `/ask` deferrals (coordinator fast-path
 *                      timeout + pending_approval flows).
 *   - `review_draft`  — chat-driven `/ask write a review of <X>` flow.
 * Future kinds (long vault search, peer pairing) extend by adding
 * members and a discriminator branch in `readLifecycle`.
 */
export type MessageLifecycle =
  | ServiceQueryLifecycle
  | MissingCapabilityLifecycle
  | AskPendingLifecycle
  | ReviewDraftLifecycle;

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
  options?: {
    metadata?: Record<string, unknown>;
    sources?: string[];
    /**
     * Override the default receive-time timestamp. The receive
     * pipeline forwards the sender's `created_time` from the
     * verified DinaMessage envelope so a burst of D2D messages
     * sorts in the order the sender meant, not the order the
     * relay happened to deliver them. MT-19-I2.
     */
    timestamp?: number;
  },
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
    timestamp: options?.timestamp ?? Date.now(),
  };

  thread.push(msg);
  persistMessage(msg);
  fireSubscribers(msg);
  return msg;
}

/**
 * Apply a remote `ChatMessage` verbatim to the local thread cache.
 *
 * Lite's browser SPA receives server-side thread mutations over SSE
 * (`GET /api/v1/chat/stream`). Each frame carries a ChatMessage built
 * by `addMessage` on the brain-server side; the SPA mirrors it into
 * its own browser-side thread store via this helper.
 *
 * Why not call `addMessage`: that function generates a fresh `id`,
 * which would diverge from the server's view of the same message.
 * Mismatched IDs are mostly harmless (lifecycle patches are keyed by
 * `askId`, not message id) but break dedup of repeat SSE frames after
 * a reconnect, where the server flushes existing history.
 *
 * Semantics:
 *   - If a message with the same `id` already exists, REPLACE it
 *     in place. This covers `updateAskLifecycle`-style patches that
 *     the server re-emits with the same id and a mutated payload.
 *   - Otherwise append in timestamp order (or at the end if the
 *     existing tail is older). Out-of-order arrivals are rare —
 *     SSE is ordered per stream — but the timestamp-sort guards
 *     against history-flush races on reconnect.
 *
 * Fires subscribers on every write, exactly like `addMessage`, so
 * `useLiveThread` re-renders for both inserts and patches.
 */
export function applyRemoteMessage(msg: ChatMessage): ChatMessage {
  let thread = threads.get(msg.threadId);
  if (!thread) {
    thread = [];
    threads.set(msg.threadId, thread);
  }

  const existingIdx = thread.findIndex((m) => m.id === msg.id);
  if (existingIdx !== -1) {
    thread[existingIdx] = msg;
  } else {
    // Cheap insertion: most arrivals are at the tail. Walk back only
    // when the new message's timestamp is older than the current tail.
    const tail = thread[thread.length - 1];
    if (tail === undefined || tail.timestamp <= msg.timestamp) {
      thread.push(msg);
    } else {
      const insertAt = thread.findIndex((m) => m.timestamp > msg.timestamp);
      if (insertAt === -1) {
        thread.push(msg);
      } else {
        thread.splice(insertAt, 0, msg);
      }
    }
  }

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
  // Default behaviour is a MERGE: pull disk rows in and union them
  // with whatever the in-memory cache already holds. Mobile chat
  // hooks call this on first per-peer mount; if an inbound message
  // arrived before the screen mounted, the in-memory thread already
  // has it (via `addMessage` from the receive pipeline) and would
  // be clobbered if we replaced. The merge keeps everything.
  // `force: true` is used by tests that seed the repo directly
  // behind the cache's back and want to assert the disk state.
  const rows = await repo.listByThread(threadId);
  const fromDisk: ChatMessage[] = rows.map((r) => ({
    id: r.id,
    threadId: r.threadId,
    type: r.type as MessageType,
    content: r.content,
    metadata: Object.keys(r.metadata).length > 0 ? r.metadata : undefined,
    sources: r.sources.length > 0 ? r.sources : undefined,
    timestamp: r.timestamp,
  }));
  let added = 0;
  if (opts.force) {
    threads.set(threadId, fromDisk);
    added = fromDisk.length;
  } else {
    const inMemory = threads.get(threadId) ?? [];
    const seen = new Set(inMemory.map((m) => m.id));
    const additions: ChatMessage[] = [];
    for (const m of fromDisk) {
      if (!seen.has(m.id)) {
        additions.push(m);
        seen.add(m.id);
      }
    }
    if (additions.length > 0) {
      // Merge + sort chronologically (timestamp, then id as
      // tiebreaker for sub-ms ties) so the chat renders in order.
      const merged = [...inMemory, ...additions].sort((a, b) => {
        if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      threads.set(threadId, merged);
    }
    added = additions.length;
  }
  // Wake subscribers so any mounted chat hook re-reads the populated
  // thread. Without this, `useSyncExternalStore`-backed views see the
  // stale snapshot — the hydrate populated the map but no notification
  // fires, so React never knows to re-render. Firing once for the
  // last loaded message is sufficient: subscribers don't use the
  // message argument and just invalidate-and-refetch.
  if (added > 0) {
    const final = threads.get(threadId);
    if (final && final.length > 0) {
      fireSubscribers(final[final.length - 1]);
    }
  }
  return added;
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
        console.warn('[chat] persist failed:', err);
      });
  } catch (err) {
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
        console.warn('[chat] persist delete failed:', err);
      });
    } catch (err) {
      console.warn('[chat] persist delete failed:', err);
    }
  }
  return threads.delete(threadId);
}

/**
 * Clear a thread's messages WITHOUT tearing down its live subscription.
 *
 * `deleteThread` removes the subscriber set (it's a full teardown), so a
 * mounted chat UI is left showing a stale snapshot — its subscription is
 * gone, so emptying the store never reaches the screen. "New chat" wants the
 * opposite: empty the messages, persist the deletion, and NOTIFY the live
 * subscribers so they re-render empty while staying subscribed.
 */
export function clearThreadMessages(threadId: string): void {
  threads.set(threadId, []);
  const repo = getChatMessageRepository();
  if (repo !== null) {
    try {
      void repo.deleteThread(threadId).catch((err) => {
        console.warn('[chat] clear persist failed:', err);
      });
    } catch (err) {
      console.warn('[chat] clear persist failed:', err);
    }
  }
  // Subscribers ignore the payload and re-snapshot the (now empty) thread.
  const listeners = subscribers.get(threadId);
  if (listeners) {
    const ping: ChatMessage = {
      id: '',
      threadId,
      type: 'system',
      content: '',
      timestamp: Date.now(),
    };
    for (const fn of listeners) {
      try {
        fn(ping);
      } catch {
        /* swallow */
      }
    }
  }
}

/**
 * Add a user message (convenience).
 *
 * `metadata` carries display hints such as `{ mode: 'services' }` for explicit
 * composer-mode commands, so the bubble renders a clean payload + a mode chip
 * instead of the raw slash prefix (docs/COMPOSER_MODES_DESIGN.md section 7.1).
 */
export function addUserMessage(
  threadId: string,
  content: string,
  metadata?: Record<string, unknown>,
): ChatMessage {
  return addMessage(threadId, 'user', content, metadata !== undefined ? { metadata } : undefined);
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
    /** Who's asking — contact display name when known, else short DID. */
    requesterLabel?: string;
    /** Human one-liner of the (validated, stripped) query params. */
    paramsPreview?: string;
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
  // Use the discriminator to pick the natural identity key for the
  // sources index — taskId for service queries, askId for ask
  // placeholders, draftId for review drafts. Surfacing the key in
  // `sources` keeps it greppable in repository rows even if metadata
  // indexing changes.
  let key: string;
  switch (lifecycle.kind) {
    case 'service_query':
      key = lifecycle.taskId;
      break;
    case 'missing_capability':
      key = lifecycle.noticeId;
      break;
    case 'ask_pending':
      key = lifecycle.askId;
      break;
    case 'review_draft':
      key = lifecycle.draftId;
      break;
  }
  return addMessage(threadId, 'dina', content, {
    metadata: { lifecycle: lifecycle as unknown as Record<string, unknown> },
    sources: [key, ...extraSources],
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
  if (typeof lc.kind !== 'string') return null;
  if (typeof lc.status !== 'string') return null;
  if (lc.kind === 'service_query') {
    if (typeof lc.taskId !== 'string' || lc.taskId === '') return null;
    return lc as unknown as ServiceQueryLifecycle;
  }
  if (lc.kind === 'missing_capability') {
    if (typeof lc.noticeId !== 'string' || lc.noticeId === '') return null;
    if (typeof lc.capability !== 'string' || lc.capability === '') return null;
    return lc as unknown as MissingCapabilityLifecycle;
  }
  if (lc.kind === 'ask_pending') {
    if (typeof lc.askId !== 'string' || lc.askId === '') return null;
    return lc as unknown as AskPendingLifecycle;
  }
  if (lc.kind === 'review_draft') {
    if (typeof lc.draftId !== 'string' || lc.draftId === '') return null;
    return lc as unknown as ReviewDraftLifecycle;
  }
  return null;
}

/**
 * Find a thread message keyed by `taskId` on its lifecycle metadata
 * (only `service_query` kind has a taskId). Returns `null` when no
 * matching message is present.
 */
export function findMessageByTaskId(threadId: string, taskId: string): ChatMessage | null {
  const thread = threads.get(threadId);
  if (!thread) return null;
  for (const msg of thread) {
    const lc = readLifecycle(msg);
    if (lc !== null && lc.kind === 'service_query' && lc.taskId === taskId) return msg;
  }
  return null;
}

/**
 * Find a thread message whose `sources` array contains `source`. Used to
 * dedupe delivery of an at-least-once workflow event that maps to a plain
 * dina bubble (no lifecycle key to reconcile on) — the deliverer tags the
 * bubble with `event:<event_id>` and skips when one already exists. Returns
 * `null` when no matching message is present.
 */
export function findMessageBySource(threadId: string, source: string): ChatMessage | null {
  const thread = threads.get(threadId);
  if (!thread) return null;
  for (const msg of thread) {
    if ((msg.sources ?? []).includes(source)) return msg;
  }
  return null;
}

/**
 * Find a thread message keyed by `askId` on its lifecycle metadata
 * (only `ask_pending` kind has an askId). Returns `null` when no
 * matching message is present. Used by the coordinator-ask bridge
 * to locate its own placeholder when the registry stream fires.
 */
export function findMessageByAskId(threadId: string, askId: string): ChatMessage | null {
  const thread = threads.get(threadId);
  if (!thread) return null;
  for (const msg of thread) {
    const lc = readLifecycle(msg);
    if (lc !== null && lc.kind === 'ask_pending' && lc.askId === askId) return msg;
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
    return lc !== null && lc.kind === 'service_query' && lc.taskId === taskId;
  });
  if (idx === -1) return null;

  const old = thread[idx];
  const oldLc = readLifecycle(old);
  if (oldLc === null || oldLc.kind !== 'service_query') return null;
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

/**
 * Patch the `ask_pending` lifecycle metadata of the message identified
 * by `askId`, optionally rewriting `content` (e.g. swapping the
 * "Working on it…" placeholder for the resolved answer). Mirrors
 * `updateMessageLifecycle` but for the ask-bridge flow. Returns the
 * patched message, or `null` if no matching placeholder exists.
 */
export function updateAskLifecycle(
  threadId: string,
  askId: string,
  patch: Partial<Omit<AskPendingLifecycle, 'kind' | 'askId'>>,
  newContent?: string,
  sources?: string[],
): ChatMessage | null {
  const thread = threads.get(threadId);
  if (!thread) return null;
  const idx = thread.findIndex((msg) => {
    const lc = readLifecycle(msg);
    return lc !== null && lc.kind === 'ask_pending' && lc.askId === askId;
  });
  if (idx === -1) return null;

  const old = thread[idx];
  const oldLc = readLifecycle(old);
  if (oldLc === null || oldLc.kind !== 'ask_pending') return null;
  const newLc: AskPendingLifecycle = { ...oldLc, ...patch, kind: 'ask_pending', askId };

  const newMsg: ChatMessage = {
    ...old,
    content: newContent ?? old.content,
    // When the placeholder morphs to the resolved answer it renders as a plain
    // dina bubble — so carry the resolved answer's source provenance (the chat
    // review pill reads `sources`). Merge over the placeholder's identity-key
    // sources (the askId index) so both survive.
    ...(sources !== undefined ? { sources: [...(old.sources ?? []), ...sources] } : {}),
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

/**
 * Find a thread message keyed by `draftId` on its lifecycle metadata
 * (only `review_draft` kind has a draftId). Returns `null` when no
 * matching message is present. Used by the inline review-draft card
 * to patch its own message in place when the user edits / publishes.
 */
export function findMessageByDraftId(threadId: string, draftId: string): ChatMessage | null {
  const thread = threads.get(threadId);
  if (!thread) return null;
  for (const msg of thread) {
    const lc = readLifecycle(msg);
    if (lc !== null && lc.kind === 'review_draft' && lc.draftId === draftId) return msg;
  }
  return null;
}

/**
 * Patch the `review_draft` lifecycle of the message identified by
 * `draftId`, optionally rewriting `content` (e.g. swapping the
 * "Drafting…" line for the published receipt). Mirrors
 * `updateMessageLifecycle` / `updateAskLifecycle`. Returns the patched
 * message, or `null` if no matching draft exists.
 */
export function updateReviewDraftLifecycle(
  threadId: string,
  draftId: string,
  patch: Partial<Omit<ReviewDraftLifecycle, 'kind' | 'draftId'>>,
  newContent?: string,
): ChatMessage | null {
  const thread = threads.get(threadId);
  if (!thread) return null;
  const idx = thread.findIndex((msg) => {
    const lc = readLifecycle(msg);
    return lc !== null && lc.kind === 'review_draft' && lc.draftId === draftId;
  });
  if (idx === -1) return null;

  const old = thread[idx];
  const oldLc = readLifecycle(old);
  if (oldLc === null || oldLc.kind !== 'review_draft') return null;
  const newLc: ReviewDraftLifecycle = { ...oldLc, ...patch, kind: 'review_draft', draftId };

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

/**
 * Patch a single message's metadata by id. The merge is shallow —
 * keys in `patch` override the existing metadata, other keys are
 * preserved. Persists + fires subscribers like the lifecycle helpers.
 *
 * Used for D2D outbound delivery status (MT-19-I1): the chat-side
 * sender writes `metadata.deliveryStatus = 'sending'` on enqueue,
 * then patches to `'delivered'` once the wire send resolves, or
 * `'failed'` on error. The chat bubble renders a tick / spinner /
 * exclamation accordingly.
 *
 * Returns the updated message, or `null` if no message matched.
 */
export function updateMessageMetadataById(
  threadId: string,
  messageId: string,
  patch: Record<string, unknown>,
): ChatMessage | null {
  const thread = threads.get(threadId);
  if (!thread) return null;
  const idx = thread.findIndex((m) => m.id === messageId);
  if (idx === -1) return null;
  const old = thread[idx];
  const newMsg: ChatMessage = {
    ...old,
    metadata: { ...(old.metadata ?? {}), ...patch },
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
