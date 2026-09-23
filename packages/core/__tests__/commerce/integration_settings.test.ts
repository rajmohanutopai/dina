/**
 * Settings proposals from an integration (JIFFY_MERCHANT_INTEGRATION_PLAN
 * §3.2, B3), driven through the REAL workflow service: a proposal is an
 * owner approval card; the owner's yes applies through the settings store's
 * own validation and re-checks the revision; a no or a lapse applies nothing;
 * the same command returns the recorded outcome and different content is a
 * conflict; Brain can neither mint nor decide one.
 */

import { settingsRevision } from '../../src/commerce/integration';
import {
  INTEGRATION_SETTINGS_PROPOSAL_TYPE,
  SUPPLIER_PROPOSABLE_CONTROLS,
  integrationWorkflowHooks,
  listSettingsProposals,
  makeSettingsProposalDecisionHandler,
  parseSettingsProposalPayload,
  proposalIdempotencyKey,
  proposalTaskId,
  proposeSupplierSettings,
  unsupportedControls,
} from '../../src/commerce/integration_settings';
import { installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';
import { InMemoryCommerceSettingsRepository } from '../../src/commerce/settings_store';
import { coordinationWorkflowHooks } from '../../src/coordination/disclosure_egress';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerServiceRespondRoutes } from '../../src/server/routes/service_respond';
import { registerWorkflowRoutes } from '../../src/server/routes/workflow';
import { WorkflowTaskKind, WorkflowTaskState } from '../../src/workflow/domain';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import {
  WorkflowService,
  composeWorkflowHooks,
  setWorkflowService,
} from '../../src/workflow/service';

import type { SupplierSettings } from '../../src/commerce/commerce_settings';

const SUPPLIER = 'did:plc:supplier5678';
const DEVICE = 'did:key:zJiffyIntegration';
const T0 = 1_800_000_000_000;

function baseSettings(over: Partial<SupplierSettings> = {}): SupplierSettings {
  return {
    actingBusinessDid: SUPPLIER,
    catalogSource: { kind: 'inline', lastHealthyAtIso: null },
    publicRegions: [{ scheme: 'admin_area', value: 'US-CA' }],
    publishIndicativePrice: true,
    quoteAccess: 'anyone',
    responsePolicy: {},
    customerPricingSource: null,
    orderAcceptance: 'review',
    listingState: 'live',
    connectors: [],
    ...over,
  };
}

interface Harness {
  settings: InMemoryCommerceSettingsRepository;
  workflow: WorkflowService;
  repo: InMemoryWorkflowRepository;
  runtime: Pick<CommerceRuntime, 'settings'>;
  clock: { now: number };
  revision: () => string;
}

