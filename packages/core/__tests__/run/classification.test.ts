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
    content_digest: null,
    tier_candidate: null,
    final_tier: null,
    tier_source: null,
    reconciliation_evidence: '[]',
    shred_after: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function setup(
  opts: {
    ceiling?: PriorityCeiling;
    runState?: RunRecord['state'];
    personaOpen?: boolean;
    onClassified?: (message: MessageRecord, run: RunRecord) => void;
  } = {},
) {
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
    ...(opts.onClassified !== undefined ? { onClassified: opts.onClassified } : {}),
  });
  return { messages, jobs, runs, svc };
}

describe('onClassified sink (R5-02)', () => {
  it('fires post-commit for an ACTION fast-path classification', () => {
    const seen: { id: string; kind: string }[] = [];
    const { messages, svc } = setup({
      onClassified: (m) => seen.push({ id: m.message_id, kind: m.kind }),
    });
    messages.create(makeMsg({ message_id: 'a', kind: 'action', action_type: 'book' }));
    svc.beginClassification('a');
    expect(seen).toEqual([{ id: 'a', kind: 'action' }]);
  });

  it('does NOT fire for an informational message until its tier finalizes, then fires once', () => {
    const seen: string[] = [];
    const { messages, svc } = setup({ onClassified: (m) => seen.push(m.message_id) });
    messages.create(makeMsg({ message_id: 'i', kind: 'informational' }));
    svc.beginClassification('i'); // job created; not yet classified
    expect(seen).toEqual([]);
    const acq = svc.workerAcquire();
    expect(acq).not.toBeNull();
    expect(svc.workerReport('i', acq!.message_revision, acq!.lease_token, 3)).toBe('ok');
    expect(seen).toEqual(['i']); // fired exactly once, post-commit
  });

  it('fires for a classify-timeout finalization, and a sink throw never breaks classification', () => {
    const { messages, svc } = setup({
      onClassified: () => {
        throw new Error('sink exploded');
      },
    });
    messages.create(makeMsg({ message_id: 'i', kind: 'informational' }));
    svc.beginClassification('i');
    expect(() => svc.finalizeTimeout('i')).not.toThrow();
    expect(messages.getById('i')?.state).toBe('classified'); // commit unaffected
  });
});

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

  it('rejects a report on an EXPIRED lease even with the correct token (F11/§12.6)', () => {
    const messages = new InMemoryMessageRepository();
    const jobs = new InMemoryClassificationJobRepository();
    const runs = new InMemoryRunRepository();
    runs.create(makeRun({ state: 'active' }));
    let now = NOW;
    const svc = new RunClassifyService({
      messageRepo: messages,
      jobRepo: jobs,
      runRepo: runs,
      nowMsFn: () => now,
      idFn: () => 'lease-exp',
      leaseMs: 30_000,
    });
    messages.create(makeMsg({ message_id: 'i', kind: 'informational' }));
    svc.beginClassification('i');
    const acq = svc.workerAcquire();
    if (acq === null) throw new Error('acquire failed');
    now = NOW + 40_000; // past the 30s lease window
    expect(svc.workerReport('i', acq.message_revision, acq.lease_token, 3)).toBe('rejected');
    // Stale Brain work never finalizes the tier — the fallback/fence owns it now.
    expect(messages.getById('i')?.state).toBe('classification_pending');
  });

  it('rejects a report when the persona LOCKED after acquire (F11/§12.6)', () => {
    const messages = new InMemoryMessageRepository();
    const jobs = new InMemoryClassificationJobRepository();
    const runs = new InMemoryRunRepository();
    runs.create(makeRun({ state: 'active' }));
    let open = true;
    const svc = new RunClassifyService({
      messageRepo: messages,
      jobRepo: jobs,
      runRepo: runs,
      nowMsFn: () => NOW,
      idFn: () => 'lease-lock',
      isPersonaOpen: () => open,
    });
    messages.create(makeMsg({ message_id: 'i', kind: 'informational' }));
    svc.beginClassification('i');
    const acq = svc.workerAcquire();
    if (acq === null) throw new Error('acquire failed');
    open = false; // persona locks between acquire and report
    expect(svc.workerReport('i', acq.message_revision, acq.lease_token, 3)).toBe('rejected');
    expect(messages.getById('i')?.state).toBe('classification_pending');
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

  it('sweepTimeouts finalizes messages past classify_timeout when Brain never reports (F12/§9.1)', () => {
    const messages = new InMemoryMessageRepository();
    const jobs = new InMemoryClassificationJobRepository();
    const runs = new InMemoryRunRepository();
    runs.create(makeRun({ state: 'active', classify_timeout_ms: 15_000 }));
    let now = NOW;
    const svc = new RunClassifyService({
      messageRepo: messages,
      jobRepo: jobs,
      runRepo: runs,
      nowMsFn: () => now,
    });
    messages.create(makeMsg({ message_id: 'i', kind: 'informational' }));
    svc.beginClassification('i'); // pending job created at NOW

    // Not yet elapsed → the sweep finalizes nothing.
    now = NOW + 10_000;
    expect(svc.sweepTimeouts()).toBe(0);
    expect(messages.getById('i')?.state).toBe('classification_pending');

    // Past classify_timeout, Brain never acquired/reported → the sweep is the
    // fallback that finalizes it at the ceiling (Brain is NOT load-bearing).
    now = NOW + 20_000;
    expect(svc.sweepTimeouts()).toBe(1);
    const m = messages.getById('i');
    expect(m?.state).toBe('classified');
    expect(m?.final_tier).not.toBeNull();
    expect(jobs.getByMessage('i')?.state).toBe('timed_out');
    // Idempotent: nothing left to finalize.
    expect(svc.sweepTimeouts()).toBe(0);
  });

  it('sweepTimeouts drains DUE jobs hidden beyond the 200-scan window behind not-yet-due jobs (F12 backlog, §9.1)', () => {
    // Regression for the real starvation: a single `listPending(200)` scan can
    // hide DUE work behind >200 EARLIER jobs whose longer `classify_timeout_ms`
    // has NOT elapsed. Here 205 not-yet-due jobs (created first, so oldest) fill
    // and exceed the page window; the 5 genuinely-due jobs sort AFTER them. The
    // old single-window sweep would return 0 (all it sees are not-due); the
    // keyset-paged sweep must page past them and finalize every due job — incl.
    // one a Brain worker leased then died on (still `pending`, lease expired).
    const messages = new InMemoryMessageRepository();
    const jobs = new InMemoryClassificationJobRepository();
    const runs = new InMemoryRunRepository();
    let now = NOW;
    const svc = new RunClassifyService({
      messageRepo: messages,
      jobRepo: jobs,
      runRepo: runs,
      nowMsFn: () => now,
    });

    // A run whose classify window is far in the future → its jobs are NEVER due
    // in this test. Created at NOW so they are the OLDEST (fill the scan window).
    runs.create(
      makeRun({ run_id: 'run-nd', idempotency_key: 'k-nd', classify_timeout_ms: 10_000_000 }),
    );
    const ND = 205; // strictly greater than the 200 page limit
    now = NOW;
    for (let i = 0; i < ND; i++) {
      messages.create(makeMsg({ message_id: `nd-${i}`, run_id: 'run-nd', dedup_key: `dnd-${i}` }));
      svc.beginClassification(`nd-${i}`);
    }

    // A run with a short window → its jobs ARE due. Created LATER (created_at =
    // NOW + 1000) so every one sorts AFTER all 205 not-due jobs — i.e. beyond the
    // first 200-row page.
    runs.create(
      makeRun({ run_id: 'run-due', idempotency_key: 'k-due', classify_timeout_ms: 15_000 }),
    );
    const DUE = 5;
    now = NOW + 1_000;
    for (let i = 0; i < DUE; i++) {
      // Long message TTL so the sweep at NOW+100_000 finalizes them on the
      // classify-timeout path — NOT skipped as past-expiry (§18 hard bound).
      messages.create(
        makeMsg({
          message_id: `due-${i}`,
          run_id: 'run-due',
          dedup_key: `ddue-${i}`,
          expires_at: NOW + 10_000_000,
        }),
      );
      svc.beginClassification(`due-${i}`);
    }
    // A dead-worker lease on a due job (still `pending`; lease expires before sweep).
    expect(jobs.acquire('due-2', 'tok', NOW + 1_000 + 5_000, NOW + 1_000)).toBe(true);

    // Past the due window (created NOW+1000, timeout 15s ⇒ due at NOW+16000) and
    // past the lease — but NOT past the not-due window (10_000_000 ms).
    now = NOW + 100_000;

    // The keyset sweep pages past the 205 not-due jobs and finalizes all 5 due.
    expect(svc.sweepTimeouts()).toBe(DUE);
    for (let i = 0; i < DUE; i++) {
      expect(messages.getById(`due-${i}`)?.state).toBe('classified');
      expect(jobs.getByMessage(`due-${i}`)?.state).toBe('timed_out');
    }
    // The not-due jobs are untouched (still pending), including the leased one's peers.
    expect(messages.getById('nd-0')?.state).toBe('classification_pending');
    expect(jobs.getByMessage('nd-204')?.state).toBe('pending');
    // Idempotent: a second sweep finalizes nothing new.
    expect(svc.sweepTimeouts()).toBe(0);
  });
});

