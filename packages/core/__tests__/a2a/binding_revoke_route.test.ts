/**
 * The owner withdraws one outbound skill binding (design §5.5) through
 * `POST /v1/owner/a2a/remote-agents/:id/bindings/:skill/revoke`. A remote
 * skill id may be any text of 1–256 characters, so the console encodes it
 * once and the router decodes it once: the route revokes exactly the
 * binding named, whatever characters its id holds.
 */

import { activateRemoteAgent, bindRemoteSkill, createNoneCredential, liveRemoteBindings, registerRemoteAgent } from '../../src/a2a';
import { CoreRouter } from '../../src/server/router';
import { registerA2ARoutes } from '../../src/server/routes/a2a';

import { LaneWorld, agentCard } from './outbound_fixture';

const CAP = 'owner-capability-for-binding-tests';
const CARD_URL = 'https://odd-ids.example/.well-known/agent-card.json';
/** Ids a second decode would misread: `%` alone (a URIError), `%41` (read as `A`), its decoded twin, and `/`. */
const IDS = ['save 20%', 'a%41b', 'aAb', 'x/y', '100%25'];

let world: LaneWorld;
let router: CoreRouter;
let agentId: string;

beforeEach(async () => {
  world = new LaneWorld();
  world.cards.set(
    CARD_URL,
    agentCard({ skills: IDS.map((id) => ({ id, name: `Skill ${id}`, description: 'A skill with an unusual id.', tags: ['text'] })) }),
  );
  const deps = { store: world.store, nowMs: () => world.clock };
  const reg = await registerRemoteAgent(deps, CARD_URL);
  if (!reg.ok) throw new Error(reg.reason);
  agentId = reg.agent.agent_id;
  const cred = createNoneCredential(deps, agentId);
  if (!cred.ok) throw new Error(cred.reason);
  for (const skill of IDS) {
    const bound = bindRemoteSkill(deps, agentId, { skill, actionClass: 'read', credentialRef: cred.credential.credential_ref });
    if (!bound.ok) throw new Error(`bind ${skill}: ${bound.reason}`);
  }
  expect(activateRemoteAgent(deps, agentId)).toEqual({ ok: true });
  router = new CoreRouter();
  registerA2ARoutes(router, CAP);
});
afterEach(() => world.close());

/** The revoke as the owner console sends it: the id encoded once in the path. */
const revoke = (skill: string) =>
  router.handle({
    method: 'POST',
    path: `/v1/owner/a2a/remote-agents/${agentId}/bindings/${encodeURIComponent(skill)}/revoke`,
    query: {},
    headers: {},
    body: {},
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'owner',
    ownerCapability: CAP,
  });

const live = () => {
  const agent = world.store.getAgent(agentId);
  if (agent === null) throw new Error('agent');
  return liveRemoteBindings(world.store, agent).map((b) => b.skill).sort();
};

it.each(IDS)('revokes the binding named %j, and only it', async (skill) => {
  const res = await revoke(skill);
  expect(res).toEqual(expect.objectContaining({ status: 200, body: { status: 'revoked' } }));
  expect(live()).toEqual(IDS.filter((id) => id !== skill).sort());
});

it('a binding already revoked, or never made, is not found', async () => {
  expect((await revoke('a%41b')).status).toBe(200);
  expect((await revoke('a%41b')).status).toBe(404);
  expect((await revoke('no such skill')).status).toBe(404);
  expect(live()).toEqual(IDS.filter((id) => id !== 'a%41b').sort());
});
