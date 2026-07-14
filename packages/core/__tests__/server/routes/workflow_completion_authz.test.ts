/**
 * SEC (P1.1) — an out-of-process `agent` may only complete/fail a `delegation`
 * task it is CURRENTLY holding (claimed → running, agent_did === its
 * authenticated DID). The repo guards complete/fail on STATE only, so without
 * this an agent could complete/fail (or force-terminate) any non-terminal task
 * by id, with a forged `agent_did`. `agentCompletionGuard` enforces ownership;
 * the recorded completer is the authenticated `callerDID`, never the body.
 */

import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerWorkflowRoutes, sanitizeStatusText } from '../../../src/server/routes/workflow';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { PLUGIN_INVOCATION_PAYLOAD_TYPE } from '../../../src/workflow/plugin_envelope';
import { WorkflowService, setWorkflowService } from '../../../src/workflow/service';

describe('round-9 #22: sanitizeStatusText caps + single-lines owner-facing runner text', () => {
  it('collapses control chars/newlines to spaces and trims', () => {
    expect(sanitizeStatusText('booking\nconfirmed\tok')).toBe('booking confirmed ok');
    expect(sanitizeStatusText('  padded  ')).toBe('padded');
  });
  it('caps the length (default 500)', () => {
    expect(sanitizeStatusText('a'.repeat(1000)).length).toBe(500);
    expect(sanitizeStatusText('a'.repeat(1000), 200).length).toBe(200);
  });
  it('normal single-line text is unchanged', () => {
    expect(sanitizeStatusText('Flight AA123 is on time')).toBe('Flight AA123 is on time');
  });
  it('non-strings become empty', () => {
    expect(sanitizeStatusText(undefined)).toBe('');
    expect(sanitizeStatusText(42)).toBe('');
  });
});

const NOW = 1_800_000_000_000;
const AGENT_A = 'did:key:agentA';
const AGENT_B = 'did:key:agentB';

let repo: InMemoryWorkflowRepository;

function build(): CoreRouter {
  const router = new CoreRouter();
  registerWorkflowRoutes(router);
  return router;
}

/** Seed a queued delegation task and claim it as `agentDID` → running. */
function seedRunningDelegation(id: string, agentDID: string): void {
  repo.create({
    id,
    kind: 'delegation',
    status: 'queued',
    priority: 'normal',
    description: 'service query',
    payload: JSON.stringify({ type: 'service_query_execution' }),
    result_summary: '',
    policy: '{}',
    created_at: NOW,
    updated_at: NOW,
  });
  const claimed = repo.claimDelegationTask(agentDID, NOW, 30_000);
  if (claimed === null || claimed.id !== id) throw new Error('test seed: claim failed');
}

function actionReq(
  id: string,
  action: 'complete' | 'fail',
  body: Record<string, unknown>,
  caller?: { type: string; did: string },
): CoreRequest {
  return {
    method: 'POST',
    path: `/v1/workflow/tasks/${id}/${action}`,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(caller ? { callerType: caller.type, callerDID: caller.did } : {}),
  };
}

