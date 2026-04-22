/**
 * Quarantine management — manage quarantined D2D messages from unknown senders.
 *
 * When a D2D message arrives from an unknown sender, it's quarantined
 * rather than staged to the vault. The user can then:
 *   - Add sender as contact → un-quarantine, stage the message
 *   - Block sender → delete quarantined messages from that sender
 *   - Ignore → message auto-expires after 30-day TTL
 *
 * Source: ARCHITECTURE.md Task 6.13
 */

export interface QuarantinedMessage {
  id: string;
  senderDID: string;
  messageType: string;
  body: string;
  receivedAt: number; // ms timestamp
  expiresAt: number; // ms timestamp
}

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** In-memory quarantine store keyed by message ID. */
const quarantine = new Map<string, QuarantinedMessage>();

/** Counter for generating quarantine IDs. */
let idCounter = 0;

/**
 * Add a message to quarantine.
 */
export function quarantineMessage(
  senderDID: string,
  messageType: string,
  body: string,
  now?: number,
): QuarantinedMessage {
  const currentTime = now ?? Date.now();
  const msg: QuarantinedMessage = {
    id: `q-${++idCounter}`,
    senderDID,
    messageType,
    body,
    receivedAt: currentTime,
    expiresAt: currentTime + TTL_MS,
  };
  quarantine.set(msg.id, msg);
  return msg;
}

/**
 * List all quarantined messages.
 * Sorted by receivedAt descending (newest first).
 */
export function listQuarantined(): QuarantinedMessage[] {
  return [...quarantine.values()].sort((a, b) => b.receivedAt - a.receivedAt);
}

/**
 * List quarantined messages from a specific sender.
 */
export function listBySender(senderDID: string): QuarantinedMessage[] {
  return [...quarantine.values()]
    .filter((m) => m.senderDID === senderDID)
    .sort((a, b) => b.receivedAt - a.receivedAt);
}

/**
 * Un-quarantine: remove messages for a sender (after adding them as contact).
 *
 * Returns the removed messages so the caller can stage them to the vault.
 */
export function unquarantineSender(senderDID: string): QuarantinedMessage[] {
  const messages: QuarantinedMessage[] = [];
  for (const [id, msg] of quarantine.entries()) {
    if (msg.senderDID === senderDID) {
      messages.push(msg);
      quarantine.delete(id);
    }
  }
  return messages;
}

/**
 * Block sender: delete all quarantined messages from this sender.
 *
 * Returns count of deleted messages.
 */
export function blockSender(senderDID: string): number {
  let deleted = 0;
  for (const [id, msg] of quarantine.entries()) {
    if (msg.senderDID === senderDID) {
      quarantine.delete(id);
      deleted++;
    }
  }
  return deleted;
}

/**
 * Delete a single quarantined message by ID.
 */
export function deleteQuarantined(messageId: string): boolean {
  return quarantine.delete(messageId);
}

/**
 * Sweep expired quarantined messages (older than 30-day TTL).
 * Returns count of purged messages.
 */
export function sweepExpired(now?: number): number {
  const currentTime = now ?? Date.now();
  let purged = 0;
  for (const [id, msg] of quarantine.entries()) {
    if (currentTime >= msg.expiresAt) {
      quarantine.delete(id);
      purged++;
    }
  }
  return purged;
}

/** Get quarantine size. */
export function quarantineSize(): number {
  return quarantine.size;
}

/** Get a quarantined message by ID. */
export function getQuarantined(messageId: string): QuarantinedMessage | null {
  return quarantine.get(messageId) ?? null;
}

/** Get unique sender DIDs in quarantine. */
export function getQuarantinedSenders(): string[] {
  const senders = new Set<string>();
  for (const msg of quarantine.values()) {
    senders.add(msg.senderDID);
  }
  return [...senders];
}

/** Reset all quarantine state (for testing). */
export function resetQuarantineState(): void {
  quarantine.clear();
  idCounter = 0;
}
