/**
 * Peer-to-peer chat egress — the "send" side of the per-peer thread UI.
 *
 * Wraps Core's `D2DSender` with two extras the raw sender doesn't
 * give you:
 *
 *   1. An optimistic local echo: the user's outgoing bubble appears
 *      in `thread(peerDID)` as soon as `sendChatMessage` is called,
 *      before the wire round-trip completes. The UI reads from the
 *      thread, so this is what makes sends feel instant.
 *   2. A wire body shape the peer's inbound handler understands. We
 *      serialise `{ text }` into the D2D body; the receiving side's
 *      `extractChatText` pulls it back out. Non-Dina peers that send
 *      a raw string fall through the same path — `extractChatText`
 *      treats a non-JSON body as verbatim text.
 *
 * The wire type is `coordination.request` — a valid V1 family member
 * that fits free-form peer text (main-dina's d2d/families.go closed
 * set has no dedicated "chat" type). Replies from the other side
 * arrive as `coordination.request` or `coordination.response`; the
 * inbound filter in `bootstrap.ts` accepts both.
 */

import { addMessage, type ChatMessage } from '@dina/brain/chat';
import { getD2DSender, MsgTypeCoordinationRequest } from '@dina/core/d2d';

export class ChatSendError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ChatSendError';
  }
}

/**
 * Send a chat message to a peer by DID.
 *
 * Mutates the thread keyed by `peerDID` with the outgoing bubble
 * first, then invokes Core's installed D2D sender. Throws
 * `ChatSendError` if the sender isn't wired yet (node not started)
 * or the underlying send fails.
 *
 * On failure, appends a separate `error`-type message to the thread
 * so the user sees the outgoing bubble followed by a failure note
 * rather than a phantom "sent" that actually never hit the wire.
 */
export async function sendChatMessage(peerDID: string, text: string): Promise<ChatMessage> {
  if (peerDID === '') {
    throw new ChatSendError('peerDID is required');
  }
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new ChatSendError('text is required');
  }

  const sender = getD2DSender();
  if (sender === null) {
    throw new ChatSendError('D2D sender not wired — bring the node up before sending');
  }

  // Optimistic local echo.
  const msg = addMessage(peerDID, 'user', trimmed, {
    metadata: { source: 'd2d', peerDID },
  });

  try {
    await sender(peerDID, MsgTypeCoordinationRequest, { text: trimmed });
    return msg;
  } catch (err) {
    // Leave the user bubble in place (it was optimistic but the user
    // DID type these words) and append a separate error line next to
    // it so the failure is visible.
    const reason = err instanceof Error ? err.message : String(err);
    addMessage(peerDID, 'error', `Couldn't deliver: ${reason}`, {
      metadata: { source: 'd2d', peerDID, failedMessageId: msg.id },
    });
    throw new ChatSendError(`send failed: ${reason}`, err);
  }
}
