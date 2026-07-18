/**
 * ISVC-4 — the Brain-classify boundary + Core delivery order (§9.1/§12.6).
 */

import {
  InMemoryClassificationJobRepository,
  RunClassifyService,
} from '../../src/run/classification';
import { InMemoryMessageRepository, type MessageRecord } from '../../src/run/message';
import { InMemoryRunRepository } from '../../src/run/repository';

import type { PriorityCeiling, RunRecord } from '../../src/run/domain';

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
    kind: 'informational',
    action_type: null,
    risk_class: null,
    state: 'enqueued',
    decision: null,
    decision_revision: 0,
    delegation_id: null,
    expires_at: NOW + 60_000,
    payload_ref: 'cid1',
    tier_candidate: null,
    final_tier: null,
    tier_source: null,
    reconciliation_evidence: '[]',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function setup(opts: { ceiling?: PriorityCeiling; runState?: RunRecord['state']; personaOpen?: boolean } = {}) {
  const messages = new InMemoryMessageRepository();
  const jobs = new InMemoryClassificationJobRepository();
  const runs = new InMemoryRunRepository();
  runs.create(
    makeRun({
      priority_ceiling: opts.ceiling ?? 'solicited',
      state: opts.runState ?? 'active',
      drain_strength: opts.runState === 'draining' ? 'fencing' : null,
      drain_cause: opts.runState === 'draining' ? 'cancel_pending' : null,
    }),
  );
  let seq = 0;
  const svc = new RunClassifyService({
    messageRepo: messages,
    jobRepo: jobs,
    runRepo: runs,
    nowMsFn: () => NOW,
    idFn: () => `lease-${++seq}`,
    isPersonaOpen: () => opts.personaOpen ?? true,
    buildClassificationView: (m) => ({ title: `t-${m.message_id}`, body: 'b', content_digest: 'cd' }),
  });
  return { messages, jobs, runs, svc };
}

describe('beginClassification (§6.3)', () => {
  it('an ACTION takes the Tier-2 base directly, NO Brain job', () => {
    const { messages, jobs, svc } = setup();
    messages.create(makeMsg({ message_id: 'a', kind: 'action', action_type: 'book' }));
    svc.beginClassification('a');
    const m = messages.getById('a');
    expect(m?.state).toBe('classified');
    expect(m?.final_tier).toBe(2);
    expect(m?.tier_source).toBe('action_base');
    expect(jobs.getByMessage('a')).toBeNull(); // Brain never sees an action
  });

  it('owner engagement ceiling quiets an action to briefing', () => {
    const { messages, svc } = setup({ ceiling: 'engagement' });
    messages.create(makeMsg({ message_id: 'a', kind: 'action' }));
    svc.beginClassification('a');
    expect(messages.getById('a')?.final_tier).toBe(3);
  });

  it('an INFORMATIONAL message enters classification_pending + gets a pull job', () => {
    const { messages, jobs, svc } = setup();
    messages.create(makeMsg({ message_id: 'i', kind: 'informational' }));
    svc.beginClassification('i');
    expect(messages.getById('i')?.state).toBe('classification_pending');
    expect(jobs.getByMessage('i')?.state).toBe('pending');
  });
});

describe('workerAcquire / workerReport (§12.6)', () => {
  it('acquires only an eligible informational job, with a bounded view (no params/vault)', () => {
    const { messages, svc } = setup();
    messages.create(makeMsg({ message_id: 'i', kind: 'informational' }));
    messages.create(makeMsg({ message_id: 'a', kind: 'action' }));
    svc.beginClassification('i');
    svc.beginClassification('a');
    const acq = svc.workerAcquire();
    expect(acq?.message_id).toBe('i'); // the action is never offered
    expect(acq?.classification_view).not.toHaveProperty('params');
    expect(acq?.classification_view.title).toBe('t-i');
    // a second acquire returns null (leased)
    expect(svc.workerAcquire()).toBeNull();
  });

  it('report records a downward candidate + finalizes the tier; idempotent + stale-lease safe', () => {
    const { messages, svc } = setup();
    messages.create(makeMsg({ message_id: 'i', kind: 'informational' }));
    svc.beginClassification('i');
    const acq = svc.workerAcquire();
    if (acq === null) throw new Error('acquire failed');
    expect(svc.workerReport('i', acq.message_revision, acq.lease_token, 3)).toBe('ok');
    const m = messages.getById('i');
    expect(m?.state).toBe('classified');
    expect(m?.tier_candidate).toBe(3);
    expect(m?.final_tier).toBe(3);
    expect(m?.tier_source).toBe('brain_candidate');
    // a repeat report is rejected (message no longer classification_pending)
    expect(svc.workerReport('i', acq.message_revision, acq.lease_token, 2)).toBe('rejected');
  });

  it('a stale lease token is rejected', () => {
    const { messages, svc } = setup();
    messages.create(makeMsg({ message_id: 'i', kind: 'informational' }));
    svc.beginClassification('i');
    const acq = svc.workerAcquire();
    if (acq === null) throw new Error('acquire failed');
    expect(svc.workerReport('i', acq.message_revision, 'wrong-lease', 3)).toBe('rejected');
  });

  it('does not offer jobs when the persona is locked or the run is fencing-draining', () => {
    const locked = setup({ personaOpen: false });
    locked.messages.create(makeMsg({ message_id: 'i', kind: 'informational' }));
    locked.svc.beginClassification('i');
    expect(locked.svc.workerAcquire()).toBeNull();

    const fencing = setup({ runState: 'draining' });
    fencing.messages.create(makeMsg({ message_id: 'j', kind: 'informational' }));
    fencing.svc.beginClassification('j');
    expect(fencing.svc.workerAcquire()).toBeNull();
  });
});

describe('classify timeout + fence (§9.1/§12.6)', () => {
  it('finalizeTimeout classifies at the ceiling and times out the job', () => {
    const { messages, jobs, svc } = setup({ ceiling: 'engagement' });
    messages.create(makeMsg({ message_id: 'i', kind: 'informational' }));
    svc.beginClassification('i');
    svc.finalizeTimeout('i');
    const m = messages.getById('i');
    expect(m?.state).toBe('classified');
    expect(m?.final_tier).toBe(3); // engagement ceiling
    expect(m?.tier_source).toBe('classify_timeout_ceiling');
    expect(jobs.getByMessage('i')?.state).toBe('timed_out');
  });

  it('fenceJob cancels the job so a fenced message is never offered to Brain', () => {
    const { messages, jobs, svc } = setup();
    messages.create(makeMsg({ message_id: 'i', kind: 'informational' }));
    svc.beginClassification('i');
    svc.fenceJob('i', 'cancelled');
    expect(jobs.getByMessage('i')?.state).toBe('cancelled');
    expect(svc.workerAcquire()).toBeNull();
  });
});
