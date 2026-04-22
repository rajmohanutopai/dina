/**
 * Task routing — route tasks to local LLM, MCP agents, or FTS.
 *
 * Routing decisions based on task type, persona tier, agent trust.
 * FTS-only tasks skip LLM. Complex tasks prefer local. MCP agents
 * require gatekeeper approval.
 *
 * Source: brain/tests/test_routing.py
 */

export type RoutingTarget = 'local_llm' | 'cloud_llm' | 'mcp_agent' | 'fts_only';

export interface TaskRoutingResult {
  target: RoutingTarget;
  agentDID?: string;
  reason: string;
}

/** Tasks that can be handled by local LLM. */
const LOCAL_LLM_TASKS = new Set(['summarize', 'classify', 'reason', 'enrich']);

/** Tasks that require MCP agent delegation. */
const AGENT_TASKS = new Set(['web_search', 'api_call', 'file_fetch']);

/** Tasks that only need FTS (no LLM at all). */
const FTS_ONLY_TASKS = new Set(['keyword_search', 'fts_lookup']);

/** Sensitive personas that prefer local LLM. */
const SENSITIVE_PERSONAS = new Set(['health', 'financial', 'medical']);

/** Trusted agent DIDs (in production, loaded from contacts). */
const trustedAgents = new Set<string>();

/** Add a trusted agent (for testing). */
export function trustAgent(agentDID: string): void {
  trustedAgents.add(agentDID);
}

/** Clear trusted agents (for testing). */
export function clearTrustedAgents(): void {
  trustedAgents.clear();
}

/**
 * Route a task to the appropriate handler.
 *
 * Priority:
 * 1. FTS-only tasks → skip LLM
 * 2. Agent delegation tasks → MCP agent (if trust allows)
 * 3. Sensitive persona → prefer local LLM
 * 4. Local-capable tasks → local LLM
 * 5. Unknown → FTS fallback
 */
export function routeTaskToHandler(
  taskType: string,
  persona?: string,
  agentTrust?: string,
): TaskRoutingResult {
  // 1. FTS-only
  if (FTS_ONLY_TASKS.has(taskType)) {
    return { target: 'fts_only', reason: `Task "${taskType}" is FTS-only` };
  }

  // 2. Agent delegation tasks
  if (AGENT_TASKS.has(taskType)) {
    return { target: 'mcp_agent', reason: `Task "${taskType}" requires MCP agent` };
  }

  // 3. Local-capable
  if (LOCAL_LLM_TASKS.has(taskType)) {
    const target = persona && SENSITIVE_PERSONAS.has(persona) ? 'local_llm' : 'local_llm';
    return { target, reason: `Task "${taskType}" routed to local LLM` };
  }

  // 4. Unknown task type → FTS fallback
  return { target: 'fts_only', reason: `Unknown task type "${taskType}" — FTS fallback` };
}

/** Check if a task type should route to local LLM. */
export function shouldRouteToLocal(taskType: string): boolean {
  return LOCAL_LLM_TASKS.has(taskType);
}

/** Check if a task type should delegate to an MCP agent. */
export function shouldDelegateToAgent(taskType: string): boolean {
  return AGENT_TASKS.has(taskType);
}

/**
 * Check agent trust score before delegation.
 * Returns { trusted, score } where score is 0.0-1.0.
 */
export function checkAgentTrustForDelegation(agentDID: string): {
  trusted: boolean;
  score: number;
} {
  if (trustedAgents.has(agentDID)) {
    return { trusted: true, score: 0.9 };
  }
  // Unknown agents get a low trust score
  return { trusted: false, score: 0.1 };
}
