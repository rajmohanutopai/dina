/**
 * NEGOTIATION_PLAN §3 rule 1 — a supplier's price card can carry its hard
 * floor. Brain may learn a card exists; the numbers are the owner's alone,
 * on every path that returns a task: one task, the list, the events feed,
 * `/running`, and a create that dedups onto the card.
 */

import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerWorkflowRoutes } from '../../../src/server/routes/workflow';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../../src/workflow/service';

let service: WorkflowService;
let router: CoreRouter;

const CARD = {
  type: 'negotiation_price_approval',
  quote_id: 'q:1',
  buyer_did: 'did:plc:buyer',
  currency: 'INR',
  lines: [
    {
      line_id: 'l1',
      asked_minor_units: '21000',
      signed_minor_units: '22000',
      quoted_minor_units: '24000',
    },
  ],
};

function read(
  path: string,
  callerType?: string,
  query: Record<string, string> = {},
  params: Record<string, string> = {},
): CoreRequest {
  return {
    method: 'GET',
    path,
    query,
    headers: {},
    body: undefined,
    rawBody: new Uint8Array(),
    params,
    trustedInProcess: true,
    ...(callerType !== undefined ? { callerType, callerDID: 'did:key:caller' } : {}),
  } as unknown as CoreRequest;
}

beforeEach(() => {
  service = new WorkflowService({ repository: new InMemoryWorkflowRepository() });
  setWorkflowService(service);
  router = new CoreRouter();
  registerWorkflowRoutes(router);
  service.create({
    id: 'negotiation-price-1',
    kind: 'approval',
    description: 'A buyer asks for a lower price. Offer it?',
    payload: JSON.stringify(CARD),
    origin: 'd2d',
    idempotencyKey: 'negotiation_price:abc',
    initialState: 'pending_approval' as never,
  });
});
afterEach(() => setWorkflowService(null));

const NUMBERS = /21000|22000|24000/;

describe('a price card read by Brain carries no numbers', () => {
  it('on a single read and on the list; the owner reads it whole', async () => {
    const brainOne = await router.handle(
      read('/v1/workflow/tasks/negotiation-price-1', 'brain', {}, { id: 'negotiation-price-1' }),
    );
    expect(JSON.stringify(brainOne.body)).not.toMatch(NUMBERS);
    expect(JSON.stringify(brainOne.body)).toContain('owner_only');
    const brainList = await router.handle(
      read('/v1/workflow/tasks', 'brain', { kind: 'approval', state: 'pending_approval' }),
    );
    expect(JSON.stringify(brainList.body)).not.toMatch(NUMBERS);
    const owner = await router.handle(
      read('/v1/workflow/tasks/negotiation-price-1', undefined, {}, { id: 'negotiation-price-1' }),
    );
    expect(JSON.stringify(owner.body)).toMatch(NUMBERS);
  });

  it('on the events feed after the owner approves', async () => {
    service.approve('negotiation-price-1');
    const brainEvents = await router.handle(read('/v1/workflow/events', 'brain'));
    const body = JSON.stringify(brainEvents.body);
    expect(body).toContain('negotiation-price-1');
    expect(body).not.toMatch(NUMBERS);
  });

  it('on /running and on a create that dedups onto the card', async () => {
    const running = await router.handle({
      ...read(
        '/v1/workflow/tasks/negotiation-price-1/running',
        'brain',
        {},
        {
          id: 'negotiation-price-1',
        },
      ),
      method: 'POST',
    } as CoreRequest);
    expect(running.status).toBe(200);
    expect(JSON.stringify(running.body)).not.toMatch(NUMBERS);
    expect(JSON.stringify(running.body)).toContain('owner_only');
    const deduped = await router.handle({
      ...read('/v1/workflow/tasks', 'brain'),
      method: 'POST',
      body: {
        id: 'brain-task-1',
        kind: 'approval',
        description: 'anything',
        payload: '{}',
        idempotency_key: 'negotiation_price:abc',
      },
    } as CoreRequest);
    expect(deduped.body).toMatchObject({ deduped: true });
    expect(JSON.stringify(deduped.body)).not.toMatch(NUMBERS);
  });
});
