/**
 * Vault lifecycle — persona tier enforcement for open/close/access.
 *
 * | Tier      | Boot   | Brain    | Agents              |
 * |-----------|--------|----------|---------------------|
 * | default   | open   | free     | free                |
 * | standard  | open   | free     | session grant       |
 * | sensitive | closed | approval | approval + grant    |
 * | locked    | closed | denied   | denied              |
 *
 * Source: core/test/vault_test.go
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

/** Check if agents can access this tier (may require session grant). */
export function agentCanAccess(tier: PersonaTier, hasGrant: boolean): boolean {
  if (tier === 'default') return true;
  if (tier === 'standard' || tier === 'sensitive') return hasGrant;
  return false;
}
