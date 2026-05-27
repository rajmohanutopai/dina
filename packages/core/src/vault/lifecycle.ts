/**
 * Vault lifecycle — persona tier enforcement for open/close/access.
 *
 * | Tier      | Boot   | Brain    | Agents (V1)         |
 * |-----------|--------|----------|---------------------|
 * | default   | open   | free     | free                |
 * | standard  | open   | free     | free *              |
 * | sensitive | closed | approval | approval + grant    |
 * | locked    | closed | denied   | approval + grant ** |
 *
 * The **Agents** column is the release contract enforced by the durable
 * persona-access gate (`agent/access.ts::requireAgentPersonaAccess`,
 * issues.txt §2), reachable only by an out-of-process dina-agent — the
 * owner's own app reads/writes every persona freely (user-vs-agent rule).
 *
 *   *  `standard` is open to agents in V1. The original "per-session grant"
 *      model is deferred (named agent sessions aren't wired to the gate
 *      yet); the dangerous leak the §2 work closed was sensitive/locked.
 *   ** `locked` for an agent goes through approval + a durable grant (and
 *      approval also unlocks the persona DEK), superseding the old
 *      "denied" — the issues.txt §2 locked-vault approve/resume flow.
 *      Cross-persona isolation still holds: a grant is per (agent, persona,
 *      mode); a health grant never unlocks finance. Brain access is
 *      unchanged (free for default/standard, denied for locked).
 *
 * Source: core/test/vault_test.go + issues.txt §2.
 */

export type PersonaTier = 'default' | 'standard' | 'sensitive' | 'locked';

/** Check if a persona tier auto-opens on boot. */
export function autoOpensOnBoot(tier: PersonaTier): boolean {
  return tier === 'default' || tier === 'standard';
}

/** Check if a persona tier requires user approval to access. */
export function requiresApproval(tier: PersonaTier): boolean {
  return tier === 'sensitive';
}

/** Check if a persona tier requires a passphrase to unlock. */
export function requiresPassphrase(tier: PersonaTier): boolean {
  return tier === 'locked';
}

/** Check if Brain can access this tier freely. */
export function brainCanAccess(tier: PersonaTier): boolean {
  return tier === 'default' || tier === 'standard';
}

/**
 * AUTHORITATIVE pure tier policy for an out-of-process agent (issues.txt §2
 * V1 contract). `agent/access.ts::requireAgentPersonaAccess` CALLS this — it
 * is the single source of truth for the boolean decision, so the runtime gate
 * and this documented contract cannot drift. It is exactly
 * `hasGrant || isFreeTier(tier)`:
 *   - default / standard → open to agents (no grant needed in V1).
 *   - sensitive / locked → require an approved durable grant.
 * (`locked` is approval+grant, NOT a hard denial — superseding the old
 * model; the owner's own app is never gated by this, see the user-vs-agent
 * rule in `agent/access.ts`.)
 */
export function agentCanAccess(tier: PersonaTier, hasGrant: boolean): boolean {
  if (tier === 'default' || tier === 'standard') return true;
  return hasGrant; // sensitive + locked
}