describe('workflow complete/fail — agent ownership gate (P1.1)', () => {
  beforeEach(() => {
    repo = new InMemoryWorkflowRepository();
    setWorkflowService(new WorkflowService({ repository: repo }));
  });
  afterEach(() => setWorkflowService(null));

  it('agent completes its OWN running delegation → 200, records the AUTHENTICATED did (body ignored)', async () => {
    const router = build();
    seedRunningDelegation('t1', AGENT_A);
    const resp = await router.handle(
      actionReq(
        't1',
        'complete',
        { result: 'ok', agent_did: 'did:key:forged' },
        {
          type: 'agent',
          did: AGENT_A,
        },
      ),
    );
    expect(resp.status).toBe(200);
    const task = repo.getById('t1');
    expect(task?.status).toBe('completed');
    // The recorded completer is the authenticated caller, NOT the forged body value.
    expect(task?.agent_did).toBe(AGENT_A);
  });

  it('agent CANNOT complete a delegation held by a DIFFERENT agent → 403, task untouched', async () => {
    const router = build();
    seedRunningDelegation('t1', AGENT_A);
    const resp = await router.handle(
      actionReq('t1', 'complete', { result: 'pwned' }, { type: 'agent', did: AGENT_B }),
    );
    expect(resp.status).toBe(403);
    expect((resp.body as { error?: string }).error).toBe('access_denied');
    expect(repo.getById('t1')?.status).toBe('running'); // not completed
  });

  it('agent CANNOT complete a NON-delegation task it does not hold → 403', async () => {
    const router = build();
    repo.create({
      id: 'appr1',
      kind: 'approval',
      status: 'running',
      priority: 'normal',
      description: 'an approval',
      payload: '{}',
      result_summary: '',
      policy: '{}',
      agent_did: AGENT_A,
      created_at: NOW,
      updated_at: NOW,
    });
    const resp = await router.handle(
      actionReq('appr1', 'complete', { result: 'x' }, { type: 'agent', did: AGENT_A }),
    );
    expect(resp.status).toBe(403);
  });

  it('agent CANNOT fail a task it does not hold → 403', async () => {
    const router = build();
    seedRunningDelegation('t1', AGENT_A);
    const resp = await router.handle(
      actionReq('t1', 'fail', { error: 'boom' }, { type: 'agent', did: AGENT_B }),
    );
    expect(resp.status).toBe(403);
    expect(repo.getById('t1')?.status).toBe('running');
  });

  it('agent fails its OWN running delegation → 200', async () => {
    const router = build();
    seedRunningDelegation('t1', AGENT_A);
    const resp = await router.handle(
      actionReq('t1', 'fail', { error: 'provider down' }, { type: 'agent', did: AGENT_A }),
    );
    expect(resp.status).toBe(200);
    expect(repo.getById('t1')?.status).toBe('failed');
  });

  it('owner (in-process, no callerType) is NOT gated — completes a delegation → 200', async () => {
    const router = build();
    seedRunningDelegation('t1', AGENT_A);
    const resp = await router.handle(actionReq('t1', 'complete', { result: 'ok' })); // no caller
    expect(resp.status).toBe(200);
    expect(repo.getById('t1')?.status).toBe('completed');
  });
});