describe('classify atomicity — the transition + tier writes are one tx unit (§6.3)', () => {
  // A tx that SKIPS its body models a rolled-back transaction: if every mutation
  // is inside the tx, skipping it must leave NO partial state (no message marked
  // classified with a null tier, no job report without the paired transition).
  const skipTx = (_fn: () => void) => {
    /* rolled back — run nothing */
  };

  function makeSvc(tx: (fn: () => void) => void) {
    const messages = new InMemoryMessageRepository();
    const jobs = new InMemoryClassificationJobRepository();
    const runs = new InMemoryRunRepository();
    runs.create(makeRun());
    const svc = new RunClassifyService({
      messageRepo: messages,
      jobRepo: jobs,
      runRepo: runs,
      nowMsFn: () => NOW,
      idFn: () => 'lease-1',
      tx,
    });
    return { messages, jobs, runs, svc };
  }

  it('beginClassification: a rolled-back tx leaves an ACTION message enqueued (no half-classified)', () => {
    const { messages, svc } = makeSvc(skipTx);
    messages.create(makeMsg({ message_id: 'a', kind: 'action' }));
    svc.beginClassification('a');
    // every write was inside the tx → nothing applied
    expect(messages.getById('a')?.state).toBe('enqueued');
    expect(messages.getById('a')?.final_tier).toBeNull();
  });

  it('beginClassification: a committed tx fully classifies the ACTION message with a tier', () => {
    const { messages, svc } = makeSvc((fn) => fn());
    messages.create(makeMsg({ message_id: 'a', kind: 'action' }));
    svc.beginClassification('a');
    expect(messages.getById('a')?.state).toBe('classified');
    expect(messages.getById('a')?.final_tier).not.toBeNull();
  });

  it('workerReport: a rolled-back tx applies NOTHING and reports rejected (no orphan job report)', () => {
    // First classify with a real tx so a pending job exists.
    const real = makeSvc((fn) => fn());
    real.messages.create(makeMsg({ message_id: 'i', kind: 'informational' }));
    real.svc.beginClassification('i');
    const acq = real.svc.workerAcquire();
    if (acq === null) throw new Error('expected an acquirable job');

    // Now report through a service whose tx rolls back — outcome is rejected and
    // the message stays classification_pending (transition + tier never applied).
    const rolled = new RunClassifyService({
      messageRepo: real.messages,
      jobRepo: real.jobs,
      runRepo: real.runs,
      nowMsFn: () => NOW,
      tx: skipTx,
    });
    const outcome = rolled.workerReport('i', acq.message_revision, acq.lease_token, 3);
    expect(outcome).toBe('rejected');
    expect(real.messages.getById('i')?.state).toBe('classification_pending');
    expect(real.messages.getById('i')?.final_tier).toBeNull();
  });
});
