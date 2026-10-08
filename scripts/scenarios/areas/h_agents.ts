/**
 * H. Agents and approvals (docs/REAL_LIFE_SCENARIOS.md). One agent is paired
 * to Alonso through Core's real ceremony and asks through `/api/v1/ask` as
 * `dina ask` does; the owner decides through the workflow routes.
 */

import { Agent } from '../client';

import type { Ctx, Scenario } from '../scenario';

let agent: Agent | null = null;

async function theAgent(c: Ctx): Promise<Agent> {
  if (agent === null) agent = await Agent.pair(c.alonso, 'scenario-agent');
  return agent;
}

/** Plant the facts the agent asks about (once per run is enough; harmless to repeat). */
async function plant(c: Ctx): Promise<void> {
  // An everyday fact for General. (An allergy is medical: the health vault's
  // description lists allergies, so it rightly goes to health.)
  await c.say(c.alonso, "/remember Juno's dog is called Biscuit");
  await c.say(c.alonso, '/remember my LDL cholesterol was 3.9 at the last blood test');
}

function approvalIdOf(body: any): string {
  return String(body?.approval_id ?? body?.approvalId ?? body?.task_id ?? '');
}

export const areaH: Scenario[] = [
  {
    id: 'H1',
    title: 'Pairing an agent',
    async run(c) {
      const a = await theAgent(c);
      // Pairing completed (Agent.pair throws otherwise); a signed call proves Core knows the key.
      const probe = await a.call('POST', '/v1/workflow/tasks/claim', { body: {} });
      c.check('Core accepts the agent\'s signed calls', probe.status === 204 || probe.status === 200, String(probe.status));
      const s = await a.startSession(`h1-${c.tag}`);
      c.check('the agent can open a session', s.startsWith('sess-'), s);
    },
  },
  {
    id: 'H2',
    title: 'An agent reads the general vault',
    async run(c) {
      await plant(c);
      const a = await theAgent(c);
      const s = await a.startSession(`h2-${c.tag}`);
      const before = (await c.alonso.tasks('approval', 'pending_approval')).length;
      const r = await a.ask("What is Juno's dog called?", s);
      c.check('answered without approval', r.status === 'complete', `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      c.check('says Biscuit', /biscuit/i.test(JSON.stringify(r.body)), JSON.stringify(r.body).slice(0, 200));
      c.check('no approval raised', (await c.alonso.tasks('approval', 'pending_approval')).length === before);
    },
  },
  {
    id: 'H3',
    title: 'An agent asks about health: the owner approves once',
    async run(c) {
      await plant(c);
      const a = await theAgent(c);
      const s = await a.startSession(`h3-${c.tag}`);
      const r = await a.ask('What was my LDL cholesterol at the last blood test?', s, 60_000);
      c.check('waits for the owner', r.status === 'pending_approval', `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      c.check('nothing about LDL disclosed yet', !/3\.9/.test(JSON.stringify(r.body)));
      const pending = await c.alonso.tasks('approval', 'pending_approval');
      const id = approvalIdOf(r.body) || pending[pending.length - 1]?.id || '';
      c.check('an approval task exists', id !== '' && pending.some((t) => t.id === id), id);
      const card = JSON.stringify(pending.find((t) => t.id === id) ?? {});
      c.check('the card does not carry the vault content', !/3\.9/.test(card));
      // "Approve Once" lets through the ask the card was raised for: it resumes.
      await c.alonso.core('POST', `/v1/workflow/tasks/${id}/approve`, { body: { scope: 'single' } });
      const after = await a.waitAsk(String(r.body?.request_id ?? ''), s, 120_000);
      c.check('answered after approval', after.status === 'complete' && /3\.9/.test(JSON.stringify(after.body)), `${after.status} ${JSON.stringify(after.body).slice(0, 200)}`);
      // dina_details.md, agent safety scenario 1: "Approve Once — single-use grant. Next ask requires fresh approval."
      const third = await a.ask('And my LDL figure again, please?', s, 60_000);
      c.check('approve once is single-use: the next ask waits again', third.status === 'pending_approval', third.status);
    },
  },
  {
    id: 'H4',
    title: 'A session grant, and a new session asks again',
    async run(c) {
      await plant(c);
      const a = await theAgent(c);
      const s = await a.startSession(`h4a-${c.tag}`);
      const first = await a.ask('What was my LDL cholesterol?', s, 60_000);
      const id = approvalIdOf(first.body) || (await c.alonso.tasks('approval', 'pending_approval')).pop()?.id || '';
      await c.alonso.core('POST', `/v1/workflow/tasks/${id}/approve`, { body: { scope: 'session' } });
      const again = await a.ask('Remind me of my LDL figure.', s, 120_000);
      c.check('same session: no second approval', again.status === 'complete', `${again.status}`);
      const s2 = await a.startSession(`h4b-${c.tag}`);
      const fresh = await a.ask('What was my LDL cholesterol?', s2, 60_000);
      c.check('new session: asks again', fresh.status === 'pending_approval', fresh.status);
    },
  },
  {
    id: 'H5',
    title: 'The owner denies',
    async run(c) {
      await plant(c);
      const a = await theAgent(c);
      const s = await a.startSession(`h5-${c.tag}`);
      const r = await a.ask('What was my LDL cholesterol at the last blood test?', s, 60_000);
      const id = approvalIdOf(r.body) || (await c.alonso.tasks('approval', 'pending_approval')).pop()?.id || '';
      await c.alonso.core('POST', `/v1/workflow/tasks/${id}/cancel`, { body: {} });
      const after = await a.ask('What was my LDL cholesterol at the last blood test?', s, 60_000);
      c.check('no health data after a deny', !/3\.9/.test(JSON.stringify(after.body)), `${after.status} ${JSON.stringify(after.body).slice(0, 200)}`);
    },
  },
  {
    id: 'H6',
    title: 'The risk ladder',
    async run(c) {
      const a = await theAgent(c);
      const session = await a.startSession(`h6-${c.tag}`);
      const v = async (action: string, target: string) =>
        (await a.call('POST', '/v1/agent/validate', { body: { type: 'agent_intent', action, target, agent_did: a.did, session, session_id: session } })).body ?? {};
      const search = await v('search', 'weather in Lisbon');
      const email = await v('send_email', 'to the landlord about the boiler');
      const money = await v('transfer_money', '500 to Bob');
      const read = await v('read_vault', 'health');
      c.check('search: allowed', search.action === 'auto_approve', JSON.stringify(search).slice(0, 120));
      c.check('send_email: owner reviews', email.action === 'flag_for_review', JSON.stringify(email).slice(0, 120));
      c.check('transfer_money: owner reviews', money.action === 'flag_for_review', JSON.stringify(money).slice(0, 120));
      c.check('read_vault: denied', read.action === 'deny', JSON.stringify(read).slice(0, 120));
    },
  },
  {
    id: 'H9',
    title: 'dina_details 13.4.1 / scenario 8: the owner decides a risky action',
    async run(c) {
      const a = await theAgent(c);
      const session = await a.startSession(`h9-${c.tag}`);
      const v = async (action: string, target: string) =>
        (await a.call('POST', '/v1/agent/validate', { body: { type: 'agent_intent', action, target, agent_did: a.did, session, session_id: session } })).body ?? {};
      const status = async (id: string) =>
        (await a.call('GET', `/v1/intent/proposals/${encodeURIComponent(id)}/status`, { query: { session_id: session } })).body ?? {};
      const email = await v('send_email', 'draft resignation letter to HR');
      const money = await v('transfer_money', '500 to vendor account');
      const eid = String(email.proposal_id ?? '');
      const mid = String(money.proposal_id ?? '');
      c.check('send_email waits for the owner', email.requires_approval === true && eid !== '', JSON.stringify(email).slice(0, 160));
      c.check('transfer_money waits for the owner', money.requires_approval === true && mid !== '', JSON.stringify(money).slice(0, 160));
      await c.alonso.core('POST', `/v1/workflow/tasks/${eid}/approve`, { body: {} });
      await c.alonso.core('POST', `/v1/workflow/tasks/${mid}/cancel`, { body: {} });
      const es = await status(eid);
      const ms = await status(mid);
      c.check('the agent sees send_email approved', /approved/i.test(JSON.stringify(es)), JSON.stringify(es).slice(0, 160));
      c.check('the agent sees transfer_money denied', /denied|cancel|rejected/i.test(JSON.stringify(ms)), JSON.stringify(ms).slice(0, 160));
    },
  },
  {
    id: 'H7',
    title: 'An approval nobody answers',
    mark: 'harness',
    reason: 'approval expiry is about an hour; the run would wait that long',
    async run() {},
  },
  {
    id: 'H8',
    title: 'The owner delegates a task',
    mark: 'phone',
    reason: '/task → delegate_to_agent is wired only in the phone app',
    async run() {},
  },
];
