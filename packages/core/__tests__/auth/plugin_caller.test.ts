/**
 * PLG-3 — plugin caller identity + the §9.0 P0 authz matrix
 * (docs/PLUGIN_ARCHITECTURE.md §7, §9.0).
 *
 * The privilege-escalation boundary: a plugin-role device that resolves
 * to `device` inherits the much wider device surface. The spec mandates
 * a pinning test that this NEVER happens — that test lives here.
 */

import {
  registerDevice,
  resetCallerTypeState,
  resolveCallerType,
  setDeviceRoleResolver,
} from '../../src/auth/caller_type';
import { isAuthorized } from '../../src/auth/authz';

const PLUGIN_DID = 'did:key:zplugininstance';

describe('resolveCallerType — plugin role (§7)', () => {
  beforeEach(() => {
    resetCallerTypeState();
    registerDevice(PLUGIN_DID, 'Acme Flight Watch (inst_1)');
  });
  afterEach(() => resetCallerTypeState());

  it("role='plugin' resolves to callerType 'plugin' — NEVER 'device' (the spec's pinning test)", () => {
    setDeviceRoleResolver(() => 'plugin');
    const identity = resolveCallerType(PLUGIN_DID);
    expect(identity.callerType).toBe('plugin');
    expect(identity.callerType).not.toBe('device');
  });

  it("role='agent' still resolves to 'agent'; user roles to 'device' (no regression)", () => {
    setDeviceRoleResolver(() => 'agent');
    expect(resolveCallerType(PLUGIN_DID).callerType).toBe('agent');
    for (const role of ['rich', 'thin', 'cli']) {
      setDeviceRoleResolver(() => role);
      expect(resolveCallerType(PLUGIN_DID).callerType).toBe('device');
    }
  });

  it('a null role resolver keeps the pre-plugin default (device) — the resolver, not absence of one, is the boundary', () => {
    setDeviceRoleResolver(null);
    expect(resolveCallerType(PLUGIN_DID).callerType).toBe('device');
  });
});

describe('authz matrix — plugin P0 surface (§9.0: nothing else, in any phase)', () => {
  const ALLOWED: Array<[string, string]> = [
    ['POST', '/v1/workflow/tasks/claim'],
    ['POST', '/v1/workflow/tasks/task-42/heartbeat'],
    ['POST', '/v1/workflow/tasks/task-42/progress'],
    ['POST', '/v1/workflow/tasks/task-42/complete'],
    ['POST', '/v1/workflow/tasks/task-42/fail'],
    ['GET', '/healthz'],
  ];

  it.each(ALLOWED)('plugin MAY %s %s', (method, path) => {
    expect(isAuthorized('plugin', method, path)).toBe(true);
  });

  const DENIED: Array<[string, string]> = [
    // The rest of the workflow sub-tree — a plugin must not mint, read,
    // enumerate, approve, or cancel work.
    ['POST', '/v1/workflow/tasks'],
    ['GET', '/v1/workflow/tasks'],
    ['GET', '/v1/workflow/tasks/task-42'],
    ['POST', '/v1/workflow/tasks/task-42/approve'],
    ['POST', '/v1/workflow/tasks/task-42/cancel'],
    ['POST', '/v1/workflow/tasks/task-42/running'],
    ['GET', '/v1/workflow/events'],
    // No pull path at all (§11): vault, ask, sessions, intent, agent.
    ['POST', '/v1/vault/query'],
    ['POST', '/v1/vault/store'],
    ['GET', '/v1/vault/kv/some-key'],
    ['POST', '/api/v1/ask'],
    ['POST', '/api/v1/remember'],
    ['POST', '/v1/session/start'],
    ['POST', '/v1/agent/validate'],
    ['GET', '/v1/intent/proposals/p-1/status'],
    // Later-phase plugin surfaces — NOT in the P0 matrix.
    ['POST', '/v1/ingest'],
    ['POST', '/v1/plugin/notify'],
    // Admin / identity / device surfaces.
    ['GET', '/v1/devices'],
    ['POST', '/v1/pair/initiate'],
    ['POST', '/v1/export'],
    ['GET', '/v1/personas'],
    ['POST', '/v1/did/sign'],
    ['GET', '/v1/contacts'],
    ['POST', '/v1/msg/send'],
    ['GET', '/v1/service/config'],
    ['POST', '/v1/notify'],
    ['GET', '/v1/reminders'],
    ['GET', '/v1/audit/recent'],
  ];

  it.each(DENIED)('plugin may NOT %s %s', (method, path) => {
    expect(isAuthorized('plugin', method, path)).toBe(false);
  });

  it('the suffix rules do not widen the agent/brain surface (no regression)', () => {
    // Agents keep exactly what they had on the tasks sub-tree…
    expect(isAuthorized('agent', 'POST', '/v1/workflow/tasks/claim')).toBe(true);
    expect(isAuthorized('agent', 'POST', '/v1/workflow/tasks/task-42/heartbeat')).toBe(true);
    expect(isAuthorized('agent', 'POST', '/v1/workflow/tasks/task-42/approve')).toBe(true); // route-level ownerDecisionGuard denies the DECISION
    expect(isAuthorized('agent', 'GET', '/v1/workflow/events')).toBe(false);
    // …and devices gained nothing on it.
    expect(isAuthorized('device', 'POST', '/v1/workflow/tasks/claim')).toBe(false);
  });

  it('AUDIT D1: the claim rule is EXACT — a plugin is NOT authorized for /claim/<verb> (over-auth guard)', () => {
    expect(isAuthorized('plugin', 'POST', '/v1/workflow/tasks/claim')).toBe(true);
    // A longer path sharing the prefix must NOT match the claim rule; it
    // falls to the generic sub-tree rule which excludes plugin.
    for (const suffix of ['running', 'cancel', 'approve', 'reset', 'anything']) {
      expect(isAuthorized('plugin', 'POST', `/v1/workflow/tasks/claim/${suffix}`)).toBe(false);
    }
  });

  it('a verb-named task id cannot smuggle reads through the suffix rules (method-aware)', () => {
    // GET /v1/workflow/tasks/complete is the get-single-task route with
    // id="complete". The suffix rules are POST-only, so this falls to
    // the generic sub-tree rule — which excludes plugin.
    expect(isAuthorized('plugin', 'GET', '/v1/workflow/tasks/complete')).toBe(false);
    expect(isAuthorized('plugin', 'GET', '/v1/workflow/tasks/fail')).toBe(false);
    // The POST verbs themselves stay allowed.
    expect(isAuthorized('plugin', 'POST', '/v1/workflow/tasks/task-1/complete')).toBe(true);
  });
});
