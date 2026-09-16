/**
 * The guest-side attach rule (GROUP_COORDINATION §6; §16 rules 5–6) — driven
 * through the REAL workflow service: a provider's execution task completes
 * with a result carrying `disclosures`, and what reaches the fake bridge
 * sender is what would reach the organizer.
 *
 * Rule 5 has two halves and both are pinned: a tier of `none` means the fact
 * never leaves, and a tier that admits it still sends nothing until the
 * owner says yes. A no sends the availability without it.
 */

import { appendAudit, queryAudit, resetAuditState } from '../../src/audit/service';
import {
  DISCLOSURE_REVIEW_APPROVAL_TYPE,
  coordinationWorkflowHooks,
  gateDisclosures,
  parseDisclosureReviewPayload,
  reviewTaskIdFor,
  tierAdmitsDisclosure,
} from '../../src/coordination/disclosure_egress';
import { clearSharingPolicies, setSharingPolicy } from '../../src/gatekeeper/sharing';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerServiceRespondRoutes } from '../../src/server/routes/service_respond';
import { registerWorkflowRoutes } from '../../src/server/routes/workflow';
import { WorkflowTaskKind, WorkflowTaskPriority, WorkflowTaskState } from '../../src/workflow/domain';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService, type ServiceQueryBridgeContext } from '../../src/workflow/service';

import type { SharingTier } from '../../src/gatekeeper/sharing';

const ORGANIZER = 'did:plc:mike';
const T0 = 1_700_000_000_000;

function executionPayload(capability = 'availability_coordination'): string {
  return JSON.stringify({
    type: 'service_query_execution',
    from_did: ORGANIZER,
    query_id: 'q-1',
    capability,
    ttl_seconds: 120,
    service_name: "The Millers' Dina",
    params: { intent: "Emma's birthday", candidate_slots: [{ start: 'Sat 26' }] },
  });
}

interface Harness {
  service: WorkflowService;
  repo: InMemoryWorkflowRepository;
  sent: ServiceQueryBridgeContext[];
  tiers: Map<string, SharingTier>;
  clock: { now: number };
}

function harness(): Harness {
  const repo = new InMemoryWorkflowRepository();
  const sent: ServiceQueryBridgeContext[] = [];
  const tiers = new Map<string, SharingTier>();
  const clock = { now: T0 };
  let service: WorkflowService | null = null;
  const hooks = coordinationWorkflowHooks({
    tierFor: (_did, category) => tiers.get(category),
    workflow: () => service,
    contactName: (did) => (did === ORGANIZER ? 'Mike' : null),
    nowMs: () => clock.now,
  });
  service = new WorkflowService({
    repository: repo,
    nowMsFn: () => clock.now,
    responseBridgeSender: async (ctx) => {
      sent.push({ ...ctx });
    },
    ...hooks,
  });
  return { service, repo, sent, tiers, clock };
}

function execTask(h: Harness, id = 'exec-1', capability?: string, expiresAtSec?: number): string {
  h.repo.create({
    id,
    kind: WorkflowTaskKind.Delegation,
    status: WorkflowTaskState.Created,
    priority: WorkflowTaskPriority.Normal,
    description: 'exec',
    payload: executionPayload(capability),
    result_summary: '',
    policy: '',
    origin: 'd2d',
    created_at: h.clock.now,
    updated_at: h.clock.now,
    ...(expiresAtSec !== undefined ? { expires_at: expiresAtSec } : {}),
  });
  h.repo.transition(id, WorkflowTaskState.Created, WorkflowTaskState.Running, h.clock.now);
  return id;
}

const flush = async (h: Harness): Promise<void> => {
  await new Promise<void>((r) => setImmediate(r));
  await h.service.flushBridgeInFlight();
};

const GLUTEN = { kind: 'dietary', text: 'someone in the household is gluten-free', about: 'household' };
const STEP_FREE = { kind: 'accessibility', text: 'we need step-free access', about: 'household' };
const CAN_DRIVE = { kind: 'transport', text: 'we can drive', about: 'household' };

