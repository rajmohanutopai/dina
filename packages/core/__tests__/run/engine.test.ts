/**
 * ISVC-10 — the active-engine driver (pacer + dispatch tick).
 * INTERACTIVE_SERVICES_ARCHITECTURE.md §7/§8/§11.
 */

import { AdmissionService } from '../../src/run/admission';
import { RunDispatchService } from '../../src/run/dispatch';
import { RunEngine, type RunEngineOptions } from '../../src/run/engine';
import { InMemoryMessageRepository, type MessageRecord } from '../../src/run/message';
import { InMemoryRunRepository } from '../../src/run/repository';
import { InMemoryReservationRepository } from '../../src/run/reservation';
import { RunService } from '../../src/run/service';

import type { RunRecord } from '../../src/run/domain';

const NOW = 1_700_000_000_000;

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: 'r1',
    idempotency_key: 'k1',
    service_uri: 'at://x/y/z',
    provider_did: 'did:plc:p',
    persona: 'general',
    transport: 'pull',
    push_grant_ref: null,
    provider_grant_id: null,
    provider_grant_expires_at_sec: null,
    interval_ms: 0,
    next_fetch_at: NOW,
    queue_cap: 4,
    action_risk_ceiling: 'MODERATE',
    priority_ceiling: 'solicited',
    classify_timeout_ms: 15_000,
    muted: false,
    on_stop: 'cancel_pending',
    erasure_mode: 'logical_deletion',
    paused_reason: null,
    stop_on_command: true,
    max_count: null,
    max_count_basis: 'decided',
    stop_on_exhaustion: true,
    expires_at: NOW + 3_600_000,
    drain_deadline_ms: 60_000,
    drain_deadline_at: null,
    drain_cause: null,
    drain_strength: null,
    config_version: 0,
    fetch_cursor: 0,
    last_commit_at: null,
    produced_count: 0,
    decided_count: 0,
    state: 'active',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function makeMsg(over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    message_id: 'm1',
    run_id: 'r1',
    reservation_id: 'res1',
    dedup_key: 'd1',
    sequence: 1,
    kind: 'action',
    action_type: 'book',
    risk_class: 'SAFE',
    state: 'risk_authorized',
    decision: 'approve',
    decision_revision: 7,
    delegation_id: null,
    expires_at: NOW + 60_000,
    payload_ref: 'cid1',
    content_digest: null,
    tier_candidate: null,
    final_tier: 2,
    tier_source: 'action_base',
    reconciliation_evidence: '[]',
    shred_after: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

interface Harness {
  runs: InMemoryRunRepository;
  messages: InMemoryMessageRepository;
  reservations: InMemoryReservationRepository;
  admission: AdmissionService;
  runService: RunService;
  dispatch: RunDispatchService;
}

function setup(opts: { personaOpen?: boolean } = {}): Harness {
  const runs = new InMemoryRunRepository();
  const messages = new InMemoryMessageRepository();
  const reservations = new InMemoryReservationRepository();
  const admission = new AdmissionService({
    runRepo: runs,
    reservationRepo: reservations,
    isPersonaOpen: () => opts.personaOpen ?? true,
    nowMsFn: () => NOW,
  });
  const runService = new RunService({ repository: runs, nowMsFn: () => NOW });
  const dispatch = new RunDispatchService({
    messageRepo: messages,
    runRepo: runs,
    nowMsFn: () => NOW,
    isPersonaOpen: () => opts.personaOpen ?? true,
  });
  return { runs, messages, reservations, admission, runService, dispatch };
}

function makeEngine(h: Harness, over: Partial<RunEngineOptions> = {}): RunEngine {
  return new RunEngine({
    runRepo: h.runs,
    messageRepo: h.messages,
    reservationRepo: h.reservations,
    admission: h.admission,
    runService: h.runService,
    dispatch: h.dispatch,
    emitQuery: () => Promise.resolve(),
    emitDelegation: () => Promise.resolve(),
    nowMsFn: () => NOW,
    ...over,
  });
}

describe('RunEngine.pacerTick (§7/§11)', () => {
  it('reserves a slot on an active pull run and emits the query', async () => {
    const h = setup();
    h.runs.create(makeRun());
    const emitted: { runId: string; reservationId: string; cursor: number; correlationId: string }[] = [];
    const engine = makeEngine(h, {
      emitQuery: async ({ run, reservationId, cursor, correlationId }) => {
        emitted.push({ runId: run.run_id, reservationId, cursor, correlationId });
      },
    });

    const report = await engine.pacerTick();

    expect(report).toEqual({ reserved: 1, sent: 1, failed: 0 });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].cursor).toBe(0);
    // The engine stamped a correlation id onto the reservation BEFORE egress, and
    // handed that exact id to the egress effect — so the response ingress can
    // resolve the slot with NO manual tagging.
    expect(emitted[0].correlationId).toBeTruthy();
    expect(h.reservations.getByCorrelation(emitted[0].correlationId)?.reservation_id).toBe(
      emitted[0].reservationId,
    );
    // The reservation is open (reserved), awaiting the correlated response.
    expect(h.reservations.countOpen('r1')).toBe(1);
  });

  it('skips PUSH runs and non-active runs', async () => {
    const h = setup();
    h.runs.create(makeRun({ run_id: 'pull-active', idempotency_key: 'k-pull' }));
    h.runs.create(
      makeRun({
        run_id: 'push-run',
        idempotency_key: 'k-push',
        transport: 'push_reserved',
        next_fetch_at: null,
      }),
    );
    h.runs.create(makeRun({ run_id: 'paused', idempotency_key: 'k-paused', state: 'paused' }));
    let calls = 0;
    const engine = makeEngine(h, {
      emitQuery: async () => {
        calls++;
      },
    });

    const report = await engine.pacerTick();

    expect(report.reserved).toBe(1); // only pull-active
    expect(calls).toBe(1);
  });

  it('a send failure RELEASES the slot so the cursor is retried, not skipped', async () => {
    const h = setup();
    h.runs.create(makeRun());
    const engine = makeEngine(h, {
      emitQuery: async () => {
        throw new Error('egress down');
      },
    });

    const report = await engine.pacerTick();

    expect(report).toEqual({ reserved: 1, sent: 0, failed: 1 });
    // Slot released → no open reservation holds the cursor; fetch_cursor unmoved.
    expect(h.reservations.countOpen('r1')).toBe(0);
    expect(h.runs.getById('r1')?.fetch_cursor).toBe(0);
  });

  it('does not reserve when the persona is locked', async () => {
    const h = setup({ personaOpen: false });
    h.runs.create(makeRun());
    let calls = 0;
    const engine = makeEngine(h, {
      emitQuery: async () => {
        calls++;
      },
    });

    const report = await engine.pacerTick();

    expect(report.reserved).toBe(0);
    expect(calls).toBe(0);
  });

  it('a past-TTL run gets the expiry barrier set immediately, not silently skipped (F9)', async () => {
    const h = setup();
    h.runs.create(makeRun({ expires_at: NOW - 1_000 })); // already past its hard TTL
    const engine = makeEngine(h);

    const report = await engine.pacerTick();

    expect(report.reserved).toBe(0);
    // The pacer opened the fencing expiry barrier rather than looping silently.
    expect(h.runs.getById('r1')?.state).toBe('draining');
    expect(h.runs.getById('r1')?.drain_cause).toBe('expiry');
  });

  it('an expired provider grant surfaces provider_grant_unavailable on /status (F9)', async () => {
    const h = setup();
    h.runs.create(
      makeRun({
        provider_grant_id: 'g1',
        provider_grant_expires_at_sec: Math.floor(NOW / 1000) - 100, // expired
      }),
    );
    const engine = makeEngine(h);

    const report = await engine.pacerTick();

    expect(report.reserved).toBe(0);
    // The run is marked fetch-paused with a reason instead of silently idle.
    expect(h.runs.getById('r1')?.paused_reason).toBe('provider_grant_unavailable');
    expect(h.runs.getById('r1')?.state).toBe('active'); // still active, just fetch-paused
  });

  it('an invalidated (revoked/expired) grant NEVER fetches, then recovers on a valid grant (F9)', async () => {
    // The V1 pull posture for grant loss (§10/§12.5): a run whose bound grant is
    // no longer valid must NOT keep querying the provider against a dead grant —
    // the pacer pauses it. (The full push block→revocation cascade is a deferred
    // §19 contract; here we prove the pull-side pacer connection: an invalid grant
    // emits ZERO queries.) Mid-run invalidation is modelled by a past expiry.
    const h = setup();
    const nowSec = Math.floor(NOW / 1000);
    h.runs.create(
      makeRun({ provider_grant_id: 'g1', provider_grant_expires_at_sec: nowSec - 1 }),
    );
    const emitted: string[] = [];
    const engine = makeEngine(h, {
      emitQuery: async ({ run }) => {
        emitted.push(run.run_id);
      },
    });

    // Invalid grant → no reservation, and CRUCIALLY no query ever leaves.
    await engine.pacerTick();
    expect(emitted).toHaveLength(0);
    expect(h.runs.getById('r1')?.paused_reason).toBe('provider_grant_unavailable');

    // Owner rebinds a still-valid grant (§7.1 replacement / §10 recovery): the
    // pacer resumes, clears the pause marker, and fetches. This drives the pacer
    // LAYER via the same `updateConfig` patch the real `/update` route emits; the
    // route-level wiring (that `/start` + `/update` actually PERSIST the grant
    // expiry, not just the id) is covered by run_decide.test.ts "persists provider
    // grant expiry through /start and a rebinding /update (F9)".
    h.runs.updateConfig(
      'r1',
      { provider_grant_id: 'g2', provider_grant_expires_at_sec: nowSec + 3_600 },
      0,
      NOW,
    );
    await engine.pacerTick();
    expect(emitted).toEqual(['r1']);
    expect(h.runs.getById('r1')?.paused_reason).toBeNull();
  });

  it('paces DUE runs (fair by next_fetch_at), never starved by older not-due runs (F8)', async () => {
    const h = setup();
    // An OLDER run that recently fetched — its next_fetch_at is in the future, so
    // it is NOT due and must NOT occupy the (tiny) pacer page ...
    h.runs.create(
      makeRun({ run_id: 'old-notdue', idempotency_key: 'k-old', next_fetch_at: NOW + 60_000 }),
    );
    // ... a NEWER run that is due now must still be paced.
    h.runs.create(makeRun({ run_id: 'new-due', idempotency_key: 'k-new', next_fetch_at: NOW }));
    const emitted: string[] = [];
    const engine = makeEngine(h, {
      pageLimit: 1, // even a page of ONE goes to the DUE run, not the oldest-created
      emitQuery: ({ run }) => {
        emitted.push(run.run_id);
        return Promise.resolve();
      },
    });

    const report = await engine.pacerTick();

    expect(report.reserved).toBe(1);
    expect(emitted).toEqual(['new-due']); // the old not-due run never starves it
  });
});

