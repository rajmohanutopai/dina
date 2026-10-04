/**
 * A2A Lane 1 across an operation's whole life (design A2A-I7, A2A-I8, §6.2–
 * §6.5, §9, §12 M1a done-when): every ending tells the asking conversation
 * exactly once; every drift class voids dispatch; a restart at any stage
 * loses nothing and re-sends nothing; a remote's JSON-RPC error is read by
 * its code and the action's class; one bad operation never stalls the
 * sweeper; ended operations purge with everything that references them.
 */

import {
  A2A_ENDED_RETENTION_MS,
  A2A_OPERATION_ENDED_EVENT,
  A2A_RESULT_BLOCKED_EVENT,
  A2A_RESULT_HELD_EVENT,
  A2A_RESULT_RELEASED_EVENT,
  MAX_PROPOSALS_PER_HOUR,
  beginOutboundDispatch,
  bindRemoteSkill,
  buildOutgoingProjection,
  cancelOutboundOperation,
  claimNextGuardJob,
  mintOutboundPermit,
  proposeDelegation,
  purgeEndedA2AOperations,
  recordRemoteOutcome,
  submitGuardVerdict,
  sweepA2AOutbound,
  type DispatchClaim,
  type OutboundActionClass,
} from '../../src/a2a';

import { LEASE_MS, LaneWorld, RUNNER_DID, SESSION } from './outbound_fixture';

const A2A_KINDS = new Set([
  A2A_OPERATION_ENDED_EVENT,
  A2A_RESULT_RELEASED_EVENT,
  A2A_RESULT_BLOCKED_EVENT,
  A2A_RESULT_HELD_EVENT,
]);

let world: LaneWorld;
let agentId: string;
let credentialRef: string;

beforeEach(async () => {
  world = new LaneWorld();
  ({ agentId, credentialRef } = await world.activeAgent());
});
afterEach(() => world.close());

function propose(text = 'Summarize the attached note.', skill = 'summarize') {
  const out = proposeDelegation(world.runtime, { releaseSession: SESSION, agentId, skill, text, replyTo: 'main' });
  if (!out.ok) throw new Error(`propose: ${out.reason}`);
  return out;
}

function claimDispatch(): DispatchClaim {
  const task = world.claim(agentId);
  if (task === null) throw new Error('nothing to claim');
  return { childTaskId: task.id, claimId: task.claim_id as string, runnerDid: RUNNER_DID };
}

function op(operationId: string) {
  const row = world.store.getTaskByExternal('outbound', 'owner', operationId);
  if (row === null) throw new Error('no operation');
  return row;
}

/** Every A2A owner-delivery event on any of the operation's tasks, as [task role, kind]. */
function a2aEvents(operationId: string): [string, string][] {
  const row = op(operationId);
  return world.store.childrenOf(row.id).flatMap((child) =>
    world.repo
      .listEventsForTask(child.child_task_id)
      .filter((e) => A2A_KINDS.has(e.event_kind))
      .map((e): [string, string] => [child.role, e.event_kind]),
  );
}

function sending(text?: string) {
  const p = propose(text);
  world.workflow.approve(p.approvalTaskId);
  const claim = claimDispatch();
  const start = beginOutboundDispatch(world.runtime, claim);
  if (start.kind !== 'send') throw new Error(`expected send, got ${start.kind}`);
  return { p, claim, start };
}