function resultOf(ctx: ServiceQueryBridgeContext): Record<string, unknown> {
  return JSON.parse(ctx.resultJSON) as Record<string, unknown>;
}

let h: Harness;
beforeEach(() => {
  resetAuditState();
  h = harness();
});

describe('the tier decides whether a disclosure may leave (rule 5, first half)', () => {
  it('tier `none` for health: the fact never leaves; the availability still answers at once', async () => {
    h.tiers.set('health', 'none');
    h.tiers.set('general', 'summary');
    const id = execTask(h);
    h.service.complete(id, JSON.stringify({ status: 'accepted', accepted_slots: [{ start: 'Sat 26' }], disclosures: [GLUTEN, CAN_DRIVE] }), 'ok');
    await flush(h);
    expect(h.sent).toHaveLength(1);
    expect(resultOf(h.sent[0])).toEqual({
      status: 'accepted',
      accepted_slots: [{ start: 'Sat 26' }],
      disclosures: [CAN_DRIVE],
    });
    expect(h.repo.getById(reviewTaskIdFor(id))).toBeNull();
  });

  it('no tier at all: nothing leaves, and the `disclosures` field is not even on the wire', async () => {
    const id = execTask(h);
    h.service.complete(id, JSON.stringify({ status: 'accepted', accepted_slots: [{ start: 'Sat 26' }], disclosures: [GLUTEN, CAN_DRIVE] }), 'ok');
    await flush(h);
    expect(resultOf(h.sent[0])).toEqual({ status: 'accepted', accepted_slots: [{ start: 'Sat 26' }] });
    const audit = queryAudit({ action: 'disclosure_gate_applied' });
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toContain('refused_by_tier=2');
    expect(audit[0].detail).not.toContain('gluten');
  });

  it('a general kind under an admitting tier leaves without review; `about` other than household is dropped and counted', async () => {
    h.tiers.set('general', 'full');
    h.tiers.set('health', 'full');
    const id = execTask(h);
    h.service.complete(
      id,
      JSON.stringify({
        status: 'accepted',
        disclosures: [CAN_DRIVE, { kind: 'note', text: 'Lily gets shy', about: 'Lily' }, { kind: 'transport', text: '', about: 'household' }],
      }),
      'ok',
    );
    await flush(h);
    expect(h.sent).toHaveLength(1);
    expect(resultOf(h.sent[0])).toEqual({ status: 'accepted', disclosures: [CAN_DRIVE] });
    const audit = queryAudit({ action: 'disclosure_gate_applied' });
    expect(audit[0].detail).toContain('malformed=2');
    expect(audit[0].detail).not.toContain('Lily');
  });

  it('`tierAdmitsDisclosure` reads summary and full as yes and everything else as no', () => {
    expect(tierAdmitsDisclosure('summary')).toBe(true);
    expect(tierAdmitsDisclosure('full')).toBe(true);
    for (const t of ['none', 'locked', 'eta_only', 'free_busy', 'exact_location', undefined] as const) {
      expect(tierAdmitsDisclosure(t)).toBe(false);
    }
  });

  it('`gateDisclosures` deduplicates by kind and text and reports review only for a health kind', () => {
    const gated = gateDisclosures(ORGANIZER, [CAN_DRIVE, CAN_DRIVE, { ...GLUTEN, text: ' someone in the household is gluten-free ' }, GLUTEN], () => 'full');
    expect(gated.kept).toEqual([CAN_DRIVE, GLUTEN]);
    expect(gated.reviewRequired).toBe(true);
    expect(gateDisclosures(ORGANIZER, [CAN_DRIVE], () => 'full').reviewRequired).toBe(false);
  });
});

