/**
 * Chat-message repository — durable storage for the Brain thread model.
 *
 * Review #14: the chat thread store used to be process-memory only, so
 * the full conversation history (including async service replies and
 * approval prompts) disappeared on every app restart. This repository
 * is the durable backing: Brain's thread module dual-writes every
 * `addMessage` into it and hydrates from it on unlock.
 *
 * Greenfield — no migration from any prior shape.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

/** Persisted chat message — mirrors Brain's `ChatMessage` 1:1. */
export interface StoredChatMessage {
  id: string;
  threadId: string;
  type: string;
  content: string;
  metadata: Record<string, unknown>;
  sources: string[];
  timestamp: number;
}

export interface ChatMessageRepository {
  /** Append a message to its thread. Upserts on `id` so a dual-write
   *  that somehow runs twice doesn't error. */
  append(msg: StoredChatMessage): Promise<void>;
  /** List messages for a thread in chronological order. */
  listByThread(threadId: string, limit?: number): Promise<StoredChatMessage[]>;
  /** Enumerate every thread id that has at least one message. */
  listThreadIds(): Promise<string[]>;
  /** Delete an entire thread. Returns `true` iff any row was removed. */
  deleteThread(threadId: string): Promise<boolean>;
  /** Remove every thread + message. Testing / identity-reset. */
  reset(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Global accessor — follows the repository-setter convention from
// `reminders/repository.ts`. Startup wires the SQLite instance; tests
// override with `setChatMessageRepository(new InMemoryChatMessageRepository())`.
// ---------------------------------------------------------------------------

let repo: ChatMessageRepository | null = null;

export function setChatMessageRepository(r: ChatMessageRepository | null): void {
  repo = r;
}

export function getChatMessageRepository(): ChatMessageRepository | null {
  return repo;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

export class SQLiteChatMessageRepository implements ChatMessageRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async append(msg: StoredChatMessage): Promise<void> {
    this.db.execute(
      `INSERT OR REPLACE INTO chat_messages
       (id, thread_id, type, content, metadata, sources, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.id,
        msg.threadId,
        msg.type,
        msg.content,
        JSON.stringify(msg.metadata ?? {}),
        JSON.stringify(msg.sources ?? []),
        msg.timestamp,
      ],
    );
  }

  async listByThread(threadId: string, limit?: number): Promise<StoredChatMessage[]> {
    // `rowid ASC` preserves insertion order for messages that share a
    // millisecond timestamp (the ChatMessage shape exposes millis only,
    // but three synchronous `addMessage` calls can all land in the
    // same tick). Random ids would otherwise reshuffle them.
    const sql =
      limit !== undefined
        ? `SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY timestamp ASC, rowid ASC LIMIT ?`
        : `SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY timestamp ASC, rowid ASC`;
    const args = limit !== undefined ? [threadId, limit] : [threadId];
    const rows = this.db.query(sql, args);
    return rows.map(rowToMessage);
  }

  async listThreadIds(): Promise<string[]> {
    const rows = this.db.query(
      `SELECT DISTINCT thread_id FROM chat_messages ORDER BY thread_id ASC`,
    );
    return rows.map((r) => String(r.thread_id));
  }

  async deleteThread(threadId: string): Promise<boolean> {
    const affected = this.db.run(`DELETE FROM chat_messages WHERE thread_id = ?`, [threadId]);
    return affected > 0;
  }

  async reset(): Promise<void> {
    this.db.run(`DELETE FROM chat_messages`, []);
  }
}

function rowToMessage(row: DBRow): StoredChatMessage {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    type: String(row.type),
    content: String(row.content ?? ''),
    metadata: safeParseObject(row.metadata),
    sources: safeParseArray(row.sources),
    timestamp: Number(row.timestamp ?? 0),
  };
}

function safeParseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function safeParseArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation — for tests + pre-persistence boots.
// ---------------------------------------------------------------------------

export class InMemoryChatMessageRepository implements ChatMessageRepository {
  private readonly rows: StoredChatMessage[] = [];

  async append(msg: StoredChatMessage): Promise<void> {
    // Upsert semantics — match SQLite's INSERT OR REPLACE on id.
    const existingIdx = this.rows.findIndex((r) => r.id === msg.id);
    const cloned: StoredChatMessage = {
      ...msg,
      metadata: { ...(msg.metadata ?? {}) },
      sources: [...(msg.sources ?? [])],
    };
    if (existingIdx >= 0) {
      this.rows[existingIdx] = cloned;
    } else {
      this.rows.push(cloned);
    }
  }

  async listByThread(threadId: string, limit?: number): Promise<StoredChatMessage[]> {
    // Stable timestamp sort — ES2019+ Array#sort is stable, so equal
    // timestamps preserve the push() insertion order (matching the
    // SQLite `rowid ASC` tie-break). Keeping random ids out of the
    // comparator avoids reordering within a single-millisecond batch.
    const filtered = this.rows
      .filter((r) => r.threadId === threadId)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((r) => ({ ...r, metadata: { ...r.metadata }, sources: [...r.sources] }));
    return limit !== undefined ? filtered.slice(0, limit) : filtered;
  }

  async listThreadIds(): Promise<string[]> {
    return Array.from(new Set(this.rows.map((r) => r.threadId))).sort();
  }

  async deleteThread(threadId: string): Promise<boolean> {
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i].threadId === threadId) this.rows.splice(i, 1);
    }
    return this.rows.length !== before;
  }

  async reset(): Promise<void> {
    this.rows.length = 0;
  }
}
