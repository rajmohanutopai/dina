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

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

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

// ── Persistence ──────────────────────────────────────────────────────────
// The in-memory map above is the authoritative read surface, but a durable
// repo (installed at unlock) lets the quarantine survive an app restart so
// the "Unknown sender" card's Accept/Block keep working. Without it the map
// empties on boot and `getQuarantined()` returns null for the re-rendered
// card. See `hydrateQuarantineFromRepository`.

export interface QuarantineRepository {
  add(msg: QuarantinedMessage): void;
  deleteById(id: string): void;
  deleteBySender(senderDID: string): void;
  deleteExpired(now: number): void;
  listAll(): QuarantinedMessage[];
  clear(): void;
}

let repo: QuarantineRepository | null = null;
export function setQuarantineRepository(r: QuarantineRepository | null): void {
  repo = r;
}
export function getQuarantineRepository(): QuarantineRepository | null {
  return repo;
}

export class SQLiteQuarantineRepository implements QuarantineRepository {
  constructor(private readonly db: DatabaseAdapter) {}
  add(m: QuarantinedMessage): void {
    this.db.run(
      `INSERT OR REPLACE INTO d2d_quarantine
         (id, sender_did, message_type, body, received_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [m.id, m.senderDID, m.messageType, m.body, m.receivedAt, m.expiresAt],
    );
  }
  deleteById(id: string): void {
    this.db.execute('DELETE FROM d2d_quarantine WHERE id = ?', [id]);
  }
  deleteBySender(senderDID: string): void {
    this.db.execute('DELETE FROM d2d_quarantine WHERE sender_did = ?', [senderDID]);
  }
  deleteExpired(now: number): void {
    this.db.execute('DELETE FROM d2d_quarantine WHERE expires_at <= ?', [now]);
  }
  listAll(): QuarantinedMessage[] {
    const rows = this.db.query<DBRow>('SELECT * FROM d2d_quarantine', []);
    return rows.map((r) => ({
      id: String(r.id),
      senderDID: String(r.sender_did),
      messageType: String(r.message_type),
      body: String(r.body),
      receivedAt: Number(r.received_at),
      expiresAt: Number(r.expires_at),
    }));
  }
  clear(): void {
    this.db.execute('DELETE FROM d2d_quarantine', []);
  }
}

/**
 * Re-populate the in-memory map from the durable repo on boot. Restores the
 * SAME ids the persisted quarantine cards reference, and advances the id
 * counter past them so new quarantines don't collide. Returns the count.
 */
export function hydrateQuarantineFromRepository(): number {
  if (repo === null) return 0;
  const entries = repo.listAll();
  let maxId = idCounter;
  for (const m of entries) {
    quarantine.set(m.id, m);
    const n = Number.parseInt(m.id.replace(/^q-/, ''), 10);
    if (!Number.isNaN(n) && n > maxId) maxId = n;
  }
  idCounter = maxId;
  return entries.length;
}

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
  repo?.add(msg);
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
  repo?.deleteBySender(senderDID);
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
  repo?.deleteBySender(senderDID);
  return deleted;
}

/**
 * Delete a single quarantined message by ID.
 */
export function deleteQuarantined(messageId: string): boolean {
  repo?.deleteById(messageId);
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
  repo?.deleteExpired(currentTime);
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