describe('a health fact waits for the owner (rule 5, second half)', () => {
  beforeEach(() => {
    h.tiers.set('health', 'full');
    h.tiers.set('general', 'full');
  });

  it('the reply is HELD: nothing is sent, a review card stands, and it expires with the query', async () => {
    const id = execTask(h);
    h.service.complete(id, JSON.stringify({ status: 'accepted', accepted_slots: [{ start: 'Sat 26' }], disclosures: [GLUTEN, CAN_DRIVE] }), 'ok');
    await flush(h);
    expect(h.sent).toHaveLength(0);
    const card = h.repo.getById(reviewTaskIdFor(id));
    expect(card).not.toBeNull();
    expect(card?.kind).toBe('approval');
    expect(card?.status).toBe('pending_approval');
    expect(card?.expires_at).toBe(Math.floor(T0 / 1000) + 120);
    expect(card?.description).toBe('Tell Mike about a household dietary need?');
    const payload = parseDisclosureReviewPayload(card?.payload ?? '');
    expect(payload?.type).toBe(DISCLOSURE_REVIEW_APPROVAL_TYPE);
    expect(payload?.disclosures).toEqual([GLUTEN, CAN_DRIVE]);
    // The card is a decision, not a payload: it names the task and the
    // response's identity, and carries no bytes a decision could release.
    expect(payload?.execution_task_id).toBe(id);
    expect(payload?.context).toEqual({
      taskId: id,
      fromDID: ORGANIZER,
      queryId: 'q-1',
      capability: 'availability_coordination',
      ttlSeconds: 120,
      serviceName: "The Millers' Dina",
    });
    expect(card?.payload).not.toContain('resultJSON');
    expect(card?.payload).not.toContain('accepted_slots');
    // The execution task's own stash holds nothing to retry: the answer is deliberately absent.
    expect(h.repo.getById(id)?.internal_stash).toBeUndefined();
  });

  it('the card expires when the query does — the execution task’s deadline, not the moment the model finished', async () => {
    const arrival = Math.floor(T0 / 1000) - 40; // the query arrived 40 s ago with a 120 s TTL
    const id = execTask(h, 'exec-late', undefined, arrival + 120);
    h.clock.now = T0 + 5_000; // the model took a while
    h.service.complete(id, JSON.stringify({ status: 'accepted', disclosures: [GLUTEN] }), 'ok');
    await flush(h);
    expect(h.repo.getById(reviewTaskIdFor(id))?.expires_at).toBe(arrival + 120);
  });

  it('a yes that comes after the card lapsed releases nothing', async () => {
    const id = execTask(h);
    h.service.complete(id, JSON.stringify({ status: 'accepted', disclosures: [GLUTEN] }), 'ok');
    await flush(h);
    h.clock.now = T0 + 200_000;
    h.repo.expireTasks(Math.floor(h.clock.now / 1000), h.clock.now);
    expect(() => h.service.approve(reviewTaskIdFor(id))).toThrow();
    await flush(h);
    expect(h.sent).toHaveLength(0);
  });

  it('yes → the reply leaves WITH the disclosures, once, and the card completes', async () => {
    const id = execTask(h);
    h.service.complete(id, JSON.stringify({ status: 'accepted', accepted_slots: [{ start: 'Sat 26' }], disclosures: [GLUTEN] }), 'ok');
    await flush(h);
    h.service.approve(reviewTaskIdFor(id));
    await flush(h);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].taskId).toBe(id);
    expect(resultOf(h.sent[0])).toEqual({ status: 'accepted', accepted_slots: [{ start: 'Sat 26' }], disclosures: [GLUTEN] });
    expect(h.repo.getById(reviewTaskIdFor(id))?.status).toBe('completed');
    expect(queryAudit({ action: 'disclosure_review_approved' })).toHaveLength(1);
    // Delivered: the bridge record is cleared, so a sweeper cannot send it twice.
    expect(h.repo.getById(id)?.internal_stash).toBeUndefined();
  });

  it('no → the reply leaves WITHOUT the disclosures; the requester still hears the availability', async () => {
    const id = execTask(h);
    h.service.complete(id, JSON.stringify({ status: 'accepted', accepted_slots: [{ start: 'Sat 26' }], disclosures: [GLUTEN, CAN_DRIVE] }), 'ok');
    await flush(h);
    h.service.cancel(reviewTaskIdFor(id), 'denied_by_operator');
    await flush(h);
    expect(h.sent).toHaveLength(1);
    expect(resultOf(h.sent[0])).toEqual({ status: 'accepted', accepted_slots: [{ start: 'Sat 26' }] });
    expect(h.repo.getById(reviewTaskIdFor(id))?.status).toBe('cancelled');
    expect(queryAudit({ action: 'disclosure_review_denied' })).toHaveLength(1);
  });

  it('a decision on any other approval, or a cancel of a card that was not pending, releases nothing', async () => {
    const id = execTask(h);
    h.service.complete(id, JSON.stringify({ status: 'accepted', disclosures: [STEP_FREE] }), 'ok');
    await flush(h);
    // An unrelated approval task decided the same way: the handler ignores it.
    h.repo.create({
      id: 'other-approval',
      kind: WorkflowTaskKind.Approval,
      status: WorkflowTaskState.PendingApproval,
      priority: WorkflowTaskPriority.Normal,
      description: 'x',
      payload: JSON.stringify({ type: 'agent_persona_access', agent_did: 'did:plc:a', persona: 'general', mode: 'read', scope: 's' }),
      result_summary: '',
      policy: '',
      origin: 'agent',
      created_at: h.clock.now,
      updated_at: h.clock.now,
    });
    h.service.approve('other-approval');
    await flush(h);
    expect(h.sent).toHaveLength(0);
    // Approve then cancel the review: the second decision does not send again.
    h.service.approve(reviewTaskIdFor(id));
    await flush(h);
    expect(h.sent).toHaveLength(1);
    expect(() => h.service.cancel(reviewTaskIdFor(id), 'late')).toThrow();
    await flush(h);
    expect(h.sent).toHaveLength(1);
  });

  it('with no workflow store to hold the card, the availability answers without the fact — never silence, never the fact', async () => {
    const repo = new InMemoryWorkflowRepository();
    const sent: ServiceQueryBridgeContext[] = [];
    const service = new WorkflowService({
      repository: repo,
      nowMsFn: () => T0,
      responseBridgeSender: async (ctx) => {
        sent.push({ ...ctx });
      },
      ...coordinationWorkflowHooks({ tierFor: () => 'full', workflow: () => null }),
    });
    const local: Harness = { service, repo, sent, tiers: new Map(), clock: { now: T0 } };
    const id = execTask(local);
    service.complete(id, JSON.stringify({ status: 'accepted', disclosures: [GLUTEN] }), 'ok');
    await flush(local);
    expect(sent).toHaveLength(1);
    expect(resultOf(sent[0])).toEqual({ status: 'accepted' });
  });

  it('the wrapper form `{status:"success", result}` is gated the same way', async () => {
    const id = execTask(h);
    h.service.complete(id, JSON.stringify({ status: 'success', result: { status: 'accepted', disclosures: [CAN_DRIVE, GLUTEN] } }), 'ok');
    await flush(h);
    expect(h.sent).toHaveLength(0);
    h.service.cancel(reviewTaskIdFor(id), 'no');
    await flush(h);
    expect(resultOf(h.sent[0])).toEqual({ status: 'success', result: { status: 'accepted' } });
  });
});