describe('every ending tells the conversation exactly once (A2A-I7)', () => {
  const ENDED: [string, string][] = [['approval', A2A_OPERATION_ENDED_EVENT]];
  const ENDED_ON_DISPATCH: [string, string][] = [['dispatch', A2A_OPERATION_ENDED_EVENT]];

  it('the owner says no', () => {
    const p = propose();
    world.workflow.cancel(p.approvalTaskId, 'no');
    sweepA2AOutbound(world.runtime);
    expect(op(p.operationId)).toMatchObject({ state: 'refused' });
    expect(a2aEvents(p.operationId)).toEqual(ENDED);
  });

  it('the card lapses', () => {
    const p = propose();
    world.clock += 16 * 60_000;
    world.workflow.expireTasks(Math.floor(world.clock / 1000), world.clock);
    sweepA2AOutbound(world.runtime);
    expect(op(p.operationId)).toMatchObject({ state: 'expired' });
    expect(a2aEvents(p.operationId)).toEqual(ENDED);
  });

  it('the authority moved between proposal and approval (after the owner pressed Send)', () => {
    const p = propose();
    world.db.run(`UPDATE a2a_skill_bindings SET revision = revision + 1 WHERE remote_agent_id = ? AND skill = 'summarize'`, [agentId]);
    world.workflow.approve(p.approvalTaskId);
    expect(op(p.operationId)).toMatchObject({ state: 'stale_authority', reason_code: 'binding_changed' });
    expect(a2aEvents(p.operationId)).toEqual(ENDED);
  });

  it('the owner cancels before deciding, and after approving', () => {
    const before = propose('one');
    cancelOutboundOperation(world.runtime, before.operationId);
    expect(a2aEvents(before.operationId)).toEqual(ENDED);
    const after = propose('two');
    world.workflow.approve(after.approvalTaskId);
    cancelOutboundOperation(world.runtime, after.operationId);
    sweepA2AOutbound(world.runtime);
    expect(a2aEvents(after.operationId)).toEqual(ENDED_ON_DISPATCH);
  });

  it('drift voids the dispatch', () => {
    const p = propose();
    world.workflow.approve(p.approvalTaskId);
    const claim = claimDispatch();
    world.db.run(`UPDATE a2a_skill_bindings SET revision = revision + 1 WHERE remote_agent_id = ? AND skill = 'summarize'`, [agentId]);
    beginOutboundDispatch(world.runtime, claim);
    expect(a2aEvents(p.operationId)).toEqual(ENDED_ON_DISPATCH);
  });

  it('the remote fails, cancels, or leaves Dina unsure', () => {
    const failed = sending('a');
    recordRemoteOutcome(world.runtime, failed.claim, { kind: 'failed', reason: 'remote_failed' });
    expect(a2aEvents(failed.p.operationId)).toEqual(ENDED_ON_DISPATCH);
    const unsure = sending('b');
    recordRemoteOutcome(world.runtime, unsure.claim, { kind: 'unknown', reason: 'deadline' });
    expect(a2aEvents(unsure.p.operationId)).toEqual(ENDED_ON_DISPATCH);
  });

  it('the sweeper expires a queued operation whose child died, and closes a running one that ended unreported', () => {
    const queued = propose('q');
    world.workflow.approve(queued.approvalTaskId);
    const child = world.store.childrenOf(op(queued.operationId).id, 'dispatch')[0]?.child_task_id ?? '';
    world.db.run(`UPDATE workflow_tasks SET state = 'failed' WHERE id = ?`, [child]);
    const running = sending('r');
    world.db.run(`UPDATE workflow_tasks SET state = 'failed' WHERE id = ?`, [running.claim.childTaskId]);
    sweepA2AOutbound(world.runtime);
    sweepA2AOutbound(world.runtime);
    expect(op(queued.operationId)).toMatchObject({ state: 'expired', reason_code: 'dispatch_expired' });
    expect(op(running.p.operationId)).toMatchObject({ state: 'outcome_unknown', reason_code: 'dispatch_ended_unreported' });
    expect(a2aEvents(queued.operationId)).toEqual(ENDED_ON_DISPATCH);
    expect(a2aEvents(running.p.operationId)).toEqual(ENDED_ON_DISPATCH);
  });

  it('a released result ends with the release alone', () => {
    const { p, claim } = sending();
    recordRemoteOutcome(world.runtime, claim, { kind: 'result', parts: [{ text: 'ok' }] });
    const work = claimNextGuardJob(world.runtime);
    if (work === null) throw new Error('no work');
    submitGuardVerdict(world.runtime, { jobId: work.job_id, claimId: work.claim_id, digest: work.digest, verdict: 'passed', code: 'model_pass' });
    sweepA2AOutbound(world.runtime);
    expect(a2aEvents(p.operationId)).toEqual([['dispatch', A2A_RESULT_RELEASED_EVENT]]);
  });
});