describe('round-10 #2: workflow reads are own-task-only for agent/plugin callers', () => {
  beforeEach(() => {
    repo = new InMemoryWorkflowRepository();
    setWorkflowService(new WorkflowService({ repository: repo }));
  });
  afterEach(() => setWorkflowService(null));

  function readReq(
    id: string,
    verb: 'get' | 'running',
    caller?: { type: string; did: string },
  ): CoreRequest {
    return {
      method: verb === 'get' ? 'GET' : 'POST',
      path: verb === 'get' ? `/v1/workflow/tasks/${id}` : `/v1/workflow/tasks/${id}/running`,
      query: {},
      headers: {},
      body: {},
      rawBody: new Uint8Array(),
      params: { id },
      trustedInProcess: true,
      ...(caller ? { callerType: caller.type, callerDID: caller.did } : {}),
    };
  }

  it('an agent may GET / running a task it OWNS but NOT one held by another agent', async () => {
    const router = build();
    seedRunningDelegation('t1', AGENT_A);
    // Owner (AGENT_A) can read + running its own task.
    expect(
      (await router.handle(readReq('t1', 'get', { type: 'agent', did: AGENT_A }))).status,
    ).toBe(200);
    expect(
      (await router.handle(readReq('t1', 'running', { type: 'agent', did: AGENT_A }))).status,
    ).toBe(200);
    // A DIFFERENT agent cannot read it by id (payloads carry params/context).
    expect(
      (await router.handle(readReq('t1', 'get', { type: 'agent', did: AGENT_B }))).status,
    ).toBe(403);
    expect(
      (await router.handle(readReq('t1', 'running', { type: 'agent', did: AGENT_B }))).status,
    ).toBe(403);
    // An owner surface (no callerType = in-process admin/brain) is not gated.
    expect((await router.handle(readReq('t1', 'get'))).status).toBe(200);
  });

  it('round-10 #21: a plugin completion with no parseable pinned envelope fails closed', async () => {
    const router = build();
    // A running delegation claimed by a PLUGIN caller whose payload is NOT a
    // valid plugin envelope (corruption) → complete must terminalize, not apply.
    seedRunningDelegation('t1', 'did:key:plugin');
    const claimId = String(repo.getById('t1')?.claim_id ?? ''); // plugin callers must present it
    const resp = await router.handle(
      actionReq(
        't1',
        'complete',
        { result: '{"x":1}', claim_id: claimId },
        { type: 'plugin', did: 'did:key:plugin' },
      ),
    );
    expect(resp.status).toBe(200); // the fail() itself succeeds
    expect(repo.getById('t1')?.status).toBe('failed');
  });

  it('round-12 #5: an EFFECTFUL runner returning a schema-invalid result parks outcome_unknown, not failed', () => {
    const router = build();
    const envelope = {
      type: PLUGIN_INVOCATION_PAYLOAD_TYPE,
      install_id: 'pli_1',
      capability_id: 'com.acme.book.reserve',
      params: {},
      context: [],
      manifest_cid: 'bafyreicid',
      approved_scope_hash: 'a'.repeat(64),
      // A result missing the required `confirmation` fails this pinned schema.
      schema_snapshot: {
        type: 'object',
        required: ['confirmation'],
        properties: { confirmation: { type: 'string' } },
      },
      config_revision: 1,
      execution_id: 'exec-1',
      idempotency_key: 'idem-1',
      action_class: 'booking', // EFFECTFUL — the effect may already have happened
      effects_idempotency: 'unsupported',
    };
    repo.create({
      id: 't1',
      kind: 'delegation',
      status: 'queued',
      priority: 'normal',
      description: 'plugin invocation',
      payload: JSON.stringify(envelope),
      result_summary: '',
      policy: '',
      idempotency_key: 'idem-1',
      created_at: NOW,
      updated_at: NOW,
    });
    const claimed = repo.claimDelegationTask('did:key:plugin', NOW, 30_000);
    if (claimed === null || claimed.id !== 't1') throw new Error('test seed: claim failed');
    const claimId = String(repo.getById('t1')?.claim_id ?? '');
    // The booking runner performed the reservation, then returned a malformed
    // result (no `confirmation`). Plain `failed` would imply nothing happened.
    return router
      .handle(
        actionReq(
          't1',
          'complete',
          { result: '{"oops":"no confirmation"}', claim_id: claimId },
          { type: 'plugin', did: 'did:key:plugin' },
        ),
      )
      .then((resp) => {
        expect(resp.status).toBe(200);
        const task = repo.getById('t1');
        expect(task?.status).toBe('outcome_unknown');
        expect(task?.error).toContain('result rejected');
      });
  });

  it('round-13 #6: an EFFECTFUL runner that /FAILS parks outcome_unknown (not failed) + records attribution', async () => {
    const router = build();
    const envelope = {
      type: PLUGIN_INVOCATION_PAYLOAD_TYPE,
      install_id: 'pli_1',
      capability_id: 'com.acme.pay.charge',
      params: {},
      context: [],
      manifest_cid: 'bafyreicid',
      approved_scope_hash: 'a'.repeat(64),
      schema_snapshot: null,
      config_revision: 1,
      execution_id: 'exec-1',
      idempotency_key: 'idem-1',
      action_class: 'payment', // EFFECTFUL — money may have moved
      effects_idempotency: 'unsupported',
    };
    repo.create({
      id: 't1',
      kind: 'delegation',
      status: 'queued',
      priority: 'normal',
      description: 'plugin invocation',
      payload: JSON.stringify(envelope),
      result_summary: '',
      policy: '',
      idempotency_key: 'idem-1',
      created_at: NOW,
      updated_at: NOW,
    });
    const claimed = repo.claimDelegationTask('did:key:plugin', NOW, 30_000);
    if (claimed === null || claimed.id !== 't1') throw new Error('test seed: claim failed');
    const claimId = String(repo.getById('t1')?.claim_id ?? '');
    // The payment runner charged the card, then hit an error and reported /fail.
    const resp = await router.handle(
      actionReq(
        't1',
        'fail',
        { error: 'gateway timeout after charge', claim_id: claimId },
        { type: 'plugin', did: 'did:key:plugin' },
      ),
    );
    expect(resp.status).toBe(200);
    const task = repo.getById('t1');
    expect(task?.status).toBe('outcome_unknown'); // NOT 'failed'
    // Round-13 #10: attribution recorded on the parked task.
    expect(task?.agent_did).toBe('did:key:plugin');
  });
});
