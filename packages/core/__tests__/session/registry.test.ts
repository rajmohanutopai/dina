/**
 * Item 6 — durable session registry tests (§15).
 *
 * Covers DID-binding (cross-agent isolation), idempotent start (one Core session
 * per host session), lease/heartbeat, revoke-on-end, and lease-lapse reaping.
 * Uses an injectable clock so expiry is deterministic.
 */

import {
  SessionRegistry,
  DEFAULT_LEASE_MS,
  type SessionRecord,
  type EndReason,
} from '../../src/session/registry';

import type { AuthorityOrigin } from '../../src/agent/gating_policy';
import type { SessionRepository } from '../../src/session/repository';

const A = 'did:key:z6MkAgentA';
const B = 'did:key:z6MkAgentB';

function serviceOrigin(correlationId = 'query-1'): AuthorityOrigin {
  return {
    kind: 'service_request',
    ownerDid: 'did:plc:owner',
    requesterDid: 'did:plc:requester',
    ingress: 'd2d',
    correlationId,
    authenticatedAtMs: 1_000,
  };
}

function makeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('start', () => {
  it('mints a session bound to the caller DID + host session', () => {
    const reg = new SessionRegistry(makeClock().now);
    const s = reg.start({ agentDid: A, hostSessionId: 'host-1' });
    expect(s.agentDid).toBe(A);
    expect(s.hostSessionId).toBe('host-1');
    expect(s.endedAtMs).toBeNull();
    expect(s.leaseExpiresAtMs).toBe(1000 + DEFAULT_LEASE_MS);
  });

  it('is idempotent for the same (agentDid, hostSessionId) — one Core session (F-04)', () => {
    const clock = makeClock();
    const reg = new SessionRegistry(clock.now);
    const first = reg.start({ agentDid: A, hostSessionId: 'host-1' });
    clock.advance(1000);
    const second = reg.start({ agentDid: A, hostSessionId: 'host-1' });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.leaseExpiresAtMs).toBe(2000 + DEFAULT_LEASE_MS); // lease renewed
  });

  it('different agents on the same host id get different sessions', () => {
    const reg = new SessionRegistry(makeClock().now);
    const sa = reg.start({ agentDid: A, hostSessionId: 'host-1' });
    const sb = reg.start({ agentDid: B, hostSessionId: 'host-1' });
    expect(sa.sessionId).not.toBe(sb.sessionId);
  });

  it('cannot mint a second owner session while the host carries non-owner authority', () => {
    const reg = new SessionRegistry(makeClock().now);
    const first = reg.start({ agentDid: A, hostSessionId: 'host-1' });
    expect(reg.activateAuthorityOrigin(first.sessionId, A, serviceOrigin())).toBe(true);

    const restarted = reg.start({ agentDid: A, hostSessionId: 'host-1' });
    expect(restarted.sessionId).toBe(first.sessionId);
    expect(restarted.authorityOrigin).toEqual(serviceOrigin());
    expect(reg.liveCount()).toBe(1);
  });
});

describe('authority origin reservation', () => {
  it('binds one exact non-owner origin and rejects an overwrite', () => {
    const reg = new SessionRegistry(makeClock().now);
    const session = reg.start({ agentDid: A, hostSessionId: 'host-1' });
    const first = serviceOrigin('query-1');
    const second = serviceOrigin('query-2');

    expect(reg.activateAuthorityOrigin(session.sessionId, A, first)).toBe(true);
    expect(reg.activateAuthorityOrigin(session.sessionId, A, first)).toBe(true);
    expect(reg.activateAuthorityOrigin(session.sessionId, A, second)).toBe(false);
    expect(reg.authorizesAuthorityOrigin(session.sessionId, A, first)).toBe(true);
    expect(reg.authorizesAuthorityOrigin(session.sessionId, A, second)).toBe(false);
  });

  it('only an exact origin can release the reservation', () => {
    const reg = new SessionRegistry(makeClock().now);
    const session = reg.start({ agentDid: A, hostSessionId: 'host-1' });
    const first = serviceOrigin('query-1');
    expect(reg.activateAuthorityOrigin(session.sessionId, A, first)).toBe(true);

    expect(reg.clearAuthorityOrigin(session.sessionId, A, serviceOrigin('query-2')).ok).toBe(true);
    expect(reg.get(session.sessionId)?.authorityOrigin).toEqual(first);
    expect(reg.clearAuthorityOrigin(session.sessionId, A, first).ok).toBe(true);
    expect(reg.get(session.sessionId)?.authorityOrigin).toBeNull();
  });
});

