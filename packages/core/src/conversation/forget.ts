/**
 * What Core keeps about a conversation, forgotten when the conversation ends
 * (its last message deleted, chat reset, or its history replaced by a forced
 * restore). One place names it all, so every path that ends a conversation
 * forgets the same things:
 *  - its taint and coverage records (UCP plan §3.16);
 *  - its UCP handles, searches, results and guard jobs (§3.11), and the
 *    counters behind its handles.
 */

import { UcpSearchStore } from '../commerce/ucp/search_store';

import type { DatabaseAdapter } from '../storage/db_adapter';

export function forgetConversation(db: DatabaseAdapter, sessionId: string): void {
  db.run(`DELETE FROM conversation_taint WHERE session_id = ?`, [sessionId]);
  db.run(`DELETE FROM conversation_coverage WHERE session_id = ?`, [sessionId]);
  new UcpSearchStore(db).forgetSession(sessionId);
}
