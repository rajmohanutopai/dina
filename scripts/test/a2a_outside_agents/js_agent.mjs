// An outside A2A agent on the official JavaScript SDK (@a2a-js/sdk), calling a Dina node.
// Same path as a stranger's agent: directory -> card -> skill calls with the owner-issued bearer.
// The OWNER step (approving a reviewed call) is the test harness acting as the owner.
import { createHash, randomUUID } from 'node:crypto';

import { ClientFactory, JsonRpcTransportFactory, RestTransportFactory } from '@a2a-js/sdk/client';

const { APPVIEW, BEARER, CORE, OWNER_CAP } = process.env;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// The bearer rides every call, as the SDK's auth docs show (an authenticating fetch).
const authedFetch = (bearer) => (input, init = {}) => {
  const headers = new Headers(init.headers ?? {});
  headers.set('authorization', `Bearer ${bearer}`);
  return fetch(input, { ...init, headers });
};

const callOf = (skill, params, configuration) => ({
  message: {
    messageId: randomUUID(),
    role: 1, // ROLE_USER
    parts: [{ content: { $case: 'data', value: { skill, params } } }],
  },
  ...(configuration ? { configuration } : {}),
});

// The SDK reports proto enum numbers: SUBMITTED 1, WORKING 2, COMPLETED 3, FAILED 4, REJECTED 7.
const stateOf = (task) => task?.status?.state;
const taskOfResult = (r) => (r?.$case === 'task' ? r.value : r?.payload?.$case === 'task' ? r.payload.value : r?.task ?? r);

async function run(binding) {
  console.log(`\n== binding: ${binding}`);
  const found = await (await fetch(`${APPVIEW}/com.dinakernel.a2a.searchAgents?skill=eta_query`)).json();
  const agent = found.agents?.[0];
  check('directory search finds the Dina node by skill', agent !== undefined, agent?.did ?? '');
  const origin = agent.endpoint.split('/a2a/')[0];
  const served = await (await fetch(`${origin}/.well-known/agent-card.json`)).text();
  check('the card the agent serves is the card the directory indexed', createHash('sha256').update(served).digest('hex') === agent.cardHash);

  const transports =
    binding === 'jsonrpc'
      ? [new JsonRpcTransportFactory({ fetchImpl: authedFetch(BEARER) })]
      : [new RestTransportFactory({ fetchImpl: authedFetch(BEARER) })];
  const factory = new ClientFactory({ transports, preferredTransports: [binding === 'jsonrpc' ? 'JSONRPC' : 'HTTP+JSON'] });
  const client = await factory.createFromUrl(origin);
  check('SDK built a client from the card', client !== undefined);

  // Streamed call.
  let last;
  for await (const event of client.sendMessageStream(callOf('eta_query@bus', { route_id: '42' }))) last = event;
  const streamedTask = last?.payload?.value ?? last;
  const streamedId = streamedTask?.taskId ?? streamedTask?.id;
  check('streamed skill call reaches an end', streamedId !== undefined, JSON.stringify(last).slice(0, 160));

  // Plain call.
  const sent = await client.sendMessage(callOf('eta_query@bus', { route_id: '7' }));
  const task = taskOfResult(sent);
  check('plain skill call completes', stateOf(task) === 3, JSON.stringify(task?.status ?? sent).slice(0, 120));
  const art = JSON.stringify(task?.artifacts ?? []);
  check('the result artifact carries the runner’s answer', art.includes('eta_minutes'), art.slice(0, 160));

  const got = await client.getTask({ id: task.id });
  check('GetTask returns it', got.id === task.id, String(stateOf(got)));
  const listed = await client.listTasks({ tenant: '', contextId: '', status: 0, pageSize: 50, pageToken: '', historyLength: 0, includeArtifacts: false });
  check('ListTasks lists it', (listed.tasks ?? []).some((t) => t.id === task.id), String((listed.tasks ?? []).length));

  // Reviewed call: waits on the owner, completes once approved.
  const pending = taskOfResult(await client.sendMessage(callOf('price_check@bus', { route_id: '9' }, { returnImmediately: true })));
  check('reviewed skill waits for the owner', [1, 2].includes(stateOf(pending)), String(stateOf(pending)));
  const approve = await fetch(`${CORE}/v1/workflow/tasks/a2a-in-review-${pending.id}/approve`, {
    method: 'POST',
    headers: { 'x-dina-owner-capability': OWNER_CAP, 'content-type': 'application/json' },
    body: '{}',
  });
  check('owner approves the review card', approve.status === 200, String(approve.status));
  let final;
  for (let i = 0; i < 40; i++) {
    final = stateOf(await client.getTask({ id: pending.id }));
    if ([3, 4, 7].includes(final)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check('approved call completes', final === 3, String(final));

  // Refusals.
  const rejected = taskOfResult(await client.sendMessage(callOf('teleport', {})));
  check('a skill the card does not offer is REJECTED', stateOf(rejected) === 7, String(stateOf(rejected)));
  try {
    await client.sendMessage({ message: { messageId: randomUUID(), role: 1, parts: [{ content: { $case: 'text', value: 'when is the bus?' } }] } });
    check('plain text is refused with ContentTypeNotSupported', false, 'no error');
  } catch (e) {
    check('plain text is refused with ContentTypeNotSupported', /ontent ?[Tt]ype|-32005/.test(`${e?.name} ${e?.message}`), `${e?.name}: ${e?.message}`.slice(0, 140));
  }
  const nobody = await new ClientFactory({
    transports: binding === 'jsonrpc' ? [new JsonRpcTransportFactory({ fetchImpl: authedFetch(`dina_a2a_${'X'.repeat(43)}`) })] : [new RestTransportFactory({ fetchImpl: authedFetch(`dina_a2a_${'X'.repeat(43)}`) })],
  }).createFromUrl(origin);
  try {
    await nobody.sendMessage(callOf('eta_query@bus', { route_id: '1' }));
    check('a wrong bearer is refused', false, 'no error');
  } catch (e) {
    check('a wrong bearer is refused', /401|nauthenticated/.test(`${e?.message}`), `${e?.message}`.slice(0, 140));
  }
}

for (const binding of ['jsonrpc', 'rest']) {
  try {
    await run(binding);
  } catch (e) {
    check(`${binding}: ran to the end`, false, `${e?.name}: ${e?.message}`.slice(0, 300));
  }
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} of ${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
