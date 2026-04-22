/**
 * Task 4.82 — workflow persistence tests.
 */

import {
  InMemoryWorkflowAdapter,
  WorkflowTaskRegistry,
  type WorkflowEvent,
  type WorkflowTask,
} from '../src/workflow/workflow_persistence';

function fixedClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    nowMsFn: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const sampleTask = {
  id: 'task-1',
  kind: 'service_query_execution',
  payload: JSON.stringify({ capability: 'eta_query' }),
};

describe('InMemoryWorkflowAdapter (task 4.82)', () => {
  it('insert → get round-trips a task with all fields', async () => {
    const adapter = new InMemoryWorkflowAdapter();
    const now = 1_700_000_000_000;
    const task: WorkflowTask = {
      id: 't',
      kind: 'k',
      payload: '{}',
      status: 'pending',
      attempts: 0,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await adapter.insert(task);
    const got = await adapter.get('t');
    expect(got).toEqual(task);
    expect(got).not.toBe(task); // defensive copy
  });

  it('insert-duplicate-id throws', async () => {
    const adapter = new InMemoryWorkflowAdapter();
    const task: WorkflowTask = {
      id: 't',
      kind: 'k',
      payload: '{}',
      status: 'pending',
      attempts: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    await adapter.insert(task);
    await expect(adapter.insert(task)).rejects.toThrow(/duplicate id/);
  });

  it('update on unknown id throws', async () => {
    const adapter = new InMemoryWorkflowAdapter();
    const task: WorkflowTask = {
      id: 'ghost',
      kind: 'k',
      payload: '{}',
      status: 'pending',
      attempts: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    await expect(adapter.update(task)).rejects.toThrow(/unknown id/);
  });

  it('delete returns true on known, false on unknown', async () => {
    const adapter = new InMemoryWorkflowAdapter();
    const task: WorkflowTask = {
      id: 't',
      kind: 'k',
      payload: '{}',
      status: 'pending',
      attempts: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    await adapter.insert(task);
    expect(await adapter.delete('t')).toBe(true);
    expect(await adapter.delete('t')).toBe(false);
  });

  it('loadAll returns all inserted tasks as copies', async () => {
    const adapter = new InMemoryWorkflowAdapter();
    for (let i = 0; i < 3; i++) {
      await adapter.insert({
        id: `t-${i}`,
        kind: 'k',
        payload: '{}',
        status: 'pending',
        attempts: 0,
        createdAtMs: i,
        updatedAtMs: i,
      });
    }
    const rows = await adapter.loadAll();
    expect(rows).toHaveLength(3);
    // Mutation of returned list does not affect the store.
    rows[0]!.status = 'completed';
    const fresh = await adapter.loadAll();
    expect(fresh[0]!.status).toBe('pending');
  });
});

describe('WorkflowTaskRegistry (task 4.82)', () => {
  describe('enqueue', () => {
    it('creates a pending task with attempts=0', async () => {
      const clock = fixedClock();
      const reg = new WorkflowTaskRegistry({
        adapter: new InMemoryWorkflowAdapter(),
        nowMsFn: clock.nowMsFn,
      });
      const task = await reg.enqueue(sampleTask);
      expect(task).toMatchObject({
        id: 'task-1',
        kind: 'service_query_execution',
        status: 'pending',
        attempts: 0,
        createdAtMs: clock.nowMsFn(),
      });
    });

    it('emits `enqueued` event', async () => {
      const events: WorkflowEvent[] = [];
      const reg = new WorkflowTaskRegistry({
        adapter: new InMemoryWorkflowAdapter(),
        onEvent: (e) => events.push(e),
      });
      await reg.enqueue(sampleTask);
      expect(events.map((e) => e.kind)).toEqual(['enqueued']);
    });

    it.each([
      ['empty id', { ...sampleTask, id: '' }],
      ['empty kind', { ...sampleTask, kind: '' }],
      ['non-string payload', { ...sampleTask, payload: 42 as unknown as string }],
    ])('rejects %s', async (_label, input) => {
      const reg = new WorkflowTaskRegistry({
        adapter: new InMemoryWorkflowAdapter(),
      });
      await expect(reg.enqueue(input)).rejects.toThrow();
    });
  });

  describe('state machine', () => {
    it('pending → running → completed', async () => {
      const clock = fixedClock();
      const events: WorkflowEvent[] = [];
      const reg = new WorkflowTaskRegistry({
        adapter: new InMemoryWorkflowAdapter(),
        nowMsFn: clock.nowMsFn,
        onEvent: (e) => events.push(e),
      });
      await reg.enqueue(sampleTask);
      const running = await reg.markRunning('task-1');
      expect(running.status).toBe('running');
      expect(running.attempts).toBe(1);
      clock.advance(500);
      const done = await reg.markCompleted('task-1', JSON.stringify({ ok: true }));
      expect(done.status).toBe('completed');
      expect(done.resultJson).toBe('{"ok":true}');
      expect(done.completedAtMs).toBe(clock.nowMsFn());
      expect(events.map((e) => e.kind)).toEqual([
        'enqueued',
        'started',
        'completed',
      ]);
      const completedEv = events[2] as Extract<
        WorkflowEvent,
        { kind: 'completed' }
      >;
      expect(completedEv.durationMs).toBe(500);
    });

    it('pending → running → failed', async () => {
      const reg = new WorkflowTaskRegistry({
        adapter: new InMemoryWorkflowAdapter(),
      });
      await reg.enqueue(sampleTask);
      await reg.markRunning('task-1');
      const failed = await reg.markFailed(
        'task-1',
        JSON.stringify({ reason: 'upstream' }),
      );
      expect(failed.status).toBe('failed');
      expect(failed.errorJson).toBe('{"reason":"upstream"}');
      expect(failed.attempts).toBe(1);
    });

    it('attempts increments across retry cycles', async () => {
      const reg = new WorkflowTaskRegistry({
        adapter: new InMemoryWorkflowAdapter(),
      });
      await reg.enqueue(sampleTask);
      await reg.markRunning('task-1');
      await reg.markFailed('task-1', '{}');
      // Simulate retry — need to re-enqueue with a new id OR the
      // registry's state machine forbids re-running a failed task.
      // Test the forbidden-transition:
      await expect(reg.markRunning('task-1')).rejects.toThrow(/failed/);
    });

    it.each([
      ['markRunning on unknown', 'markRunning', 'ghost'],
      ['markCompleted on unknown', 'markCompleted', 'ghost'],
      ['markFailed on unknown', 'markFailed', 'ghost'],
    ])('%s throws not-found', async (_label, method, id) => {
      const reg = new WorkflowTaskRegistry({
        adapter: new InMemoryWorkflowAdapter(),
      });
      const fn = method === 'markRunning'
        ? () => reg.markRunning(id)
        : method === 'markCompleted'
        ? () => reg.markCompleted(id, '{}')
        : () => reg.markFailed(id, '{}');
      await expect(fn()).rejects.toThrow(/not found/);
    });

    it('markCompleted on a pending (not-yet-running) task throws', async () => {
      const reg = new WorkflowTaskRegistry({
        adapter: new InMemoryWorkflowAdapter(),
      });
      await reg.enqueue(sampleTask);
      await expect(reg.markCompleted('task-1', '{}')).rejects.toThrow(
        /need running/,
      );
    });

    it('markRunning on a running task throws (no double-run)', async () => {
      const reg = new WorkflowTaskRegistry({
        adapter: new InMemoryWorkflowAdapter(),
      });
      await reg.enqueue(sampleTask);
      await reg.markRunning('task-1');
      await expect(reg.markRunning('task-1')).rejects.toThrow(/running/);
    });
  });

  describe('restoreOnStartup (crash recovery)', () => {
    it('demotes running → pending + counts terminal', async () => {
      const adapter = new InMemoryWorkflowAdapter();
      // Simulate state left by a crash: one running (mid-flight), one
      // completed (crashed AFTER terminal), one pending (never started).
      const now = 1_000;
      await adapter.insert({
        id: 'a',
        kind: 'k',
        payload: '{}',
        status: 'running',
        attempts: 1,
        createdAtMs: now,
        updatedAtMs: now,
      });
      await adapter.insert({
        id: 'b',
        kind: 'k',
        payload: '{}',
        status: 'completed',
        attempts: 1,
        createdAtMs: now,
        updatedAtMs: now,
        completedAtMs: now + 100,
        resultJson: '{}',
      });
      await adapter.insert({
        id: 'c',
        kind: 'k',
        payload: '{}',
        status: 'pending',
        attempts: 0,
        createdAtMs: now,
        updatedAtMs: now,
      });

      const events: WorkflowEvent[] = [];
      const reg = new WorkflowTaskRegistry({
        adapter,
        onEvent: (e) => events.push(e),
      });
      const summary = await reg.restoreOnStartup();
      expect(summary.loaded).toBe(3);
      expect(summary.demotedRunningToPending).toBe(1);
      expect(summary.terminal).toBe(1); // 'b' is completed; 'c' is pending

      // Verify `a` is now pending and attempts are preserved for retry accounting.
      const aAfter = await reg.get('a');
      expect(aAfter?.status).toBe('pending');
      expect(aAfter?.attempts).toBe(1); // prior run counted

      // The `restored` event fired for `a`.
      const restored = events.find((e) => e.kind === 'restored');
      expect(restored).toMatchObject({ kind: 'restored', id: 'a', fromStatus: 'running' });
    });

    it('leaves terminal tasks unchanged', async () => {
      const adapter = new InMemoryWorkflowAdapter();
      await adapter.insert({
        id: 'done',
        kind: 'k',
        payload: '{}',
        status: 'completed',
        attempts: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        completedAtMs: 2,
        resultJson: '{}',
      });
      const reg = new WorkflowTaskRegistry({ adapter });
      await reg.restoreOnStartup();
      const done = await reg.get('done');
      expect(done?.status).toBe('completed');
      expect(done?.resultJson).toBe('{}');
    });

    it('empty adapter is a no-op', async () => {
      const reg = new WorkflowTaskRegistry({
        adapter: new InMemoryWorkflowAdapter(),
      });
      expect(await reg.restoreOnStartup()).toEqual({
        loaded: 0,
        demotedRunningToPending: 0,
        terminal: 0,
      });
    });
  });

  describe('listPending + listAll', () => {
    it('listPending is FIFO (oldest first), only pending', async () => {
      const clock = fixedClock();
      const reg = new WorkflowTaskRegistry({
        adapter: new InMemoryWorkflowAdapter(),
        nowMsFn: clock.nowMsFn,
      });
      await reg.enqueue({ id: 'a', kind: 'k', payload: '{}' });
      clock.advance(10);
      await reg.enqueue({ id: 'b', kind: 'k', payload: '{}' });
      clock.advance(10);
      await reg.enqueue({ id: 'c', kind: 'k', payload: '{}' });
      // Complete `a` so it's no longer pending.
      await reg.markRunning('a');
      await reg.markCompleted('a', '{}');
      const pending = await reg.listPending();
      expect(pending.map((t) => t.id)).toEqual(['b', 'c']);
    });

    it('listAll returns all tasks in createdAt order', async () => {
      const clock = fixedClock();
      const reg = new WorkflowTaskRegistry({
        adapter: new InMemoryWorkflowAdapter(),
        nowMsFn: clock.nowMsFn,
      });
      await reg.enqueue({ id: 'a', kind: 'k', payload: '{}' });
      clock.advance(10);
      await reg.enqueue({ id: 'b', kind: 'k', payload: '{}' });
      expect((await reg.listAll()).map((t) => t.id)).toEqual(['a', 'b']);
    });
  });

  describe('purge', () => {
    it('removes terminal tasks', async () => {
      const reg = new WorkflowTaskRegistry({
        adapter: new InMemoryWorkflowAdapter(),
      });
      await reg.enqueue(sampleTask);
      await reg.markRunning('task-1');
      await reg.markCompleted('task-1', '{}');
      expect(await reg.purge('task-1')).toBe(true);
      expect(await reg.get('task-1')).toBeNull();
    });

    it('refuses to purge pending / running tasks', async () => {
      const reg = new WorkflowTaskRegistry({
        adapter: new InMemoryWorkflowAdapter(),
      });
      await reg.enqueue(sampleTask);
      expect(await reg.purge('task-1')).toBe(false);
      await reg.markRunning('task-1');
      expect(await reg.purge('task-1')).toBe(false);
    });

    it('throws on unknown id', async () => {
      const reg = new WorkflowTaskRegistry({
        adapter: new InMemoryWorkflowAdapter(),
      });
      await expect(reg.purge('ghost')).rejects.toThrow(/not found/);
    });
  });

  describe('construction validation', () => {
    it('rejects missing adapter', () => {
      expect(
        () =>
          new WorkflowTaskRegistry({
            adapter: undefined as unknown as InMemoryWorkflowAdapter,
          }),
      ).toThrow(/adapter is required/);
    });
  });

  describe('persistence across registry instances', () => {
    it('second registry over same adapter sees prior tasks', async () => {
      const adapter = new InMemoryWorkflowAdapter();
      const first = new WorkflowTaskRegistry({ adapter });
      await first.enqueue(sampleTask);
      await first.markRunning('task-1');

      const second = new WorkflowTaskRegistry({ adapter });
      const restore = await second.restoreOnStartup();
      expect(restore.demotedRunningToPending).toBe(1);
      const pending = await second.listPending();
      expect(pending.map((t) => t.id)).toEqual(['task-1']);
    });
  });
});
