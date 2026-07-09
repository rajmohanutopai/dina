/**
 * Quarantine card sync — WEB.
 *
 * The thin-client has no in-process `onQuarantinedD2D` hook, so on chat mount
 * it polls Core (via the brain `/api/v1/d2d/quarantine` proxy) and injects a
 * review card into the thread for each pending unknown-sender message not
 * already shown — matching the metadata shape mobile's receive hook uses so
 * the same `InlineQuarantineCard` renders (F4 / MRS-05).
 */

import { getThread, addMessage } from '@dina/brain/chat';

interface QuarantinedMessage {
  id: string;
  senderDID: string;
  messageType: string;
  body: string;
  receivedAt: number;
}

function shownQuarantineIds(threadId: string): Set<string> {
  const ids = new Set<string>();
  for (const m of getThread(threadId)) {
    const lc = m.metadata?.lifecycle as { quarantineId?: unknown } | undefined;
    if (typeof lc?.quarantineId === 'string') ids.add(lc.quarantineId);
  }
  return ids;
}

export function syncQuarantineCards(threadId: string): void {
  // Quarantine review cards belong ONLY in the main chat (mirrors the mobile
  // onQuarantinedD2D hook, which always posts to `main`). `useLiveThread`
  // mounts for other threads too; hard-scope here so a per-peer thread never
  // gets an unknown-sender card injected into it.
  if (threadId !== 'main') return;
  void (async () => {
    let messages: QuarantinedMessage[] = [];
    try {
      const res = await fetch('/api/v1/d2d/quarantine');
      if (!res.ok) return;
      const body = (await res.json()) as { messages?: QuarantinedMessage[] };
      messages = body.messages ?? [];
    } catch {
      return; // transient blip — a later mount retries
    }
    const shown = shownQuarantineIds(threadId);
    for (const msg of messages) {
      if (shown.has(msg.id)) continue;
      addMessage(threadId, 'dina', `Someone who isn't in your contacts wants to message you.`, {
        metadata: {
          source: 'd2d',
          senderDID: msg.senderDID,
          lifecycle: {
            kind: 'quarantine_request',
            quarantineId: msg.id,
            senderDID: msg.senderDID,
            messageType: msg.messageType,
          },
        },
      });
    }
  })();
}
