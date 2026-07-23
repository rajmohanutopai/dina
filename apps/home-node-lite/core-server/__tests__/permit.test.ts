/**
 * Item 3d — payload-bound single-use permit tests.
 *
 * Verifies the four bindings (payload, single-use, principal, time) plus the
 * hook-realistic "redeem by re-sent payload" path. Uses an injectable clock so
 * expiry is deterministic.
 */

import {
  hashPayload,
  PermitStore,
  stableStringify,
  type ToolPayload,
} from '../src/gate/permit';

const AGENT = 'did:key:z6MkAgent';
const SESSION = 'sess-1';
const payloadA: ToolPayload = { tool: 'Bash', input: { command: 'npm install' } };
const payloadB: ToolPayload = { tool: 'Bash', input: { command: 'rm -rf /' } };

function makeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('stableStringify / hashPayload', () => {
  it('is independent of object key order', () => {
    const a = hashPayload({ tool: 'Edit', input: { path: 'a.ts', text: 'x' } });
    const b = hashPayload({ tool: 'Edit', input: { text: 'x', path: 'a.ts' } });
    expect(a).toBe(b);
  });
  it('differs when the payload differs', () => {
    expect(hashPayload(payloadA)).not.toBe(hashPayload(payloadB));
  });
  it('sorts nested keys deterministically', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it('treats missing input as null', () => {
    expect(hashPayload({ tool: 'X', input: undefined })).toBe(
      hashPayload({ tool: 'X', input: null }),
    );
  });
});

describe('mint', () => {
  it('binds the record to the payload hash + principal + expiry', () => {
    const clock = makeClock();
    const store = new PermitStore(clock.now);
    const p = store.mint({
      action: 'package_install',
      risk: 'MODERATE',
      payload: payloadA,
      agentDid: AGENT,
      sessionId: SESSION,
      decision: 'approved',
      ttlMs: 60_000,
    });
    expect(p.payloadHash).toBe(hashPayload(payloadA));
    expect(p.expiresAtMs).toBe(1000 + 60_000);
    expect(p.consumedAtMs).toBeNull();
    expect(store.size()).toBe(1);
  });
});

describe('consume — happy path & single-use', () => {
  it('redeems once, then reports already_consumed', () => {
    const store = new PermitStore(makeClock().now);
    const p = store.mint({
      action: 'package_install',
      risk: 'MODERATE',
      payload: payloadA,
      agentDid: AGENT,
      sessionId: SESSION,
      decision: 'approved',
    });
    const first = store.consume({ agentDid: AGENT, sessionId: SESSION, payload: payloadA, permitId: p.permitId });
    expect(first.ok).toBe(true);
    const second = store.consume({ agentDid: AGENT, sessionId: SESSION, payload: payloadA, permitId: p.permitId });
    expect(second).toEqual({ ok: false, reason: 'already_consumed' });
  });

  it('marks the permit consumed at the current time', () => {
    const clock = makeClock();
    const store = new PermitStore(clock.now);
    const p = store.mint({
      action: 'code_edit',
      risk: 'SAFE',
      payload: payloadA,
      agentDid: AGENT,
      sessionId: SESSION,
      decision: 'auto',
    });
    clock.advance(50);
    store.consume({ agentDid: AGENT, sessionId: SESSION, payload: payloadA });
    expect(store.get(p.permitId)?.consumedAtMs).toBe(1050);
  });
});

describe('consume — payload binding (bait-and-switch)', () => {
  it('refuses a different payload than was approved', () => {
    const store = new PermitStore(makeClock().now);
    const p = store.mint({
      action: 'package_install',
      risk: 'MODERATE',
      payload: payloadA, // approved: npm install
      agentDid: AGENT,
      sessionId: SESSION,
      decision: 'approved',
    });
    // agent tries to execute a DIFFERENT command with the same permit id
    const res = store.consume({
      agentDid: AGENT,
      sessionId: SESSION,
      payload: payloadB, // rm -rf /
      permitId: p.permitId,
    });
    expect(res).toEqual({ ok: false, reason: 'payload_mismatch' });
    // and the permit is NOT consumed — a correct retry can still redeem it
    expect(store.get(p.permitId)?.consumedAtMs).toBeNull();
  });
});

describe('consume — principal binding', () => {
  it('refuses a different agent', () => {
    const store = new PermitStore(makeClock().now);
    const p = store.mint({
      action: 'code_edit',
      risk: 'SAFE',
      payload: payloadA,
      agentDid: AGENT,
      sessionId: SESSION,
      decision: 'auto',
    });
    const res = store.consume({ agentDid: 'did:key:z6MkOther', sessionId: SESSION, payload: payloadA, permitId: p.permitId });
    expect(res).toEqual({ ok: false, reason: 'principal_mismatch' });
  });
  it('refuses a different session', () => {
    const store = new PermitStore(makeClock().now);
    const p = store.mint({
      action: 'code_edit',
      risk: 'SAFE',
      payload: payloadA,
      agentDid: AGENT,
      sessionId: SESSION,
      decision: 'auto',
    });
    const res = store.consume({ agentDid: AGENT, sessionId: 'other', payload: payloadA, permitId: p.permitId });
    expect(res).toEqual({ ok: false, reason: 'principal_mismatch' });
  });
});

describe('consume — time binding', () => {
  it('refuses an expired permit', () => {
    const clock = makeClock();
    const store = new PermitStore(clock.now);
    store.mint({
      action: 'code_edit',
      risk: 'SAFE',
      payload: payloadA,
      agentDid: AGENT,
      sessionId: SESSION,
      decision: 'auto',
      ttlMs: 1000,
    });
    clock.advance(1001);
    const res = store.consume({ agentDid: AGENT, sessionId: SESSION, payload: payloadA });
    expect(res).toEqual({ ok: false, reason: 'not_found' }); // expired ⇒ no match by payload
  });
  it('reports expired when redeemed by explicit id', () => {
    const clock = makeClock();
    const store = new PermitStore(clock.now);
    const p = store.mint({
      action: 'code_edit',
      risk: 'SAFE',
      payload: payloadA,
      agentDid: AGENT,
      sessionId: SESSION,
      decision: 'auto',
      ttlMs: 1000,
    });
    clock.advance(1001);
    const res = store.consume({ agentDid: AGENT, sessionId: SESSION, payload: payloadA, permitId: p.permitId });
    expect(res).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('consume by re-sent payload (hook flow)', () => {
  it('finds the newest matching un-consumed permit without an id', () => {
    const clock = makeClock();
    const store = new PermitStore(clock.now);
    store.mint({ action: 'a', risk: 'SAFE', payload: payloadA, agentDid: AGENT, sessionId: SESSION, decision: 'auto' });
    clock.advance(10);
    const newer = store.mint({ action: 'a', risk: 'SAFE', payload: payloadA, agentDid: AGENT, sessionId: SESSION, decision: 'auto' });
    const res = store.consume({ agentDid: AGENT, sessionId: SESSION, payload: payloadA });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.permit.permitId).toBe(newer.permitId);
  });
  it('returns not_found when nothing matches', () => {
    const store = new PermitStore(makeClock().now);
    const res = store.consume({ agentDid: AGENT, sessionId: SESSION, payload: payloadA });
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('mintApprovedFromHash (Item B — owner-approval path)', () => {
  it('mints an approved, single-use permit redeemable by the re-sent payload', () => {
    const store = new PermitStore();
    const hash = hashPayload(payloadA);
    const rec = store.mintApprovedFromHash({
      action: 'vcs_push',
      risk: 'MODERATE',
      payloadHash: hash,
      agentDid: AGENT,
      sessionId: SESSION,
    });
    expect(rec.decision).toBe('approved');
    expect(rec.payloadHash).toBe(hash);
    // Redeems once for the exact payload (the gate's no-permitId path)…
    expect(store.consume({ agentDid: AGENT, sessionId: SESSION, payload: payloadA }).ok).toBe(true);
    // …precisely: the SAME permit is now consumed…
    expect(store.consume({ agentDid: AGENT, sessionId: SESSION, payload: payloadA, permitId: rec.permitId })).toEqual({
      ok: false,
      reason: 'already_consumed',
    });
    // …and the gate's no-id retry sees no LIVE permit to redeem (→ re-gates).
    expect(store.consume({ agentDid: AGENT, sessionId: SESSION, payload: payloadA }).ok).toBe(false);
  });

  it('is principal-bound: a foreign session cannot redeem it', () => {
    const store = new PermitStore();
    store.mintApprovedFromHash({
      action: 'vcs_push',
      risk: 'MODERATE',
      payloadHash: hashPayload(payloadA),
      agentDid: AGENT,
      sessionId: SESSION,
    });
    expect(store.consume({ agentDid: AGENT, sessionId: 'other', payload: payloadA })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('is time-bound: an expired approved permit no longer redeems', () => {
    const clock = makeClock();
    const store = new PermitStore(clock.now);
    const rec = store.mintApprovedFromHash({
      action: 'vcs_push',
      risk: 'MODERATE',
      payloadHash: hashPayload(payloadA),
      agentDid: AGENT,
      sessionId: SESSION,
      ttlMs: 100,
    });
    clock.advance(200);
    // Explicit id → the precise `expired` reason; the gate's no-id path sees no
    // live match and re-gates.
    expect(store.consume({ agentDid: AGENT, sessionId: SESSION, payload: payloadA, permitId: rec.permitId })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(store.consume({ agentDid: AGENT, sessionId: SESSION, payload: payloadA }).ok).toBe(false);
  });
});

describe('sweep', () => {
  it('drops consumed and expired permits, keeps live ones', () => {
    const clock = makeClock();
    const store = new PermitStore(clock.now);
    const live = store.mint({ action: 'a', risk: 'SAFE', payload: payloadA, agentDid: AGENT, sessionId: SESSION, decision: 'auto', ttlMs: 100_000 });
    const consumed = store.mint({ action: 'b', risk: 'SAFE', payload: payloadB, agentDid: AGENT, sessionId: SESSION, decision: 'auto', ttlMs: 100_000 });
    store.consume({ agentDid: AGENT, sessionId: SESSION, payload: payloadB, permitId: consumed.permitId });
    const expired = store.mint({ action: 'c', risk: 'SAFE', payload: { tool: 'X', input: 1 }, agentDid: AGENT, sessionId: SESSION, decision: 'auto', ttlMs: 10 });
    clock.advance(20);
    const removed = store.sweep();
    expect(removed).toBe(2);
    expect(store.get(live.permitId)).toBeDefined();
    expect(store.get(consumed.permitId)).toBeUndefined();
    expect(store.get(expired.permitId)).toBeUndefined();
  });
});
