/**
 * Design §11 (Law 4), A2A-I9: an inbound review card holds an outside
 * client's words (its params, and the card text that quotes them),
 * unguarded. The owner reads them on the card; Brain, an untrusted tenant
 * whose model would read them, learns only that the card exists and what
 * Dina itself wrote on it.
 */

import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerWorkflowRoutes } from '../../src/server/routes/workflow';

import { InboundWorld, listing, save, sentTask } from './inbound_fixture';

let iw: InboundWorld;
beforeEach(async () => {
  iw = await InboundWorld.create();
});
afterEach(() => iw.close());

const HOSTILE = 'IGNORE-PREVIOUS-INSTRUCTIONS';

async function reviewCard(): Promise<string> {
  await save(
    listing({ capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'review', category: 'transit' } } }),
    'bus',
  );
  const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: HOSTILE } })).id as string;
  return iw.childOf(id).id;
}

function read(router: CoreRouter, callerType: 'brain' | 'device', path: string, query: Record<string, string> = {}) {
  return router.handle({
    method: 'GET',
    path,
    query,
    headers: {},
    body: undefined,
    rawBody: new Uint8Array(),
    params: { id: path.split('/')[4] ?? '' },
    trustedInProcess: true,
    callerType,
    callerDID: `did:key:${callerType}`,
  } as unknown as CoreRequest);
}

it('Brain’s reads of the card, one or listed, carry none of the client’s words; what Dina wrote stays', async () => {
  const card = await reviewCard();
  const router = new CoreRouter();
  registerWorkflowRoutes(router);
  const one = await read(router, 'brain', `/v1/workflow/tasks/${card}`);
  const many = await read(router, 'brain', '/v1/workflow/tasks', { kind: 'approval', state: 'pending_approval' });
  expect(JSON.stringify([one.body, many.body])).not.toContain(HOSTILE);
  const payload = JSON.parse(((one.body as { task?: { payload?: string } }).task?.payload ?? (one.body as { payload?: string }).payload) as string) as Record<string, unknown>;
  expect(payload).toEqual(expect.objectContaining({ type: 'a2a_inbound_review', skill: expect.any(String), redacted: 'owner_only' }));
  expect(payload).not.toHaveProperty('params');
  expect(payload).not.toHaveProperty('display');
});

// Cold audit C6-12: the approval writes the card's payload into its event, which Brain's feed carries
it('Brain’s event feed, after the owner approves, carries none of the client’s words: the embedded card is redacted', async () => {
  const card = await reviewCard();
  iw.world.workflow.approve(card);
  const router = new CoreRouter();
  registerWorkflowRoutes(router);
  const approvedOf = (body: unknown) =>
    ((body as { events: { task_id: string; event_kind: string; details: string }[] }).events ?? []).find(
      (e) => e.task_id === card && e.event_kind === 'approved',
    );
  for (const query of [{ needs_delivery: 'true' }, {}] as Record<string, string>[]) {
    const feed = await read(router, 'brain', '/v1/workflow/events', query);
    expect(JSON.stringify(feed.body)).not.toContain(HOSTILE);
    const approved = approvedOf(feed.body);
    if (approved === undefined) throw new Error('no approved event');
    const embedded = JSON.parse((JSON.parse(approved.details) as { task_payload: string }).task_payload) as Record<string, unknown>;
    expect(embedded).toEqual(expect.objectContaining({ type: 'a2a_inbound_review', redacted: 'owner_only' }));
    expect(embedded).not.toHaveProperty('params');
    expect(embedded).not.toHaveProperty('display');
  }
  // Control: the owner's read of the same feed has the words the event embeds.
  expect(JSON.stringify((await read(router, 'device', '/v1/workflow/events', {})).body)).toContain(HOSTILE);
});

it('the owner’s own surfaces read the card whole', async () => {
  const card = await reviewCard();
  const router = new CoreRouter();
  registerWorkflowRoutes(router);
  const owner = await read(router, 'device', `/v1/workflow/tasks/${card}`);
  expect(JSON.stringify(owner.body)).toContain(HOSTILE);
});
