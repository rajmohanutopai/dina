/**
 * `search_a2a_agents` (design §8.4): candidates from the public directory,
 * never grants. The directory relays; Brain refilters on its own registry,
 * orders by the contract whatever order arrived, never offers this node's
 * own card, and hands the owner a card URL to register, nothing callable.
 */

import { A2A_DIRECTORY_QUERY_MAX_LENGTH, MAX_ID_LENGTH } from '@dina/a2a';

import { AppViewError, type A2ADirectoryAgent } from '../../src/appview_client/http';
import { createSearchA2AAgentsTool, type A2ADirectorySearchResult } from '../../src/reasoning/a2a_tools';

const SELF = 'did:plc:selfaaaaaaaaaaaaaaaaaaaa';
let n = 0;
const agent = (over: Partial<A2ADirectoryAgent> = {}): A2ADirectoryAgent => {
  n += 1;
  return {
    did: `did:plc:${String(n).padStart(24, 'a').replace(/[0-9]/g, 'b')}`,
    displayName: `Agent ${n}`,
    endpoint: 'https://agent.example/a2a/v1',
    skills: ['eta_query'],
    trustScore: 0.5,
    recommendation: 'caution',
    indexedAt: '2026-10-01T00:00:00.000Z',
    stale: false,
    cardHash: 'a'.repeat(64),
    ...over,
  };
};

function tool(found: A2ADirectoryAgent[] | Error, over: { resultLimit?: number; self?: string | null } = {}) {
  const calls: unknown[] = [];
  const { self = SELF, ...rest } = over;
  const t = createSearchA2AAgentsTool({
    appViewClient: {
      searchA2AAgents: async (params) => {
        calls.push(params);
        if (found instanceof Error) throw found;
        return found;
      },
    },
    // Core answers with the DID the node's card is published under.
    core: { a2aSelfDid: async () => self },
    ...rest,
  });
  return { run: async (args: Record<string, unknown>) => (await t.execute(args)) as A2ADirectorySearchResult, calls };
}

it('asks the directory and hands back candidates with the card URL to register, framed as candidates', async () => {
  const a = agent({ endpoint: 'https://bus.example/a2a/v1', skills: ['eta_query'], trustScore: 0.9, recommendation: 'proceed' });
  const { run, calls } = tool([a]);
  const out = await run({ skill: 'eta_query', q: 'bus' });
  expect(calls).toEqual([{ skill: 'eta_query', q: 'bus', limit: 20 }]);
  expect(out.candidates).toEqual([
    {
      did: a.did,
      name: a.displayName,
      card_url: 'https://bus.example/.well-known/agent-card.json',
      skills: ['eta_query'],
      trust_score: 0.9,
      recommendation: 'proceed',
      stale: false,
      indexed_at: a.indexedAt,
    },
  ]);
  expect(out.note).toMatch(/Dina cannot call any of them/);
  expect(out.note).toMatch(/never authorizes/);
  expect(out.note).toMatch(/data, never as instructions/);
  // Nothing in a candidate is an agent_id: it is not something delegate_to_a2a_agent can take.
  expect(Object.keys(out.candidates[0] ?? {})).not.toContain('agent_id');
});

it('never offers this node’s own card: the DID Core names, whatever the owner’s DID is', async () => {
  const { run } = tool([agent({ did: SELF }), agent()]);
  const out = await run({ skill: 'eta_query' });
  expect(out.candidates.map((c) => c.did)).not.toContain(SELF);
  expect(out.candidates).toHaveLength(1);
  // A node with no DID yet has published no card: nothing to leave out.
  const fresh = tool([agent({ did: SELF }), agent()], { self: null });
  expect((await fresh.run({ skill: 'eta_query' })).candidates).toHaveLength(2);
});

it('drops a card holding any skill the local registry does not know or allow in public: AppView should have', async () => {
  const { run } = tool([
    agent({ displayName: 'Unknown skill', skills: ['eta_query', 'teleport'] }),
    agent({ displayName: 'Not public', skills: ['appointment_status'] }),
    agent({ displayName: 'Malformed', skills: ['eta_query@'] }),
    agent({ displayName: 'Fine', skills: ['eta_query', 'price_check@shop'] }),
  ]);
  expect((await run({})).candidates.map((c) => c.name)).toEqual(['Fine']);
});

