/**
 * COMMITMENT_KERNEL §6 step 3, §15 step 7 — the option family's cards are
 * Core's to mint and the owner's to answer.
 *
 *   W-01  Brain may not create a clearance card, nor approve one Core made;
 *         the link is not cleared;
 *   W-02  the owner's yes needs a person present (it lets a buyer's yes bind
 *         the run with no further card).
 */

import {
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  OWNER_IN_PROCESS_PRINCIPAL,
  proveOwnerPresence,
} from '../../../src/commerce/owner_presence';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import {
  CORE_MINTED_PAYLOAD_TYPES,
  PRESENCE_GATED_PAYLOAD_TYPES,
  registerWorkflowRoutes,
} from '../../../src/server/routes/workflow';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../../src/workflow/service';

let service: WorkflowService;
let router: CoreRouter;
let cleared: string[];

const CARD = { type: 'option_clear', request_id: 'req-0011223344556677' };

function post(
  path: string,
  body: unknown,
  callerType: string | undefined,
  params: Record<string, string> = {},
): CoreRequest {
  return {
    method: 'POST',
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params,
    trustedInProcess: true,
    ...(callerType !== undefined ? { callerType, callerDID: 'did:key:caller' } : {}),
  } as unknown as CoreRequest;
}

beforeEach(() => {
  cleared = [];
  service = new WorkflowService({
    repository: new InMemoryWorkflowRepository(),
    approvalDecisionHandler: ({ task, decision }) => {
      if (decision === 'approved') cleared.push(task.id);
    },
  });
  setWorkflowService(service);
  router = new CoreRouter();
  registerWorkflowRoutes(router);
  service.create({
    id: 'option-clear-1',
    kind: 'approval',
    description: 'A shipper can run one of your orders. Offer it?',
    payload: JSON.stringify(CARD),
    origin: 'system',
    idempotencyKey: 'option-clear-1',
    initialState: 'pending_approval' as never,
  });
});
afterEach(() => {
  setWorkflowService(null);
  installOwnerPresenceVerifier(null);
  clearOwnerPresence();
});

describe("the option family's cards", () => {
  it('W-01: Brain may neither mint nor decide a clearance', async () => {
    for (const type of ['option_clear', 'option_link', 'option_disclosure', 'option_fallback'])
      expect(CORE_MINTED_PAYLOAD_TYPES.has(type)).toBe(true);
    const minted = await router.handle(
      post(
        '/v1/workflow/tasks',
        { id: 'forged', kind: 'approval', description: 'x', payload: JSON.stringify(CARD) },
        'brain',
      ),
    );
    expect([400, 403]).toContain(minted.status);
    const approved = await router.handle(
      post('/v1/workflow/tasks/option-clear-1/approve', {}, 'brain', { id: 'option-clear-1' }),
    );
    expect(approved.status).toBe(403);
    expect(cleared).toEqual([]);
    expect(service.store().getById('option-clear-1')?.status).toBe('pending_approval');
  });

  it("W-02: the owner's yes needs a person present", async () => {
    expect(PRESENCE_GATED_PAYLOAD_TYPES.has('option_clear')).toBe(true);
    installOwnerPresenceVerifier(async (p) => p === 'correct horse');
    const unproven = await router.handle(
      post('/v1/workflow/tasks/option-clear-1/approve', {}, undefined, { id: 'option-clear-1' }),
    );
    expect(unproven.status).toBe(403);
    expect(cleared).toEqual([]);
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    const proven = await router.handle(
      post('/v1/workflow/tasks/option-clear-1/approve', {}, undefined, { id: 'option-clear-1' }),
    );
    expect(proven.status).toBe(200);
    expect(cleared).toEqual(['option-clear-1']);
  });
});
