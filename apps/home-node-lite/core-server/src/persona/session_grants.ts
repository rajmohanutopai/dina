/**
 * Task 4.70 — session grants scoped to named sessions.
 *
 * Agents (OpenClaw, other sidecars) work inside **named sessions**
 * — `dina session start --name "refactor-auth"` creates a session
 * that holds an explicit grant list for whatever personas the agent
 * needs to read/write during the task. When the session ends, all
 * grants it holds are revoked atomically. This prevents the classic
 * "agent still has access after the task it was granted access for
 * is done" failure mode.
 *
 * **Model**:
 *   - A `Session` owns a set of `(agentDid, persona, mode)` grants.
 *   - Multiple agents can participate in one session (e.g. OpenClaw
 *     + a review bot both scoped to `/work`).
 *   - Agents CAN belong to multiple sessions — `grant.check()`
 *     returns the UNION of their grants from all active sessions
 *     they're in.
 *   - Ending a session revokes all its grants in one step — grants
 *     an agent has from OTHER still-active sessions are preserved.
 *
 * **Model vs task 4.71 (auto-lock)**: those two are orthogonal.
 * Auto-lock is the PERSONA side (the vault file locks after idle).
 * Session grants are the AGENT side (the agent loses access when
 * the session ends). Both rails fail-closed independently: lock
 * kills vault access even if grants are still active; session end
 * kills grants even if the persona is still unlocked.
 *
 * **Storage**: in-memory today. When `@dina/storage-node` lands, a
 * SQLCipher-backed variant implements the same surface for
 * persistence across restarts. Grants are cheap + ephemeral so
 * in-memory-only matches how the Go Core handles them today.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4i task 4.70.
 */

export type GrantMode = 'read' | 'write';

export interface Grant {
  agentDid: string;
  persona: string;
  mode: GrantMode;
}

export interface SessionHandle {
  /** Stable session id (sender/operator-chosen). */
  readonly id: string;
  /** Session name for ops + logs (e.g. "refactor-auth"). */
  readonly name: string;
  /** When the session started (ms since epoch). */
  readonly startedAtMs: number;
}

export interface SessionGrantsOptions {
  /** Injectable clock (ms). Default `Date.now`. */
  nowMsFn?: () => number;
  /** Diagnostic hook. */
  onEvent?: (event: SessionEvent) => void;
}

export type SessionEvent =
  | { kind: 'session_started'; id: string; name: string }
  | { kind: 'session_ended'; id: string; name: string; revokedCount: number }
  | { kind: 'grant_added'; sessionId: string; grant: Grant }
  | { kind: 'grant_revoked'; sessionId: string; grant: Grant };

/**
 * In-memory registry of active sessions + their grants.
 * Thread-safe is irrelevant (Node single-threaded), but ordering is
 * deterministic — Map insertion order + explicit serialization.
 */
export class SessionGrantRegistry {
  private readonly sessions = new Map<string, SessionState>();
  private readonly nowMsFn: () => number;
  private readonly onEvent?: (event: SessionEvent) => void;

  constructor(opts: SessionGrantsOptions = {}) {
    this.nowMsFn = opts.nowMsFn ?? Date.now;
    this.onEvent = opts.onEvent;
  }

  /**
   * Start a new named session. The id must be globally unique (the
   * operator/CLI is responsible for picking one; a UUID is typical).
   * Throws on duplicate id — failing loud beats silently clobbering
   * a caller's unrelated session.
   */
  start(id: string, name: string): SessionHandle {
    if (!id) throw new Error('SessionGrantRegistry.start: id is required');
    if (!name) throw new Error('SessionGrantRegistry.start: name is required');
    if (this.sessions.has(id)) {
      throw new Error(`SessionGrantRegistry.start: session id "${id}" already active`);
    }
    const startedAtMs = this.nowMsFn();
    this.sessions.set(id, {
      id,
      name,
      startedAtMs,
      grants: new Set<string>(),
    });
    this.onEvent?.({ kind: 'session_started', id, name });
    return { id, name, startedAtMs };
  }

  /**
   * Add a grant to an active session. Returns true if the grant was
   * added, false if it was already present (idempotent).
   */
  addGrant(sessionId: string, grant: Grant): boolean {
    const session = this.requireSession(sessionId);
    const key = grantKey(grant);
    if (session.grants.has(key)) return false;
    session.grants.add(key);
    this.onEvent?.({ kind: 'grant_added', sessionId, grant });
    return true;
  }

  /**
   * Check whether an agent has a grant of the given mode on a persona
   * across ALL active sessions. A `'write'` request is satisfied by
   * ANY session that grants `'write'`; a `'read'` request is
   * satisfied by ANY session that grants either `'read'` or `'write'`.
   */
  check(agentDid: string, persona: string, mode: GrantMode): boolean {
    for (const session of this.sessions.values()) {
      if (mode === 'read') {
        if (
          session.grants.has(grantKey({ agentDid, persona, mode: 'read' })) ||
          session.grants.has(grantKey({ agentDid, persona, mode: 'write' }))
        ) {
          return true;
        }
      } else if (session.grants.has(grantKey({ agentDid, persona, mode: 'write' }))) {
        return true;
      }
    }
    return false;
  }

  /**
   * End a session. Revokes all grants it holds + removes the session
   * from the registry. Returns the count of revoked grants. Grants
   * an agent holds from OTHER still-active sessions are preserved.
   * Throws on unknown session id.
   */
  end(sessionId: string): number {
    const session = this.requireSession(sessionId);
    const revoked = session.grants.size;
    if (this.onEvent) {
      for (const key of session.grants) {
        this.onEvent({ kind: 'grant_revoked', sessionId, grant: parseGrantKey(key) });
      }
    }
    this.sessions.delete(sessionId);
    this.onEvent?.({
      kind: 'session_ended',
      id: session.id,
      name: session.name,
      revokedCount: revoked,
    });
    return revoked;
  }

  /**
   * List sessions an agent participates in (has at least one grant).
   * Useful for /admin + ops visibility.
   */
  sessionsForAgent(agentDid: string): SessionHandle[] {
    const out: SessionHandle[] = [];
    for (const session of this.sessions.values()) {
      for (const key of session.grants) {
        if (parseGrantKey(key).agentDid === agentDid) {
          out.push({ id: session.id, name: session.name, startedAtMs: session.startedAtMs });
          break;
        }
      }
    }
    return out;
  }

  /** Count of active sessions. */
  size(): number {
    return this.sessions.size;
  }

  /** Count of grants across all active sessions. */
  totalGrants(): number {
    let n = 0;
    for (const s of this.sessions.values()) n += s.grants.size;
    return n;
  }

  /**
   * End ALL active sessions — used on graceful shutdown (task 4.9)
   * so no session state leaks across process restarts.
   */
  endAll(): number {
    const ids = Array.from(this.sessions.keys());
    let total = 0;
    for (const id of ids) total += this.end(id);
    return total;
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`SessionGrantRegistry: session "${sessionId}" not active`);
    }
    return session;
  }
}

interface SessionState {
  readonly id: string;
  readonly name: string;
  readonly startedAtMs: number;
  readonly grants: Set<string>;
}

/**
 * Canonical grant serialization — used as the Set key. Must be
 * lossless so `parseGrantKey` recovers the original struct.
 */
function grantKey(g: Grant): string {
  return `${g.mode}::${g.agentDid}::${g.persona}`;
}

function parseGrantKey(key: string): Grant {
  const [mode, agentDid, persona] = key.split('::');
  return {
    mode: mode as GrantMode,
    agentDid: agentDid ?? '',
    persona: persona ?? '',
  };
}
