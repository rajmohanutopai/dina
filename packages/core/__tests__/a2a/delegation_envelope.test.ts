/**
 * Dina calling Dina (design §7.2a): the data part is Dina's invocation
 * envelope, and its `skill` is the remote's skill as its card writes it.
 * That id is the remote's own word: the scrub leaves it as written (an
 * rkey-qualified id reads like a UPI address), and it must be the skill the
 * owner bound, since it is what the remote will run.
 */

import { DINA_A2A_EXTENSION_URI } from '@dina/a2a';

import {
  activateRemoteAgent,
  bindRemoteSkill,
  createNoneCredential,
  proposeDelegation,
  registerRemoteAgent,
} from '../../src/a2a';

import { LaneWorld, SESSION, agentCard } from './outbound_fixture';

const DINA_URL = 'https://bus.example/.well-known/agent-card.json';

let world: LaneWorld;
beforeEach(() => {
  world = new LaneWorld();
});
afterEach(() => world.close());

/** Register a remote from its card, bind `skill`, activate, and start an owner turn. */
async function bound(cardUrl: string, skill: string): Promise<string> {
  const d = { store: world.store, nowMs: () => world.clock };
  const reg = await registerRemoteAgent(d, cardUrl);
  if (!reg.ok) throw new Error(`register: ${reg.reason}`);
  const agentId = reg.agent.agent_id;
  const cred = createNoneCredential(d, agentId);
  if (!cred.ok) throw new Error(cred.reason);
  if (!bindRemoteSkill(d, agentId, { skill, actionClass: 'read', credentialRef: cred.credential.credential_ref }).ok) throw new Error('bind');
  if (!activateRemoteAgent(d, agentId).ok) throw new Error('activate');
  world.turn();
  return agentId;
}