describe('which tier answers for a contact', () => {
  afterEach(() => clearSharingPolicies());

  it('a per-category policy, when one was set, comes before the contact’s own tier; with neither, nothing leaves', async () => {
    // Default deps: the module stores. No contact directory is wired here, so
    // the contact's own tier is unknown and only an explicit policy admits.
    const repo = new InMemoryWorkflowRepository();
    const sent: ServiceQueryBridgeContext[] = [];
    let service: WorkflowService | null = null;
    const hooks = coordinationWorkflowHooks({ workflow: () => service, nowMs: () => T0 });
    service = new WorkflowService({
      repository: repo,
      nowMsFn: () => T0,
      responseBridgeSender: async (ctx) => {
        sent.push({ ...ctx });
      },
      ...hooks,
    });
    const local: Harness = { service, repo, sent, tiers: new Map(), clock: { now: T0 } };
    const silent = execTask(local, 'exec-silent');
    service.complete(silent, JSON.stringify({ status: 'accepted', disclosures: [CAN_DRIVE] }), 'ok');
    await flush(local);
    expect(resultOf(sent[0])).toEqual({ status: 'accepted' });

    setSharingPolicy(ORGANIZER, 'general', 'summary');
    setSharingPolicy(ORGANIZER, 'health', 'none');
    const admitted = execTask(local, 'exec-admitted');
    service.complete(admitted, JSON.stringify({ status: 'accepted', disclosures: [CAN_DRIVE, GLUTEN] }), 'ok');
    await flush(local);
    expect(resultOf(sent[1])).toEqual({ status: 'accepted', disclosures: [CAN_DRIVE] });
    expect(repo.getById(reviewTaskIdFor(admitted))).toBeNull();
  });
});

