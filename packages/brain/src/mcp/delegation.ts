/**
 * MCP agent delegation — safety gates, intent validation, query sanitization.
 *
 * Agents (OpenClaw, etc.) communicate via MCP. Brain validates intents
 * before delegation. SAFE actions auto-approved, MODERATE/HIGH need user
 * approval, BLOCKED denied outright.
 *
 * Source: brain/tests/test_mcp.py
 */

export type IntentRisk = 'SAFE' | 'MODERATE' | 'HIGH' | 'BLOCKED';

export interface DelegationRequest {
  agentDID: string;
  action: string;
  description: string;
  context?: Record<string, unknown>;
}

export interface DelegationDecision {
  approved: boolean;
  risk: IntentRisk;
  requiresUserApproval: boolean;
  reason: string;
}

// ---------------------------------------------------------------
// Risk classification (matches gatekeeper/intent.ts policy table)
// ---------------------------------------------------------------

const ACTION_RISK: Record<string, IntentRisk> = {
  search: 'SAFE',
  query: 'SAFE',
  list: 'SAFE',
  remember: 'SAFE',
  store: 'SAFE',
  send_small: 'SAFE',
  delete_small: 'SAFE',
  send_email: 'MODERATE',
  send_large: 'MODERATE',
  delete_large: 'MODERATE',
  modify_settings: 'MODERATE',
  purchase: 'HIGH',
  payment: 'HIGH',
  bulk_operation: 'HIGH',
  credential_export: 'BLOCKED',
  key_access: 'BLOCKED',
  did_sign: 'BLOCKED',
  did_rotate: 'BLOCKED',
  vault_backup: 'BLOCKED',
  persona_unlock: 'BLOCKED',
  seed_export: 'BLOCKED',
};

/** Numeric risk ordering for escalation checks. */
const RISK_ORDER: Record<IntentRisk, number> = { SAFE: 0, MODERATE: 1, HIGH: 2, BLOCKED: 3 };

// ---------------------------------------------------------------
// Blacklist + tool whitelist
// ---------------------------------------------------------------

const blacklistedAgents = new Set<string>();

const ALLOWED_TOOLS = new Set([
  'gmail_fetch',
  'calendar_read',
  'contacts_lookup',
  'web_search',
  'file_read',
  'vault_search',
  'vault_query',
  'fts_search',
  'embed',
  'create_reminder',
]);

/** Add an agent to the blacklist. */
export function blacklistAgent(agentDID: string): void {
  blacklistedAgents.add(agentDID);
}

/** Clear blacklist (for testing). */
export function clearBlacklist(): void {
  blacklistedAgents.clear();
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/** Evaluate a delegation request through the safety gate. */
export function evaluateDelegation(request: DelegationRequest): DelegationDecision {
  if (isAgentBlacklisted(request.agentDID)) {
    return {
      approved: false,
      risk: 'BLOCKED',
      requiresUserApproval: false,
      reason: `Agent "${request.agentDID}" is blacklisted`,
    };
  }

  const risk = ACTION_RISK[request.action] ?? 'MODERATE';

  if (risk === 'BLOCKED') {
    return {
      approved: false,
      risk,
      requiresUserApproval: false,
      reason: `Action "${request.action}" is blocked`,
    };
  }
  if (risk === 'HIGH' || risk === 'MODERATE') {
    return {
      approved: true,
      risk,
      requiresUserApproval: true,
      reason: `Action "${request.action}" requires user approval`,
    };
  }

  return {
    approved: true,
    risk: 'SAFE',
    requiresUserApproval: false,
    reason: `Action "${request.action}" is safe — auto-approved`,
  };
}

/** Check if an agent DID is on the blacklist. */
export function isAgentBlacklisted(agentDID: string): boolean {
  return blacklistedAgents.has(agentDID);
}

/** Sanitize a query before passing to an MCP agent. */
export function sanitizeAgentQuery(query: string): string {
  if (!query) return '';
  let sanitized = query;
  sanitized = sanitized.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  sanitized = sanitized.replace(/<[^>]+>/g, '');
  sanitized = sanitized.replace(/;.*?(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE)\b/gi, '');
  sanitized = sanitized.trim();
  return sanitized;
}

/** Check if an MCP tool name is in the allowed whitelist. */
export function isToolAllowed(toolName: string): boolean {
  if (!toolName) return false;
  return ALLOWED_TOOLS.has(toolName);
}

/** Validate agent constraints (approved for A cannot escalate to B). */
export function validateConstraints(approvedAction: string, attemptedAction: string): boolean {
  const approvedRisk = ACTION_RISK[approvedAction] ?? 'MODERATE';
  const attemptedRisk = ACTION_RISK[attemptedAction] ?? 'MODERATE';
  return RISK_ORDER[attemptedRisk] <= RISK_ORDER[approvedRisk];
}
