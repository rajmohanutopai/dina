/**
 * Lane 2's repair sweep, the workflow requeue hook and the public card's
 * name (notes M2, M3): what the sweep reports when one call fails, that a
 * swapped workflow service leaves one requeue observer, and which listing
 * names the card.
 */

import {
  a2aWorkflowHooks,
  buildInboundCard,
  claimDeliveries,
  ingressSendMessage,
  sweepA2AInbound,
  type A2ACardConfig,
} from '../../src/a2a';
import { deriveP256SigningKey } from '../../src/crypto';
import { listServiceConfigs } from '../../src/service/service_config';
import { WorkflowService } from '../../src/workflow/service';

import { InboundWorld, listing, save, sentTask } from './inbound_fixture';

import type { AgentCard } from '@dina/a2a';

let iw: InboundWorld;
beforeEach(async () => {
  iw = await InboundWorld.create();
});
afterEach(() => {
  jest.restoreAllMocks();
  iw.close();
});

const reviewListing = () =>
  listing({
    capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'review', category: 'transit' } },
  });

describe('the repair sweep reports a failing call by id and error class only (notes M2 review)', () => {
  // Plan C238
  it('one call that throws is counted and named by its id and error class, never the message; the rest are repaired, and it is retried next sweep', async () => {
    // Approved review cards whose decision handler never ran: the sweep mints their execution.
    iw.world.useService(false, { responseEgressGate: a2aWorkflowHooks(() => iw.world.runtime).responseEgressGate });
    const rt = { ...iw.rt, a2a: iw.world.runtime };
    await save(reviewListing(), 'bus');
    // The fixture's runtime still points at the first service; send through the new one.
    const call = (route: string) =>
      sentTask(ingressSendMessage(rt, iw.request('SendMessage', iw.message({ skill: 'eta_query', params: { route_id: route } })))).id as string;
    const bad = call('SECRET-PARAM-VALUE');
    const good = call('2');
    iw.world.workflow.approve(iw.childOf(bad).id);
    iw.world.workflow.approve(iw.childOf(good).id);
    const badCard = iw.childOf(bad).id;
    const store = iw.world.store;
    const real = store.getChild.bind(store);
    const spy = jest.spyOn(store, 'getChild').mockImplementation((id: string) => {
      if (id === badCard) throw new TypeError(`could not read SECRET-PARAM-VALUE for ${id}`);
      return real(id);
    });
    const reported: { operation_id: string; error: string }[] = [];
    const counts = sweepA2AInbound(rt, (entry) => reported.push(entry));
    expect(counts).toEqual(expect.objectContaining({ minted: 1, failed: 1 }));
    expect(reported).toEqual([{ operation_id: bad, error: 'TypeError' }]);
    expect(JSON.stringify(reported)).not.toContain('SECRET');
    expect(iw.opOf(good).internal_id).toBe(`a2a-in-exec-${good}-g0`);
    // The fault clears: the next sweep repairs the one it skipped.
    spy.mockRestore();
    expect(sweepA2AInbound(rt).minted).toBe(1);
    expect(iw.opOf(bad).internal_id).toBe(`a2a-in-exec-${bad}-g0`);
  });
});

describe('one requeue observer per repository (notes M3: "One slot, not a list")', () => {
  // Extra X-19
  it('after the early workflow service is swapped for the full plane over one repository, a lapsed lease is one event, told to the new observer only', () => {
    const early = jest.fn();
    // The server's early service, then the full plane over the same repository.
    new WorkflowService({ repository: iw.world.repo, nowMsFn: () => iw.world.clock, onTaskRequeued: early });
    const hooks = a2aWorkflowHooks(() => iw.world.runtime);
    const counted = jest.fn(hooks.onTaskRequeued);
    iw.world.useService(true, {
      responseEgressGate: hooks.responseEgressGate,
      onTaskRequeued: counted,
      responseBridgeSender: async () => undefined,
    });
    const rt = { ...iw.rt, a2a: iw.world.runtime };
    const id = sentTask(ingressSendMessage(rt, iw.request('SendMessage', iw.message({ skill: 'eta_query', params: { route_id: '1' } })))).id as string;
    iw.claimChild(id, 1_000);
    iw.world.clock += 5_000;
    expect(iw.world.repo.expireLeasedTasks(iw.world.clock)).toHaveLength(1);
    expect(early).not.toHaveBeenCalled();
    expect(counted).toHaveBeenCalledTimes(1);
    const story = iw.world.store
      .outboxOf(iw.opOf(id).id)
      .filter((r) => r.target_kind === 'sse')
      .map((r) => (JSON.parse(r.event_json) as { statusUpdate?: { status: { state: string } } }).statusUpdate?.status.state);
    expect(story).toEqual(['TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED']);
    // And the claim hands the gateway each once.
    const claimed = claimDeliveries(rt, { claimant: 'did:key:z6MkGateway', limit: 100, webhookLimit: 0 });
    expect(claimed.items.filter((i) => i.task_id === id)).toHaveLength(2);
  });
});

describe('the public card’s name (notes M2: "the self listing when it is live and public, else the first such listing")', () => {
  const CONFIG: A2ACardConfig = {
    key: { privateKey: deriveP256SigningKey(new Uint8Array(32).fill(9), 0).privateKey, generation: 0 },
    publicOrigin: 'https://dina.example.org',
  };
  const card = async (): Promise<AgentCard> => {
    const built = await buildInboundCard(iw.world.store, { nodeDid: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz', config: CONFIG });
    if (!built.ok) throw new Error(built.reason);
    return built.card;
  };

  // Extra X-21
  it('a paused self listing gives the name to the first other live public listing in rkey order, passing over a known_only one, and the version moves with it', async () => {
    await save(listing({ name: 'Corner Shop', description: 'The self listing.' }), 'self');
    // A live known_only listing sorts first; a second public listing sorts last.
    await save(listing({ name: 'Hidden', discoverability: 'known_only', isDiscoverable: false }), 'aaa-hidden');
    await save(listing({ name: 'Zoo Line' }), 'zoo');
    expect(listServiceConfigs().map((l) => l.rkey)).toEqual(['aaa-hidden', 'bus', 'self', 'zoo']);
    const first = await card();
    expect([first.name, first.description]).toEqual(['Corner Shop', 'The self listing.']);
    await save(listing({ name: 'Corner Shop', description: 'The self listing.', status: 'paused' }), 'self');
    const second = await card();
    expect(second.name).toBe('Bus 42');
    expect(second.version).not.toBe(first.version);
    // With the first public listing paused too, the name moves to the next public one, never to the hidden one.
    await save(listing({ status: 'paused' }), 'bus');
    expect((await card()).name).toBe('Zoo Line');
    // Live again: the name comes back to self.
    await save(listing({}), 'bus');
    await save(listing({ name: 'Corner Shop', description: 'The self listing.' }), 'self');
    expect((await card()).name).toBe('Corner Shop');
  });
});