function dinaCard() {
  world.cards.set(
    DINA_URL,
    agentCard({
      name: 'Bus 42',
      supportedInterfaces: [{ url: 'https://bus.example/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { extensions: [{ uri: DINA_A2A_EXTENSION_URI, description: 'Dina invocation contract.' }] },
      skills: [
        { id: 'eta_query@bus', name: 'ETA', description: 'Arrival times.', tags: ['transit'] },
        { id: 'price_check@bus', name: 'Price', description: 'Fares.', tags: ['transit'] },
        // An id no scrubbing touches (it looks like no personal detail): only the rule itself can refuse it.
        { id: 'fares', name: 'Fares', description: 'Buy a fare.', tags: ['transit'] },
      ],
    }),
  );
}

const dataOf = (out: ReturnType<typeof proposeDelegation>) =>
  out.ok ? (out.projection.parts.find((p) => 'data' in p) as { data: Record<string, unknown> } | undefined)?.data : undefined;

it('the bound skill goes out as the card writes it; a UPI-like value elsewhere is still a placeholder', async () => {
  dinaCard();
  const agentId = await bound(DINA_URL, 'eta_query@bus');
  const out = proposeDelegation(world.runtime, {
    releaseSession: SESSION,
    agentId,
    skill: 'eta_query@bus',
    data: { skill: 'eta_query@bus', params: { route_id: '42', pay_to: 'owner@okaxis' } },
  });
  expect(out.ok).toBe(true);
  expect(dataOf(out)).toEqual({ skill: 'eta_query@bus', params: { route_id: '42', pay_to: '[UPI_1]' } });
});

it('a Dina envelope naming a skill the owner did not bind is refused: it is the skill the remote would run', async () => {
  dinaCard();
  const agentId = await bound(DINA_URL, 'eta_query@bus');
  for (const skill of ['price_check@bus', 'eta_query', 'eta_query@bus​']) {
    const out = proposeDelegation(world.runtime, {
      releaseSession: SESSION,
      agentId,
      skill: 'eta_query@bus',
      data: { skill, params: { route_id: '42' } },
    });
    expect([skill, out]).toEqual([skill, { ok: false, reason: 'envelope_skill_not_bound' }]);
  }
});

// Cold audit C4-8: the rule is THIS proposal's binding, not any skill bound on the agent
it('with two skills bound, an envelope naming the other one is refused: a read consent cannot run a write', async () => {
  dinaCard();
  const agentId = await bound(DINA_URL, 'eta_query@bus');
  const d = { store: world.store, nowMs: () => world.clock };
  const [row] = world.store.db.query('SELECT credential_ref FROM a2a_remote_credentials WHERE remote_agent_id = ?', [agentId]) as {
    credential_ref: string;
  }[];
  const credentialRef = row?.credential_ref ?? '';
  for (const other of ['price_check@bus', 'fares']) {
    expect(bindRemoteSkill(d, agentId, { skill: other, actionClass: 'write', credentialRef }).ok).toBe(true);
  }
  const propose = (skill: string, data: Record<string, unknown>) =>
    proposeDelegation(world.runtime, { releaseSession: SESSION, agentId, skill, data });
  for (const other of ['price_check@bus', 'fares']) {
    // Named directly, and through a key that becomes `skill` once cleaned.
    expect([other, propose('eta_query@bus', { skill: other, params: { route_id: '42' } })]).toEqual([
      other,
      { ok: false, reason: 'envelope_skill_not_bound' },
    ]);
    expect([other, propose('eta_query@bus', { ['sk\u200Bill']: other, params: { route_id: '42' } })]).toEqual([
      other,
      { ok: false, reason: 'envelope_skill_not_bound' },
    ]);
    // Control: the same envelope under a proposal for that skill goes out.
    const own = propose(other, { skill: other, params: { route_id: '42' } });
    expect(dataOf(own)).toEqual({ skill: other, params: { route_id: '42' } });
  }
});

it('a key that becomes `skill` only once cleaned cannot name another skill: the envelope is checked as it goes out', async () => {
  dinaCard();
  const agentId = await bound(DINA_URL, 'eta_query@bus');
  // Invisible characters the cleaning removes from keys: a zero-width space, a joiner, a soft hyphen, a bidi mark.
  for (const key of ['sk\u200Bill', 'skil\u200Dl', 's\u00ADkill', '\u200Eskill']) {
    const out = proposeDelegation(world.runtime, {
      releaseSession: SESSION,
      agentId,
      skill: 'eta_query@bus',
      data: { [key]: 'price_check@bus', params: { route_id: '42' } },
    });
    expect([JSON.stringify(key), out]).toEqual([JSON.stringify(key), { ok: false, reason: 'envelope_skill_not_bound' }]);
  }
  // Even naming the bound skill: a key not written `skill` is not the envelope's skill, its value is
  // scrubbed like any other, and what would go out names no bound skill. (The plain `skill` member goes
  // out as written: the first test.)
  const smuggled = proposeDelegation(world.runtime, {
    releaseSession: SESSION,
    agentId,
    skill: 'eta_query@bus',
    data: { ['sk\u200Bill']: 'eta_query@bus', params: { route_id: '42' } },
  });
  expect(smuggled).toEqual({ ok: false, reason: 'envelope_skill_not_bound' });
});

it('only the envelope’s own skill member is spared: the same id deeper in the data is scrubbed like any value', async () => {
  dinaCard();
  const agentId = await bound(DINA_URL, 'eta_query@bus');
  const out = proposeDelegation(world.runtime, {
    releaseSession: SESSION,
    agentId,
    skill: 'eta_query@bus',
    data: { skill: 'eta_query@bus', params: { route_id: '42', skill: 'eta_query@bus' } },
  });
  expect(dataOf(out)).toEqual({ skill: 'eta_query@bus', params: { route_id: '42', skill: '[UPI_1]' } });
});

it('a remote that is not Dina: data is free-form, a skill member is checked against nothing, and only the bound id is spared', async () => {
  const agentId = await bound('https://agent.example/.well-known/agent-card.json', 'summarize');
  const spared = proposeDelegation(world.runtime, { releaseSession: SESSION, agentId, skill: 'summarize', data: { skill: 'summarize', n: 1 } });
  expect(dataOf(spared)).toEqual({ n: 1, skill: 'summarize' });
  const other = proposeDelegation(world.runtime, { releaseSession: SESSION, agentId, skill: 'summarize', data: { skill: 'someone@okaxis' } });
  expect(dataOf(other)).toEqual({ skill: '[UPI_1]' });
});