describe('a withheld disclosure takes the model’s prose with it (found on the first live run)', () => {
  const PROSE = {
    status: 'accepted',
    accepted_slots: [{ start: 'Sat 26', note: 'works — and we are gluten-free' }],
    message: 'Confirmed. Household dietary note: someone in our household is gluten-free.',
  };

  it('owner denies → the reply leaves as availability only: no message, no slot note', async () => {
    h.tiers.set('health', 'full');
    const id = execTask(h);
    h.service.complete(id, JSON.stringify({ ...PROSE, disclosures: [GLUTEN] }), 'ok');
    await flush(h);
    h.service.cancel(reviewTaskIdFor(id), 'no');
    await flush(h);
    expect(resultOf(h.sent[0])).toEqual({ status: 'accepted', accepted_slots: [{ start: 'Sat 26' }] });
    expect(h.sent[0].resultJSON).not.toContain('gluten');
  });

  it('owner approves → the prose goes with the disclosure it echoes', async () => {
    h.tiers.set('health', 'full');
    const id = execTask(h);
    h.service.complete(id, JSON.stringify({ ...PROSE, disclosures: [GLUTEN] }), 'ok');
    await flush(h);
    h.service.approve(reviewTaskIdFor(id));
    await flush(h);
    expect(resultOf(h.sent[0])).toEqual({ ...PROSE, disclosures: [GLUTEN] });
  });

  it('tier refuses a health kind → prose stripped even though a general kind is kept', async () => {
    h.tiers.set('health', 'none');
    h.tiers.set('general', 'full');
    const id = execTask(h);
    h.service.complete(id, JSON.stringify({ ...PROSE, disclosures: [GLUTEN, CAN_DRIVE] }), 'ok');
    await flush(h);
    expect(resultOf(h.sent[0])).toEqual({ status: 'accepted', accepted_slots: [{ start: 'Sat 26' }], disclosures: [CAN_DRIVE] });
  });

  it('a malformed disclosure (a named person) is enough to strip the prose that may name them too', async () => {
    h.tiers.set('general', 'full');
    const id = execTask(h);
    h.service.complete(
      id,
      JSON.stringify({ status: 'counter', counter_slots: [{ start: 'Sun 27', note: 'Lily prefers Sundays' }], message: 'Lily is shy', disclosures: [{ kind: 'note', text: 'Lily gets shy', about: 'Lily' }] }),
      'ok',
    );
    await flush(h);
    expect(resultOf(h.sent[0])).toEqual({ status: 'counter', counter_slots: [{ start: 'Sun 27' }] });
    expect(h.sent[0].resultJSON).not.toContain('Lily');
  });

  it('nothing attached, nothing withheld → prose passes untouched', async () => {
    const id = execTask(h);
    h.service.complete(id, JSON.stringify({ ...PROSE, disclosures: [] }), 'ok');
    await flush(h);
    expect(resultOf(h.sent[0])).toEqual({ status: 'accepted', accepted_slots: PROSE.accepted_slots, message: PROSE.message });
  });
});