function harness(): Harness {
  const settings = new InMemoryCommerceSettingsRepository();
  expect(settings.writeSupplier(baseSettings()).ok).toBe(true);
  const runtime = { settings };
  const repo = new InMemoryWorkflowRepository();
  const clock = { now: T0 };
  let service: WorkflowService | null = null;
  const workflow: WorkflowService = new WorkflowService({
    repository: repo,
    nowMsFn: () => clock.now,
    approvalDecisionHandler: makeSettingsProposalDecisionHandler({
      runtime: () => runtime,
      workflow: () => service,
      nowMs: () => clock.now,
    }),
  });
  service = workflow;
  const revision = (): string => {
    const r = settingsRevision(settings.readSupplier());
    if (r === null) throw new Error('fixture: supplier settings must be stored');
    return r;
  };
  return { settings, workflow, repo, runtime, clock, revision };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('what may be proposed', () => {
  it('names the controls and refuses anything else by name — identity and connector wiring are re-consent, never a proposal', () => {
    expect(SUPPLIER_PROPOSABLE_CONTROLS).not.toContain('actingBusinessDid');
    expect(SUPPLIER_PROPOSABLE_CONTROLS).not.toContain('connectors');
    expect(SUPPLIER_PROPOSABLE_CONTROLS).not.toContain('catalogSource');
    expect(SUPPLIER_PROPOSABLE_CONTROLS).not.toContain('customerPricingSource');
    expect(
      unsupportedControls({ orderAcceptance: 'auto', connectors: [], actingBusinessDid: 'x' }),
    ).toEqual(['connectors', 'actingBusinessDid']);
    const refused = proposeSupplierSettings(h.runtime, h.workflow, {
      commandId: 'cmd-1',
      expectedRevision: h.revision(),
      controls: { connectors: [] },
      proposedBy: DEVICE,
    });
    expect(refused).toEqual({
      kind: 'refused',
      refusal: 'unsupported_control',
      detail: 'connectors',
    });
    expect(h.repo.getByIdempotencyKey(proposalIdempotencyKey('cmd-1'))).toBeNull();
  });

  it('a stale revision is a conflict that names the current one; a merge that does not validate is refused with the store’s findings; no base record refuses', () => {
    const stale = proposeSupplierSettings(h.runtime, h.workflow, {
      commandId: 'cmd-2',
      expectedRevision: 'f'.repeat(64),
      controls: { orderAcceptance: 'auto' },
      proposedBy: DEVICE,
    });
    expect(stale).toEqual({
      kind: 'refused',
      refusal: 'revision_conflict',
      currentRevision: h.revision(),
    });
    const invalid = proposeSupplierSettings(h.runtime, h.workflow, {
      commandId: 'cmd-3',
      expectedRevision: h.revision(),
      controls: { quoteAccess: 'everyone' },
      proposedBy: DEVICE,
    });
    expect(invalid.kind).toBe('refused');
    expect((invalid as { refusal: string }).refusal).toBe('invalid_settings');
    expect((invalid as { findings: unknown[] }).findings.length).toBeGreaterThan(0);
    const empty = new InMemoryCommerceSettingsRepository();
    const absent = proposeSupplierSettings({ settings: empty }, h.workflow, {
      commandId: 'cmd-4',
      expectedRevision: 'a'.repeat(64),
      controls: { orderAcceptance: 'auto' },
      proposedBy: DEVICE,
    });
    expect(absent).toEqual({ kind: 'refused', refusal: 'settings_absent' });
    // Nothing above minted a card.
    expect(listSettingsProposals(h.workflow)).toEqual([]);
  });
});

describe('the card and the owner’s decision', () => {
  it('a valid proposal is one pending approval card carrying the content digest; the same command returns it; different content is a conflict', () => {
    const rev = h.revision();
    const args = {
      commandId: 'cmd-10',
      expectedRevision: rev,
      controls: { orderAcceptance: 'auto' as const },
      proposedBy: DEVICE,
    };
    const first = proposeSupplierSettings(h.runtime, h.workflow, args);
    expect(first).toEqual({ kind: 'pending', taskId: proposalTaskId('cmd-10') });
    const task = h.repo.getById(proposalTaskId('cmd-10'));
    expect(task?.status).toBe(WorkflowTaskState.PendingApproval);
    expect(task?.kind).toBe('approval');
    const payload = parseSettingsProposalPayload(task?.payload ?? '');
    expect(payload).toMatchObject({
      type: INTEGRATION_SETTINGS_PROPOSAL_TYPE,
      command_id: 'cmd-10',
      kind: 'supplier',
      expected_revision: rev,
      controls: { orderAcceptance: 'auto' },
      proposed_by: DEVICE,
    });
    expect(payload?.content_digest).toMatch(/^[0-9a-f]{64}$/);
    // Replay: the same command and content → the same pending card, no second one.
    expect(proposeSupplierSettings(h.runtime, h.workflow, args)).toEqual(first);
    expect(listSettingsProposals(h.workflow)).toHaveLength(1);
    // Same command, different content → conflict, still one card.
    const conflict = proposeSupplierSettings(h.runtime, h.workflow, {
      ...args,
      controls: { orderAcceptance: 'review' },
    });
    expect(conflict).toMatchObject({ kind: 'refused', refusal: 'command_conflict' });
    expect(listSettingsProposals(h.workflow)).toHaveLength(1);
    // Nothing applied yet.
    expect(h.revision()).toBe(rev);
  });

  it('approve applies the merge through the store, completes the card with the new revision, and the command then reads as applied', () => {
    const rev = h.revision();
    proposeSupplierSettings(h.runtime, h.workflow, {
      commandId: 'cmd-11',
      expectedRevision: rev,
      controls: { orderAcceptance: 'auto', listingState: 'paused' },
      proposedBy: DEVICE,
    });
    h.workflow.approve(proposalTaskId('cmd-11'));
    const read = h.settings.readSupplier();
    expect(read.ok && read.settings.orderAcceptance).toBe('auto');
    expect(read.ok && read.settings.listingState).toBe('paused');
    // Untouched controls keep their values; identity is untouched.
    expect(read.ok && read.settings.actingBusinessDid).toBe(SUPPLIER);
    expect(read.ok && read.settings.quoteAccess).toBe('anyone');
    const applied = h.revision();
    expect(applied).not.toBe(rev);
    const task = h.repo.getById(proposalTaskId('cmd-11'));
    expect(task?.status).toBe(WorkflowTaskState.Completed);
    expect(JSON.parse(task?.result ?? '{}')).toEqual({ applied_revision: applied });
    expect(
      proposeSupplierSettings(h.runtime, h.workflow, {
        commandId: 'cmd-11',
        expectedRevision: rev,
        controls: { orderAcceptance: 'auto', listingState: 'paused' },
        proposedBy: DEVICE,
      }),
    ).toEqual({ kind: 'applied', taskId: proposalTaskId('cmd-11'), revision: applied });
  });

  it('deny applies nothing and the command reads as closed; a lapse the same', () => {
    const rev = h.revision();
    const args = {
      commandId: 'cmd-12',
      expectedRevision: rev,
      controls: { orderAcceptance: 'auto' as const },
      proposedBy: DEVICE,
    };
    proposeSupplierSettings(h.runtime, h.workflow, args);
    h.workflow.cancel(proposalTaskId('cmd-12'), 'denied_by_operator');
    expect(h.revision()).toBe(rev);
    expect(proposeSupplierSettings(h.runtime, h.workflow, args)).toMatchObject({
      kind: 'closed',
      taskId: proposalTaskId('cmd-12'),
      state: 'cancelled',
    });
    // A lapse through the service's sweep: same outcome, nothing applied.
    h.workflow.create({
      id: 'x',
      kind: 'approval',
      description: 'other',
      payload: '{}',
      initialState: WorkflowTaskState.PendingApproval,
      expiresAtSec: Math.floor(T0 / 1000) + 5,
    });
    proposeSupplierSettings(h.runtime, h.workflow, { ...args, commandId: 'cmd-13' });
    // Proposals carry no deadline of their own — the owner decides when — so
    // a sweep leaves them pending; only an explicit decision closes one.
    h.workflow.expireTasks(Math.floor(T0 / 1000) + 10, T0 + 10_000);
    expect(h.repo.getById(proposalTaskId('cmd-13'))?.status).toBe(
      WorkflowTaskState.PendingApproval,
    );
    expect(h.revision()).toBe(rev);
  });

  it('a revision that moved between proposal and approval fails the card instead of overwriting what the owner set', () => {
    const rev = h.revision();
    proposeSupplierSettings(h.runtime, h.workflow, {
      commandId: 'cmd-14',
      expectedRevision: rev,
      controls: { orderAcceptance: 'auto' },
      proposedBy: DEVICE,
    });
    // The owner edits settings on their own surface meanwhile.
    expect(h.settings.writeSupplier(baseSettings({ quoteAccess: 'known_only' })).ok).toBe(true);
    const moved = h.revision();
    h.workflow.approve(proposalTaskId('cmd-14'));
    const task = h.repo.getById(proposalTaskId('cmd-14'));
    expect(task?.status).toBe(WorkflowTaskState.Failed);
    expect(task?.error).toContain('revision_conflict');
    const read = h.settings.readSupplier();
    expect(read.ok && read.settings.orderAcceptance).toBe('review');
    expect(read.ok && read.settings.quoteAccess).toBe('known_only');
    expect(h.revision()).toBe(moved);
  });
});

describe('what the review round pinned', () => {
  it('a card mid-apply (queued or running) still reads as pending to the connector, never as closed', () => {
    const rev = h.revision();
    const first = proposeSupplierSettings(h.runtime, h.workflow, {
      commandId: 'cmd-30',
      expectedRevision: rev,
      controls: { orderAcceptance: 'auto' },
      proposedBy: DEVICE,
    });
    expect(first.kind).toBe('pending');
    const id = proposalTaskId('cmd-30');
    expect(
      h.repo.transition(id, WorkflowTaskState.PendingApproval, WorkflowTaskState.Queued, T0),
    ).toBe(true);
    expect(
      proposeSupplierSettings(h.runtime, h.workflow, {
        commandId: 'cmd-30',
        expectedRevision: rev,
        controls: { orderAcceptance: 'auto' },
        proposedBy: DEVICE,
      }),
    ).toEqual({ kind: 'pending', taskId: id });
    expect(h.repo.transition(id, WorkflowTaskState.Queued, WorkflowTaskState.Running, T0)).toBe(
      true,
    );
    expect(
      proposeSupplierSettings(h.runtime, h.workflow, {
        commandId: 'cmd-30',
        expectedRevision: rev,
        controls: { orderAcceptance: 'auto' },
        proposedBy: DEVICE,
      }),
    ).toEqual({ kind: 'pending', taskId: id });
  });

  it('a node busy with other approvals never pushes a proposal off the listing', () => {
    for (let i = 0; i < 60; i += 1) {
      h.workflow.create({
        id: `other-${i}`,
        kind: WorkflowTaskKind.Approval,
        description: 'x',
        payload: JSON.stringify({ type: 'vault_read_request' }),
        initialState: WorkflowTaskState.PendingApproval,
      });
    }
    const rev = h.revision();
    proposeSupplierSettings(h.runtime, h.workflow, {
      commandId: 'cmd-31',
      expectedRevision: rev,
      controls: { listingState: 'paused' },
      proposedBy: DEVICE,
    });
    const listed = listSettingsProposals(h.workflow);
    expect(listed.map((p) => p.payload.command_id)).toEqual(['cmd-31']);
  });

  it('a mistyped boolean or an invalid region is refused at the door as invalid_settings, so it never reaches the card', () => {
    const rev = h.revision();
    const mistyped = proposeSupplierSettings(h.runtime, h.workflow, {
      commandId: 'cmd-32',
      expectedRevision: rev,
      controls: { acceptColdInvites: 'no' },
      proposedBy: DEVICE,
    });
    expect(mistyped).toMatchObject({ kind: 'refused', refusal: 'invalid_settings' });
    expect(mistyped.kind === 'refused' && mistyped.findings?.map((f) => f.field)).toEqual([
      'acceptColdInvites',
    ]);
    const nullish = proposeSupplierSettings(h.runtime, h.workflow, {
      commandId: 'cmd-33',
      expectedRevision: rev,
      controls: { publishIndicativePrice: null },
      proposedBy: DEVICE,
    });
    expect(nullish).toMatchObject({ kind: 'refused', refusal: 'invalid_settings' });
    const region = proposeSupplierSettings(h.runtime, h.workflow, {
      commandId: 'cmd-34',
      expectedRevision: rev,
      controls: {
        publicRegions: [
          { scheme: 'admin_area', value: 'US-CA' },
          { scheme: 'nope', value: '' },
        ],
      },
      proposedBy: DEVICE,
    });
    expect(region).toMatchObject({ kind: 'refused', refusal: 'invalid_settings' });
    expect(region.kind === 'refused' && region.findings?.map((f) => f.field)).toEqual([
      'publicRegions[1]',
    ]);
    expect(h.repo.getByCorrelationId(INTEGRATION_SETTINGS_PROPOSAL_TYPE)).toEqual([]);
  });
});

describe('composition with the coordination hooks', () => {
  it('both decision handlers run; the integration gate passes every result through; a throwing handler does not silence the next', () => {
    const seen: string[] = [];
    const composed = composeWorkflowHooks(
      {
        responseEgressGate: () => ({ kind: 'passthrough' }),
        approvalDecisionHandler: () => {
          seen.push('a');
          throw new Error('a broke');
        },
      },
      integrationWorkflowHooks({ nowMs: () => T0 }),
      {
        responseEgressGate: () => ({ kind: 'replace', json: '{"x":1}' }),
        approvalDecisionHandler: () => {
          seen.push('c');
        },
      },
      {
        responseEgressGate: () => ({ kind: 'withhold', reason: 'never reached' }),
        approvalDecisionHandler: () => {
          seen.push('d');
        },
      },
    );
    const ctx = {
      taskId: 't',
      fromDID: 'did:plc:x',
      queryId: 'q',
      capability: 'availability_coordination',
      ttlSeconds: 60,
      resultJSON: '{}',
      serviceName: '',
    };
    expect(composed.responseEgressGate(ctx)).toEqual({ kind: 'replace', json: '{"x":1}' });
    composed.approvalDecisionHandler({
      task: {
        id: 't',
        kind: 'approval',
        status: 'queued',
        priority: 'normal',
        description: '',
        payload: '{}',
        result_summary: '',
        policy: '',
        created_at: T0,
        updated_at: T0,
      },
      decision: 'approved',
    });
    expect(seen).toEqual(['a', 'c', 'd']);
    // The real pair the hosts compose is a WorkflowHooks value too.
    const hosts = composeWorkflowHooks(
      coordinationWorkflowHooks({ nowMs: () => T0 }),
      integrationWorkflowHooks({ nowMs: () => T0 }),
    );
    expect(typeof hosts.responseEgressGate).toBe('function');
    expect(typeof hosts.approvalDecisionHandler).toBe('function');
  });
});

describe('the workflow routes fence the card', () => {
  const OWNER_CAP = 'test-owner-capability';
  function req(
    method: CoreRequest['method'],
    path: string,
    callerType: string,
    body?: unknown,
  ): CoreRequest {
    return {
      method,
      path,
      query: {},
      headers: {},
      body,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType,
      callerDID: 'did:key:caller',
      ...(callerType === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
    } as CoreRequest;
  }
  afterEach(() => {
    setWorkflowService(null);
    installCommerceRuntime(null);
  });

  it('Brain may neither approve nor cancel a proposal, and the create route refuses the payload type; the owner approves', async () => {
    setWorkflowService(h.workflow);
    installCommerceRuntime(h.runtime as unknown as CommerceRuntime);
    const router = new CoreRouter();
    registerWorkflowRoutes(router, OWNER_CAP);
    const rev = h.revision();
    proposeSupplierSettings(h.runtime, h.workflow, {
      commandId: 'cmd-20',
      expectedRevision: rev,
      controls: { orderAcceptance: 'auto' },
      proposedBy: DEVICE,
    });
    const id = proposalTaskId('cmd-20');
    expect(
      (await router.handle(req('POST', `/v1/workflow/tasks/${id}/approve`, 'brain', {}))).status,
    ).toBe(403);
    expect(
      (await router.handle(req('POST', `/v1/workflow/tasks/${id}/cancel`, 'brain', {}))).status,
    ).toBe(403);
    // …nor fail it: from pending_approval, a fail would be a no in Brain's hand.
    expect(
      (await router.handle(req('POST', `/v1/workflow/tasks/${id}/fail`, 'brain', { error: 'x' })))
        .status,
    ).toBe(403);
    expect(h.repo.getById(id)?.status).toBe(WorkflowTaskState.PendingApproval);
    const minted = await router.handle(
      req('POST', '/v1/workflow/tasks', 'brain', {
        id: 'planted',
        kind: 'approval',
        description: 'x',
        payload: JSON.stringify({
          type: INTEGRATION_SETTINGS_PROPOSAL_TYPE,
          command_id: 'p',
          kind: 'supplier',
          expected_revision: rev,
          controls: {},
          content_digest: 'd',
          proposed_by: 'brain',
        }),
        initial_state: 'pending_approval',
      }),
    );
    expect(minted.status).toBe(400);
    expect((minted.body as { error: string }).error).toBe('reserved_payload_type');
    // A `service.respond` against the card is refused BEFORE any claim: the
    // card stays where the owner's decision reaches it. (The phone's deny path
    // used to take this route for the kind and strand the card in `queued`.)
    registerServiceRespondRoutes(router, { sender: async () => undefined });
    const responded = await router.handle(
      req('POST', '/v1/service/respond', 'brain', {
        task_id: id,
        response_body: { query_id: 'q', status: 'unavailable' },
      }),
    );
    expect(responded.status).toBe(403);
    expect((responded.body as { error: string }).error).toBe('owner_decision_required');
    expect(h.repo.getById(id)?.status).toBe(WorkflowTaskState.PendingApproval);
    expect(
      (await router.handle(req('POST', `/v1/workflow/tasks/${id}/approve`, 'owner', {}))).status,
    ).toBe(200);
    expect(h.repo.getById(id)?.status).toBe(WorkflowTaskState.Completed);
    const read = h.settings.readSupplier();
    expect(read.ok && read.settings.orderAcceptance).toBe('auto');
  });
});
