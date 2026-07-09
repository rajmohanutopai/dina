/**
 * Durable agent persona-grant repository (issues.txt §2).
 *
 * A grant is the persisted RESULT of a user approving an agent's request
 * for locked/sensitive persona data. It is bound to the exact
 * `(agent_did, persona, mode)` and bounded by `expires_at`; `revoked_at`
 * tombstones it. The deterministic `requireAgentPersonaAccess` gate reads
 * `findActiveGrant` before any agent-facing vault read — no grant, no
 * data. Durability (SQLCipher) is what lets the agent resume after an app
 * restart.
 *
 * Sync on purpose (same rationale as the outbox repo + `db_adapter.ts`):
 * the gate runs inline on the vault read path.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type GrantMode = 'read' | 'write';

export interface AgentPersonaGrant {
  id: string;
  sessionId: string | null;
  agentDID: string;
  persona: string;
  mode: GrantMode;
  /** JSON of the REQUESTED scope (e.g. the agent's query) — never vault results. */
  scopeJson: string;
  approvalTaskId: string;
  expiresAt: number;
  revokedAt: number | null;
  createdAt: number;
}

export interface AgentPersonaGrantInsert {
  id: string;
  sessionId?: string | null;
  agentDID: string;
  persona: string;
  mode: GrantMode;
  scopeJson: string;
  approvalTaskId: string;
  expiresAt: number;
  createdAt: number;
}

export interface AgentGrantRepository {
  insert(grant: AgentPersonaGrantInsert): AgentPersonaGrant;
  get(id: string): AgentPersonaGrant | null;
  /**
   * The hot path: return an active (not revoked, not expired) grant for the
   * exact tuple `(agentDID, session, persona)` whose mode satisfies `mode` — a
   * `write` grant also satisfies a `read` request. `null` when none.
   *
   * SESSION-SCOPED (dina_details.md §3.6): a grant is keyed on the exact
   * session it was approved under; `sessionId` is matched null-safely (a
   * session-less request `null` matches only session-less grants, a named
   * session matches only that session's grants). A fresh session therefore
   * finds no grant and re-prompts — approvals do NOT carry across sessions.
   * Deterministic; no LLM involvement.
   */
  findActiveGrant(
    agentDID: string,
    persona: string,
    mode: GrantMode,
    sessionId: string | null,
    now: number,
  ): AgentPersonaGrant | null;
  /** Tombstone one grant. Idempotent. Returns false if unknown. */
  revoke(id: string, now: number): boolean;
  /**
   * Revoke every active grant for an agent (e.g. when its device is
   * revoked — issues.txt §5). Returns the count revoked.
   */
  revokeForAgent(agentDID: string, now: number): number;
  /** Active grants for an agent (diagnostics / UI). */
  listActiveForAgent(agentDID: string, now: number): AgentPersonaGrant[];
  /** Every row (tests). */
  listAll(): AgentPersonaGrant[];
  /** Remove a row (tests). */
  remove(id: string): boolean;
}

let repo: AgentGrantRepository | null = null;
export function setAgentGrantRepository(r: AgentGrantRepository | null): void {
  repo = r;
}
export function getAgentGrantRepository(): AgentGrantRepository | null {
  return repo;
}

const COLS =
  'id, session_id, agent_did, persona, mode, scope_json, approval_task_id, expires_at, revoked_at, created_at';

