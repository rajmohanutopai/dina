/**
 * Chat-turn transport — native default.
 *
 * Calls `handleChat` from `@dina/brain/chat` in-process. The
 * orchestrator persists both the user message and its response to
 * the in-process thread store, which the UI's `useLiveThread`
 * subscribes to.
 *
 * The web peer (`chat_transport.web.ts`) instead POSTs to the
 * brain-server's `/api/v1/chat` endpoint and mirrors the server's
 * response back into the LOCAL thread store so the UI re-renders
 * the same way. Splitting this out keeps `useChatThread.ts`
 * identical across both platforms — only the transport differs.
 *
 * Source: docs/HOME_NODE_LITE_WEB_UI_TASKS.md Phase 4 follow-up
 * ("LLM keys stay on brain-server; browser POSTs"; see also
 * `apps/home-node-lite/web/SECURITY.md`).
 */

import { handleChat, type ChatResponse } from '@dina/brain/chat';

/**
 * Run one chat turn. On native/mobile this calls the orchestrator
 * in-process; on web (via the `.web.ts` peer) it POSTs to
 * brain-server.
 *
 * The contract callers must trust:
 *   - returns the orchestrator's `ChatResponse`
 *   - the thread store contains BOTH the user message AND the
 *     orchestrator's response by the time the promise resolves
 *
 * The web peer fulfils the second clause by calling
 * `addUserMessage` + `addDinaResponse` against the local thread
 * store mirror.
 */
export async function runChatTurn(
  text: string,
  threadId: string,
): Promise<ChatResponse> {
  return handleChat(text, threadId);
}

/**
 * No-op on native — the chat store is in-process, so there is no stream to
 * open/close; `useLiveThread`'s in-process `subscribeToThread` already sees
 * every `addMessage` write (including inbound D2D). The web peer overrides
 * these to open/close the `/api/v1/chat/stream` EventSource.
 */
export function openChatStream(_threadId: string): void {
  // intentionally empty
}

export function closeChatStream(_threadId: string): void {
  // intentionally empty
}
