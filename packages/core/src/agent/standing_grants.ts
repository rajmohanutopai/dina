/**
 * Standing grants for standard personas (REAL_LIFE_FIXES_2 §7.2).
 *
 * A standard persona (/work) now needs a grant for agents. So that no
 * pairing loses access silently, a one-time migration gives each active
 * agent pairing a standing read grant for each standard persona that exists
 * at upgrade. Each grant is audited and revocable from the Agents screen.
 * Deleting a persona revokes every grant on it, so a persona re-created with
 * the same name at a stricter tier never inherits them.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { appendAudit } from '../audit/service';
import { kvGet, kvSet } from '../kv/store';
import { listPersonas, onPersonaDeleted } from '../persona/service';

import { getAgentGrantRepository, STANDING_GRANT_EXPIRES_AT } from './grant_repository';

import type { PairedDevice } from '../devices/registry';

const DONE_KEY = 'standard_baseline_v1';
const NS = 'agent_grants';

/** Give every active agent a standing grant per standard persona, once. */
export async function migrateStandardPersonaGrants(
  devices: readonly PairedDevice[],
  now: number = Date.now(),
): Promise<{ created: number; ran: boolean }> {
  if ((await kvGet(DONE_KEY, NS)) !== null) return { created: 0, ran: false };
  const repo = getAgentGrantRepository();
  const personas = listPersonas();
  // Personas not loaded yet: try again next boot rather than mark it done.
  if (repo === null || personas.length === 0) return { created: 0, ran: false };
  const standard = personas.filter((p) => p.tier === 'standard').map((p) => p.name);
  let created = 0;
  for (const device of devices) {
    if (device.revoked || device.role !== 'agent') continue;
    const existing = repo.listActiveForAgent(device.did, now);
    for (const persona of standard) {
      if (existing.some((g) => g.grantKind === 'standing' && g.persona === persona)) continue;
      const id = `grant-${bytesToHex(randomBytes(8))}`;
      repo.insert({
        id,
        sessionId: null,
        agentDID: device.did,
        persona,
        mode: 'read',
        scopeJson: JSON.stringify({ scope: 'baseline_migration' }),
        approvalTaskId: `baseline_migration:${id}`,
        expiresAt: STANDING_GRANT_EXPIRES_AT,
        createdAt: now,
        grantKind: 'standing',
        grantedTier: 'standard',
      });
      appendAudit(device.did, 'agent_access_baseline_grant', persona, `grant=${id}`);
      created++;
    }
  }
  await kvSet(DONE_KEY, String(now), NS);
  return { created, ran: true };
}

/** A standing grant the owner gives at pairing for a chosen standard persona. */
export function grantStandingAccess(agentDID: string, persona: string, pairingId: string, now: number = Date.now()): string | null {
  const repo = getAgentGrantRepository();
  if (repo === null) return null;
  const tier = listPersonas().find((p) => p.name === persona)?.tier;
  if (tier !== 'standard') return null;
  const id = `grant-${bytesToHex(randomBytes(8))}`;
  repo.insert({
    id,
    sessionId: null,
    agentDID,
    persona,
    mode: 'read',
    scopeJson: JSON.stringify({ scope: 'pairing' }),
    approvalTaskId: `pairing:${pairingId}`,
    expiresAt: STANDING_GRANT_EXPIRES_AT,
    createdAt: now,
    grantKind: 'standing',
    grantedTier: 'standard',
  });
  appendAudit(agentDID, 'agent_access_pairing_grant', persona, `grant=${id}`);
  return id;
}

let wired = false;

/** Deleting a persona revokes every grant on it (idempotent wiring). */
export function revokeGrantsOnPersonaDelete(): void {
  if (wired) return;
  wired = true;
  onPersonaDeleted((persona) => {
    const n = getAgentGrantRepository()?.revokeForPersona(persona, Date.now()) ?? 0;
    if (n > 0) appendAudit('core', 'agent_access_revoked_persona_deleted', persona, `grants=${n}`);
  });
}