describe('every drift class voids the dispatch in its transaction (§6.3)', () => {
  type Tamper = (row: ReturnType<typeof op>, claim: DispatchClaim) => void;
  const cases: [string, Tamper][] = [
    // A new pin the owner bound and approved again: bindings follow the pin.
    ['card_changed', (row) => {
      world.db.run(`UPDATE a2a_remote_agents SET card_hash = 'x' WHERE agent_id = ?`, [row.remote_agent_id]);
      world.db.run(`UPDATE a2a_skill_bindings SET card_hash = 'x' WHERE remote_agent_id = ?`, [row.remote_agent_id]);
    }],
    ['endpoint_changed', (row) => world.db.run(`UPDATE a2a_remote_agents SET endpoint = 'https://elsewhere.example/rpc' WHERE agent_id = ?`, [row.remote_agent_id])],
    ['binding_changed', (row) => world.db.run(`UPDATE a2a_skill_bindings SET revision = revision + 1 WHERE remote_agent_id = ? AND skill = 'summarize'`, [row.remote_agent_id])],
    ['credential_changed', (row) => world.db.run(`UPDATE a2a_remote_credentials SET revision = revision + 1 WHERE remote_agent_id = ?`, [row.remote_agent_id])],
    ['credential_revoked', (row) => world.db.run(`UPDATE a2a_remote_credentials SET status = 'revoked', revoked_at = 1 WHERE remote_agent_id = ?`, [row.remote_agent_id])],
    ['agent_revoked', (row) => world.db.run(`UPDATE a2a_remote_agents SET status = 'revoked' WHERE agent_id = ?`, [row.remote_agent_id])],
    ['approval_not_intact', (row) => {
      const approval = world.store.childrenOf(row.id, 'approval')[0]?.child_task_id ?? '';
      world.db.run(`UPDATE workflow_tasks SET state = 'cancelled' WHERE id = ?`, [approval]);
    }],
    ['no_permit', (row) => world.db.run(`UPDATE a2a_permits SET state = 'void' WHERE operation_ref = ?`, [row.id])],
    ['snapshot_unreadable', (row) => world.db.run(`UPDATE a2a_tasks SET snapshot_json = '{' WHERE id = ?`, [row.id])],
    ['consent_mismatch', (row) => world.db.run(`UPDATE a2a_permits SET payload_hash = 'f' WHERE operation_ref = ?`, [row.id])],
  ];

  it.each(cases)('%s', (reason, tamper) => {
    const p = propose();
    world.workflow.approve(p.approvalTaskId);
    const claim = claimDispatch();
    tamper(op(p.operationId), claim);
    expect(beginOutboundDispatch(world.runtime, claim)).toEqual({ kind: 'settled', state: 'stale_authority', reason });
    const row = op(p.operationId);
    expect(row).toMatchObject({ state: 'stale_authority', reason_code: reason, message_id: null });
    expect(world.store.permitsOf(row.id).every((permit) => permit.state === 'void')).toBe(true);
    expect(world.repo.getById(claim.childTaskId)?.status).toBe('failed');
  });
});

