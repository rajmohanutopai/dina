/**
 * Agent session lifecycle — scoped access grants.
 *
 * Sessions bind (persona, session, agent DID) grants.
 * Grants: single-use (consumed after one access) or session-scoped.
 * Session end revokes all grants.
 *
 * Triple binding invariant: a grant for persona P in session S from agent A
 * does NOT apply to persona P in session S' or from agent B.
 *
 * Source: core/test/session_handler_test.go
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface AgentSession {
  id: string;
  agentDID: string;
  name: string;
  grants: SessionGrant[];
  createdAt: number;
  active: boolean;
}

export interface SessionGrant {
  persona: string;
  scope: 'single' | 'session';
  grantedBy: string;
  consumed: boolean;
}

/** In-memory session store. */
const sessions = new Map<string, AgentSession>();

/** Generate a unique session ID. */
function generateSessionId(): string {
  return `sess-${bytesToHex(randomBytes(8))}`;
}

/**
 * Start a new agent session.
 *
 * @param agentDID - The agent's DID
 * @param name - Human-readable session name (e.g., "chair-research")
 * @returns The new session object
 */
export function startSession(agentDID: string, name: string): AgentSession {
  if (!agentDID) {
    throw new Error('session: agent DID required');
  }

  const session: AgentSession = {
    id: generateSessionId(),
    agentDID,
    name,
    grants: [],
    createdAt: Date.now(),
    active: true,
  };

  sessions.set(session.id, session);
  return session;
}

/**
 * End a session — revoke all grants, mark inactive.
 *
 * @throws if session not found
 */
export function endSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`session: "${sessionId}" not found`);
  }

  session.active = false;
  session.grants = [];
  sessions.delete(sessionId);
}

/**
 * Add a grant to a session.
 *
 * @param sessionId - Session to add grant to
 * @param persona - Persona name the grant authorizes access to
 * @param scope - 'single' (consumed after one use) or 'session' (valid until session end)
 * @param grantedBy - Who approved the grant (e.g., "user")
 * @throws if session not found or inactive
 */
export function addGrant(
  sessionId: string,
  persona: string,
  scope: 'single' | 'session',
  grantedBy: string,
): void {
  const session = sessions.get(sessionId);
  if (!session || !session.active) {
    throw new Error(`session: "${sessionId}" not found or inactive`);
  }

  session.grants.push({
    persona,
    scope,
    grantedBy,
    consumed: false,
  });
}

/**
 * Check if a session has an active grant for a persona.
 *
 * Single-use grants are consumed (marked consumed) on first successful check.
 * Session-scoped grants persist across multiple checks.
 *
 * @returns true if an active grant exists, false otherwise
 */
export function checkGrant(sessionId: string, persona: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || !session.active) {
    return false;
  }

  for (const grant of session.grants) {
    if (grant.persona !== persona || grant.consumed) {
      continue;
    }

    if (grant.scope === 'single') {
      // Consume single-use grant
      grant.consumed = true;
      return true;
    }

    // Session-scoped — always valid while session is active
    return true;
  }

  return false;
}

/** List active sessions for an agent DID. */
export function listSessions(agentDID: string): AgentSession[] {
  return Array.from(sessions.values()).filter((s) => s.agentDID === agentDID && s.active);
}

/** Get a session by ID (for testing). */
export function getSession(sessionId: string): AgentSession | undefined {
  return sessions.get(sessionId);
}

/** Clear all sessions (for testing). */
export function clearAllSessions(): void {
  sessions.clear();
}
