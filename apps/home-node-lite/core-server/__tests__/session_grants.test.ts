/**
 * Task 4.70 — session grant registry tests.
 *
 * Fully deterministic: injected clock, no timers. These tests pin the
 * observable contract of SessionGrantRegistry so later refactors (e.g.
 * SQLCipher-backed storage) can't silently regress the semantics.
 */

import {
  SessionGrantRegistry,
  type Grant,
  type SessionEvent,
} from '../src/persona/session_grants';

/** Tiny mock clock — every call advances by 1 ms so startedAtMs values are
 *  distinguishable in tests that assert on ordering. */
function mockClock(start = 1_000_000): () => number {
  let now = start;
  return () => {
    const t = now;
    now += 1;
    return t;
  };
}

const agentA = 'did:key:agentA';
const agentB = 'did:key:agentB';
const personaWork = '/work';
const personaHealth = '/health';

describe('SessionGrantRegistry (task 4.70)', () => {
  describe('start + end lifecycle', () => {
    it('starts a session and exposes its handle', () => {
      const reg = new SessionGrantRegistry({ nowMsFn: mockClock(5_000) });
      const handle = reg.start('s1', 'refactor-auth');
      expect(handle).toMatchObject({ id: 's1', name: 'refactor-auth', startedAtMs: 5_000 });
      expect(reg.size()).toBe(1);
    });

    it('ends a session + returns the count of revoked grants', () => {
      const reg = new SessionGrantRegistry();
      reg.start('s1', 'task');
      reg.addGrant('s1', { agentDid: agentA, persona: personaWork, mode: 'read' });
      reg.addGrant('s1', { agentDid: agentA, persona: personaWork, mode: 'write' });
      expect(reg.end('s1')).toBe(2);
      expect(reg.size()).toBe(0);
    });

    it('rejects empty id / name at start', () => {
      const reg = new SessionGrantRegistry();
      expect(() => reg.start('', 'x')).toThrow(/id is required/);
      expect(() => reg.start('s1', '')).toThrow(/name is required/);
    });

    it('rejects duplicate session id', () => {
      const reg = new SessionGrantRegistry();
      reg.start('s1', 'task-one');
      expect(() => reg.start('s1', 'task-two')).toThrow(/already active/);
    });

    it('throws when ending an unknown session', () => {
      const reg = new SessionGrantRegistry();
      expect(() => reg.end('ghost')).toThrow(/session "ghost" not active/);
    });
  });

  describe('addGrant', () => {
    it('is idempotent — second add of same grant returns false', () => {
      const reg = new SessionGrantRegistry();
      reg.start('s1', 'task');
      const grant: Grant = { agentDid: agentA, persona: personaWork, mode: 'read' };
      expect(reg.addGrant('s1', grant)).toBe(true);
      expect(reg.addGrant('s1', grant)).toBe(false);
      expect(reg.totalGrants()).toBe(1);
    });

    it('treats read + write on same (agent, persona) as distinct grants', () => {
      const reg = new SessionGrantRegistry();
      reg.start('s1', 'task');
      reg.addGrant('s1', { agentDid: agentA, persona: personaWork, mode: 'read' });
      reg.addGrant('s1', { agentDid: agentA, persona: personaWork, mode: 'write' });
      expect(reg.totalGrants()).toBe(2);
    });

    it('throws on unknown session', () => {
      const reg = new SessionGrantRegistry();
      expect(() =>
        reg.addGrant('ghost', { agentDid: agentA, persona: personaWork, mode: 'read' }),
      ).toThrow(/session "ghost" not active/);
    });
  });

  describe('check — per-mode semantics', () => {
    it('write grant satisfies a read check', () => {
      const reg = new SessionGrantRegistry();
      reg.start('s1', 'task');
      reg.addGrant('s1', { agentDid: agentA, persona: personaWork, mode: 'write' });
      expect(reg.check(agentA, personaWork, 'read')).toBe(true);
      expect(reg.check(agentA, personaWork, 'write')).toBe(true);
    });

    it('read grant does NOT satisfy a write check', () => {
      const reg = new SessionGrantRegistry();
      reg.start('s1', 'task');
      reg.addGrant('s1', { agentDid: agentA, persona: personaWork, mode: 'read' });
      expect(reg.check(agentA, personaWork, 'read')).toBe(true);
      expect(reg.check(agentA, personaWork, 'write')).toBe(false);
    });

    it('returns false for a persona the agent has no grant on', () => {
      const reg = new SessionGrantRegistry();
      reg.start('s1', 'task');
      reg.addGrant('s1', { agentDid: agentA, persona: personaWork, mode: 'read' });
      expect(reg.check(agentA, personaHealth, 'read')).toBe(false);
    });

    it('returns false for a different agent', () => {
      const reg = new SessionGrantRegistry();
      reg.start('s1', 'task');
      reg.addGrant('s1', { agentDid: agentA, persona: personaWork, mode: 'read' });
      expect(reg.check(agentB, personaWork, 'read')).toBe(false);
    });
  });

  describe('check — union across multiple sessions', () => {
    it('returns true if ANY active session grants the mode', () => {
      const reg = new SessionGrantRegistry();
      reg.start('s1', 'refactor');
      reg.start('s2', 'review');
      reg.addGrant('s1', { agentDid: agentA, persona: personaWork, mode: 'read' });
      reg.addGrant('s2', { agentDid: agentA, persona: personaWork, mode: 'write' });
      expect(reg.check(agentA, personaWork, 'write')).toBe(true);
    });

    it('ending one session preserves grants from other sessions', () => {
      const reg = new SessionGrantRegistry();
      reg.start('s1', 'refactor');
      reg.start('s2', 'review');
      reg.addGrant('s1', { agentDid: agentA, persona: personaWork, mode: 'read' });
      reg.addGrant('s2', { agentDid: agentA, persona: personaWork, mode: 'read' });
      reg.end('s1');
      expect(reg.check(agentA, personaWork, 'read')).toBe(true);
      reg.end('s2');
      expect(reg.check(agentA, personaWork, 'read')).toBe(false);
    });
  });

  describe('sessionsForAgent', () => {
    it('lists every active session where the agent has ≥1 grant', () => {
      const reg = new SessionGrantRegistry({ nowMsFn: mockClock(1000) });
      reg.start('s1', 'refactor');
      reg.start('s2', 'review');
      reg.start('s3', 'bystander');
      reg.addGrant('s1', { agentDid: agentA, persona: personaWork, mode: 'read' });
      reg.addGrant('s2', { agentDid: agentA, persona: personaHealth, mode: 'read' });
      reg.addGrant('s3', { agentDid: agentB, persona: personaWork, mode: 'read' });
      const sessions = reg.sessionsForAgent(agentA).map((s) => s.id).sort();
      expect(sessions).toEqual(['s1', 's2']);
    });

    it('returns [] when the agent has no grants anywhere', () => {
      const reg = new SessionGrantRegistry();
      reg.start('s1', 'task');
      expect(reg.sessionsForAgent(agentA)).toEqual([]);
    });

    it('does not list a session more than once even when the agent has multiple grants in it', () => {
      const reg = new SessionGrantRegistry();
      reg.start('s1', 'task');
      reg.addGrant('s1', { agentDid: agentA, persona: personaWork, mode: 'read' });
      reg.addGrant('s1', { agentDid: agentA, persona: personaWork, mode: 'write' });
      reg.addGrant('s1', { agentDid: agentA, persona: personaHealth, mode: 'read' });
      const sessions = reg.sessionsForAgent(agentA);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.id).toBe('s1');
    });
  });

  describe('endAll (graceful shutdown)', () => {
    it('ends every active session + returns total revoked grants', () => {
      const reg = new SessionGrantRegistry();
      reg.start('s1', 'a');
      reg.start('s2', 'b');
      reg.addGrant('s1', { agentDid: agentA, persona: personaWork, mode: 'read' });
      reg.addGrant('s2', { agentDid: agentB, persona: personaHealth, mode: 'write' });
      expect(reg.endAll()).toBe(2);
      expect(reg.size()).toBe(0);
      expect(reg.totalGrants()).toBe(0);
    });

    it('is a no-op when there are no active sessions', () => {
      const reg = new SessionGrantRegistry();
      expect(reg.endAll()).toBe(0);
    });
  });

  describe('events', () => {
    it('fires session_started / grant_added / grant_revoked / session_ended in order', () => {
      const events: SessionEvent[] = [];
      const reg = new SessionGrantRegistry({ onEvent: (e) => events.push(e) });
      reg.start('s1', 'task');
      const grant: Grant = { agentDid: agentA, persona: personaWork, mode: 'read' };
      reg.addGrant('s1', grant);
      reg.end('s1');
      expect(events.map((e) => e.kind)).toEqual([
        'session_started',
        'grant_added',
        'grant_revoked',
        'session_ended',
      ]);
      const started = events[0] as Extract<SessionEvent, { kind: 'session_started' }>;
      expect(started).toMatchObject({ kind: 'session_started', id: 's1', name: 'task' });
      const revoked = events[2] as Extract<SessionEvent, { kind: 'grant_revoked' }>;
      expect(revoked.grant).toEqual(grant);
      const ended = events[3] as Extract<SessionEvent, { kind: 'session_ended' }>;
      expect(ended).toMatchObject({ kind: 'session_ended', id: 's1', name: 'task', revokedCount: 1 });
    });

    it('does not emit grant_added when the grant was already present', () => {
      const events: SessionEvent[] = [];
      const reg = new SessionGrantRegistry({ onEvent: (e) => events.push(e) });
      reg.start('s1', 'task');
      const grant: Grant = { agentDid: agentA, persona: personaWork, mode: 'read' };
      reg.addGrant('s1', grant);
      reg.addGrant('s1', grant);
      const added = events.filter((e) => e.kind === 'grant_added');
      expect(added).toHaveLength(1);
    });
  });

  describe('totalGrants + size', () => {
    it('tracks counts across sessions', () => {
      const reg = new SessionGrantRegistry();
      expect(reg.size()).toBe(0);
      expect(reg.totalGrants()).toBe(0);
      reg.start('s1', 'a');
      reg.start('s2', 'b');
      reg.addGrant('s1', { agentDid: agentA, persona: personaWork, mode: 'read' });
      reg.addGrant('s1', { agentDid: agentA, persona: personaHealth, mode: 'read' });
      reg.addGrant('s2', { agentDid: agentB, persona: personaWork, mode: 'write' });
      expect(reg.size()).toBe(2);
      expect(reg.totalGrants()).toBe(3);
    });
  });
});
