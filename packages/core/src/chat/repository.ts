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
 *
 * The thread's taint records live and die with its messages (UCP plan
 * §3.16): the first message written to a thread marks it covered
 * (`conversation_coverage`), so Core knows its `conversation_taint` rows are
 * the whole record; once a thread has no messages left, both go.
 */

import { forgetConversation } from '../conversation/forget';
import { currentDataScope, type DataScope } from '../scope/data_scope';
import { scopedInsertFields, scopedParams, scopedWhere } from '../scope/repository';
import { releaseSessionId } from '../vault/release';

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
    this.db.transaction(() => {
      // A thread's first message, written here: its taint record is complete from now on.
      // Across every data scope, so a demo thread's history cannot pass for a new one.
      const earlier = this.db.query(`SELECT 1 FROM chat_messages WHERE thread_id = ? LIMIT 1`, [
        msg.threadId,
      ]);
      if (earlier.length === 0) {
        this.db.run(
          `INSERT OR IGNORE INTO conversation_coverage (session_id, covered_since) VALUES (?, ?)`,
          [releaseSessionId('chat', msg.threadId), msg.timestamp],
        );
      }
      this.insert(msg);
    });
  }

  private insert(msg: StoredChatMessage): void {
    this.db.execute(
      `INSERT OR REPLACE INTO chat_messages
       (id, thread_id, type, content, metadata, sources, timestamp, data_scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.id,
        msg.threadId,
        msg.type,
        msg.content,
        JSON.stringify(msg.metadata ?? {}),
        JSON.stringify(msg.sources ?? []),
        msg.timestamp,
        scopedInsertFields().data_scope,
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
        ? `SELECT * FROM chat_messages WHERE thread_id = ? AND ${scopedWhere()} ORDER BY timestamp ASC, rowid ASC LIMIT ?`
        : `SELECT * FROM chat_messages WHERE thread_id = ? AND ${scopedWhere()} ORDER BY timestamp ASC, rowid ASC`;
    const args =
      limit !== undefined ? [threadId, ...scopedParams(), limit] : [threadId, ...scopedParams()];
    const rows = this.db.query(sql, args);
    return rows.map(rowToMessage);
  }

  async listThreadIds(): Promise<string[]> {
    const rows = this.db.query(
      `SELECT DISTINCT thread_id FROM chat_messages WHERE ${scopedWhere()} ORDER BY thread_id ASC`,
      [...scopedParams()],
    );
    return rows.map((r) => String(r.thread_id));
  }

  async deleteThread(threadId: string): Promise<boolean> {
    let affected = 0;
    this.db.transaction(() => {
      affected = this.db.run(`DELETE FROM chat_messages WHERE thread_id = ? AND ${scopedWhere()}`, [
        threadId,
        ...scopedParams(),
      ]);
      this.forgetIfEmpty([threadId]);
    });
    return affected > 0;
  }

  /** A thread with no messages left is a conversation that has ended: Core forgets what it kept about it. */
  private forgetIfEmpty(threadIds: readonly string[]): void {
    for (const threadId of threadIds) {
      if (
        this.db.query(`SELECT 1 FROM chat_messages WHERE thread_id = ? LIMIT 1`, [threadId])
          .length > 0
      )
        continue;
      forgetConversation(this.db, releaseSessionId('chat', threadId));
    }
  }

  async reset(): Promise<void> {
    // Scope-bound reset (spec: deletes filter to currentDataScope) — a demo
    // reset never wipes user chat. Full sign-out wipe goes through teardown.
    this.db.transaction(() => {
      const threads = this.db
        .query(`SELECT DISTINCT thread_id FROM chat_messages WHERE ${scopedWhere()}`, [
          ...scopedParams(),
        ])
        .map((r) => String(r.thread_id));
      this.db.run(`DELETE FROM chat_messages WHERE ${scopedWhere()}`, [...scopedParams()]);
      this.forgetIfEmpty(threads);
    });
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
  // Each row carries the scope it was appended under (mirrors the SQLite
  // data_scope column), so reads/deletes can isolate by the active scope.
  private readonly rows: { msg: StoredChatMessage; scope: DataScope }[] = [];

  async append(msg: StoredChatMessage): Promise<void> {
    // Upsert semantics — match SQLite's INSERT OR REPLACE on id (ids are
    // globally unique, so this never collides across scopes); re-stamp scope.
    const existingIdx = this.rows.findIndex((r) => r.msg.id === msg.id);
    const cloned: StoredChatMessage = {
      ...msg,
      metadata: { ...(msg.metadata ?? {}) },
      sources: [...(msg.sources ?? [])],
    };
    const entry = { msg: cloned, scope: currentDataScope() };
    if (existingIdx >= 0) {
      this.rows[existingIdx] = entry;
    } else {
      this.rows.push(entry);
    }
  }

  async listByThread(threadId: string, limit?: number): Promise<StoredChatMessage[]> {
    const scope = currentDataScope();
    const filtered = this.rows
      .filter((r) => r.scope === scope && r.msg.threadId === threadId)
      .map((r) => r.msg)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((m) => ({ ...m, metadata: { ...m.metadata }, sources: [...m.sources] }));
    return limit !== undefined ? filtered.slice(0, limit) : filtered;
  }

  async listThreadIds(): Promise<string[]> {
    const scope = currentDataScope();
    return Array.from(
      new Set(this.rows.filter((r) => r.scope === scope).map((r) => r.msg.threadId)),
    ).sort();
  }

  async deleteThread(threadId: string): Promise<boolean> {
    const scope = currentDataScope();
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i].scope === scope && this.rows[i].msg.threadId === threadId) {
        this.rows.splice(i, 1);
      }
    }
    return this.rows.length !== before;
  }

  async reset(): Promise<void> {
    // Scope-bound (matches the SQLite repo): clears only the active scope.
    const scope = currentDataScope();
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i].scope === scope) this.rows.splice(i, 1);
    }
  }
}
