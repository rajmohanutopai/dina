/**
 * D2D message view hook — display inbound messages, reply, quarantine review.
 *
 * Provides:
 *   - List inbound D2D messages (staged + quarantined)
 *   - Message detail with sender info and trust level
 *   - Reply flow (compose → send via D2D pipeline)
 *   - Quarantine review: accept sender (un-quarantine) or block
 *
 * Source: ARCHITECTURE.md Task 6.19
 */

import { getThread, addMessage, type ChatMessage } from '@dina/brain/chat';
// `addContact` here is the contact-DIRECTORY version (records the person +
// trust level) — distinct from the 1-arg egress-gate `addContact` on
// `@dina/core/d2d`. Accepting a stranger must record the real contact so
// resolveSender returns a positive trust on their NEXT message too.
import { addContact, getContact, updateContact } from '@dina/core';
import {
  listQuarantined,
  listBySender,
  getQuarantined,
  unquarantineSender,
  blockSender,
  quarantineSize,
  resetQuarantineState,
  receiveAndStage,
} from '@dina/core/d2d';

export interface D2DMessageItem {
  id: string;
  senderDID: string;
  senderLabel: string;
  messageType: string;
  body: string;
  timestamp: number;
  timeLabel: string;
  isQuarantined: boolean;
  trustLevel: string;
}

export interface QuarantineAction {
  action: 'accepted' | 'blocked' | 'error';
  senderDID: string;
  error?: string;
}

/** DID → display label mapping. */
const senderLabels = new Map<string, string>();

/** Register a display label for a sender DID. */
export function registerSenderLabel(did: string, label: string): void {
  senderLabels.set(did, label);
}

/**
 * Get inbound D2D messages from the chat thread.
 */
export function getInboundMessages(threadId?: string): D2DMessageItem[] {
  const messages = getThread(threadId ?? 'main');
  return messages
    .filter((m) => m.type === 'dina' || m.type === 'system')
    .filter((m) => m.metadata?.source === 'd2d')
    .map((m) => toMessageItem(m, false));
}

/**
 * Get quarantined messages awaiting review.
 */
export function getQuarantinedMessages(): D2DMessageItem[] {
  const items = listQuarantined();
  return items.map((q) => ({
    id: q.id,
    senderDID: q.senderDID,
    senderLabel: senderLabels.get(q.senderDID) ?? shortDID(q.senderDID),
    messageType: q.messageType,
    body: typeof q.body === 'string' ? q.body : JSON.stringify(q.body),
    timestamp: q.receivedAt,
    timeLabel: formatTime(q.receivedAt),
    isQuarantined: true,
    trustLevel: 'unknown',
  }));
}

/**
 * Durably set a sender's trust level — an UPSERT. `addContact` THROWS when a
 * contact policy already exists, so a sender who is already a contact (e.g.
 * `trustLevel='unknown'` — the very state that gets their messages
 * quarantined) must be UPDATED in place, not re-added. Without this split,
 * Accept never upgrades an existing unknown contact to verified (their next
 * message re-quarantines forever) and Block fails outright for any existing
 * non-blocked contact.
 */
function setSenderTrust(did: string, trustLevel: 'verified' | 'blocked'): void {
  if (getContact(did) !== null) {
    updateContact(did, { trustLevel });
  } else {
    addContact(did, senderLabels.get(did) ?? shortDID(did), trustLevel);
  }
}

/**
 * Accept a quarantined message — add sender as contact, un-quarantine.
 */
