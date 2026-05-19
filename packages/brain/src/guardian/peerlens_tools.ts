/**
 * Trust-providing tool registry — single source of truth for "did the
 * agentic loop fetch verified PeerLens / trust data on this turn?".
 *
 * Two scanners need the same answer:
 *
 *   - `guardian/guard_scan.ts` — single-shot post-processor used by
 *     the chat-reasoning pipeline. Flags rating claims when no trust
 *     tool fired.
 *   - `reasoning/guard_scanner.ts` — LLM-based scanner used by the
 *     agentic loop. Strips fabricated/consensus sentences when no
 *     trust tool fired.
 *
 * Previously each kept its own copy of the allow-list with a "kept in
 * sync via comment" note. Comments rot. This module is the canonical
 * registry; both scanners import from here.
 *
 * Adding a new trust-providing tool: append the exact name to
 * `TRUST_TOOL_NAMES`, OR — if the new tool fits an existing prefix
 * family (`peerlens_*`, `peer_lens_*`) — no edit needed; the prefix
 * match in `isTrustTool` picks it up automatically.
 */

/**
 * Canonical names of tools that return verified PeerLens / trust data.
 * The set is small and exact — siblings under a common prefix should
 * be added to the corresponding prefix list in `isTrustTool` instead
 * of being enumerated one by one.
 */
export const TRUST_TOOL_NAMES: ReadonlySet<string> = new Set([
  'search_peerlens',
  // Legacy alias — older clients / model checkpoints may still emit
  // the renamed name. Kept here so detection stays correct during
  // the transition window.
  'search_trust_network',
  'peerlens_lookup',
  'peer_lens_lookup',
]);

/**
 * Prefix families. Any tool whose name starts with one of these is
 * treated as a trust tool. Lets future siblings (`peerlens_aggregate`,
 * `peer_lens_subject_detail`, …) ship without a parallel update here.
 */
const TRUST_TOOL_PREFIXES: readonly string[] = ['peerlens_', 'peer_lens_'];

/** Is `name` a recognised trust-providing tool? */
export function isTrustTool(name: string): boolean {
  if (TRUST_TOOL_NAMES.has(name)) return true;
  for (const prefix of TRUST_TOOL_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

/** Did the agentic loop call ANY trust-providing tool on this turn? */
export function trustToolUsed(toolsCalled: readonly string[] | undefined): boolean {
  if (!toolsCalled || toolsCalled.length === 0) return false;
  for (const name of toolsCalled) {
    if (isTrustTool(name)) return true;
  }
  return false;
}