describe('the gate touches nothing else', () => {
  it('another capability, a result with no disclosures, and an error result all pass through byte for byte', async () => {
    h.tiers.set('health', 'none');
    const eta = execTask(h, 'exec-eta', 'eta_query');
    h.service.complete(eta, JSON.stringify({ eta_min: 4, disclosures: [GLUTEN] }), 'ok');
    const plain = execTask(h, 'exec-plain');
    h.service.complete(plain, JSON.stringify({ status: 'counter', counter_slots: [{ start: 'Sun 27' }] }), 'ok');
    const failed = execTask(h, 'exec-failed');
    h.service.complete(failed, JSON.stringify({ status: 'error', error: 'no calendar' }), 'ok');
    await flush(h);
    expect(h.sent.map((c) => c.resultJSON)).toEqual([
      JSON.stringify({ eta_min: 4, disclosures: [GLUTEN] }),
      JSON.stringify({ status: 'counter', counter_slots: [{ start: 'Sun 27' }] }),
      JSON.stringify({ status: 'error', error: 'no calendar' }),
    ]);
    expect(queryAudit({ action: 'disclosure_gate_applied' })).toHaveLength(0);
  });

  it('the audit trail names counts and task ids, never a disclosure', async () => {
    h.tiers.set('health', 'full');
    const id = execTask(h);
    h.service.complete(id, JSON.stringify({ status: 'accepted', disclosures: [GLUTEN] }), 'ok');
    await flush(h);
    h.service.approve(reviewTaskIdFor(id));
    await flush(h);
    appendAudit('test', 'marker', 'x');
    const everything = queryAudit().map((e) => `${e.action} ${e.resource} ${e.detail ?? ''}`).join('\n');
    expect(everything).toContain('disclosure_gate_applied');
    expect(everything).not.toContain('gluten');
  });
});

// ---------------------------------------------------------------------------
// The card decided through the REAL workflow routes, and every other door a
// provider answer leaves by
// ---------------------------------------------------------------------------

function routeReq(method: CoreRequest['method'], path: string, callerType: string | undefined, body?: unknown): CoreRequest {
  return {
    method,
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(callerType !== undefined ? { callerType, callerDID: 'did:key:caller' } : {}),
  };
}

