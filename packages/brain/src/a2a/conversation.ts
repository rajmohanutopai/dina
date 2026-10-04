/**
 * The conversation an ask or a chat turn belongs to, as Core's release log
 * names it (A2A design §4.2): the owner's chat thread when the ask came from
 * chat, else the ask alone. Core logs every vault release under the session
 * id, records the owner's words under it, and binds an A2A proposal to it;
 * an A2A result returns to the reply thread.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

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

/**
 * A session id Core accepts (`[A-Za-z0-9][A-Za-z0-9:._-]{0,127}`): the id
 * itself when it fits, else a digest of it, so no thread name can make a
 * read fail or two threads share a session.
 */
export function releaseSessionId(kind: 'chat' | 'ask', id: string): string {
  const plain = `${kind}:${id}`;
  // `h-` is the digest form's mark: a thread that spells it gets digested too.
  if (/^[A-Za-z0-9:._-]{1,128}$/.test(plain) && !id.startsWith('h-')) return plain;
  return `${kind}:h-${bytesToHex(sha256(new TextEncoder().encode(id))).slice(0, 40)}`;
}
