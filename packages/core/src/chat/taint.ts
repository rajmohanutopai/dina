/**
 * What Brain has read in a conversation, for checks on text Brain sends out
 * (UCP plan §3.16; the same rule A2A applies to proposals).
 *
 * Two records together: the A2A release log (every release, for a day) and
 * `conversation_taint` (every persona read in a chat conversation, for as long
 * as its messages exist; written by the release log in the same
 * transaction). A conversation is `covered` when its record is known to be
 * whole: a chat thread whose first message was written on a node that keeps
 * `conversation_taint` (`conversation_coverage`). A thread begun before that,
 * or restored without it, is uncovered: a missing record must never read as
 * clean. An ask lives inside the release log's day and is covered by it when
 * the log holds it; a session Core has no record of is uncovered.
 */

import { isRestrictedRead, restrictedReads } from '../a2a/provenance';

import type { A2AReleaseLog } from '../a2a/release_log';
import type { DatabaseAdapter } from '../storage/db_adapter';

export interface ConversationTaint {
  covered: boolean;
  /** Restricted personas Brain read in this conversation, sorted. */
  restrictedPersonas: string[];
}

export function readConversationTaint(
  db: DatabaseAdapter,
  log: A2AReleaseLog,
  sessionId: string,
): ConversationTaint {
  const durable = db
    .query(`SELECT persona, persona_tier FROM conversation_taint WHERE session_id = ?`, [sessionId])
    .filter((r) => isRestrictedRead(String(r.persona_tier), String(r.persona)))
    .map((r) => String(r.persona));
  const restricted = [...new Set([...restrictedReads(log, sessionId), ...durable])].sort();
  // Covered only where Core holds the record: a chat thread marked from its first
  // message, or an ask the release log knows. Any other session is uncovered.
  const covered = sessionId.startsWith('chat:')
    ? db.query(`SELECT 1 FROM conversation_coverage WHERE session_id = ?`, [sessionId]).length > 0
    : sessionId.startsWith('ask:') && log.conversationStart(sessionId) !== null;
  return { covered, restrictedPersonas: restricted };
}