describe('validate — DID binding + lifecycle', () => {
  it('accepts the owning DID', () => {
    const reg = new SessionRegistry(makeClock().now);
    const s = reg.start({ agentDid: A, hostSessionId: 'h' });
    expect(reg.validate(s.sessionId, A)).toEqual({
      ok: true,
      session: expect.objectContaining({ sessionId: s.sessionId }),
    });
  });

  it('rejects a different agent (cross-agent isolation)', () => {
    const reg = new SessionRegistry(makeClock().now);
    const s = reg.start({ agentDid: A, hostSessionId: 'h' });
    expect(reg.validate(s.sessionId, B)).toEqual({ ok: false, reason: 'principal_mismatch' });
  });

  it('rejects an unknown session', () => {
    const reg = new SessionRegistry(makeClock().now);
    expect(reg.validate('sess-nope', A)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects an ended session', () => {
    const reg = new SessionRegistry(makeClock().now);
    const s = reg.start({ agentDid: A, hostSessionId: 'h' });
    reg.end(s.sessionId, A);
    expect(reg.validate(s.sessionId, A)).toEqual({ ok: false, reason: 'ended' });
  });

  it('rejects (and reaps) a lease-lapsed session', () => {
    const clock = makeClock();
    const reg = new SessionRegistry(clock.now);
    const s = reg.start({ agentDid: A, hostSessionId: 'h', leaseMs: 1000 });
    clock.advance(1001);
    expect(reg.validate(s.sessionId, A)).toEqual({ ok: false, reason: 'lease_lapsed' });
    expect(reg.get(s.sessionId)?.endReason).toBe('lease_lapsed');
  });
});

describe('renew — heartbeat', () => {
  it('extends the lease on a valid call', () => {
    const clock = makeClock();
    const reg = new SessionRegistry(clock.now);
    const s = reg.start({ agentDid: A, hostSessionId: 'h', leaseMs: 1000 });
    clock.advance(500);
    reg.renew(s.sessionId, A, 1000);
    clock.advance(700); // 1200 total; would have lapsed without the renew
    expect(reg.validate(s.sessionId, A).ok).toBe(true);
  });

  it("cannot renew another agent's session", () => {
    const reg = new SessionRegistry(makeClock().now);
    const s = reg.start({ agentDid: A, hostSessionId: 'h' });
    expect(reg.renew(s.sessionId, B)).toEqual({ ok: false, reason: 'principal_mismatch' });
  });
});

describe('end — revoke-on-end', () => {
  it('fires the onEnd hook with reason=explicit', () => {
    const ended: { id: string; reason: EndReason }[] = [];
    const reg = new SessionRegistry(makeClock().now, (s: SessionRecord, reason) =>
      ended.push({ id: s.sessionId, reason }),
    );
    const s = reg.start({ agentDid: A, hostSessionId: 'h' });
    reg.end(s.sessionId, A);
    expect(ended).toEqual([{ id: s.sessionId, reason: 'explicit' }]);
  });

  it('is DID-bound and idempotent', () => {
    const reg = new SessionRegistry(makeClock().now);
    const s = reg.start({ agentDid: A, hostSessionId: 'h' });
    expect(reg.end(s.sessionId, B)).toEqual({ ok: false, reason: 'principal_mismatch' });
    expect(reg.end(s.sessionId, A).ok).toBe(true);
    expect(reg.end(s.sessionId, A)).toEqual({ ok: false, reason: 'ended' });
  });

  it('ends every session for a revoked principal and leaves other principals live', () => {
    const ended: { agentDid: string; reason: EndReason }[] = [];
    const reg = new SessionRegistry(makeClock().now, (session, reason) => {
      ended.push({ agentDid: session.agentDid, reason });
    });
    const first = reg.start({ agentDid: A, hostSessionId: 'host-1' });
    const second = reg.start({ agentDid: A, hostSessionId: 'host-2' });
    const other = reg.start({ agentDid: B, hostSessionId: 'host-1' });

    expect(reg.endAllForPrincipal(A)).toEqual({ ended: 2, ok: true });
    expect(reg.get(first.sessionId)?.endReason).toBe('authority_revoked');
    expect(reg.get(second.sessionId)?.endReason).toBe('authority_revoked');
    expect(reg.validate(other.sessionId, B).ok).toBe(true);
    expect(ended).toEqual([
      { agentDid: A, reason: 'authority_revoked' },
      { agentDid: A, reason: 'authority_revoked' },
    ]);
  });
});

describe('durable lifecycle writes — fail closed', () => {
  function throwingRepo(): SessionRepository {
    return {
      upsert: () => {
        throw new Error('disk unavailable');
      },
      loadActive: () => [],
    };
  }

  it('does not publish a newly-started session in memory when persistence fails', () => {
    const reg = new SessionRegistry(makeClock().now, undefined, throwingRepo());
    expect(() => reg.start({ agentDid: A, hostSessionId: 'host-1' })).toThrow('disk unavailable');
    expect(reg.liveCount()).toBe(0);
  });

  it('does not report an end or fire cleanup when the durable tombstone fails', () => {
    let fail = false;
    let cleanupCalls = 0;
    const repo: SessionRepository = {
      upsert: () => {
        if (fail) throw new Error('disk unavailable');
      },
      loadActive: () => [],
    };
    const reg = new SessionRegistry(makeClock().now, () => cleanupCalls++, repo);
    const session = reg.start({ agentDid: A, hostSessionId: 'host-1' });
    fail = true;

    expect(() => reg.end(session.sessionId, A)).toThrow('disk unavailable');
    expect(reg.validate(session.sessionId, A).ok).toBe(true);
    expect(cleanupCalls).toBe(0);
  });

  it('does not extend the in-memory lease when the durable heartbeat fails', () => {
    const clock = makeClock();
    let fail = false;
    const repo: SessionRepository = {
      upsert: () => {
        if (fail) throw new Error('disk unavailable');
      },
      loadActive: () => [],
    };
    const reg = new SessionRegistry(clock.now, undefined, repo);
    const session = reg.start({ agentDid: A, hostSessionId: 'host-1', leaseMs: 100 });
    const originalExpiry = session.leaseExpiresAtMs;
    fail = true;
    clock.advance(10);

    expect(() => reg.renew(session.sessionId, A, 1_000)).toThrow('disk unavailable');
    expect(reg.get(session.sessionId)?.leaseExpiresAtMs).toBe(originalExpiry);
  });
});

describe('reapExpired — lease reconciliation sweep', () => {
  it('ends lapsed sessions (revoking grants) and leaves live ones', () => {
    const clock = makeClock();
    const ended: string[] = [];
    const reg = new SessionRegistry(clock.now, (s) => ended.push(s.sessionId));
    const short = reg.start({ agentDid: A, hostSessionId: 'h-short', leaseMs: 1000 });
    const long = reg.start({ agentDid: B, hostSessionId: 'h-long', leaseMs: 100_000 });
    clock.advance(1001);
    const reaped = reg.reapExpired();
    expect(reaped).toBe(1);
    expect(ended).toEqual([short.sessionId]);
    expect(reg.validate(long.sessionId, B).ok).toBe(true);
    expect(reg.liveCount()).toBe(1);
  });
});

describe('listActive — caller isolation', () => {
  it('returns only live sessions for the requested DID', () => {
    const clock = makeClock();
    const reg = new SessionRegistry(clock.now);
    const first = reg.start({ agentDid: A, hostSessionId: 'a-old' });
    clock.advance(1);
    const second = reg.start({ agentDid: A, hostSessionId: 'a-new' });
    reg.start({ agentDid: B, hostSessionId: 'b' });
    reg.end(first.sessionId, A);

    expect(reg.listActive(A).map((s) => s.sessionId)).toEqual([second.sessionId]);
    expect(reg.listActive(B)).toHaveLength(1);
  });

  it('reaps expired sessions before projecting them', () => {
    const clock = makeClock();
    const reg = new SessionRegistry(clock.now);
    reg.start({ agentDid: A, hostSessionId: 'short', leaseMs: 10 });
    clock.advance(11);
    expect(reg.listActive(A)).toEqual([]);
  });
});