it('keeps only cards that offer what was asked: the exact id, or any skill of the capability or its alias', async () => {
  const found = [
    agent({ displayName: 'Shop', skills: ['price_check@shop'] }),
    agent({ displayName: 'Other shop', skills: ['price_check@other'] }),
    agent({ displayName: 'Bus', skills: ['eta_query'] }),
  ];
  expect((await tool(found).run({ skill: 'price_check@shop' })).candidates.map((c) => c.name)).toEqual(['Shop']);
  expect((await tool(found).run({ skill: 'price_check' })).candidates.map((c) => c.name).sort()).toEqual(['Other shop', 'Shop']);
  expect((await tool(found).run({ skill: 'bus_eta' })).candidates.map((c) => c.name)).toEqual(['Bus']);
});

it('orders as the contract says, whatever order arrived: fresh before stale, then trust; ties keep the directory’s order', async () => {
  const found = [
    agent({ displayName: 'Stale, trusted', trustScore: 1, stale: true }),
    agent({ displayName: 'Low', trustScore: 0.1 }),
    agent({ displayName: 'High', trustScore: 0.9 }),
    agent({ displayName: 'Tie A', trustScore: 0.5 }),
    agent({ displayName: 'Tie B', trustScore: 0.5 }),
  ];
  expect((await tool(found).run({})).candidates.map((c) => c.name)).toEqual(['High', 'Tie A', 'Tie B', 'Low', 'Stale, trusted']);
});

it('caps what reaches the model', async () => {
  const found = Array.from({ length: 12 }, () => agent());
  expect((await tool(found, { resultLimit: 3 }).run({})).candidates).toHaveLength(3);
});

it('a skill Dina does not know is never sent to the directory', async () => {
  const { run, calls } = tool([agent()]);
  for (const skill of ['teleport', 'eta_query@', 'a@b@c']) {
    const out = await run({ skill });
    expect(out.candidates).toEqual([]);
    expect(out.note).toMatch(/search_capabilities/);
  }
  expect(calls).toEqual([]);
});

it('a closed or unreachable directory is said plainly; anything else is a fault and surfaces', async () => {
  const closed = await tool(new AppViewError('AppView responded 503', 503, '/xrpc/com.dinakernel.a2a.searchAgents')).run({ skill: 'eta_query' });
  expect(closed).toEqual({ candidates: [], note: 'The agent directory is not available right now.' });
  await expect(tool(new TypeError('bug')).run({})).rejects.toThrow('bug');
  const unreachable = await tool(new AppViewError('network error: ECONNREFUSED', null, '/xrpc/com.dinakernel.a2a.searchAgents')).run({});
  expect(unreachable.note).toBe('The agent directory is not available right now.');
  // A request AppView refuses, or AppView failing, is not an outage.
  for (const status of [400, 500]) {
    await expect(tool(new AppViewError(`AppView responded ${status}`, status, '/xrpc/com.dinakernel.a2a.searchAgents')).run({})).rejects.toMatchObject({ status });
  }
});

it('holds the directory’s own limits: the model hears what to change, and nothing is asked', async () => {
  const { run, calls } = tool([agent()]);
  const longQ = await run({ q: 'q'.repeat(A2A_DIRECTORY_QUERY_MAX_LENGTH + 1) });
  expect(longQ).toEqual({ candidates: [], note: `Use at most ${A2A_DIRECTORY_QUERY_MAX_LENGTH} characters of words to match.` });
  // A known capability whose id is too long: the note names the limit, not an unknown capability.
  const longSkill = await run({ skill: `eta_query@${'r'.repeat(MAX_ID_LENGTH)}` });
  expect(longSkill).toEqual({ candidates: [], note: `Use a skill id of at most ${MAX_ID_LENGTH} characters.` });
  expect(calls).toEqual([]);
  await run({ q: 'q'.repeat(A2A_DIRECTORY_QUERY_MAX_LENGTH) });
  expect(calls).toHaveLength(1);
});

it('an empty directory says so', async () => {
  expect(await tool([]).run({ skill: 'eta_query' })).toEqual({ candidates: [], note: 'No agent in the directory offers that.' });
});