describe('a restart at any stage loses nothing and re-sends nothing', () => {
  it('pending decision: the card survives and approval mints', () => {
    const p = propose();
    world.restart();
    world.workflow.approve(p.approvalTaskId);
    expect(op(p.operationId).state).toBe('queued');
    expect(world.store.permitsOf(op(p.operationId).id)).toHaveLength(1);
  });

  it('approved but not minted (the process died before the handler): the sweeper mints once', () => {
    world.useService(false);
    const p = propose();
    world.workflow.approve(p.approvalTaskId);
    world.restart();
    expect(sweepA2AOutbound(world.runtime).minted).toBe(1);
    expect(sweepA2AOutbound(world.runtime).minted).toBe(0);
    expect(world.store.permitsOf(op(p.operationId).id)).toHaveLength(1);
  });

  it('queued: the next runner claims and sends', () => {
    const p = propose();
    world.workflow.approve(p.approvalTaskId);
    world.restart();
    expect(beginOutboundDispatch(world.runtime, claimDispatch())).toMatchObject({ kind: 'send', operationId: p.operationId });
  });

  it('transmitting: never sent again; the operation ends outcome_unknown', () => {
    const { p } = sending();
    world.restart();
    world.clock += LEASE_MS + 1;
    world.repo.expireLeasedTasks(world.clock);
    expect(beginOutboundDispatch(world.runtime, claimDispatch())).toEqual({ kind: 'settled', state: 'outcome_unknown', reason: 'lease_lost_after_send' });
    expect(a2aEvents(p.operationId)).toEqual([['dispatch', A2A_OPERATION_ENDED_EVENT]]);
  });

  it('acknowledged: the next runner resumes polling the same remote task, from the time it was sent', () => {
    const { p, claim, start } = sending();
    const sentAt = world.clock;
    expect(start.sentAt).toBe(sentAt);
    recordRemoteOutcome(world.runtime, claim, { kind: 'acknowledged', remoteTaskId: 'rt-9' });
    world.restart();
    world.clock += LEASE_MS + 1;
    world.repo.expireLeasedTasks(world.clock);
    // The send time, not the resume's: a resume never earns the poll more time (§6.4).
    expect(beginOutboundDispatch(world.runtime, claimDispatch())).toMatchObject({
      kind: 'resume',
      remoteTaskId: 'rt-9',
      operationId: p.operationId,
      sentAt,
    });
  });

  it('quarantined: the held result waits for the guard and releases once', () => {
    const { p, claim } = sending();
    recordRemoteOutcome(world.runtime, claim, { kind: 'result', parts: [{ text: 'kept across the restart' }] });
    world.restart();
    const work = claimNextGuardJob(world.runtime);
    if (work === null) throw new Error('no work');
    expect(work.content).toEqual({ version: 1, parts: [{ text: 'kept across the restart' }] });
    expect(submitGuardVerdict(world.runtime, { jobId: work.job_id, claimId: work.claim_id, digest: work.digest, verdict: 'passed', code: 'model_pass' })).toEqual({ ok: true, state: 'completed' });
    expect(a2aEvents(p.operationId)).toEqual([['dispatch', A2A_RESULT_RELEASED_EVENT]]);
  });
});

describe('a JSON-RPC error to SendMessage (A2A-I8)', () => {
  it.each([
    [-32602, 'summarize', 'failed', 'remote_rejected'],
    [-32009, 'extract', 'failed', 'remote_rejected'],
    [-32603, 'summarize', 'failed', 'remote_error'],
    [-32603, 'extract', 'outcome_unknown', 'remote_error_after_send'],
    [-32050, 'extract', 'outcome_unknown', 'remote_error_after_send'],
  ])('code %i on a %s request ends %s (%s)', (code, skill, state, reason) => {
    const p = propose('go', skill);
    world.workflow.approve(p.approvalTaskId);
    const claim = claimDispatch();
    beginOutboundDispatch(world.runtime, claim);
    expect(recordRemoteOutcome(world.runtime, claim, { kind: 'send_error', code })).toEqual({ ok: true, state });
    expect(op(p.operationId)).toMatchObject({ state, reason_code: reason });
  });
});

