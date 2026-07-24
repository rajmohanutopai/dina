/**
 * Item C (Codex review — agent_scope live derivation).
 *
 * Proves the whole chain through the REAL signed auth pipeline: Core derives
 * `agentScope` from the signature-authenticated DEVICE RECORD (never a client
 * claim) and enforces the scope rules — a coding agent reaches the coding
 * surfaces but not the runner claim, and vice-versa. An agent with no stamped
 * scope defaults to `runner`, so pre-scope delegation runners keep working while
 * an unstamped device is still barred from the coding surfaces.
 */

import { TEST_ED25519_SEED } from '@dina/test-harness';

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
const agentDid = 'did:key:z6MkScopeAgent';

function signed(method: string, path: string) {
  const body = new Uint8Array();
  const headers = signRequest(method, path, '', body, TEST_ED25519_SEED, agentDid);
  return { method, path, query: '', body, headers };
}

/** Wire a fresh pipeline where `agentDid` is a paired AGENT device with `scope`. */
function wire(scope: 'coding' | 'runner' | null): void {
  resetMiddlewareState();
  resetCallerTypeState();
  registerPublicKeyResolver((d) => (d === agentDid ? pubKey : null));
  registerDevice(agentDid, 'agent-device'); // caller_type: DID → device
  setDeviceRoleResolver(() => 'agent');
  setDeviceScopeResolver(() => scope);
}

describe('agent_scope derivation + enforcement (signed pipeline)', () => {
  afterEach(() => {
    resetMiddlewareState();
    resetCallerTypeState();
  });

  it("derives 'coding' from the device record and admits the coding gate", () => {
    wire('coding');
    const r = authenticateRequest(signed('POST', '/v1/agent/gate'));
    expect(r.authenticated).toBe(true);
    expect(r.agentScope).toBe('coding');
  });

  it("admits only a coding agent to the agent PII scrub façade", () => {
    wire('coding');
    expect(authenticateRequest(signed('POST', '/v1/agent/scrub')).authenticated).toBe(true);

    wire('runner');
    const denied = authenticateRequest(signed('POST', '/v1/agent/scrub'));
    expect(denied.authenticated).toBe(false);
    expect(denied.reason).toMatch(/agent_scope 'coding' required/);
  });

  it("admits only a coding agent to its own audit projection", () => {
    wire('coding');
    expect(authenticateRequest(signed('GET', '/v1/agent/audit')).authenticated).toBe(true);

    wire('runner');
    const denied = authenticateRequest(signed('GET', '/v1/agent/audit'));
    expect(denied.authenticated).toBe(false);
    expect(denied.reason).toMatch(/agent_scope 'coding' required/);
  });

  it('a coding agent is DENIED the runner-only workflow claim', () => {
    wire('coding');
    const r = authenticateRequest(signed('POST', '/v1/workflow/tasks/claim'));
    expect(r.authenticated).toBe(false);
    expect(r.rejectedAt).toBe('authorization');
    expect(r.reason).toMatch(/agent_scope 'runner' required/);
  });

  it("an unstamped agent defaults to 'runner': admitted to claim", () => {
    wire(null);
    const r = authenticateRequest(signed('POST', '/v1/workflow/tasks/claim'));
    expect(r.authenticated).toBe(true);
    expect(r.agentScope).toBe('runner');
  });

  it('the runner default is DENIED a coding surface (fail-closed for coding)', () => {
    wire(null);
    const r = authenticateRequest(signed('POST', '/v1/agent/memory'));
    expect(r.authenticated).toBe(false);
    expect(r.reason).toMatch(/agent_scope 'coding' required/);
  });

  it('a client-sent scope header is ignored — only the device record decides', () => {
    wire('runner'); // the DEVICE is a runner…
    const req = signed('POST', '/v1/agent/gate');
    // …even if the caller forges an X-Agent-Scope header, it is not in the
    // canonical signature and Core never reads it → still denied.
    (req.headers as Record<string, string>)['x-agent-scope'] = 'coding';
    const r = authenticateRequest(req);
    expect(r.authenticated).toBe(false);
    expect(r.reason).toMatch(/agent_scope 'coding' required/);
  });
});
