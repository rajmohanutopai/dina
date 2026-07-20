/**
 * R5-01 (§7) — the owner `response_lost` surface:
 *   GET  /v1/run/:id/status       → `lost: [{reservation_id, cursor, reason, at}]`
 *   POST /v1/run/:id/skip-lost    → terminal `skipped`; clears `paused_reason`
 *                                    once no lost slot remains.
 */

import {
  InMemoryCommandReceiptRepository,
  setCommandReceiptRepository,
} from '../../../src/run/command_receipt';
import { InMemoryMessageRepository, setMessageRepository } from '../../../src/run/message';
import { InMemoryRunRepository, setRunRepository } from '../../../src/run/repository';
import {
  InMemoryReservationRepository,
  setReservationRepository,
  type ReservationRecord,
} from '../../../src/run/reservation';
import { RunService, setRunService } from '../../../src/run/service';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerRunRoutes } from '../../../src/server/routes/run';

const OWNER_CAP = 'test-owner-capability-secret';
const NOW = 1_700_000_000_000;
const FAR_FUTURE = Date.now() + 3_600_000;

let keySeq = 0;
function ownerReq(method: 'GET' | 'POST', path: string, body: Record<string, unknown> = {}): CoreRequest {
  return {
    method,
    path,
    headers: {},
    query: {},
    body: method === 'POST' ? { idempotency_key: `k-${++keySeq}`, ...body } : {},
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'owner',
    ownerCapability: OWNER_CAP,
    callerDID: 'did:key:owner',
  } as unknown as CoreRequest;
}

function lostReservation(
  over: Partial<ReservationRecord> & { reservation_id: string; run_id: string },
): ReservationRecord {
  return {
    cursor: 0,
    state: 'response_lost',
    message_id: null,
    dedup_key: null,
    content_digest: null,
    sealed_response_ref: null,
    held_message_json: null,
    error_reason: 'blob_missing',
    error_at: NOW,
    lease_expires_at: null,
    query_correlation_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

describe('response_lost owner surface (R5-01/§7)', () => {
  let router: CoreRouter;
  let runs: InMemoryRunRepository;
  let reservations: InMemoryReservationRepository;

  function startPausedRun(): string {
    const run = new RunService({ repository: runs, nowMsFn: () => NOW }).create({
      service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
      provider_did: 'did:plc:prov',
      persona: 'general',
      idempotency_key: `idem-${Math.random()}`,
      expires_at: FAR_FUTURE,
    });
    runs.setPausedReason(run.run_id, 'response_lost', NOW);
    return run.run_id;
  }

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    reservations = new InMemoryReservationRepository();
    setRunRepository(runs);
    setReservationRepository(reservations);
    setMessageRepository(new InMemoryMessageRepository());
    setCommandReceiptRepository(new InMemoryCommandReceiptRepository());
    setRunService(new RunService({ repository: runs, nowMsFn: () => NOW }));
    router = new CoreRouter();
    registerRunRoutes(router, OWNER_CAP);
  });

  afterEach(() => {
    setRunService(null);
    setRunRepository(null);
    setReservationRepository(null);
    setMessageRepository(null);
    setCommandReceiptRepository(null);
  });

  it('/status surfaces lost slots in cursor order (metadata only)', async () => {
    const runId = startPausedRun();
    reservations.create(lostReservation({ reservation_id: 'l2', run_id: runId, cursor: 3, error_reason: 'corrupt' }));
    reservations.create(lostReservation({ reservation_id: 'l1', run_id: runId, cursor: 1 }));
    reservations.create(
      lostReservation({ reservation_id: 'c1', run_id: runId, cursor: 0, state: 'committed', error_reason: null }),
    );

    const res = await router.handle(ownerReq('GET', `/v1/run/${runId}/status`));
    expect(res.status).toBe(200);
    const b = res.body as { lost: { reservation_id: string; cursor: number; reason: string }[] };
    expect(b.lost.map((l) => l.reservation_id)).toEqual(['l1', 'l2']);
    expect(b.lost[0]).toEqual({ reservation_id: 'l1', cursor: 1, reason: 'blob_missing', at: NOW });
  });

  it('skip-lost skips the slot and clears paused_reason when it was the LAST lost slot', async () => {
    const runId = startPausedRun();
    reservations.create(lostReservation({ reservation_id: 'l1', run_id: runId, cursor: 1 }));

    const res = await router.handle(
      ownerReq('POST', `/v1/run/${runId}/skip-lost`, { reservation_id: 'l1' }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reservation_id: 'l1', state: 'skipped', fetch_resumed: true });
    expect(reservations.getById('l1')?.state).toBe('skipped');
    expect(runs.getById(runId)?.paused_reason).toBeNull();
  });

  it('skip-lost keeps paused_reason while OTHER lost slots remain', async () => {
    const runId = startPausedRun();
    reservations.create(lostReservation({ reservation_id: 'l1', run_id: runId, cursor: 1 }));
    reservations.create(lostReservation({ reservation_id: 'l2', run_id: runId, cursor: 2 }));

    const res = await router.handle(
      ownerReq('POST', `/v1/run/${runId}/skip-lost`, { reservation_id: 'l1' }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fetch_resumed: false });
    expect(runs.getById(runId)?.paused_reason).toBe('response_lost');
  });

  it('409s a reservation that is not response_lost (CAS guard)', async () => {
    const runId = startPausedRun();
    reservations.create(
      lostReservation({ reservation_id: 'c1', run_id: runId, cursor: 0, state: 'committed', error_reason: null }),
    );
    const res = await router.handle(
      ownerReq('POST', `/v1/run/${runId}/skip-lost`, { reservation_id: 'c1' }),
    );
    expect(res.status).toBe(409);
    expect(reservations.getById('c1')?.state).toBe('committed');
  });

  it('404s a reservation belonging to a DIFFERENT run', async () => {
    const runId = startPausedRun();
    reservations.create(lostReservation({ reservation_id: 'lx', run_id: 'other-run', cursor: 1 }));
    const res = await router.handle(
      ownerReq('POST', `/v1/run/${runId}/skip-lost`, { reservation_id: 'lx' }),
    );
    expect(res.status).toBe(404);
    expect(reservations.getById('lx')?.state).toBe('response_lost');
  });

  it('rejects a non-owner caller', async () => {
    const runId = startPausedRun();
    reservations.create(lostReservation({ reservation_id: 'l1', run_id: runId, cursor: 1 }));
    const req = ownerReq('POST', `/v1/run/${runId}/skip-lost`, { reservation_id: 'l1' });
    const res = await router.handle({ ...req, callerType: undefined } as unknown as CoreRequest);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(reservations.getById('l1')?.state).toBe('response_lost');
  });

  it('replays the SAME response for a duplicate idempotency key without re-executing', async () => {
    const runId = startPausedRun();
    reservations.create(lostReservation({ reservation_id: 'l1', run_id: runId, cursor: 1 }));
    const req = ownerReq('POST', `/v1/run/${runId}/skip-lost`, { reservation_id: 'l1' });
    const first = await router.handle(req);
    expect(first.status).toBe(200);
    // Same key + same body → replayed 200 (NOT the 409 the now-skipped state
    // would produce on a re-execute).
    const replay = await router.handle(req);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ state: 'skipped' });
  });
});
