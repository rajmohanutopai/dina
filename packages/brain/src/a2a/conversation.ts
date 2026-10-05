/**
 * The conversation an ask or a chat turn belongs to, as Core's release log
 * names it (A2A design §4.2): the owner's chat thread when the ask came from
 * chat, else the ask alone. Core logs every vault release under the session
 * id, records the owner's words under it, and binds an A2A proposal to it;
 * an A2A result returns to the reply thread.
 */

import { releaseSessionId } from '@dina/core';

export { releaseSessionId };

/**
 * The conversation an ask serves (A2A design §4.2 (b)): the owner's chat
 * thread when it came from chat, else the ask alone. Core logs every vault
 * release under `releaseSession`; an A2A result returns to `replyTo`.
 */
export function askConversation(
  askId: string,
  conversation: string | undefined,
): { releaseSession: string; replyTo?: string } {
  if (conversation === undefined || conversation === '')
    return { releaseSession: releaseSessionId('ask', askId) };
  return { releaseSession: releaseSessionId('chat', conversation), replyTo: conversation };
}