export class SQLiteAgentGrantRepository implements AgentGrantRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  insert(g: AgentPersonaGrantInsert): AgentPersonaGrant {
    this.db.execute(
      `INSERT INTO agent_persona_grants
         (id, session_id, agent_did, persona, mode, scope_json, approval_task_id, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [
        g.id,
        g.sessionId ?? null,
        g.agentDID,
        g.persona,
        g.mode,
        g.scopeJson,
        g.approvalTaskId,
        g.expiresAt,
        g.createdAt,
      ],
    );
    const row = this.get(g.id);
    if (row === null) throw new Error(`agent_persona_grants: insert of ${g.id} did not persist`);
    return row;
  }

  get(id: string): AgentPersonaGrant | null {
    const rows = this.db.query(`SELECT ${COLS} FROM agent_persona_grants WHERE id = ?`, [id]);
    return rows.length > 0 ? rowToGrant(rows[0]) : null;
  }

  findActiveGrant(
    agentDID: string,
    persona: string,
    mode: GrantMode,
    sessionId: string | null,
    now: number,
  ): AgentPersonaGrant | null {
    // `session_id IS ?` is null-safe: a null bind matches session_id IS NULL,
    // a value matches equality — so the session dimension is part of the key.
    const rows = this.db.query(
      `SELECT ${COLS} FROM agent_persona_grants
        WHERE agent_did = ? AND persona = ? AND session_id IS ? AND revoked_at IS NULL
          AND expires_at > ? AND (mode = ? OR mode = 'write')
        ORDER BY expires_at DESC
        LIMIT 1`,
      [agentDID, persona, sessionId, now, mode],
    );
    return rows.length > 0 ? rowToGrant(rows[0]) : null;
  }

  revoke(id: string, now: number): boolean {
    const existing = this.db.query(
      'SELECT 1 FROM agent_persona_grants WHERE id = ? AND revoked_at IS NULL',
      [id],
    );
    if (existing.length === 0) return false;
    this.db.execute('UPDATE agent_persona_grants SET revoked_at = ? WHERE id = ?', [now, id]);
    return true;
  }

  revokeForAgent(agentDID: string, now: number): number {
    return this.db.run(
      'UPDATE agent_persona_grants SET revoked_at = ? WHERE agent_did = ? AND revoked_at IS NULL',
      [now, agentDID],
    );
  }

  listActiveForAgent(agentDID: string, now: number): AgentPersonaGrant[] {
    return this.db
      .query(
        `SELECT ${COLS} FROM agent_persona_grants
          WHERE agent_did = ? AND revoked_at IS NULL AND expires_at > ?
          ORDER BY created_at DESC`,
        [agentDID, now],
      )
      .map(rowToGrant);
  }

  listAll(): AgentPersonaGrant[] {
    return this.db
      .query(`SELECT ${COLS} FROM agent_persona_grants ORDER BY created_at ASC`)
      .map(rowToGrant);
  }

  remove(id: string): boolean {
    const existing = this.db.query('SELECT 1 FROM agent_persona_grants WHERE id = ?', [id]);
    if (existing.length === 0) return false;
    this.db.execute('DELETE FROM agent_persona_grants WHERE id = ?', [id]);
    return true;
  }
}

/**
 * In-memory mirror — dev/test fallback used when no SQL repo is
 * installed. Same semantics as the SQLite impl (parity-tested).
 */
export class InMemoryAgentGrantRepository implements AgentGrantRepository {
  private rows = new Map<string, AgentPersonaGrant>();

  clear(): void {
    this.rows.clear();
  }

  insert(g: AgentPersonaGrantInsert): AgentPersonaGrant {
    const row: AgentPersonaGrant = {
      id: g.id,
      sessionId: g.sessionId ?? null,
      agentDID: g.agentDID,
      persona: g.persona,
      mode: g.mode,
      scopeJson: g.scopeJson,
      approvalTaskId: g.approvalTaskId,
      expiresAt: g.expiresAt,
      revokedAt: null,
      createdAt: g.createdAt,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  get(id: string): AgentPersonaGrant | null {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }

  findActiveGrant(
    agentDID: string,
    persona: string,
    mode: GrantMode,
    sessionId: string | null,
    now: number,
  ): AgentPersonaGrant | null {
    let best: AgentPersonaGrant | null = null;
    for (const r of this.rows.values()) {
      if (
        r.agentDID === agentDID &&
        r.persona === persona &&
        r.sessionId === sessionId &&
        r.revokedAt === null &&
        r.expiresAt > now &&
        (r.mode === mode || r.mode === 'write')
      ) {
        if (best === null || r.expiresAt > best.expiresAt) best = r;
      }
    }
    return best ? { ...best } : null;
  }

  revoke(id: string, now: number): boolean {
    const r = this.rows.get(id);
    if (!r || r.revokedAt !== null) return false;
    r.revokedAt = now;
    return true;
  }

  revokeForAgent(agentDID: string, now: number): number {
    let count = 0;
    for (const r of this.rows.values()) {
      if (r.agentDID === agentDID && r.revokedAt === null) {
        r.revokedAt = now;
        count++;
      }
    }
    return count;
  }

  listActiveForAgent(agentDID: string, now: number): AgentPersonaGrant[] {
    return [...this.rows.values()]
      .filter((r) => r.agentDID === agentDID && r.revokedAt === null && r.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({ ...r }));
  }

  listAll(): AgentPersonaGrant[] {
    return [...this.rows.values()].sort((a, b) => a.createdAt - b.createdAt).map((r) => ({ ...r }));
  }

  remove(id: string): boolean {
    return this.rows.delete(id);
  }
}

function rowToGrant(row: DBRow): AgentPersonaGrant {
  return {
    id: String(row.id ?? ''),
    sessionId: row.session_id === null ? null : String(row.session_id),
    agentDID: String(row.agent_did ?? ''),
    persona: String(row.persona ?? ''),
    mode: String(row.mode ?? 'read') as GrantMode,
    scopeJson: String(row.scope_json ?? '{}'),
    approvalTaskId: String(row.approval_task_id ?? ''),
    expiresAt: Number(row.expires_at ?? 0),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    createdAt: Number(row.created_at ?? 0),
  };
}
