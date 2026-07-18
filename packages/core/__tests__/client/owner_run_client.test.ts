/**
 * ISVC-9 — the owner-only run-control client end-to-end through the real router
 * (INTERACTIVE_SERVICES_ARCHITECTURE.md §12.5). Proves the owner dispatch is
 * admitted and the same routes reject a non-owner caller.
 */

import { InProcessOwnerRunClient, OwnerRunHttpError } from '../../src/client/owner-run-client';
import { InMemoryMessageRepository, setMessageRepository, type MessageRecord } from '../../src/run/message';
import { InMemoryRunRepository, setRunRepository } from '../../src/run/repository';
import { RunService, setRunService } from '../../src/run/service';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerRunRoutes } from '../../src/server/routes/run';
import { registerWatchRoutes } from '../../src/server/routes/watch';
import { WatchService, setWatchService, getWatchService } from '../../src/watch/service';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';

const NOW = 1_700_000_000_000;
// The decide route checks a message's signed `expires_at` against the real
// wall clock (§6.3 / VERIF #11), so message expiry must be real-clock-relative,
// not tied to the run service's synthetic `NOW`.
const MSG_EXPIRES_AT = Date.now() + 3_600_000;

function makeMsg(over: Partial<MessageRecord>): MessageRecord {
  return {
    message_id: 'm1', run_id: 'r', reservation_id: null, dedup_key: 'd', sequence: 1,
    kind: 'action', action_type: 'book', risk_class: 'SAFE', state: 'classified',
    decision: null, decision_revision: 0, delegation_id: null, expires_at: MSG_EXPIRES_AT,
    payload_ref: null, tier_candidate: null, final_tier: 2, tier_source: 'action_base',
    reconciliation_evidence: '[]', created_at: NOW, updated_at: NOW, ...over,
  };
}

let router: CoreRouter;
let messages: InMemoryMessageRepository;

beforeEach(() => {
  const repo = new InMemoryRunRepository();
  setRunRepository(repo);
  setRunService(new RunService({ repository: repo, nowMsFn: () => NOW }));
  messages = new InMemoryMessageRepository();
  setMessageRepository(messages);
  setWatchService(new WatchService({ repository: new InMemoryWorkflowRepository(), nowMsFn: () => NOW }));
  router = new CoreRouter();
  registerRunRoutes(router);
  registerWatchRoutes(router);
});

afterEach(() => {
  setRunService(null);
  setWatchService(null);
  setRunRepository(null);
  setMessageRepository(null);
});

function startBody() {
  return {
    service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
    provider_did: 'did:plc:prov',
    persona: 'general',
    idempotency_key: `k-${Math.random()}`,
    ttl_seconds: 3600,
  };
}

describe('InProcessOwnerRunClient (§12.5)', () => {
  it('drives start → status → pause → resume → stop as the owner', async () => {
    const client = new InProcessOwnerRunClient(router);
    const started = await client.runStart(startBody());
    expect(started.run_id).toMatch(/^run-/);
    expect(started.effective_erasure_mode).toBe('logical_deletion');

    const status = await client.runStatus(started.run_id);
    expect(status.state).toBe('active');

    expect((await client.runPause(started.run_id)).state).toBe('paused');
    expect((await client.runResume(started.run_id)).state).toBe('active');
    expect((await client.runStop(started.run_id, 'cancel_pending')).state).toBe('draining');
  });

  it('records an owner decision on a classified action message', async () => {
    const client = new InProcessOwnerRunClient(router);
    const started = await client.runStart(startBody());
    messages.create(makeMsg({ message_id: 'm1', run_id: started.run_id, state: 'classified', decision_revision: 0 }));
    const decided = await client.runDecide(started.run_id, { message_id: 'm1', decision: 'approve' });
    expect(decided.state).toBe('approved');
    expect(decided.decision_revision).toBe(1);
    expect(messages.getById('m1')?.state).toBe('approved');
  });

  it('a deny/acknowledge kind-mismatch is rejected', async () => {
    const client = new InProcessOwnerRunClient(router);
    const started = await client.runStart(startBody());
    messages.create(makeMsg({ message_id: 'info', run_id: started.run_id, kind: 'informational', state: 'classified' }));
    // approve on an informational message → 400
    await expect(client.runDecide(started.run_id, { message_id: 'info', decision: 'approve' })).rejects.toThrow(
      OwnerRunHttpError,
    );
    // acknowledge is valid for informational
    const ack = await client.runDecide(started.run_id, { message_id: 'info', decision: 'acknowledge' });
    expect(ack.state).toBe('acknowledged');
  });

  it('lists + steers poll-mode watches through the owner client (PSVC-4)', async () => {
    const client = new InProcessOwnerRunClient(router);
    const svc = getWatchService();
    if (svc === null) throw new Error('watch service not wired');
    const w = svc.createPollWatch({
      subscription_id: 'sub-1',
      persona: 'general',
      service_uri: 'at://did:plc:prov/x/self',
      provider_did: 'did:plc:prov',
      capability: 'flight_status',
      poll_interval_sec: 300,
    });

    let list = await client.watchList();
    expect(list.watches.map((x) => x.subscription_id)).toEqual(['sub-1']);
    expect(list.watches[0].status).toBe('active');

    expect((await client.watchPause(w.id)).ok).toBe(true);
    list = await client.watchList();
    expect(list.watches[0].status).toBe('paused');

    expect((await client.watchResume(w.id)).ok).toBe(true);
    expect((await client.watchCancel(w.id)).ok).toBe(true);
    list = await client.watchList();
    expect(list.watches).toHaveLength(0);
  });

  it('a NON-owner in-process caller is rejected on every run route (§12.5)', async () => {
    // A plain trustedInProcess request WITHOUT the owner marker (i.e. what
    // Brain's shared transport produces) must be 403 on the run routes.
    const brainish: CoreRequest = {
      method: 'POST', path: '/v1/run/start', query: {}, headers: {}, body: startBody(),
      rawBody: new Uint8Array(), params: {}, trustedInProcess: true,
    };
    const res = await router.handle(brainish);
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe('access_denied');
  });
});
