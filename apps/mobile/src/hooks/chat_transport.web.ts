/**
 * Chat-turn transport — web peer.
 *
 * Brain-server owns the thread store (it's the same in-process store
 * mobile uses, just running in a Node process behind HTTP). The SPA
 * subscribes to that store over Server-Sent Events
 * (`GET /api/v1/chat/stream?threadId=X`) and mirrors every emitted
 * ChatMessage into its own browser-side store via `applyRemoteMessage`.
 *
 * That mirror lets `useLiveThread`'s `subscribeToThread` listener — the
 * same hook mobile uses in-process — fire identically on the web.
 * `runChatTurn` becomes a thin fire-and-forget POST that just kicks
 * the orchestrator; every bubble (user, dina, ask_pending placeholder,
 * lifecycle patches that arrive minutes later) lands via the SSE stream.
 *
 * Architecture mirrors mobile end-to-end: any future async-delivery
 * improvements made to `createCoordinatorAskHandler`, the AskRegistry
 * lifecycle events, or the thread store flow through to both platforms
 * automatically. The SSE transport is the lite-only adapter that
 * translates in-process events into HTTP frames.
 *
 * Source: docs/HOME_NODE_LITE_WEB_UI_TASKS.md — SSE chat delivery.
 */

import {
  applyRemoteMessage,
  type ChatMessage,
  type ChatResponse,
} from '@dina/brain/chat';

const CHAT_ENDPOINT = '/api/v1/chat';
const CHAT_STREAM_ENDPOINT = '/api/v1/chat/stream';

interface ChatErrorBody {
  error?: string;
}

/**
 * One EventSource per threadId. Re-using a subscription across many
 * `runChatTurn` calls keeps the browser-side connection count low
 * (typically one per active chat tab). When a thread is reset or the
 * SPA navigates away, the consumer can call `closeChatStream(threadId)`
 * to tear it down explicitly; in practice the stream tears down on
 * tab close, which is fine.
 */
const activeStreams = new Map<string, EventSource>();

function ensureChatStream(threadId: string): void {
  if (activeStreams.has(threadId)) return;
  // SSR-safe: EventSource only exists in the browser. Tests that run
  // in jsdom may or may not implement it; we no-op when absent so the
  // POST path still works in test harnesses.
  if (typeof EventSource === 'undefined') return;

  const url = `${CHAT_STREAM_ENDPOINT}?threadId=${encodeURIComponent(threadId)}`;
  const es = new EventSource(url);

  es.addEventListener('message', (ev: MessageEvent<string>) => {
    let msg: ChatMessage;
    try {
      msg = JSON.parse(ev.data) as ChatMessage;
    } catch {
      // Malformed frame — drop. The brain-server emits valid JSON;
      // anything else is a proxy mangling the stream and there's
      // nothing useful the SPA can do beyond ignoring it.
      return;
    }
    // The brain-server only emits messages for the threadId we
    // subscribed to, but guard defensively in case a future
    // multiplexed transport reuses this consumer.
    if (typeof msg.threadId === 'string' && msg.threadId === threadId) {
      applyRemoteMessage(msg);
    }
  });

  // EventSource auto-reconnects on transient errors using the
  // `retry:` value the server sends (2 s). We don't tear it down on
  // error — let the browser keep trying. A permanent failure (server
  // gone, route 404'd) eventually surfaces as a stuck UI; users can
  // refresh. Surfacing this in the UI is a future polish.
  es.addEventListener('error', () => {
    // No-op; the browser will reconnect. Tearing down here would
    // give up on a transient blip (e.g. a sleeping laptop).
  });

  activeStreams.set(threadId, es);
}

/**
 * Close the SSE subscription for a thread. Call this when the user
 * explicitly resets or navigates away from a chat thread — keeps the
 * connection count tidy. Not strictly necessary; tabs closing also
 * tears down the EventSource.
 */
export function closeChatStream(threadId: string): void {
  const es = activeStreams.get(threadId);
  if (es !== undefined) {
    es.close();
    activeStreams.delete(threadId);
  }
}

export async function runChatTurn(text: string, threadId: string): Promise<ChatResponse> {
  // Ensure the stream is open BEFORE the POST so we don't miss the
  // user-bubble event the orchestrator emits at the top of
  // `handleChat`. EventSource open is idempotent per threadId.
  ensureChatStream(threadId);

  const httpResp = await fetch(CHAT_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, threadId }),
  });

  if (!httpResp.ok) {
    const body: ChatErrorBody = await httpResp.json().catch(() => ({}));
    throw new Error(body.error ?? `chat request failed (HTTP ${httpResp.status})`);
  }

  // The response body still carries the orchestrator's final
  // `ChatResponse` (intent, response, sources, …) — useful for
  // callers that want it programmatically (tests, scripted flows).
  // Bubble rendering, however, is driven by the SSE stream, not by
  // this return value. `applyRemoteMessage` has already (or is about
  // to) populate the local store with the same content.
  return (await httpResp.json()) as ChatResponse;
}
