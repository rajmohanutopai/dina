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
import {
  listQuarantined,
  getQuarantined,
  unquarantineSender,
  blockSender,
  deleteQuarantined,
  quarantineSize,
  resetQuarantineState,
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
 * Accept a quarantined message — add sender as contact, un-quarantine.
 */
export function acceptFromQuarantine(quarantineId: string): QuarantineAction {
  try {
    const entry = getQuarantined(quarantineId);
    if (!entry) {
      return { action: 'error', senderDID: '', error: 'Quarantine entry not found' };
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
