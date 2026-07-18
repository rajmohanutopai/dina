/**
 * ISVC-4 / VERIF regression — the owner `/v1/run/:id/decide` route
 * (INTERACTIVE_SERVICES_ARCHITECTURE.md §12.5 + §5.1 + §6.3). Covers the four
 * decide-path findings from the VERIF adversarial pass:
 *   #6  durable command idempotency (a replayed decide returns the stored
 *       response WITHOUT re-deciding, even after the message left `classified`).
 *   #8  a fencing/terminal barrier admits NO new decision.
 *   #10 a decided-basis count barrier opens once decided_count hits max_count.
 *   #11 an expired message can never be decided (and is transitioned → expired).
 */

import {
  InMemoryCommandReceiptRepository,
  setCommandReceiptRepository,
} from '../../../src/run/command_receipt';
import {
  InMemoryMessageRepository,
  setMessageRepository,
  type MessageKind,
  type MessageRecord,
} from '../../../src/run/message';
import { InMemoryRunRepository, setRunRepository } from '../../../src/run/repository';
import { RunService, setRunService } from '../../../src/run/service';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerRunRoutes } from '../../../src/server/routes/run';

const NOW = 1_700_000_000_000;
// The decide route reads real `Date.now()` for the message-expiry check (§6.3),
// so message `expires_at` must be relative to the real clock, not the fixed
// `NOW` used for the run's own (unchecked-at-decide) clock.
const FAR_FUTURE = Date.now() + 3_600_000;

function ownerReq(path: string, body: Record<string, unknown>): CoreRequest {
  return {
    method: 'POST',
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'owner',
    callerDID: 'did:key:owner',
  };
}