// Cold audit C3-15: design §6.4 and A2A-I8 split by action class, so every class is tried
describe('every action class, after the send: no side effect possible ends failed; any other, outcome unknown', () => {
  const CLASSES = [
    ['read', 'failed'],
    ['quote', 'failed'],
    ['write', 'outcome_unknown'],
    ['booking', 'outcome_unknown'],
    ['agentic', 'outcome_unknown'],
  ] as const;

  /** `summarize`, bound under `actionClass`, sent and in flight. */
  function sentAs(actionClass: OutboundActionClass): { p: ReturnType<typeof propose>; claim: DispatchClaim } {
    const rebound = bindRemoteSkill({ store: world.store, nowMs: () => world.clock }, agentId, { skill: 'summarize', actionClass, credentialRef });
    if (!rebound.ok) throw new Error(rebound.reason);
    const p = propose();
    world.workflow.approve(p.approvalTaskId);
    const claim = claimDispatch();
    expect(beginOutboundDispatch(world.runtime, claim)).toMatchObject({ kind: 'send' });
    return { p, claim };
  }

  it.each(CLASSES)('an internal error answering SendMessage (%s): %s', (actionClass, state) => {
    const { p, claim } = sentAs(actionClass);
    expect(recordRemoteOutcome(world.runtime, claim, { kind: 'send_error', code: -32603 })).toEqual({ ok: true, state });
    expect(op(p.operationId)).toMatchObject({ state, reason_code: state === 'failed' ? 'remote_error' : 'remote_error_after_send' });
  });

  it.each(CLASSES)('a result Dina refuses, the remote having reported it done (%s): %s', (actionClass, state) => {
    const { p, claim } = sentAs(actionClass);
    expect(recordRemoteOutcome(world.runtime, claim, { kind: 'result', parts: [{ url: 'https://agent.example/f.pdf' }] })).toEqual({ ok: true, state });
    expect(op(p.operationId)).toMatchObject({ state, reason_code: 'result_refused:url_part_refused', result_json: null });
  });

  it.each(CLASSES)('an error that says the remote refused before acting (%s): failed, whatever the class', (actionClass) => {
    const { p, claim } = sentAs(actionClass);
    expect(recordRemoteOutcome(world.runtime, claim, { kind: 'send_error', code: -32602 })).toEqual({ ok: true, state: 'failed' });
    expect(op(p.operationId)).toMatchObject({ state: 'failed', reason_code: 'remote_rejected' });
  });
});

describe('what leaves carries no original (D7, §6.2 step 3)', () => {
  it('scrubs personal details in data keys and in numbers, not only in strings', () => {
    const out = buildOutgoingProjection({
      text: 'x',
      data: { 'alonso@example.com': 'x', phone: 14155550134, card: 4111111111111111, count: 3, nested: { 'ssn 123-45-6789': true } },
    });
    if (!out.ok) throw new Error(out.reason);
    const sent = JSON.stringify(out.parts);
    for (const original of ['alonso@example.com', '14155550134', '4111111111111111', '123-45-6789']) {
      expect(sent).not.toContain(original);
    }
    expect(out.parts[1]).toEqual({
      data: { '[EMAIL_1]': 'x', card: '[CREDIT_CARD_1]', count: 3, nested: { 'ssn [SSN_1]': true }, phone: '[PHONE_1]' },
    });
  });

  it('gives one value one placeholder wherever it appears: text, key and value', () => {
    const out = buildOutgoingProjection({ text: 'Mail a@x.com', data: { 'a@x.com': 'a@x.com' } });
    if (!out.ok) throw new Error(out.reason);
    expect(out.parts).toEqual([{ text: 'Mail [EMAIL_1]' }, { data: { '[EMAIL_1]': '[EMAIL_1]' } }]);
    expect(out.placeholders).toEqual([{ type: 'EMAIL', count: 1 }]);
  });

  it('two different values as keys keep two keys; nothing approved is lost', () => {
    const out = buildOutgoingProjection({ data: { 'a@x.com': 1, 'b@x.com': 2 } });
    if (!out.ok) throw new Error(out.reason);
    expect(out.parts).toEqual([{ data: { '[EMAIL_1]': 1, '[EMAIL_2]': 2 } }]);
  });

  it('refuses keys that become one after cleaning, rather than drop one', () => {
    expect(buildOutgoingProjection({ data: { ab: 1, 'a\u200bb': 2 } })).toEqual({ ok: false, reason: 'data_key_collision' });
  });

  it.each([
    ['text', { text: '[EMAIL_1] and a@b.com' }],
    ['a value', { data: { note: 'see [PHONE_2]' } }],
    ['a key', { data: { '[EMAIL_1]': 1 } }],
  ])('refuses %s that already looks like a placeholder', (_where, input) => {
    expect(buildOutgoingProjection(input)).toEqual({ ok: false, reason: 'placeholder_in_input' });
  });

  it('the runner is handed only the scrubbed projection', () => {
    const { start } = sending('Write to alonso@example.com today.');
    expect(JSON.stringify(start.parts)).not.toContain('alonso@example.com');
    expect(start.parts).toEqual([{ text: 'Write to [EMAIL_1] today.' }]);
  });
});

