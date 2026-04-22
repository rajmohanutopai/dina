/**
 * T2A.6 — Agent session lifecycle: start, grant, check, end.
 *
 * Category B: contract test. Tests the real SessionManager.
 *
 * Source: core/test/session_handler_test.go
 */

import {
  startSession,
  endSession,
  addGrant,
  checkGrant,
  listSessions,
  getSession,
  clearAllSessions,
} from '../../src/session/lifecycle';

describe('Agent Session Lifecycle', () => {
  const agentDID = 'did:key:z6MkOpenClaw';

  afterEach(() => {
    clearAllSessions();
  });

  describe('startSession', () => {
    it('creates a new session with unique ID', () => {
      const session = startSession(agentDID, 'chair-research');
      expect(session.id).toMatch(/^sess-/);
      expect(session.id.length).toBeGreaterThan(5);
    });

    it('session has agent DID and name', () => {
      const session = startSession(agentDID, 'chair-research');
      expect(session.agentDID).toBe(agentDID);
      expect(session.name).toBe('chair-research');
    });

    it('session starts with empty grants', () => {
      const session = startSession(agentDID, 'research');
      expect(session.grants).toEqual([]);
    });

    it('session is active', () => {
      const session = startSession(agentDID, 'research');
      expect(session.active).toBe(true);
    });

    it('two sessions get different IDs', () => {
      const s1 = startSession(agentDID, 'a');
      const s2 = startSession(agentDID, 'b');
      expect(s1.id).not.toBe(s2.id);
    });

    it('rejects empty agent DID', () => {
      expect(() => startSession('', 'test')).toThrow('agent DID required');
    });
  });

  describe('addGrant', () => {
    it('adds a session-scoped grant', () => {
      const s = startSession(agentDID, 'test');
      addGrant(s.id, 'health', 'session', 'user');
      expect(s.grants).toHaveLength(1);
      expect(s.grants[0].persona).toBe('health');
      expect(s.grants[0].scope).toBe('session');
    });

    it('adds a single-use grant', () => {
      const s = startSession(agentDID, 'test');
      addGrant(s.id, 'finance', 'single', 'user');
      expect(s.grants[0].scope).toBe('single');
      expect(s.grants[0].consumed).toBe(false);
    });

    it('throws if session not found', () => {
      expect(() => addGrant('nonexistent', 'health', 'session', 'user')).toThrow('not found');
    });
  });

  describe('checkGrant', () => {
    it('returns true when session-scoped grant exists', () => {
      const s = startSession(agentDID, 'test');
      addGrant(s.id, 'health', 'session', 'user');
      expect(checkGrant(s.id, 'health')).toBe(true);
    });

    it('returns false when no grant for persona', () => {
      const s = startSession(agentDID, 'test');
      addGrant(s.id, 'health', 'session', 'user');
      expect(checkGrant(s.id, 'finance')).toBe(false);
    });

    it('returns false for nonexistent session', () => {
      expect(checkGrant('nonexistent', 'health')).toBe(false);
    });

    it('single-use grant consumed after one check', () => {
      const s = startSession(agentDID, 'test');
      addGrant(s.id, 'finance', 'single', 'user');
      expect(checkGrant(s.id, 'finance')).toBe(true); // consumed
      expect(checkGrant(s.id, 'finance')).toBe(false); // gone
    });

    it('session-scoped grant persists across multiple checks', () => {
      const s = startSession(agentDID, 'test');
      addGrant(s.id, 'health', 'session', 'user');
      expect(checkGrant(s.id, 'health')).toBe(true);
      expect(checkGrant(s.id, 'health')).toBe(true);
      expect(checkGrant(s.id, 'health')).toBe(true);
    });

    it('multiple grants for same persona (single + session)', () => {
      const s = startSession(agentDID, 'test');
      addGrant(s.id, 'health', 'single', 'user');
      addGrant(s.id, 'health', 'session', 'user');
      // First check finds the single grant, consumes it
      expect(checkGrant(s.id, 'health')).toBe(true);
      // Second check: single is consumed, but session grant still active
      expect(checkGrant(s.id, 'health')).toBe(true);
    });
  });

  describe('endSession', () => {
    it('revokes all grants', () => {
      const s = startSession(agentDID, 'test');
      addGrant(s.id, 'health', 'session', 'user');
      addGrant(s.id, 'finance', 'session', 'user');
      endSession(s.id);
      expect(checkGrant(s.id, 'health')).toBe(false);
      expect(checkGrant(s.id, 'finance')).toBe(false);
    });

    it('session no longer appears in listSessions', () => {
      const s = startSession(agentDID, 'test');
      endSession(s.id);
      expect(listSessions(agentDID)).toHaveLength(0);
    });

    it('throws for nonexistent session', () => {
      expect(() => endSession('nonexistent')).toThrow('not found');
    });
  });

  describe('listSessions', () => {
    it('lists active sessions for an agent', () => {
      startSession(agentDID, 'a');
      startSession(agentDID, 'b');
      expect(listSessions(agentDID)).toHaveLength(2);
    });

    it('returns empty list when no sessions', () => {
      expect(listSessions('did:key:z6MkUnknownAgent')).toHaveLength(0);
    });

    it('does not list ended sessions', () => {
      const s1 = startSession(agentDID, 'a');
      startSession(agentDID, 'b');
      endSession(s1.id);
      const active = listSessions(agentDID);
      expect(active).toHaveLength(1);
      expect(active[0].name).toBe('b');
    });

    it('different agents see only their own sessions', () => {
      startSession('did:key:z6MkAgentA', 'a');
      startSession('did:key:z6MkAgentB', 'b');
      expect(listSessions('did:key:z6MkAgentA')).toHaveLength(1);
      expect(listSessions('did:key:z6MkAgentB')).toHaveLength(1);
    });
  });

  describe('grant triple binding', () => {
    it('grant is bound to specific session (not transferable)', () => {
      const s1 = startSession(agentDID, 'session-1');
      const s2 = startSession(agentDID, 'session-2');
      addGrant(s1.id, 'health', 'session', 'user');
      expect(checkGrant(s1.id, 'health')).toBe(true);
      expect(checkGrant(s2.id, 'health')).toBe(false);
    });

    it('grant is bound to specific agent (via session)', () => {
      const sA = startSession('did:key:z6MkAgentA', 'test');
      const sB = startSession('did:key:z6MkAgentB', 'test');
      addGrant(sA.id, 'health', 'session', 'user');
      expect(checkGrant(sA.id, 'health')).toBe(true);
      expect(checkGrant(sB.id, 'health')).toBe(false);
    });
  });
});