function classifiedMessage(
  over: Partial<MessageRecord> & { message_id: string; run_id: string; kind: MessageKind },
): MessageRecord {
  return {
    reservation_id: null,
    dedup_key: `dedup-${over.message_id}`,
    sequence: 1,
    action_type: over.kind === 'action' ? 'send' : null,
    risk_class: over.kind === 'action' ? 'SAFE' : null,
    state: 'classified',
    decision: null,
    decision_revision: 0,
    delegation_id: null,
    expires_at: FAR_FUTURE,
    payload_ref: null,
    tier_candidate: null,
    final_tier: null,
    tier_source: null,
    reconciliation_evidence: '[]',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

describe('POST /v1/run/:id/decide — VERIF regressions', () => {
  let router: CoreRouter;
  let runs: InMemoryRunRepository;
  let messages: InMemoryMessageRepository;

  function startRun(over: Record<string, unknown> = {}): string {
    const svc = getRunSvc();
    const run = svc.create({
      service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
      provider_did: 'did:plc:prov',
      persona: 'general',
      idempotency_key: `idem-${Math.random()}`,
      expires_at: NOW + 3_600_000,
      ...over,
    });
    return run.run_id;
  }

  let svcRef: RunService;
  function getRunSvc(): RunService {
    return svcRef;
  }

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    messages = new InMemoryMessageRepository();
    setRunRepository(runs);
    setMessageRepository(messages);
    setCommandReceiptRepository(new InMemoryCommandReceiptRepository());
    svcRef = new RunService({ repository: runs, nowMsFn: () => NOW });
    setRunService(svcRef);
    router = new CoreRouter();
    registerRunRoutes(router);
  });

  afterEach(() => {
    setRunService(null);
    setRunRepository(null);
    setMessageRepository(null);
    setCommandReceiptRepository(null);
  });

  it('approves a classified informational message (acknowledge) — happy path', async () => {
    const runId = startRun();
    messages.create(classifiedMessage({ message_id: 'm1', run_id: runId, kind: 'informational' }));
    const resp = await router.handle(
      ownerReq(`/v1/run/${runId}/decide`, { message_id: 'm1', decision: 'acknowledge' }),
    );
    expect(resp.status).toBe(200);
    expect((resp.body as { state: string }).state).toBe('acknowledged');
    expect((resp.body as { decision_revision: number }).decision_revision).toBe(1);
  });

  it('#6 a replayed decide returns the stored response, does NOT re-decide', async () => {
    const runId = startRun();
    messages.create(classifiedMessage({ message_id: 'm1', run_id: runId, kind: 'action' }));

    const first = await router.handle(
      ownerReq(`/v1/run/${runId}/decide`, {
        message_id: 'm1',
        decision: 'approve',
        idempotency_key: 'dec-key-1',
      }),
    );
    expect(first.status).toBe(200);
    expect((first.body as { decision_revision: number }).decision_revision).toBe(1);

    // The message has now left `classified` (it is `approved`). A naive re-check
    // would 409 here; the durable receipt must replay the original 200 instead.
    const replay = await router.handle(
      ownerReq(`/v1/run/${runId}/decide`, {
        message_id: 'm1',
        decision: 'approve',
        idempotency_key: 'dec-key-1',
      }),
    );
    expect(replay.status).toBe(200);
    expect((replay.body as { decision_revision: number }).decision_revision).toBe(1);
    // The revision did NOT advance a second time — exactly-once.
    expect(messages.getById('m1')?.decision_revision).toBe(1);
  });

  it('#6 a replayed idempotency key with a DIFFERENT body is rejected', async () => {
    const runId = startRun();
    messages.create(classifiedMessage({ message_id: 'm1', run_id: runId, kind: 'action' }));
    messages.create(classifiedMessage({ message_id: 'm2', run_id: runId, kind: 'action', sequence: 2 }));

    await router.handle(
      ownerReq(`/v1/run/${runId}/decide`, {
        message_id: 'm1',
        decision: 'approve',
        idempotency_key: 'shared-key',
      }),
    );
    const conflict = await router.handle(
      ownerReq(`/v1/run/${runId}/decide`, {
        message_id: 'm2',
        decision: 'approve',
        idempotency_key: 'shared-key',
      }),
    );
    expect(conflict.status).toBe(409);
    expect((conflict.body as { reason: string }).reason).toMatch(/idempotency_key reused/);
    // m2 was never decided (the conflict short-circuits before compute).
    expect(messages.getById('m2')?.state).toBe('classified');
  });

  it('#8 no new decision under a fencing drain (409)', async () => {
    const runId = startRun();
    messages.create(classifiedMessage({ message_id: 'm1', run_id: runId, kind: 'action' }));
    // Open a FENCING barrier (a stop with cancel_pending → fencing drain).
    runs.applyBarrier(runId, 'cancel_pending', 'fencing', NOW + 30_000, NOW);

    const resp = await router.handle(
      ownerReq(`/v1/run/${runId}/decide`, { message_id: 'm1', decision: 'approve' }),
    );
    expect(resp.status).toBe(409);
    expect((resp.body as { reason: string }).reason).toMatch(/no new decisions/);
  });

  it('#8 a PERMISSIVE drain still admits a decision', async () => {
    const runId = startRun();
    messages.create(classifiedMessage({ message_id: 'm1', run_id: runId, kind: 'informational' }));
    runs.applyBarrier(runId, 'count', 'permissive', NOW + 30_000, NOW);

    const resp = await router.handle(
      ownerReq(`/v1/run/${runId}/decide`, { message_id: 'm1', decision: 'acknowledge' }),
    );
    expect(resp.status).toBe(200);
  });

  it('#10 a decided-basis count barrier opens when decided_count hits max_count', async () => {
    const runId = startRun({ max_count: 2, max_count_basis: 'decided' });
    messages.create(classifiedMessage({ message_id: 'm1', run_id: runId, kind: 'informational' }));
    messages.create(classifiedMessage({ message_id: 'm2', run_id: runId, kind: 'informational', sequence: 2 }));

    const first = await router.handle(
      ownerReq(`/v1/run/${runId}/decide`, { message_id: 'm1', decision: 'acknowledge' }),
    );
    expect(first.status).toBe(200);
    // Below the count — still active.
    expect(runs.getById(runId)?.state).toBe('active');

    const second = await router.handle(
      ownerReq(`/v1/run/${runId}/decide`, { message_id: 'm2', decision: 'acknowledge' }),
    );
    expect(second.status).toBe(200);
    // decided_count == max_count → the permissive `count` barrier is open.
    const run = runs.getById(runId);
    expect(run?.state).toBe('draining');
    expect(run?.drain_cause).toBe('count');
    expect(run?.drain_strength).toBe('permissive');
    expect(run?.decided_count).toBe(2);
  });

  it('#10 a produced-basis run does NOT open a count barrier on decide', async () => {
    const runId = startRun({ max_count: 1, max_count_basis: 'produced' });
    messages.create(classifiedMessage({ message_id: 'm1', run_id: runId, kind: 'informational' }));

    await router.handle(
      ownerReq(`/v1/run/${runId}/decide`, { message_id: 'm1', decision: 'acknowledge' }),
    );
    // decided_count bumped, but basis is produced → no barrier from a decision.
    expect(runs.getById(runId)?.state).toBe('active');
  });

  it('#11 an expired message can never be decided and is transitioned → expired', async () => {
    const runId = startRun();
    messages.create(
      classifiedMessage({
        message_id: 'm1',
        run_id: runId,
        kind: 'action',
        expires_at: Date.now() - 1000, // already past its own signed expiry
      }),
    );

    const resp = await router.handle(
      ownerReq(`/v1/run/${runId}/decide`, { message_id: 'm1', decision: 'approve' }),
    );
    expect(resp.status).toBe(409);
    expect((resp.body as { reason: string }).reason).toMatch(/expired/);
    expect(messages.getById('m1')?.state).toBe('expired');
  });
});