describe('the owner decides the card through the workflow routes; Brain cannot', () => {
  let router: CoreRouter;
  beforeEach(() => {
    h.tiers.set('health', 'full');
    h.tiers.set('general', 'full');
    setWorkflowService(h.service);
    router = new CoreRouter();
    registerWorkflowRoutes(router);
  });
  afterEach(() => setWorkflowService(null));

  it('a paired device approves → sent WITH; Brain is refused on approve and on cancel; a device cancel → sent WITHOUT', async () => {
    const first = execTask(h, 'exec-a');
    h.service.complete(first, JSON.stringify({ status: 'accepted', accepted_slots: [{ start: 'Sat 26' }], disclosures: [GLUTEN] }), 'ok');
    await flush(h);
    const card = reviewTaskIdFor(first);
    const brainApprove = await router.handle(routeReq('POST', `/v1/workflow/tasks/${card}/approve`, 'brain', {}));
    expect(brainApprove.status).toBe(403);
    const brainCancel = await router.handle(routeReq('POST', `/v1/workflow/tasks/${card}/cancel`, 'brain', {}));
    expect(brainCancel.status).toBe(403);
    await flush(h);
    expect(h.sent).toHaveLength(0);
    expect(h.repo.getById(card)?.status).toBe('pending_approval');

    const approve = await router.handle(routeReq('POST', `/v1/workflow/tasks/${card}/approve`, 'device', {}));
    expect(approve.status).toBe(200);
    await flush(h);
    expect(h.sent).toHaveLength(1);
    expect(resultOf(h.sent[0])).toEqual({ status: 'accepted', accepted_slots: [{ start: 'Sat 26' }], disclosures: [GLUTEN] });
    expect(h.repo.getById(card)?.status).toBe('completed');

    const second = execTask(h, 'exec-b');
    h.service.complete(second, JSON.stringify({ status: 'accepted', disclosures: [STEP_FREE, CAN_DRIVE] }), 'ok');
    await flush(h);
    const cancel = await router.handle(routeReq('POST', `/v1/workflow/tasks/${reviewTaskIdFor(second)}/cancel`, 'device', { reason: 'no' }));
    expect(cancel.status).toBe(200);
    await flush(h);
    expect(h.sent).toHaveLength(2);
    expect(resultOf(h.sent[1])).toEqual({ status: 'accepted' });
  });

  it('a review card cannot be minted through the create route, and a planted one releases nothing but the task’s own result', async () => {
    const minted = await router.handle(
      routeReq('POST', '/v1/workflow/tasks', 'device', {
        id: 'forged',
        kind: 'approval',
        description: 'x',
        payload: JSON.stringify({
          type: 'disclosure_review',
          execution_task_id: 'exec-a',
          context: { taskId: 'exec-a', fromDID: 'did:plc:attacker', queryId: 'q', capability: 'availability_coordination', ttlSeconds: 60, serviceName: '' },
          disclosures: [],
        }),
        initial_state: 'pending_approval',
      }),
    );
    expect(minted.status).toBe(400);
    expect((minted.body as { error: string }).error).toBe('reserved_payload_type');

    // Planted by hand in the store: the identity on the card names another
    // requester than the task answers, so the decision releases nothing.
    const exec = execTask(h, 'exec-c');
    h.service.complete(exec, JSON.stringify({ status: 'accepted', disclosures: [GLUTEN] }), 'ok');
    await flush(h);
    h.repo.create({
      id: 'planted',
      kind: WorkflowTaskKind.Approval,
      status: WorkflowTaskState.PendingApproval,
      priority: WorkflowTaskPriority.Normal,
      description: 'x',
      payload: JSON.stringify({
        type: 'disclosure_review',
        execution_task_id: 'exec-c',
        context: { taskId: 'exec-c', fromDID: 'did:plc:attacker', queryId: 'q-1', capability: 'availability_coordination', ttlSeconds: 120, serviceName: '' },
        disclosures: [GLUTEN],
      }),
      result_summary: '',
      policy: '',
      origin: 'd2d',
      created_at: h.clock.now,
      updated_at: h.clock.now,
    });
    h.service.approve('planted');
    await flush(h);
    expect(h.sent).toHaveLength(0);
    expect(h.repo.getById('planted')?.status).toBe('failed');
    // The genuine card still stands and releases the task's own bytes to the task's own requester.
    h.service.approve(reviewTaskIdFor(exec));
    await flush(h);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].fromDID).toBe(ORGANIZER);
  });
});