describe('an ending never commits without its event', () => {
  it('rolls the ending back when no task can carry the event', () => {
    const p = propose();
    const row = op(p.operationId);
    world.db.run(`DELETE FROM a2a_task_children WHERE operation_ref = ?`, [row.id]);
    expect(() => cancelOutboundOperation(world.runtime, p.operationId)).toThrow(/no task to carry/);
    expect(op(p.operationId).state).toBe('pending_decision');
  });

  it('ends an operation whose card was never written, untold, and only that one', () => {
    const p = propose();
    const row = op(p.operationId);
    world.db.run(`DELETE FROM a2a_task_children WHERE operation_ref = ?`, [row.id]);
    expect(sweepA2AOutbound(world.runtime)).toMatchObject({ orphaned: 1, failed: 0 });
    expect(op(p.operationId)).toMatchObject({ state: 'failed', reason_code: 'approval_missing' });
  });

  it('a result whose quarantine cannot be read ends blocked, told once', () => {
    const { p, claim } = sending();
    recordRemoteOutcome(world.runtime, claim, { kind: 'result', parts: [{ text: 'x' }] });
    world.db.run('UPDATE a2a_tasks SET result_quarantine = ? WHERE id = ?', ['{', op(p.operationId).id]);
    expect(claimNextGuardJob(world.runtime)).toBeNull();
    expect(claimNextGuardJob(world.runtime)).toBeNull();
    expect(a2aEvents(p.operationId)).toEqual([['dispatch', A2A_RESULT_BLOCKED_EVENT]]);
  });
});

