/**
 * Pipeline safety — MCP tool restrictions, structured output validation,
 * briefing dedup, and crash recovery.
 *
 * Invariants:
 * - Reader pipeline has NO outbound MCP tools (read-only)
 * - Sender output is structured (not raw text)
 * - Disallowed MCP tools rejected before execution
 * - Briefing deduplicates repeated items (by source_id + type)
 *
 * Source: brain/tests/test_pipeline_safety.py
 */

// ---------------------------------------------------------------
// Pipeline stage tool allowlists
// ---------------------------------------------------------------

/**
 * Allowed MCP tools per pipeline stage.
 * - 'reader': read-only tools (vault search, FTS, contact lookup)
 * - 'classifier': analysis tools (domain classify, persona select)
 * - 'enricher': enrichment tools (summarize, embed)
 * - 'sender': outbound tools (send_email, send_message, post_to_service)
 */
const STAGE_ALLOWLISTS: Record<string, Set<string>> = {
  reader: new Set([
    'vault_search',
    'vault_query',
    'fts_search',
    'contact_lookup',
    'reminder_list',
    'kv_get',
  ]),
  classifier: new Set(['vault_search', 'vault_query', 'fts_search']),
  enricher: new Set(['vault_search', 'vault_query', 'fts_search', 'embed']),
  sender: new Set([
    'vault_search',
    'vault_query',
    'fts_search',
    'send_email',
    'send_message',
    'post_to_service',
    'create_reminder',
  ]),
};

/** Stages that have outbound (write/send) capabilities. */
const OUTBOUND_STAGES = new Set(['sender']);

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Check if a pipeline stage has outbound tools.
 * Reader, classifier, enricher MUST NOT have outbound tools.
 * Only sender stage has outbound capabilities.
 */
export function hasOutboundTools(stage: string): boolean {
  return OUTBOUND_STAGES.has(stage);
}

/**
 * Validate that output is structured (object with known shape), not raw text.
 * Sender/enricher output must be structured for downstream processing.
 */
export function isStructuredOutput(output: unknown): boolean {
  if (output === null || output === undefined) return false;
  if (typeof output === 'string') return false;
  if (typeof output === 'number') return false;
  if (typeof output === 'boolean') return false;
  if (Array.isArray(output)) return true;
  return typeof output === 'object';
}

/**
 * Check if an MCP tool is in the allowed set for this pipeline stage.
 *
 * @param toolName - The MCP tool being requested
 * @param stage - The pipeline stage making the request
 * @returns true if the tool is allowed in this stage
 */
export function isToolAllowedInStage(toolName: string, stage: string): boolean {
  const allowlist = STAGE_ALLOWLISTS[stage];
  if (!allowlist) return false;
  return allowlist.has(toolName);
}

/**
 * Deduplicate items in a briefing by (source_id + type) compound key.
 * Keeps the first occurrence of each unique key.
 */
export function deduplicateBriefingItems(
  items: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const result: Array<Record<string, unknown>> = [];

  for (const item of items) {
    const key = `${item.source_id ?? ''}:${item.type ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}

/**
 * Regenerate briefing from vault source items after a crash.
 * Queries Core for recent Tier 3 items and rebuilds the briefing queue.
 *
 * TODO: Requires Core HTTP client (task 3.2). Stub for now.
 */
export async function regenerateBriefingFromSource(): Promise<Array<Record<string, unknown>>> {
  // TODO: Phase 3.2 — call Core API to fetch recent Tier 3 items
  return [];
}