describe('every door a provider answer leaves by is gated', () => {
  beforeEach(() => {
    h.tiers.set('health', 'full');
    h.tiers.set('general', 'full');
    setWorkflowService(h.service);
  });
  afterEach(() => setWorkflowService(null));

  it('the reasoning lane’s staged commit: a health disclosure is held, a general one leaves', () => {
    const stage = (id: string, result: unknown): void => {
      h.repo.create({
        id,
        kind: WorkflowTaskKind.Reasoning,
        status: WorkflowTaskState.Created,
        priority: WorkflowTaskPriority.Normal,
        description: 'compose',
        payload: JSON.stringify({ taskKind: 'service.respond' }),
        result_summary: '',
        policy: '',
        origin: 'system',
        created_at: h.clock.now,
        updated_at: h.clock.now,
        claim_id: 'claim-1',
      });
      h.repo.transition(id, WorkflowTaskState.Created, WorkflowTaskState.Running, h.clock.now);
      // A reasoning task completes only under its claim token (§9.1).
      const landed = h.repo.completeWithDetails(id, '', 'composed', JSON.stringify(result), '{}', h.clock.now, 'claim-1');
      expect(landed).not.toBe(0);
      h.service.stageServiceQueryResponse({
        taskId: id,
        fromDID: ORGANIZER,
        queryId: 'q-r',
        capability: 'availability_coordination',
        ttlSeconds: 120,
        resultJSON: JSON.stringify(result),
        serviceName: 'x',
      });
    };
    stage('reason-general', { status: 'accepted', disclosures: [CAN_DRIVE] });
    expect(h.repo.getById('reason-general')?.internal_stash ?? '').toContain('bridge_pending:');
    expect(h.repo.getById('reason-general')?.internal_stash ?? '').toContain('we can drive');
    stage('reason-health', { status: 'accepted', disclosures: [GLUTEN] });
    expect(h.repo.getById('reason-health')?.internal_stash).toBeUndefined();
    const card = h.repo.getById(reviewTaskIdFor('reason-health'));
    expect(card?.status).toBe('pending_approval');
  });

  it('the owner’s manual /v1/service/respond: a health disclosure is held and released on the yes; a general one is sent gated', async () => {
    const sentBodies: unknown[] = [];
    const router = new CoreRouter();
    registerServiceRespondRoutes(router, {
      sender: async (_to, _type, body) => {
        sentBodies.push(body);
      },
      nowSecFn: () => Math.floor(h.clock.now / 1000),
      nowMsFn: () => h.clock.now,
    });
    const approval = (id: string): void => {
      h.repo.create({
        id,
        kind: WorkflowTaskKind.Approval,
        status: WorkflowTaskState.PendingApproval,
        priority: WorkflowTaskPriority.Normal,
        description: 'review',
        payload: executionPayload(),
        result_summary: '',
        policy: '',
        origin: 'd2d',
        created_at: h.clock.now,
        updated_at: h.clock.now,
      });
    };
    approval('manual-health');
    const held = await router.handle(
      routeReq('POST', '/v1/service/respond', 'device', {
        task_id: 'manual-health',
        response_body: { status: 'success', result: { status: 'accepted', accepted_slots: [{ start: 'Sat 26' }], disclosures: [GLUTEN] } },
      }),
    );
    expect(held.status).toBe(200);
    expect(held.body).toEqual({ status: 'held', task_id: 'manual-health' });
    expect(sentBodies).toHaveLength(0);
    expect(h.repo.getById('manual-health')?.status).toBe('completed');
    const card = reviewTaskIdFor('manual-health');
    expect(h.repo.getById(card)?.status).toBe('pending_approval');
    h.service.approve(card);
    await flush(h);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].taskId).toBe('manual-health');
    expect(resultOf(h.sent[0]).result).toEqual({ status: 'accepted', accepted_slots: [{ start: 'Sat 26' }], disclosures: [GLUTEN] });

    approval('manual-general');
    const sent = await router.handle(
      routeReq('POST', '/v1/service/respond', 'device', {
        task_id: 'manual-general',
        response_body: { status: 'success', result: { status: 'accepted', disclosures: [CAN_DRIVE, { kind: 'note', text: 'x', about: 'Lily' }] } },
      }),
    );
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ status: 'sent', task_id: 'manual-general' });
    expect(sentBodies).toHaveLength(1);
    expect((sentBodies[0] as { result: unknown }).result).toEqual({ status: 'accepted', disclosures: [CAN_DRIVE] });
  });
});
