/**
 * Item 6b — agent_scope fail-closed + non-spoofable tests (§11/§14).
 */

import {
  isScopeAuthorized,
  requiredScopeFor,
  resolveAgentScope,
  type AgentScope,
} from '../../src/auth/agent_scope';

describe('resolveAgentScope — device-record derivation', () => {
  it('accepts the two valid scopes', () => {
    expect(resolveAgentScope('coding')).toBe('coding');
    expect(resolveAgentScope('runner')).toBe('runner');
  });
  it('fails closed on missing / unknown / corrupt values', () => {
    for (const v of [undefined, null, '', 'CODING', 'admin', 'root', 'coding ']) {
      expect(resolveAgentScope(v)).toBeUndefined();
    }
  });
});

describe('requiredScopeFor', () => {
  it('maps the coding tool façades to coding', () => {
    for (const p of ['/v1/agent/memory', '/v1/agent/find-service', '/v1/agent/talk', '/v1/agent/delegate', '/v1/agent/peerlens', '/v1/agent/ask', '/v1/agent/reminders']) {
      expect(requiredScopeFor(p)).toBe('coding');
    }
  });
  it('is boundary-safe (no prefix bleed)', () => {
    expect(requiredScopeFor('/v1/agent/talkable')).toBeNull();
    expect(requiredScopeFor('/v1/agent/memoryfoo')).toBeNull();
  });
  it('returns null for unconstrained routes', () => {
    expect(requiredScopeFor('/v1/vault/query')).toBeNull();
    expect(requiredScopeFor('/healthz')).toBeNull();
  });
  it('matches subpaths', () => {
    expect(requiredScopeFor('/v1/agent/talk/send')).toBe('coding');
  });
});

describe('isScopeAuthorized — fail-closed', () => {
  it('allows a matching scope on a gated route', () => {
    expect(isScopeAuthorized('coding', '/v1/agent/talk')).toBe(true);
  });
  it('DENIES a mismatched scope (runner reaching a coding façade)', () => {
    expect(isScopeAuthorized('runner', '/v1/agent/talk')).toBe(false);
  });
  it('DENIES a missing scope on a gated route (fail-closed)', () => {
    expect(isScopeAuthorized(undefined, '/v1/agent/talk')).toBe(false);
  });
  it('allows any scope (incl. undefined) on an unconstrained route', () => {
    for (const s of ['coding', 'runner', undefined] as (AgentScope | undefined)[]) {
      expect(isScopeAuthorized(s, '/v1/vault/query')).toBe(true);
    }
  });

  it('SPOOF: a request cannot escalate — scope comes only from the device record', () => {
    // A `runner` device whose signed request TRIES to reach a coding façade is
    // denied; there is no request field that could carry a coding scope, and a
    // client-sent value is never read (resolveAgentScope only reads the record).
    const deviceScope = resolveAgentScope('runner'); // what Core derived
    expect(isScopeAuthorized(deviceScope, '/v1/agent/delegate')).toBe(false);
    // Even a well-formed but forged string is ignored by resolveAgentScope.
    expect(resolveAgentScope('coding\n')).toBeUndefined();
  });
});
