/**
 * HOSTED_DINA §3.2 — the `dot` agent scope is an allowlist. Through the real
 * signed pipeline: a `dot` device reaches the routes its tools call and is
 * refused everywhere else, including routes any other agent may call. This
 * is what limits the keys a shared front door holds.
 */

import { TEST_ED25519_SEED } from '@dina/test-harness';

import { isDotRoute, isScopeAuthorized, resolveAgentScope } from '../../src/auth/agent_scope';
import {
  registerDevice,
  resetCallerTypeState,
  setDeviceRoleResolver,
  setDeviceScopeResolver,
} from '../../src/auth/caller_type';
import { signRequest } from '../../src/auth/canonical';
import {
  authenticateRequest,
  registerPublicKeyResolver,
  resetMiddlewareState,
} from '../../src/auth/middleware';
import { getPublicKey } from '../../src/crypto/ed25519';

const pubKey = getPublicKey(TEST_ED25519_SEED);
const agentDid = 'did:key:z6MkDotScopeAgent';

function signed(method: string, path: string, query = '') {
  const body = new Uint8Array();
  const headers = signRequest(method, path, query, body, TEST_ED25519_SEED, agentDid);
  return { method, path, query, body, headers };
}

function wire(scope: 'dot' | 'coding'): void {
  resetMiddlewareState();
  resetCallerTypeState();
  registerPublicKeyResolver((d) => (d === agentDid ? pubKey : null));
  registerDevice(agentDid, 'dot-device');
  setDeviceRoleResolver(() => 'agent');
  setDeviceScopeResolver(() => scope);
}

/** One request per tool in the CLI's `dot` profile (`DOT_PROFILE_TOOLS`). */
const DOT_TOOL_ROUTES: [string, string][] = [
  ['POST', '/v1/session/start'], // dina_session_start
  ['POST', '/v1/session/end'], // dina_session_end
  ['GET', '/v1/sessions'], // dina_status
  ['POST', '/v1/commerce/agent/tender-drafts'], // dina_tender_draft
  ['GET', '/v1/commerce/agent/tender-drafts/status'], // dina_tender_status
  ['POST', '/v1/agent/peerlens/search'], // dina_peerlens
  ['POST', '/v1/agent/validate'], // dina_validate
  ['GET', '/v1/intent/proposals/prop-123/status'], // dina_validate_status
  ['DELETE', '/v1/devices/self'], // unlink
];

describe('the dot scope', () => {
  afterEach(() => {
    resetMiddlewareState();
    resetCallerTypeState();
  });

  it('is a scope the device record may carry', () => {
    expect(resolveAgentScope('dot')).toBe('dot');
  });

  it('admits every route a dot tool calls', () => {
    wire('dot');
    for (const [method, path] of DOT_TOOL_ROUTES) {
      const r = authenticateRequest(signed(method, path));
      expect({ method, path, ok: r.authenticated, reason: r.reason }).toEqual({
        method,
        path,
        ok: true,
        reason: undefined,
      });
      expect(r.agentScope).toBe('dot');
    }
  });

  it('refuses routes other agents may call, and the right path with the wrong method', () => {
    wire('dot');
    for (const [method, path] of [
      ['POST', '/v1/vault/query'],
      ['POST', '/v1/agent/peerlens/attest'],
      ['POST', '/v1/agent/peerlens/status'],
      ['POST', '/v1/agent/gate'],
      ['POST', '/v1/agent/ask'],
      ['POST', '/v1/workflow/tasks/claim'],
      ['GET', '/v1/commerce/agent/tender-drafts'],
      ['POST', '/v1/commerce/agent/tender-drafts/status'],
      ['GET', '/v1/intent/proposals/prop-123/approve'],
      ['GET', '/v1/intent/proposals//status'],
    ] as [string, string][]) {
      const r = authenticateRequest(signed(method, path));
      expect({ path, ok: r.authenticated }).toEqual({ path, ok: false });
    }
    const r = authenticateRequest(signed('POST', '/v1/vault/query'));
    expect(r.reason).toMatch(/agent_scope 'dot' may not call POST \/v1\/vault\/query/);
  });

  it('leaves the other scopes as they were', () => {
    wire('coding');
    expect(authenticateRequest(signed('POST', '/v1/agent/peerlens/attest')).authenticated).toBe(
      true,
    );
    expect(isScopeAuthorized('coding', '/v1/agent/peerlens/search')).toBe(true);
    expect(isScopeAuthorized('runner', '/v1/agent/peerlens/search')).toBe(false);
  });

  it('lets a route re-check its own path without a method', () => {
    expect(isDotRoute('/v1/agent/peerlens/search')).toBe(true);
    expect(isDotRoute('/v1/agent/peerlens/attest')).toBe(false);
    expect(isScopeAuthorized('dot', '/v1/agent/peerlens/search')).toBe(true);
  });
});