describe('RunEngine.dispatchTick (§8)', () => {
  it('claims a risk_authorized action, emits the delegation, marks it dispatched', async () => {
    const h = setup();
    h.runs.create(makeRun());
    h.messages.create(makeMsg({ state: 'risk_authorized' }));
    const emitted: string[] = [];
    const engine = makeEngine(h, {
      emitDelegation: async ({ delegationId }) => {
        emitted.push(delegationId);
      },
    });

    const report = await engine.dispatchTick();

    expect(report).toEqual({ risk_evaluated: 0, claimed: 1, sent: 1, retried: 0 });
    expect(emitted).toHaveLength(1);
    expect(h.messages.getById('m1')?.state).toBe('dispatched');
    expect(h.messages.getById('m1')?.delegation_id).toBe(emitted[0]);
  });

  it('R5-05: dispatches an authorized action even when >pageLimit older idle runs precede it', async () => {
    const h = setup();
    // Three idle-but-active runs created EARLIER, each carrying only a
    // non-actionable message. The old `listByState('active', pageLimit)` page
    // would be entirely these, hiding the later run's authorized action forever.
    for (let i = 0; i < 3; i += 1) {
      h.runs.create(makeRun({ run_id: `idle-${i}`, idempotency_key: `k-idle-${i}`, created_at: NOW + i }));
      h.messages.create(
        makeMsg({ message_id: `im-${i}`, run_id: `idle-${i}`, state: 'classified', created_at: NOW + i }),
      );
    }
    // A LATER run with an owner-authorized action.
    h.runs.create(makeRun({ run_id: 'act', idempotency_key: 'k-act', created_at: NOW + 100 }));
    h.messages.create(
      makeMsg({ message_id: 'am', run_id: 'act', state: 'risk_authorized', created_at: NOW + 100 }),
    );
    const emitted: string[] = [];
    const engine = makeEngine(h, {
      pageLimit: 2, // smaller than the idle-run count, to expose the old starvation
      emitDelegation: async ({ delegationId }) => void emitted.push(delegationId),
    });

    const report = await engine.dispatchTick();

    expect(report.claimed).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(h.messages.getById('am')?.state).toBe('dispatched');
  });

  it('runs the risk gate: an owner-approved SAFE action → risk_authorized → dispatched in one pass', async () => {
    const h = setup();
    h.runs.create(makeRun());
    // Owner just approved a SAFE action; the risk gate has not run yet.
    h.messages.create(makeMsg({ state: 'approved', risk_class: 'SAFE' }));
    const engine = makeEngine(h);

    const report = await engine.dispatchTick();

    expect(report.risk_evaluated).toBe(1);
    expect(report.claimed).toBe(1);
    expect(report.sent).toBe(1);
    expect(h.messages.getById('m1')?.state).toBe('dispatched');
  });

  it('a MODERATE approved action gates to risk_pending and is NOT dispatched (awaits owner confirm)', async () => {
    const h = setup();
    h.runs.create(makeRun({ action_risk_ceiling: 'HIGH' }));
    h.messages.create(makeMsg({ state: 'approved', risk_class: 'MODERATE' }));
    let calls = 0;
    const engine = makeEngine(h, {
      emitDelegation: async () => {
        calls++;
      },
    });

    const report = await engine.dispatchTick();

    expect(report.risk_evaluated).toBe(1);
    expect(report.claimed).toBe(0);
    expect(calls).toBe(0);
    expect(h.messages.getById('m1')?.state).toBe('risk_pending');
  });

  it('an ambiguous send is LEFT sending to retry, never falsely marked failed (F7/§6.2)', async () => {
    const h = setup();
    h.runs.create(makeRun());
    h.messages.create(makeMsg({ state: 'risk_authorized' }));
    let attempts = 0;
    const engine = makeEngine(h, {
      emitDelegation: () => {
        attempts++;
        return Promise.reject(new Error('egress down / ambiguous'));
      },
    });

    const report = await engine.dispatchTick();

    expect(report).toEqual({ risk_evaluated: 0, claimed: 1, sent: 0, retried: 1 });
    // The row stays `sending` (a possibly-effected action is NEVER dropped as
    // failed); the delegation id is minted + stable for the resend.
    expect(h.messages.getById('m1')?.state).toBe('sending');
    expect(h.messages.getById('m1')?.delegation_id).not.toBeNull();

    // A SECOND tick re-drives the durable `sending` row with the SAME delegation
    // id (at-least-once) — this time egress succeeds → dispatched.
    let secondId = '';
    const engine2 = makeEngine(h, {
      emitDelegation: ({ delegationId }) => {
        secondId = delegationId;
        return Promise.resolve();
      },
    });
    const report2 = await engine2.dispatchTick();
    expect(report2).toEqual({ risk_evaluated: 0, claimed: 0, sent: 1, retried: 0 });
    expect(secondId).toBe(h.messages.getById('m1')?.delegation_id);
    expect(h.messages.getById('m1')?.state).toBe('dispatched');
    expect(attempts).toBe(1);
  });

  it('does not claim a message whose run is fencing-draining (guard fails)', async () => {
    const h = setup();
    h.runs.create(
      makeRun({
        state: 'draining',
        drain_cause: 'cancel_pending',
        drain_strength: 'fencing',
        drain_deadline_at: NOW + 30_000,
      }),
    );
    h.messages.create(makeMsg({ state: 'risk_authorized' }));
    let calls = 0;
    const engine = makeEngine(h, {
      emitDelegation: async () => {
        calls++;
      },
    });

    const report = await engine.dispatchTick();

    expect(report.claimed).toBe(0);
    expect(calls).toBe(0);
    expect(h.messages.getById('m1')?.state).toBe('risk_authorized'); // untouched
  });

  it('dispatches a cause-retained approval on a draining-PERMISSIVE run before its deadline', async () => {
    const h = setup();
    h.runs.create(
      makeRun({
        state: 'draining',
        drain_cause: 'finish_pending',
        drain_strength: 'permissive',
        drain_deadline_at: NOW + 30_000,
      }),
    );
    h.messages.create(makeMsg({ state: 'risk_authorized' }));
    const engine = makeEngine(h);

    const report = await engine.dispatchTick();

    expect(report.claimed).toBe(1);
    expect(h.messages.getById('m1')?.state).toBe('dispatched');
  });

  it('ignores messages not in risk_authorized', async () => {
    const h = setup();
    h.runs.create(makeRun());
    h.messages.create(makeMsg({ message_id: 'pending', state: 'risk_pending' }));
    h.messages.create(makeMsg({ message_id: 'classified', state: 'classified' }));
    const engine = makeEngine(h);

    const report = await engine.dispatchTick();

    expect(report.claimed).toBe(0);
  });
});

describe('RunEngine.tick', () => {
  it('runs the pacer then the dispatch pass', async () => {
    const h = setup();
    h.runs.create(makeRun());
    h.messages.create(makeMsg({ state: 'risk_authorized' }));
    const engine = makeEngine(h);

    const report = await engine.tick();

    expect(report.pacer.reserved).toBe(1);
    expect(report.dispatch.claimed).toBe(1);
  });
});
