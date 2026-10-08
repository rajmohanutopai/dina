/**
 * Chat thread storage for the split-process Brain (REAL_LIFE_FIXES §1.4).
 *
 * The phone's Brain persists chat into Core's `chat_messages` table in the
 * same VM. Here Brain is a separate process and never opens SQLite, so its
 * `ChatMessageRepository` is Core's brain-only `/v1/chat/*` routes over the
 * signed client. Threads then survive a Brain restart, and clearing a thread
 * deletes it in Core for good.
 */

import type { ChatMessageRepository, CoreClient, StoredChatMessage } from '@dina/core';

export class CoreChatMessageRepository implements ChatMessageRepository {
  constructor(
    private readonly core: Pick<
      CoreClient,
      'chatAppend' | 'chatList' | 'chatThreadIds' | 'chatDeleteThread' | 'chatReset'
    >,
  ) {}

  append(msg: StoredChatMessage): Promise<void> {
    return this.core.chatAppend(msg);
  }

  listByThread(threadId: string, limit?: number): Promise<StoredChatMessage[]> {
    return this.core.chatList(threadId, limit);
  }

  listThreadIds(): Promise<string[]> {
    return this.core.chatThreadIds();
  }

  deleteThread(threadId: string): Promise<boolean> {
    return this.core.chatDeleteThread(threadId);
  }

  reset(): Promise<void> {
    return this.core.chatReset();
  }
}
