/** REAL_LIFE_FIXES_2 §7.2 — existing agent pairings keep work access; deleting a persona revokes it. */

import { InMemoryAgentGrantRepository, setAgentGrantRepository } from '../../src/agent/grant_repository';
import { migrateStandardPersonaGrants, revokeGrantsOnPersonaDelete } from '../../src/agent/standing_grants';
import { requireAgentPersonaAccess } from '../../src/agent/access';
import { resetKVStore } from '../../src/kv/store';
import { createPersona, deletePersona, resetPersonaState } from '../../src/persona/service';

import type { PairedDevice } from '../../src/devices/registry';

const device = (did: string, role: PairedDevice['role'], revoked = false) =>
  ({ deviceId: did, did, role, revoked }) as unknown as PairedDevice;

let repo: InMemoryAgentGrantRepository;
beforeEach(() => {
  resetPersonaState();
  resetKVStore();
  repo = new InMemoryAgentGrantRepository();
  setAgentGrantRepository(repo);
  createPersona('general', 'default');
  createPersona('work', 'standard');
  createPersona('side_projects', 'standard');
  createPersona('health', 'sensitive');
});
afterAll(() => setAgentGrantRepository(null));

it('gives each active agent a standing grant per standard persona, once', async () => {
  const devices = [device('did:key:agent1', 'agent'), device('did:key:phone', 'rich'), device('did:key:gone', 'agent', true)];
  const first = await migrateStandardPersonaGrants(devices);
  expect(first).toEqual({ created: 2, ran: true });
  expect(repo.listAll().map((g) => `${g.agentDID}:${g.persona}:${g.grantKind}`).sort()).toEqual([
    'did:key:agent1:side_projects:standing',
    'did:key:agent1:work:standing',
  ]);
  expect(await migrateStandardPersonaGrants(devices)).toEqual({ created: 0, ran: false });
  expect(requireAgentPersonaAccess({ agentDID: 'did:key:agent1', persona: 'work', mode: 'read', scope: 'x', sessionId: 'any' }).kind).toBe('allow');
  // No approvals service in this test, so Core fails closed instead of raising a card.
  expect(requireAgentPersonaAccess({ agentDID: 'did:key:agent1', persona: 'health', mode: 'read', scope: 'x' }).kind).not.toBe('allow');
});

it('waits for personas to load before marking itself done', async () => {
  resetPersonaState();
  expect(await migrateStandardPersonaGrants([device('did:key:agent1', 'agent')])).toEqual({ created: 0, ran: false });
  createPersona('work', 'standard');
  expect((await migrateStandardPersonaGrants([device('did:key:agent1', 'agent')])).created).toBe(1);
});

it('deleting a persona revokes its grants', async () => {
  revokeGrantsOnPersonaDelete();
  await migrateStandardPersonaGrants([device('did:key:agent1', 'agent')]);
  deletePersona('work');
  expect(repo.listAll().filter((g) => g.persona === 'work').every((g) => g.revokedAt !== null)).toBe(true);
});

it('after a persona becomes sensitive, a fresh approval is honoured even beside the old standing grant', async () => {
  const { setPersonaTierInMemory } = await import('../../src/persona/service');
  await migrateStandardPersonaGrants([device('did:key:agent1', 'agent')]);
  setPersonaTierInMemory('work', 'sensitive');
  const ask = { agentDID: 'did:key:agent1', persona: 'work', mode: 'read' as const, scope: 'x', sessionId: 's1' };
  // The standing grant was given at 'standard' and no longer covers.
  expect(requireAgentPersonaAccess(ask).kind).not.toBe('allow');
  // The owner approves this session at the new tier.
  repo.insert({
    id: 'g-new',
    sessionId: 's1',
    agentDID: 'did:key:agent1',
    persona: 'work',
    mode: 'read',
    scopeJson: '{}',
    approvalTaskId: 't1',
    expiresAt: Date.now() + 3_600_000,
    createdAt: Date.now(),
    grantedTier: 'sensitive',
  });
  expect(requireAgentPersonaAccess(ask).kind).toBe('allow');
});