describe('the sweeper', () => {
  it('repairs every other operation when one cannot be repaired', () => {
    world.useService(false);
    const a = propose('a');
    const b = propose('b');
    world.workflow.approve(a.approvalTaskId);
    world.workflow.approve(b.approvalTaskId);
    const real = world.store.childrenOf.bind(world.store);
    const aRef = op(a.operationId).id;
    const spy = jest.spyOn(world.store, 'childrenOf').mockImplementation((ref, role) => {
      if (ref === aRef) throw new Error('disk fault');
      return real(ref, role);
    });
    try {
      expect(sweepA2AOutbound(world.runtime)).toMatchObject({ minted: 1, failed: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(op(b.operationId).state).toBe('queued');
    expect(sweepA2AOutbound(world.runtime)).toMatchObject({ minted: 1, failed: 0 });
  });
});

describe('ended operations purge with everything that references them (§9)', () => {
  it('deletes children first after the retention window, and nothing earlier', () => {
    // One blocked result (guard job, quarantine) and one owner-cancelled run (cancel request).
    const blocked = sending('b');
    recordRemoteOutcome(world.runtime, blocked.claim, { kind: 'result', parts: [{ text: 'held' }] });
    const work = claimNextGuardJob(world.runtime);
    if (work === null) throw new Error('no work');
    submitGuardVerdict(world.runtime, { jobId: work.job_id, claimId: work.claim_id, digest: work.digest, verdict: 'blocked', code: 'model_block' });
    const cancelled = sending('c');
    cancelOutboundOperation(world.runtime, cancelled.p.operationId);
    recordRemoteOutcome(world.runtime, cancelled.claim, { kind: 'cancelled' });
    const live = propose('still waiting');
    const ended = [blocked.p.operationId, cancelled.p.operationId].map((id) => {
      const row = op(id);
      return { id, ref: row.id, tasks: world.store.childrenOf(row.id).map((c) => c.child_task_id) };
    });
    expect(world.db.query(`SELECT COUNT(*) AS n FROM a2a_cancel_requests WHERE operation_ref = ?`, [ended[1]?.ref])[0]).toEqual({ n: 1 });

    world.clock += A2A_ENDED_RETENTION_MS - 1;
    expect(purgeEndedA2AOperations(world.runtime)).toBe(0);
    world.clock += 2;
    expect(purgeEndedA2AOperations(world.runtime)).toBe(2);

    for (const { id, ref, tasks } of ended) {
      expect(world.store.getTaskByExternal('outbound', 'owner', id)).toBeNull();
      for (const table of ['a2a_guard_jobs', 'a2a_permits', 'a2a_task_children', 'a2a_cancel_requests']) {
        expect(world.db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE operation_ref = ?`, [ref])[0]).toEqual({ n: 0 });
      }
      // The consent card (the approved message) and the dispatch child go too, with their events.
      expect(tasks).toHaveLength(2);
      for (const task of tasks) {
        expect(world.repo.getById(task)).toBeNull();
        expect(world.repo.listEventsForTask(task)).toEqual([]);
      }
    }
    expect(op(live.operationId).state).toBe('pending_decision');
    expect(world.repo.getById(live.approvalTaskId)?.status).toBe('pending_approval');
  });
});

describe('proposal bounds', () => {
  it('refuses more than the hourly cap, then allows again an hour later', () => {
    for (let i = 0; i < MAX_PROPOSALS_PER_HOUR; i += 1) {
      const out = proposeDelegation(world.runtime, { releaseSession: SESSION, agentId, skill: 'summarize', text: `n${i}` });
      if (!out.ok) throw new Error(out.reason);
      world.workflow.cancel(out.approvalTaskId, 'no');
    }
    expect(proposeDelegation(world.runtime, { releaseSession: SESSION, agentId, skill: 'summarize', text: 'one more' })).toEqual({ ok: false, reason: 'too_many_recent' });
    world.clock += 60 * 60_000;
    world.turn(); // the owner speaks again: proposals belong to a live turn
    expect(proposeDelegation(world.runtime, { releaseSession: SESSION, agentId, skill: 'summarize', text: 'later' }).ok).toBe(true);
  });
});

describe('the store’s transactions', () => {
  it('refuse an asynchronous body and roll back what it wrote', () => {
    const p = propose();
    const ref = op(p.operationId).id;
    expect(() =>
      world.store.transaction(() => {
        world.store.requestCancel(ref, world.clock);
        return Promise.resolve(1);
      }),
    ).toThrow(/synchronous/);
    expect(world.store.getCancelRequest(ref)).toBeNull();
  });
});

describe('minting by the sweeper and the handler', () => {
  it('rethrows a real fault: no stored permit means no race was lost', () => {
    world.useService(false);
    const p = propose();
    world.workflow.approve(p.approvalTaskId);
    const insert = jest.spyOn(world.store, 'insertPermit').mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    try {
      expect(() => mintOutboundPermit(world.runtime, p.approvalTaskId)).toThrow('disk I/O error');
    } finally {
      insert.mockRestore();
    }
    expect(world.store.permitsOf(op(p.operationId).id)).toEqual([]);
    expect(op(p.operationId).state).toBe('pending_decision');
  });

  it('refuses to mint an operation whose card does not hash to what it stages', () => {
    world.useService(false);
    const p = propose();
    world.workflow.approve(p.approvalTaskId);
    world.db.run(`UPDATE a2a_tasks SET request_hash = 'f' WHERE id = ?`, [op(p.operationId).id]);
    expect(mintOutboundPermit(world.runtime, p.approvalTaskId)).toBe('consent_mismatch');
  });
});