export function acceptFromQuarantine(quarantineId: string): QuarantineAction {
  try {
    const entry = getQuarantined(quarantineId);
    if (!entry) {
      return { action: 'error', senderDID: '', error: 'Quarantine entry not found' };
    }
    // 1. Record the sender as a verified contact so this message AND every
    //    future one from them passes the trust gate (resolveSender reads
    //    the contact directory). Upsert: new contact → add; existing
    //    (e.g. 'unknown') → UPDATE to 'verified' so future messages stop
    //    re-quarantining.
    try {
      setSenderTrust(entry.senderDID, 'verified');
    } catch (addErr) {
      // The sender must end up durably VERIFIED before we release the message.
      // A failure that leaves them null OR still 'unknown' must NOT release:
      // updateContact writes SQL first (directory.ts), so a failed durable
      // write throws with the cached contact UNCHANGED — the contact exists but
      // the trust upgrade didn't stick. Force-staging then would push the
      // message through on a phantom upgrade (and the next message would just
      // re-quarantine). Require the verified post-condition, not mere existence.
      if (getContact(entry.senderDID)?.trustLevel !== 'verified') {
        return {
          action: 'error',
          senderDID: entry.senderDID,
          error: `Could not save contact: ${addErr instanceof Error ? addErr.message : String(addErr)}`,
        };
      }
    }
    // 2. Stage every held message BEFORE deleting its quarantine row. If the
    //    durable staging write throws, the original row remains retryable
    //    instead of being silently lost between the two stores. Successful
    //    retries are safe because staging deduplicates on the message id.
    const held = listBySender(entry.senderDID);
    for (const msg of held) {
      const body = typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body);
      // `isContact: true` (6th arg) is the real "known sender" gate in
      // receiveAndStage — the `senderTrust` string only short-circuits
      // 'blocked'. We just added them as a contact above, so force-stage
      // (otherwise the message would re-quarantine in a loop).
      const staged = receiveAndStage(
        msg.messageType,
        entry.senderDID,
        'verified',
        body,
        msg.id,
        true,
      );
      if (staged.action !== 'staged') {
        return {
          action: 'error',
          senderDID: entry.senderDID,
          error: `Could not process held message: ${staged.reason}`,
        };
      }
    }
    unquarantineSender(entry.senderDID);
    return { action: 'accepted', senderDID: entry.senderDID };
  } catch (err) {
    return {
      action: 'error',
      senderDID: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Block a quarantined sender — delete message, block DID.
 */
export function blockFromQuarantine(quarantineId: string): QuarantineAction {
  try {
    const entry = getQuarantined(quarantineId);
    if (!entry) {
      return { action: 'error', senderDID: '', error: 'Quarantine entry not found' };
    }
    // Persist a DURABLE block first: record the sender as a 'blocked' contact
    // so resolveSender returns senderTrust='blocked' and receive_pipeline drops
    // every FUTURE message pre-gate (d2d_recv_blocked). Without this, blockSender
    // only clears the currently-held rows and the next message just
    // re-quarantines — a block that doesn't block. Upsert: new contact → add
    // as blocked; existing (e.g. 'unknown') → UPDATE to 'blocked'.
    try {
      setSenderTrust(entry.senderDID, 'blocked');
    } catch (addErr) {
      // Couldn't persist the block — surface it rather than silently clearing
      // the held rows (which would look "blocked" but let the next message in).
      if (getContact(entry.senderDID)?.trustLevel !== 'blocked') {
        return {
          action: 'error',
          senderDID: entry.senderDID,
          error: `Could not block sender: ${addErr instanceof Error ? addErr.message : String(addErr)}`,
        };
      }
    }
    // Then drop the currently-held quarantined messages from this sender.
    blockSender(entry.senderDID);
    return { action: 'blocked', senderDID: entry.senderDID };
  } catch (err) {
    return {
      action: 'error',
      senderDID: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Compose a reply to a D2D sender.
 * Adds the reply to the chat thread and returns it.
 */
export function composeReply(senderDID: string, text: string, threadId?: string): ChatMessage {
  return addMessage(threadId ?? 'main', 'user', text, {
    metadata: { replyTo: senderDID, source: 'd2d' },
  });
}

/**
 * Get quarantine badge count.
 */
export function getQuarantineBadge(): number {
  return quarantineSize();
}

/**
 * Reset (for testing).
 */
export function resetD2DMessages(): void {
  senderLabels.clear();
  resetQuarantineState();
}

/** Map ChatMessage to D2D item. */
function toMessageItem(m: ChatMessage, isQuarantined: boolean): D2DMessageItem {
  return {
    id: m.id,
    senderDID: (m.metadata?.senderDID as string) ?? '',
    senderLabel: senderLabels.get((m.metadata?.senderDID as string) ?? '') ?? 'Unknown',
    messageType: (m.metadata?.messageType as string) ?? 'message',
    body: m.content,
    timestamp: m.timestamp,
    timeLabel: formatTime(m.timestamp),
    isQuarantined,
    trustLevel: (m.metadata?.trustLevel as string) ?? 'unknown',
  };
}

/** Short DID for display. */
function shortDID(did: string): string {
  if (!did || did.length <= 20) return did || 'Unknown';
  return `${did.slice(0, 12)}...${did.slice(-4)}`;
}

/** Format timestamp. */
function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}
