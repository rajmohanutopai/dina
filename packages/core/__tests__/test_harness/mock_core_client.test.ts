/**
 * MockCoreClient behavioral smoke — Brain tests depend on these
 * guarantees: (1) records every call, (2) returns configurable canned
 * data, (3) honors `throwOn` failure injection, (4) implements the
 * full `CoreClient` interface (compile-time assertion via implicit
 * variable annotation below).
 *
 * Task 1.34 — test lives in core because that's where jest runs; the
 * mock itself lives in `@dina/test-harness`.
 */

import { MockCoreClient } from '@dina/test-harness';
import type { CoreClient } from '../../src/client/core-client';
import { WorkflowConflictError } from '../../src';

describe('MockCoreClient (task 1.34)', () => {
  // Compile-time assertion: any drift in CoreClient that MockCoreClient
  // doesn't cover will fail this assignment. (Runtime side-effect free.)
  it('satisfies the CoreClient interface at compile time', () => {
    const m: CoreClient = new MockCoreClient();
    expect(m).toBeInstanceOf(MockCoreClient);
  });

  it('records every method call with its args', async () => {
    const m = new MockCoreClient();
    await m.healthz();
    await m.vaultQuery('personal', { q: 'dentist' });
    await m.personaStatus('financial');

    expect(m.calls).toHaveLength(3);
    expect(m.calls[0]?.method).toBe('healthz');
    expect(m.calls[0]?.args).toEqual([]);
    expect(m.calls[1]?.method).toBe('vaultQuery');
    expect(m.calls[1]?.args).toEqual(['personal', { q: 'dentist' }]);
    expect(m.calls[2]?.method).toBe('personaStatus');
    expect(m.calls[2]?.args).toEqual(['financial']);

    expect(m.callCountOf('vaultQuery')).toBe(1);
    expect(m.callCountOf('notify')).toBe(0);
  });

  it('returns configurable canned responses', async () => {
    const m = new MockCoreClient();
    m.healthResult = { status: 'ok', did: 'did:key:configured', version: '42.0.0' };
    m.vaultListResult = {
      items: [{ id: 'one' }, { id: 'two' }],
      count: 2,
      total: 99,
    };

    const h = await m.healthz();
    expect(h.did).toBe('did:key:configured');
    expect(h.version).toBe('42.0.0');

    const l = await m.vaultList('personal');
    expect(l.total).toBe(99);
    expect(l.items).toHaveLength(2);
  });

  it('piiScrub passes input through by default (empty canned scrubbed)', async () => {
    // Default MockCoreClient.piiScrubResult.scrubbed is "" — the mock
    // echoes the input so downstream prompt-builders in Brain tests get
    // intelligible text without having to configure the mock.
    const m = new MockCoreClient();
    const r = await m.piiScrub('Hello Alice');
    expect(r.scrubbed).toBe('Hello Alice');
    expect(r.sessionId).toBe('mock-pii-session');
  });

  it('piiScrub honors a configured non-empty scrubbed string', async () => {
    const m = new MockCoreClient();
    m.piiScrubResult = {
      scrubbed: 'Hello {{ENTITY:0}}',
      sessionId: 'custom-session',
      entityCount: 1,
    };
    const r = await m.piiScrub('Hello Alice');
    expect(r.scrubbed).toBe('Hello {{ENTITY:0}}');
    expect(r.entityCount).toBe(1);
  });

  it('personaStatus respects per-persona overrides before falling back', async () => {
    const m = new MockCoreClient();
    m.personaStatusByName.financial = {
      persona: 'financial',
      tier: 'locked',
      open: false,
      dekFingerprint: null,
      openedAt: null,
    };
    m.personaStatusResult = {
      persona: 'PLACEHOLDER',
      tier: 'default',
      open: true,
      dekFingerprint: 'ab12cd34',
      openedAt: 1776700000,
    };

    const locked = await m.personaStatus('financial');
    expect(locked.tier).toBe('locked');
    expect(locked.open).toBe(false);

    // Fallback path: unmatched persona → default result, but with the
    // requested name spliced in (so tests don't see 'PLACEHOLDER').
    const standard = await m.personaStatus('work');
    expect(standard.tier).toBe('default');
    expect(standard.persona).toBe('work');
  });

  it('serviceQuery echoes queryId so callers can correlate without configuring per-test', async () => {
    const m = new MockCoreClient();
    const r = await m.sendServiceQuery({
      toDID: 'did:plc:busdriver',
      capability: 'eta_query',
      queryId: 'q-real-id',
      params: {},
      ttlSeconds: 60,
    });
    expect(r.taskId).toBe('mock-task-id');
    expect(r.queryId).toBe('q-real-id');
  });

  it('throwOn injects a method-specific exception; other methods keep working', async () => {
    const m = new MockCoreClient();
    m.throwOn = { vaultStore: new Error('simulated core outage') };

    await expect(
      m.vaultStore('personal', { type: 'note', content: {} }),
    ).rejects.toThrow(/simulated core outage/);

    // healthz unaffected.
    await expect(m.healthz()).resolves.toMatchObject({ status: 'ok' });

    // The throw-path still recorded the attempt.
    expect(m.callCountOf('vaultStore')).toBe(1);
  });

  it('serviceConfig defaults to null (matches the real transports on missing config)', async () => {
    const m = new MockCoreClient();
    await expect(m.serviceConfig()).resolves.toBeNull();

    m.serviceConfigResult = {
      isDiscoverable: true,
      name: 'Test Service',
      capabilities: {},
    };
    await expect(m.serviceConfig()).resolves.not.toBeNull();
  });

  // ─── Staging inbox (task 1.29h / 1.32 preamble) ───────────────────────

  it('stagingIngest records request + returns configurable canned result', async () => {
    const m = new MockCoreClient();
    m.stagingIngestResult = {
      itemId: 'stg-ingested',
      duplicate: false,
      status: 'received',
    };
    const r = await m.stagingIngest({
      source: 'chat',
      sourceId: 'msg-1',
      data: { body: 'remember this' },
    });
    expect(r).toEqual({ itemId: 'stg-ingested', duplicate: false, status: 'received' });
    expect(m.calls[0]).toEqual({
      method: 'stagingIngest',
      args: [{ source: 'chat', sourceId: 'msg-1', data: { body: 'remember this' } }],
    });
  });

  it('stagingClaim records args + returns configurable canned result', async () => {
    const m = new MockCoreClient();
    m.stagingClaimResult = {
      items: [{ id: 'stg-a' }, { id: 'stg-b' }],
      count: 2,
    };
    const r = await m.stagingClaim(10);
    expect(r.count).toBe(2);
    expect(r.items).toHaveLength(2);
    expect(m.calls[0]).toEqual({ method: 'stagingClaim', args: [10] });
  });

  it('stagingResolve echoes the incoming itemId on the result without per-test config', async () => {
    const m = new MockCoreClient();
    const r = await m.stagingResolve({
      itemId: 'stg-real',
      persona: 'health',
      data: { text: 'x' },
      personaOpen: true,
    });
    // Echo pattern matches serviceQuery.queryId — callers can correlate
    // batch mocks without splitting the canned result per call.
    expect(r.itemId).toBe('stg-real');
  });

  it('stagingFail echoes itemId on the result', async () => {
    const m = new MockCoreClient();
    const r = await m.stagingFail('stg-broken', 'vault locked');
    expect(r.itemId).toBe('stg-broken');
    expect(m.calls[0]?.args).toEqual(['stg-broken', 'vault locked']);
  });

  it('stagingExtendLease echoes itemId + seconds so callers do not need to configure', async () => {
    const m = new MockCoreClient();
    const r = await m.stagingExtendLease('stg-slow', 900);
    expect(r.itemId).toBe('stg-slow');
    expect(r.extendedBySeconds).toBe(900);
    expect(m.calls[0]?.args).toEqual(['stg-slow', 900]);
  });

  it('msgSend records the whole request and returns ok:true by default', async () => {
    const m = new MockCoreClient();
    const r = await m.msgSend({
      recipientDID: 'did:plc:peer',
      messageType: 'text',
      body: { hello: 'world' },
    });
    expect(r.ok).toBe(true);
    const call = m.calls[0]!;
    expect(call.method).toBe('msgSend');
    expect((call.args[0] as { recipientDID: string }).recipientDID).toBe('did:plc:peer');
  });

  it('throwOn isolates staging failures — other methods keep working', async () => {
    const m = new MockCoreClient();
    m.throwOn = { stagingClaim: new Error('core unreachable') };
    await expect(m.stagingClaim(5)).rejects.toThrow(/core unreachable/);
    await expect(m.stagingFail('x', 'y')).resolves.toMatchObject({ itemId: 'x' });
  });

  it('reset() drops all recorded calls + clears throwOn + per-persona overrides', async () => {
    const m = new MockCoreClient();
    m.throwOn = { healthz: new Error('x') };
    m.personaStatusByName.financial = {
      persona: 'financial',
      tier: 'locked',
      open: false,
      dekFingerprint: null,
      openedAt: null,
    };
    await m.scratchpadCheckpoint('reset-probe', 1, { before: true });
    try {
      await m.healthz();
    } catch {
      /* expected */
    }
    expect(m.calls.length).toBeGreaterThan(0);

    m.reset();

    expect(m.calls).toHaveLength(0);
    expect(m.throwOn).toEqual({});
    expect(m.personaStatusByName).toEqual({});
    // Scratchpad store clears too so back-to-back tests share no state.
    expect(m.scratchpadStore.size).toBe(0);

    // After reset, healthz no longer throws.
    await expect(m.healthz()).resolves.toMatchObject({ status: 'ok' });
  });

  // ─── Scratchpad (task 1.32 preamble) ──────────────────────────────────

  it('scratchpadCheckpoint → scratchpadResume round-trips the entry', async () => {
    const m = new MockCoreClient();
    const cp = await m.scratchpadCheckpoint('nudge-2', 3, { draft: 'hi' });
    expect(cp).toEqual({ taskId: 'nudge-2', step: 3 });
    const entry = await m.scratchpadResume('nudge-2');
    expect(entry).not.toBeNull();
    expect(entry!.step).toBe(3);
    expect(entry!.context).toEqual({ draft: 'hi' });
    expect(entry!.createdAt).toBeLessThanOrEqual(entry!.updatedAt);
  });

  it('scratchpadResume returns null for unseen taskId', async () => {
    const m = new MockCoreClient();
    expect(await m.scratchpadResume('never-written')).toBeNull();
  });

  it('scratchpadClear drops the row; subsequent resume → null', async () => {
    const m = new MockCoreClient();
    await m.scratchpadCheckpoint('to-clear', 1, { probe: true });
    await m.scratchpadClear('to-clear');
    expect(await m.scratchpadResume('to-clear')).toBeNull();
  });

  it('scratchpadCheckpoint step=0 acts as Python delete sentinel', async () => {
    const m = new MockCoreClient();
    await m.scratchpadCheckpoint('delete-via-zero', 2, { live: true });
    await m.scratchpadCheckpoint('delete-via-zero', 0, {});
    expect(await m.scratchpadResume('delete-via-zero')).toBeNull();
  });

  it('scratchpadCheckpoint upsert preserves createdAt across updates', async () => {
    // Contract: createdAt is stable across upserts (real SQLite repo uses
    // `ON CONFLICT … DO UPDATE` leaving created_at unchanged). updatedAt
    // moves forward monotonically — `>=` matches the invariant without
    // needing a synthetic delay (fast hosts can hit the same millisecond).
    const m = new MockCoreClient();
    await m.scratchpadCheckpoint('upsert-task', 1, { step: 1 });
    const first = await m.scratchpadResume('upsert-task');
    await m.scratchpadCheckpoint('upsert-task', 2, { step: 2 });
    const second = await m.scratchpadResume('upsert-task');
    expect(second!.createdAt).toBe(first!.createdAt);
    expect(second!.updatedAt).toBeGreaterThanOrEqual(first!.updatedAt);
    expect(second!.step).toBe(2);
    expect(second!.context).toEqual({ step: 2 });
  });

  it('throwOn isolates scratchpad failures — other methods keep working', async () => {
    const m = new MockCoreClient();
    m.throwOn = { scratchpadResume: new Error('scratchpad offline') };
    await expect(m.scratchpadResume('any')).rejects.toThrow(/scratchpad offline/);
    // Checkpoint still works — the throwOn key is per-method.
    await expect(
      m.scratchpadCheckpoint('other-task', 1, {}),
    ).resolves.toMatchObject({ taskId: 'other-task', step: 1 });
  });

  // ─── Service respond (task 1.32 slice A) ──────────────────────────────

  it('sendServiceRespond echoes taskId + returns canned status/alreadyProcessed', async () => {
    const m = new MockCoreClient();
    const r = await m.sendServiceRespond('svc-123', { status: 'success', result: { x: 1 } });
    expect(r).toEqual({ status: 'sent', taskId: 'svc-123', alreadyProcessed: false });
  });

  it('sendServiceRespond canned response can flip alreadyProcessed for retry-path tests', async () => {
    const m = new MockCoreClient();
    m.serviceRespondResult = {
      status: 'completed',
      taskId: 'PLACEHOLDER',
      alreadyProcessed: true,
    };
    const r = await m.sendServiceRespond('svc-456', { status: 'success' });
    expect(r.alreadyProcessed).toBe(true);
    expect(r.status).toBe('completed');
    // Echoed taskId wins over the PLACEHOLDER in the canned shape.
    expect(r.taskId).toBe('svc-456');
  });

  // ─── Workflow events (task 1.32 slice B) ──────────────────────────────

  it('listWorkflowEvents honours needsDeliveryOnly — hides acked + non-delivery events', async () => {
    const m = new MockCoreClient();
    m.workflowEvents = [
      {
        event_id: 1,
        task_id: 't1',
        at: 1,
        event_kind: 'completed',
        needs_delivery: true,
        delivery_attempts: 0,
        delivery_failed: false,
        details: '{}',
      },
      {
        event_id: 2,
        task_id: 't2',
        at: 2,
        event_kind: 'progress',
        needs_delivery: false, // no delivery expected
        delivery_attempts: 0,
        delivery_failed: false,
        details: '{}',
      },
      {
        event_id: 3,
        task_id: 't3',
        at: 3,
        event_kind: 'completed',
        needs_delivery: true,
        delivery_attempts: 1,
        delivery_failed: false,
        details: '{}',
        acknowledged_at: 100, // already retired
      },
    ];
    const hot = await m.listWorkflowEvents({ needsDeliveryOnly: true });
    expect(hot.map((e) => e.event_id)).toEqual([1]);
    // Full stream returns all three unchanged.
    const all = await m.listWorkflowEvents();
    expect(all.map((e) => e.event_id)).toEqual([1, 2, 3]);
  });

  it('listWorkflowEvents since + limit paginate the seeded buffer', async () => {
    const m = new MockCoreClient();
    m.workflowEvents = [
      {
        event_id: 1,
        task_id: 't1',
        at: 1,
        event_kind: 'x',
        needs_delivery: true,
        delivery_attempts: 0,
        delivery_failed: false,
        details: '{}',
      },
      {
        event_id: 2,
        task_id: 't2',
        at: 2,
        event_kind: 'x',
        needs_delivery: true,
        delivery_attempts: 0,
        delivery_failed: false,
        details: '{}',
      },
      {
        event_id: 3,
        task_id: 't3',
        at: 3,
        event_kind: 'x',
        needs_delivery: true,
        delivery_attempts: 0,
        delivery_failed: false,
        details: '{}',
      },
    ];
    const page = await m.listWorkflowEvents({ since: 1, limit: 1 });
    expect(page.map((e) => e.event_id)).toEqual([2]);
  });

  it('acknowledgeWorkflowEvent records the id + returns canned bool', async () => {
    const m = new MockCoreClient();
    const ok = await m.acknowledgeWorkflowEvent(42);
    expect(ok).toBe(true);
    expect(m.ackedEventIds).toEqual([42]);

    m.workflowEventAckResult = false; // simulate "already retired" 404-path
    expect(await m.acknowledgeWorkflowEvent(99)).toBe(false);
    expect(m.ackedEventIds).toEqual([42, 99]);
  });

  it('failWorkflowEventDelivery records the id + opts, returns canned bool', async () => {
    const m = new MockCoreClient();
    const ok = await m.failWorkflowEventDelivery(7, {
      nextDeliveryAt: 1_700_000_999_000,
      error: 'thread-resolver refused',
    });
    expect(ok).toBe(true);
    expect(m.failedEventIds).toEqual([7]);
    // Args were recorded for later assertion on opts.
    const lastCall = m.calls[m.calls.length - 1]!;
    expect(lastCall.method).toBe('failWorkflowEventDelivery');
    expect(lastCall.args).toEqual([
      7,
      { nextDeliveryAt: 1_700_000_999_000, error: 'thread-resolver refused' },
    ]);
  });

  // ─── Workflow tasks (task 1.32 slices C + D) ──────────────────────────

  it('listWorkflowTasks filters by kind + state with limit', async () => {
    const m = new MockCoreClient();
    const now = Date.now();
    m.workflowTasks.push(
      {
        id: 'a',
        kind: 'service_query',
        status: 'queued',
        priority: 'normal',
        description: '',
        payload: '{}',
        result_summary: '',
        policy: '{}',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'b',
        kind: 'service_query',
        status: 'queued',
        priority: 'normal',
        description: '',
        payload: '{}',
        result_summary: '',
        policy: '{}',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'c',
        kind: 'approval',
        status: 'queued',
        priority: 'normal',
        description: '',
        payload: '{}',
        result_summary: '',
        policy: '{}',
        created_at: now,
        updated_at: now,
      },
    );
    const result = await m.listWorkflowTasks({
      kind: 'service_query',
      state: 'queued',
      limit: 1,
    });
    expect(result.map((t) => t.id)).toEqual(['a']);
  });

  it('getWorkflowTask returns null for unseen id', async () => {
    const m = new MockCoreClient();
    expect(await m.getWorkflowTask('never')).toBeNull();
  });

  it('createWorkflowTask pushes into buffer + returns deduped:false', async () => {
    const m = new MockCoreClient();
    const res = await m.createWorkflowTask({
      id: 'wf-new',
      kind: 'service_query',
      description: 'test',
      payload: '{}',
    });
    expect(res.deduped).toBe(false);
    expect(res.task.id).toBe('wf-new');
    expect(m.workflowTasks).toHaveLength(1);
    expect(await m.getWorkflowTask('wf-new')).toEqual(res.task);
  });

  it('createWorkflowTask with matching idempotency key returns existing deduped:true', async () => {
    const m = new MockCoreClient();
    await m.createWorkflowTask({
      id: 'wf-orig',
      kind: 'service_query',
      description: 'orig',
      payload: '{}',
      idempotencyKey: 'idem-1',
    });
    const retry = await m.createWorkflowTask({
      id: 'wf-retry',
      kind: 'service_query',
      description: 'retry',
      payload: '{}',
      idempotencyKey: 'idem-1',
    });
    expect(retry.deduped).toBe(true);
    expect(retry.task.id).toBe('wf-orig'); // original, not retry
    // Only ONE task in the buffer — dedupe didn't create a second row.
    expect(m.workflowTasks).toHaveLength(1);
  });

  it('createWorkflowTask throws WorkflowConflictError on duplicate id', async () => {
    const m = new MockCoreClient();
    await m.createWorkflowTask({
      id: 'wf-1',
      kind: 'service_query',
      description: 'first',
      payload: '{}',
    });
    let caught: unknown;
    try {
      await m.createWorkflowTask({
        id: 'wf-1', // same id
        kind: 'service_query',
        description: 'dup',
        payload: '{}',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowConflictError);
    expect((caught as { code?: string })?.code).toBe('duplicate_id');
  });

  it('approveWorkflowTask + cancel + complete + fail mutate in place', async () => {
    const m = new MockCoreClient();
    await m.createWorkflowTask({
      id: 'wf-x',
      kind: 'approval',
      description: '',
      payload: '{}',
      initialState: 'pending_approval',
    });
    const approved = await m.approveWorkflowTask('wf-x');
    expect(approved.status).toBe('queued');

    // cancel
    await m.createWorkflowTask({
      id: 'wf-cancel',
      kind: 'service_query',
      description: '',
      payload: '{}',
    });
    const cancelled = await m.cancelWorkflowTask('wf-cancel', 'reason here');
    expect(cancelled.status).toBe('cancelled');

    // complete
    await m.createWorkflowTask({
      id: 'wf-complete',
      kind: 'service_query',
      description: '',
      payload: '{}',
    });
    const done = await m.completeWorkflowTask('wf-complete', '{"x":1}', 'summary');
    expect(done.status).toBe('completed');
    expect(done.result).toBe('{"x":1}');
    expect(done.result_summary).toBe('summary');

    // fail
    await m.createWorkflowTask({
      id: 'wf-fail',
      kind: 'service_query',
      description: '',
      payload: '{}',
    });
    const failed = await m.failWorkflowTask('wf-fail', 'oops');
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('oops');
  });

  it('state transitions throw on unknown id', async () => {
    const m = new MockCoreClient();
    await expect(m.approveWorkflowTask('never')).rejects.toThrow(/task not found/);
    await expect(m.cancelWorkflowTask('never')).rejects.toThrow(/task not found/);
    await expect(m.completeWorkflowTask('never', '{}', 's')).rejects.toThrow(/task not found/);
    await expect(m.failWorkflowTask('never', 'e')).rejects.toThrow(/task not found/);
  });

  it('cancel+complete+fail record their full arg list (not just id) for test assertions', async () => {
    const m = new MockCoreClient();
    await m.createWorkflowTask({
      id: 'wf-args',
      kind: 'service_query',
      description: '',
      payload: '{}',
    });
    await m.cancelWorkflowTask('wf-args', 'my-reason');
    const cancelCall = m.calls[m.calls.length - 1]!;
    expect(cancelCall.method).toBe('cancelWorkflowTask');
    expect(cancelCall.args).toEqual(['wf-args', 'my-reason']);

    await m.createWorkflowTask({
      id: 'wf-args-2',
      kind: 'service_query',
      description: '',
      payload: '{}',
    });
    await m.completeWorkflowTask('wf-args-2', '{}', 'sum', 'did:plc:agent');
    const completeCall = m.calls[m.calls.length - 1]!;
    expect(completeCall.args).toEqual(['wf-args-2', '{}', 'sum', 'did:plc:agent']);
  });

  it('reset() clears workflow event state + scratchpad store together', async () => {
    const m = new MockCoreClient();
    m.workflowEvents = [
      {
        event_id: 1,
        task_id: 't1',
        at: 1,
        event_kind: 'x',
        needs_delivery: true,
        delivery_attempts: 0,
        delivery_failed: false,
        details: '{}',
      },
    ];
    await m.acknowledgeWorkflowEvent(1);
    await m.failWorkflowEventDelivery(2);
    await m.createWorkflowTask({
      id: 'wf-reset',
      kind: 'service_query',
      description: '',
      payload: '{}',
    });
    expect(m.ackedEventIds).toHaveLength(1);
    expect(m.failedEventIds).toHaveLength(1);
    expect(m.workflowTasks).toHaveLength(1);

    m.reset();

    expect(m.workflowEvents).toEqual([]);
    expect(m.workflowTasks).toEqual([]);
    expect(m.ackedEventIds).toEqual([]);
    expect(m.failedEventIds).toEqual([]);
  });

  // ─── Memory + contacts (task 1.32 slice E) ────────────────────────────

  it('memoryTouch records params + echoes topic as canonical by default', async () => {
    const m = new MockCoreClient();
    const r = await m.memoryTouch({
      persona: 'personal',
      topic: 'dentist',
      kind: 'entity',
    });
    expect(r.status).toBe('ok');
    expect(r.canonical).toBe('dentist');
    expect(m.memoryTouches).toHaveLength(1);
    expect(m.memoryTouches[0]).toEqual({
      persona: 'personal',
      topic: 'dentist',
      kind: 'entity',
    });
  });

  it('memoryTouch canned-response override drives the skipped path', async () => {
    const m = new MockCoreClient();
    m.memoryTouchResult = { status: 'skipped', reason: 'persona locked' };
    const r = await m.memoryTouch({
      persona: 'financial',
      topic: 'portfolio',
      kind: 'theme',
    });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('persona locked');
    // The touch was still recorded — tests can count attempts even on
    // skipped paths for observability.
    expect(m.memoryTouches).toHaveLength(1);
  });

  it('updateContact records {did, updates} pairs without mutating input', async () => {
    const m = new MockCoreClient();
    const updates = { preferredFor: ['dental', 'surgery'] };
    await m.updateContact('did:plc:drcarl', updates);
    expect(m.contactUpdates).toHaveLength(1);
    expect(m.contactUpdates[0]!.did).toBe('did:plc:drcarl');
    expect(m.contactUpdates[0]!.updates.preferredFor).toEqual(['dental', 'surgery']);
    // Caller's `updates` object is defensive-copied so test mutation
    // after the call doesn't rewrite the recorded history.
    updates.preferredFor.push('mutation');
    expect(m.contactUpdates[0]!.updates.preferredFor).toEqual(['dental', 'surgery']);
  });

  it('updateContact throwOn injection simulates the 404-path', async () => {
    const m = new MockCoreClient();
    m.throwOn = { updateContact: new Error('contact not found') };
    await expect(
      m.updateContact('did:plc:unknown', { preferredFor: ['x'] }),
    ).rejects.toThrow(/contact not found/);
  });

  it('reset() clears memoryTouches + contactUpdates + memoryTouchResult override', async () => {
    const m = new MockCoreClient();
    m.memoryTouchResult = { status: 'skipped', reason: 'x' };
    await m.memoryTouch({ persona: 'personal', topic: 't', kind: 'entity' });
    await m.updateContact('did:plc:x', { preferredFor: ['y'] });
    expect(m.memoryTouches).toHaveLength(1);
    expect(m.contactUpdates).toHaveLength(1);

    m.reset();

    expect(m.memoryTouches).toEqual([]);
    expect(m.contactUpdates).toEqual([]);
    expect(m.memoryTouchResult).toBeUndefined();

    // After reset, memoryTouch falls back to the default 'ok' shape.
    const r = await m.memoryTouch({ persona: 'personal', topic: 't', kind: 'entity' });
    expect(r.status).toBe('ok');
  });
});
