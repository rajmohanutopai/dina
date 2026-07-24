/**
 * Item 6b — `agent_scope` (Plugin Developer Surface §11/§14, NEW-19/NEW-02).
 *
 * An agent is one of two scopes, fixed by the ENROLLING AUTHORITY at pairing,
 * persisted on the device record, and derived by Core from the signature-
 * authenticated device DID — never a client claim:
 *
 *   • `coding`  — a coding-agent plugin (Claude Code / Codex). Reaches the
 *                 coding tool façades (gate, memory, find-service, talk, …).
 *   • `runner`  — a delegation runner. Claims/heartbeats/completes workflow
 *                 tasks; it is NOT a coding agent.
 *
 * Both keep `callerType='agent'` (renaming would silently disable the many
 * `!== 'agent'` guards — a fail-open, NEW-02). The scope is an ADDITIONAL
 * constraint on top of the caller-type authz matrix.
 *
 * Fail-closed, non-spoofable: a scope-gated route with a missing/unknown scope
 * is DENIED. The canonical signed payload is method/path/query/timestamp/nonce/
 * body-hash only, so a request-supplied scope would be unsigned — Core therefore
 * IGNORES any client-sent scope and reads only the device record (see
 * `resolveAgentScope`).
 */

export type AgentScope = 'coding' | 'runner';

const VALID_SCOPES: ReadonlySet<string> = new Set<AgentScope>(['coding', 'runner']);

/** Normalise a device-record scope value; unknown/missing ⇒ undefined (fail-closed). */
export function resolveAgentScope(deviceScope: string | null | undefined): AgentScope | undefined {
  return typeof deviceScope === 'string' && VALID_SCOPES.has(deviceScope)
    ? (deviceScope as AgentScope)
    : undefined;
}

interface ScopeRule {
  prefix: string;
  scope: AgentScope;
}

/**
 * Route prefixes that require a specific agent scope. Boundary-safe prefix match
 * (a rule for `/v1/agent/talk` must not match `/v1/agent/talkable`).
 *
 * The coding tool façades require `coding`; the delegation-runner workflow-claim
 * surface requires `runner`. Left off this list ⇒ no scope constraint (the
 * caller-type matrix alone decides).
 */
const SCOPE_RULES: readonly ScopeRule[] = [
  // Coding-agent surfaces (the plugin the coding scope exists for).
  { prefix: '/v1/agent/gate', scope: 'coding' },
  { prefix: '/v1/agent/audit', scope: 'coding' },
  { prefix: '/v1/agent/memory', scope: 'coding' },
  { prefix: '/v1/agent/scrub', scope: 'coding' },
  { prefix: '/v1/agent/find-service', scope: 'coding' },
  { prefix: '/v1/agent/talk', scope: 'coding' },
  { prefix: '/v1/agent/delegate', scope: 'coding' },
  { prefix: '/v1/agent/peerlens', scope: 'coding' },
  { prefix: '/v1/agent/ask', scope: 'coding' },
  { prefix: '/v1/agent/reminders', scope: 'coding' },
  // Delegation-runner surface: claiming a workflow task is a RUNNER action, not
  // a coding one (Item C — narrow the broad agent authz). A coding agent that
  // somehow reaches the claim endpoint is denied by scope even though the
  // caller-type matrix admits any 'agent'.
  { prefix: '/v1/workflow/tasks/claim', scope: 'runner' },
];

/** Boundary-safe prefix test: exact, or followed by `/`. */
function pathHasPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  return path.startsWith(prefix) && path[prefix.length] === '/';
}

/** The scope a route requires, or null if it has no scope constraint. */
export function requiredScopeFor(path: string): AgentScope | null {
  for (const rule of SCOPE_RULES) {
    if (pathHasPrefix(path, rule.prefix)) return rule.scope;
  }
  return null;
}

/**
 * Fail-closed scope check for an agent caller. `true` when the route has no
 * scope constraint OR the caller's (device-derived) scope matches. A scope-gated
 * route with an undefined/mismatched scope is DENIED.
 */
export function isScopeAuthorized(scope: AgentScope | undefined, path: string): boolean {
  const required = requiredScopeFor(path);
  if (required === null) return true;
  if (scope === undefined) return false; // fail-closed on missing scope
  return scope === required;
}
