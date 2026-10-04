/**
 * The extended card (A2A §3.1.11, design §7.1, §12 M3 done-when): one
 * authenticated client's projection — the public skills in its scope and
 * the skills its live grants open — signed like the public card; a revoked
 * grant's skill is gone from the next card; every example is a call Core
 * accepts.
 */

import { verifyAgentCardSignatures, type AgentCard } from '@dina/a2a';

import {
  cardPublicJwk,
  createA2AClient,
  ingressGetExtendedAgentCard,
  ingressSendMessage,
  issueA2AGrant,
  parsePublicJwk,
  revokeA2AGrant,
  verifyWithJwk,
  type A2ACardConfig,
} from '../../src/a2a';
import { deriveP256SigningKey } from '../../src/crypto';

import { InboundWorld, errorOf, listing, resultOf, save, sentTask } from './inbound_fixture';

const NODE_DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const CONFIG: A2ACardConfig = {
  key: {
    privateKey: deriveP256SigningKey(new Uint8Array(32).fill(3), 0).privateKey,
    generation: 0,
  },
  publicOrigin: 'https://dina.example.org',
};
const CARD = { nodeDid: NODE_DID, config: CONFIG };

let iw: InboundWorld;
beforeEach(async () => {
  iw = await InboundWorld.create();
  await save(listing({ discoverability: 'known_only', name: 'Clinic desk' }), 'clinic');
});
afterEach(() => iw.close());

const extended = (auth?: string, card: typeof CARD | null = CARD) =>
  ingressGetExtendedAgentCard(iw.rt, iw.request('GetExtendedAgentCard', undefined, {}, auth), card);
const skillIds = (card: AgentCard) => card.skills.map((s) => s.id);

function grantClinic(): string {
  const issued = issueA2AGrant(
    iw.world.store,
    iw.grants,
    { client_id: iw.clientId, service_rkey: 'clinic', capability: 'eta_query' },
    iw.world.clock,
  );
  if (!issued.ok) throw new Error(issued.reason);
  return issued.grant.grantId;
}

it('requires the client’s credential (401 without it)', async () => {
  expect((await extended(undefined)).status).toBe(200);
  expect(
    (
      await ingressGetExtendedAgentCard(
        iw.rt,
        iw.request('GetExtendedAgentCard', undefined, {}, null),
        CARD,
      )
    ).status,
  ).toBe(401);
});

it('with no grants: the public skills in scope, signed with the card key', async () => {
  const card = resultOf(await extended()) as unknown as AgentCard;
  expect(skillIds(card)).toEqual(['eta_query@bus']);
  expect(card.capabilities).toEqual(
    expect.objectContaining({ streaming: true, pushNotifications: true, extendedAgentCard: true }),
  );
  const jwk = parsePublicJwk(cardPublicJwk(CONFIG.key));
  if (jwk === null) throw new Error('jwk');
  const report = await verifyAgentCardSignatures(
    card as unknown as Record<string, unknown>,
    ({ header, signingInputs, signature }) =>
      signingInputs.some((input) => verifyWithJwk(jwk, header.alg, input, signature)),
  );
  expect(report.state).toBe('verified');
});

it('a live grant adds its known_only skill; revoking it removes the skill from the next card', async () => {
  const grantId = grantClinic();
  const card = resultOf(await extended()) as unknown as AgentCard;
  expect(skillIds(card)).toEqual(['eta_query@bus', 'eta_query@clinic']);
  const example = JSON.parse(
    card.skills.find((s) => s.id === 'eta_query@clinic')?.examples?.[0] ?? '{}',
  ) as Record<string, unknown>;
  expect(example).toEqual(
    expect.objectContaining({ skill: 'eta_query@clinic', grant_id: grantId }),
  );
  revokeA2AGrant(iw.grants, grantId, iw.world.clock);
  expect(skillIds(resultOf(await extended()) as unknown as AgentCard)).toEqual(['eta_query@bus']);
});

it('every example on the extended card is a call Core accepts (grant_id and schema_hash included)', async () => {
  grantClinic();
  const card = resultOf(await extended()) as unknown as AgentCard;
  for (const skill of card.skills) {
    const data = JSON.parse(skill.examples?.[0] ?? 'null') as Record<string, unknown>;
    expect(typeof data.schema_hash).toBe('string');
    // The sampler's placeholder for a minLength-1 string is 'x'.
    const answer = ingressSendMessage(iw.rt, iw.request('SendMessage', iw.message(data)));
    expect((sentTask(answer).status as { state: string }).state).not.toBe('TASK_STATE_REJECTED');
  }
});

it('a client scoped away from every public skill, holding no grant, has no card (-32007)', async () => {
  const scoped = createA2AClient(
    iw.world.store,
    { display_name: 'Scoped', scope: ['price_check'] },
    iw.world.clock,
  );
  if (!scoped.ok) throw new Error(scoped.reason);
  expect(errorOf(await extended(`Bearer ${scoped.token}`))).toEqual({
    code: -32007,
    reason: 'no_skills_for_client',
  });
});

it('with no public listing, a grantee’s card is named for the listing its grant opens', async () => {
  await save(listing({ status: 'paused' }), 'bus');
  grantClinic();
  const card = resultOf(await extended()) as unknown as AgentCard;
  expect(card.name).toBe('Clinic desk');
  expect(skillIds(card)).toEqual(['eta_query@clinic']);
});

it('a node with no card configured answers -32007', async () => {
  expect(errorOf(await extended(undefined, null)).code).toBe(-32007);
});
