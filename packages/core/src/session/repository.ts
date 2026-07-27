/**
 * Item D (Codex review — session SQLite durability).
 *
 * The `SessionRegistry` keeps sessions in an in-memory Map (fast, authoritative
 * for reads within a process). This repository is the DURABLE backing: it
 * persists each session to the identity SQLite store so a coding-agent session
 * (Claude Code / Codex) SURVIVES a Core restart — on boot the registry
 * reconciles from here, reusing a still-leased session instead of forcing the
 * agent to re-run `dina_session_start`, and reaping any whose lease lapsed while
 * Core was down.
 *
 * Sync on purpose (same rationale as the grant/outbox repos + `db_adapter.ts`):
 * session writes ride the inline start/heartbeat/end path.
 */

import {
  makeUnknownAuthorityOrigin,
  parseAuthorityOrigin,
  type AuthorityOrigin,
} from '../agent/gating_policy';

import type { EndReason, SessionRecord } from './registry';
import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export interface SessionRepository {
  /** Upsert a session row (INSERT OR REPLACE on session_id). */
  upsert(s: SessionRecord): void;
  /**
   * Every NOT-yet-ended session (ended_at IS NULL) — the boot-reconcile set.
   * Ended sessions are tombstones the registry never needs to reload.
   */
  loadActive(): SessionRecord[];
  /** Remove expired tombstones and cap retained recent tombstones. */
  pruneEnded?(endedBeforeMs: number, retainNewest: number): void;
}

const COLS =
  'session_id, agent_did, host_session_id, created_at, last_seen_at, lease_expires_at, ended_at, end_reason, authority_origin_json';

function parsePersistedAuthority(row: DBRow): AuthorityOrigin | null {
  const raw = row.authority_origin_json;
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string') {
    try {
      const parsed = parseAuthorityOrigin(JSON.parse(raw));
      if (parsed !== null) return parsed;
    } catch {
      // Fall through to a fail-closed unknown origin.
    }
  }
  return makeUnknownAuthorityOrigin({
    ownerDid: 'did:unknown',
    correlationId: 'corrupt-session-origin',
    authenticatedAtMs: 0,
  });
}

function rowToSession(row: DBRow): SessionRecord {
  const endedAt = row.ended_at;
  const endReason = row.end_reason;
  return {
    sessionId: String(row.session_id ?? ''),
    agentDid: String(row.agent_did ?? ''),
    hostSessionId: String(row.host_session_id ?? ''),
    createdAtMs: Number(row.created_at ?? 0),
    lastSeenAtMs: Number(row.last_seen_at ?? 0),
    leaseExpiresAtMs: Number(row.lease_expires_at ?? 0),
    endedAtMs: endedAt == null ? null : Number(endedAt),
    // Only canonical reasons survive; anything else (drift) → null.
    endReason:
      endReason === 'explicit' || endReason === 'lease_lapsed' || endReason === 'authority_revoked'
        ? (endReason as EndReason)
        : null,
    authorityOrigin: parsePersistedAuthority(row),
  };
}

export class SQLiteSessionRepository implements SessionRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  upsert(s: SessionRecord): void {
    this.db.execute(
      `INSERT OR REPLACE INTO agent_sessions (${COLS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        s.sessionId,
        s.agentDid,
        s.hostSessionId,
        s.createdAtMs,
        s.lastSeenAtMs,
        s.leaseExpiresAtMs,
        s.endedAtMs ?? null,
        s.endReason ?? null,
        s.authorityOrigin === null ? null : JSON.stringify(s.authorityOrigin),
      ],
    );
  }

  loadActive(): SessionRecord[] {
    return this.db
      .query(`SELECT ${COLS} FROM agent_sessions WHERE ended_at IS NULL`, [])
      .map(rowToSession);
  }

  pruneEnded(endedBeforeMs: number, retainNewest: number): void {
    const boundedRetain = Math.max(1, Math.floor(retainNewest));
    this.db.transaction(() => {
      this.db.execute(
        `DELETE FROM agent_sessions
          WHERE ended_at IS NOT NULL AND ended_at < ?`,
        [endedBeforeMs],
      );
      this.db.execute(
        `DELETE FROM agent_sessions
          WHERE ended_at IS NOT NULL
            AND session_id NOT IN (
              SELECT session_id FROM agent_sessions
               WHERE ended_at IS NOT NULL
               ORDER BY ended_at DESC, session_id DESC
               LIMIT ?
            )`,
        [boundedRetain],
      );
    });
  }
}
