/**
 * ISVC-10 (E76-08) — the owner MODERATE/HIGH risk-confirmation route
 * `POST /v1/run/:id/confirm-risk`. The engine auto-authorizes SAFE actions and
 * parks MODERATE/HIGH (incl. the fail-safe null→MODERATE default) in
 * `risk_pending`; ONLY this owner-only route advances them to `risk_authorized`.
 * Before E76-08 no route reached `authorizeRisk`, so no provider action could
 * ever dispatch.
 */

import {
  InMemoryCommandReceiptRepository,
  setCommandReceiptRepository,
} from '../../../src/run/command_receipt';
import {
  RunDispatchService,
  setRunDispatchService,
  setRunPayloadView,
} from '../../../src/run/dispatch';
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

const OWNER_CAP = 'test-owner-capability-secret';
const NOW = 1_700_000_000_000;
const FAR_FUTURE = Date.now() + 3_600_000;

let keySeq = 0;
function ownerReq(path: string, body: Record<string, unknown>): CoreRequest {
  return {
    method: 'POST',
    path,
    headers: {},
    query: {},
    body: { idempotency_key: `k-${++keySeq}`, ...body },
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'owner',
    ownerCapability: OWNER_CAP,
    callerDID: 'did:key:owner',
  } as unknown as CoreRequest;
}

function actionMessage(over: Partial<MessageRecord> & { message_id: string; run_id: string }): MessageRecord {
  return {
    reservation_id: null,
    dedup_key: `dedup-${over.message_id}`,
    sequence: 1,
    kind: 'action' as MessageKind,
    action_type: 'send',
    risk_class: null, // fail-safe → MODERATE → risk_pending
    state: 'risk_pending',
    decision: 'approve',
    decision_revision: 1,
    delegation_id: null,
    expires_at: FAR_FUTURE,
    payload_ref: null,
    content_digest: null,
    tier_candidate: null,
    final_tier: null,
    tier_source: null,
    reconciliation_evidence: '[]',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

describe('POST /v1/run/:id/confirm-risk (E76-08)', () => {
  let router: CoreRouter;
  let runs: InMemoryRunRepository;
  let messages: InMemoryMessageRepository;

  function startRun(): string {
    const run = new RunService({ repository: runs, nowMsFn: () => NOW }).create({
      service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
      provider_did: 'did:plc:prov',
      persona: 'general',
      idempotency_key: `idem-${Math.random()}`,
      expires_at: FAR_FUTURE,
    });
    return run.run_id;
  }

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    messages = new InMemoryMessageRepository();
    setRunRepository(runs);
    setMessageRepository(messages);
    setCommandReceiptRepository(new InMemoryCommandReceiptRepository());
    setRunService(new RunService({ repository: runs, nowMsFn: () => NOW }));
    setRunDispatchService(
      new RunDispatchService({
        messageRepo: messages,
        runRepo: runs,
        isPersonaOpen: () => true,
        nowMsFn: () => Date.now(),
        tx: (fn) => fn(),
      }),
    );
    router = new CoreRouter();
    registerRunRoutes(router, OWNER_CAP);
  });

  afterEach(() => {
    setRunService(null);
    setRunRepository(null);
    setMessageRepository(null);
    setCommandReceiptRepository(null);
    setRunDispatchService(null);
    setRunPayloadView(null);
  });

  it('advances a risk_pending action to risk_authorized', async () => {
    const runId = startRun();
    messages.create(actionMessage({ message_id: 'm1', run_id: runId }));
    const res = await router.handle(
      ownerReq(`/v1/run/${runId}/confirm-risk`, { message_id: 'm1' }),
    );
    expect(res.status).toBe(200);
    expect(messages.getById('m1')?.state).toBe('risk_authorized');
  });

  it('rejects a non-owner caller', async () => {
    const runId = startRun();
    messages.create(actionMessage({ message_id: 'm2', run_id: runId }));
    const req = ownerReq(`/v1/run/${runId}/confirm-risk`, { message_id: 'm2' });
    const res = await router.handle({ ...req, callerType: undefined } as unknown as CoreRequest);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(messages.getById('m2')?.state).toBe('risk_pending');
  });

  it('404s a message that is not in the addressed run', async () => {
    const runId = startRun();
    messages.create(actionMessage({ message_id: 'm3', run_id: 'some-other-run' }));
    const res = await router.handle(
      ownerReq(`/v1/run/${runId}/confirm-risk`, { message_id: 'm3' }),
    );
    expect(res.status).toBe(404);
  });

  it('is an idempotent no-op on a non-risk_pending message', async () => {
    const runId = startRun();
    messages.create(actionMessage({ message_id: 'm4', run_id: runId, state: 'risk_authorized' }));
    const res = await router.handle(
      ownerReq(`/v1/run/${runId}/confirm-risk`, { message_id: 'm4' }),
    );
    expect(res.status).toBe(200);
    expect(messages.getById('m4')?.state).toBe('risk_authorized');
  });

  it('/status surfaces classified as `pending` and risk_pending as `pending_risk` (E76-11)', async () => {
    const runId = startRun();
    messages.create(
      actionMessage({ message_id: 'p1', run_id: runId, state: 'classified', decision: null }),
    );
    messages.create(actionMessage({ message_id: 'r1', run_id: runId, state: 'risk_pending' }));
    const res = await router.handle({
      method: 'GET',
      path: `/v1/run/${runId}/status`,
      headers: {},
      query: {},
      body: {},
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'owner',
      ownerCapability: OWNER_CAP,
      callerDID: 'did:key:owner',
    } as unknown as CoreRequest);
    expect(res.status).toBe(200);
    const b = res.body as {
      service_uri: string;
      provider_did: string;
      pending: { message_id: string }[];
      pending_risk: { message_id: string }[];
    };
    expect(b.pending.map((m) => m.message_id)).toContain('p1');
    expect(b.pending_risk.map((m) => m.message_id)).toContain('r1');
    // 81B-06 — service attribution is always present (run-scoped).
    expect(b.service_uri).toBe('at://did:plc:prov/com.dinakernel.service.profile/self');
    expect(b.provider_did).toBe('did:plc:prov');
  });

  it('/status renders the bounded CardSpec title/body for decidable messages (81B-06)', async () => {
    // A registered payload-view resolver stands in for Core's decrypt+render; the
    // route must thread its output into each pending / pending_risk item so the owner
    // sees WHAT they are deciding, not just a digest.
    setRunPayloadView((messageId) => ({
      title: `Title-${messageId}`,
      body: `Body-${messageId}`,
    }));
    const runId = startRun();
    messages.create(
      actionMessage({ message_id: 'p1', run_id: runId, state: 'classified', decision: null }),
    );
    messages.create(actionMessage({ message_id: 'r1', run_id: runId, state: 'risk_pending' }));
    const res = await router.handle({
      method: 'GET',
      path: `/v1/run/${runId}/status`,
      headers: {},
      query: {},
      body: {},
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'owner',
      ownerCapability: OWNER_CAP,
      callerDID: 'did:key:owner',
    } as unknown as CoreRequest);
    expect(res.status).toBe(200);
    const b = res.body as {
      pending: { message_id: string; title: string; body: string }[];
      pending_risk: { message_id: string; title: string; body: string }[];
    };
    const p = b.pending.find((m) => m.message_id === 'p1');
    expect(p?.title).toBe('Title-p1');
    expect(p?.body).toBe('Body-p1');
    const r = b.pending_risk.find((m) => m.message_id === 'r1');
    expect(r?.title).toBe('Title-r1');
    expect(r?.body).toBe('Body-r1');
  });
});
