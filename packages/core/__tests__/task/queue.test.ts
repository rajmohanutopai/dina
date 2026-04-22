/**
 * T2A.4 — Task queue state machine: enqueue, dequeue, complete, fail,
 * recovery, dead-letter.
 *
 * Category B: contract test.
 *
 * Source: core/test/taskqueue_test.go
 */

import {
  enqueueTask,
  dequeueTask,
  completeTask,
  failTask,
  recoverStaleTasks,
  deadLetterExhausted,
  getTask,
  clearTasks,
} from '../../src/task/queue';

describe('Task Queue', () => {
  beforeEach(() => {
    clearTasks();
  });

  describe('enqueueTask', () => {
    it('creates a pending task and returns ID', () => {
      const id = enqueueTask({ type: 'sync_gmail', payload: '{}' });
      expect(id).toMatch(/^task-/);
      const task = getTask(id)!;
      expect(task.status).toBe('pending');
      expect(task.type).toBe('sync_gmail');
    });

    it('assigns unique IDs', () => {
      const id1 = enqueueTask({ type: 'test' });
      const id2 = enqueueTask({ type: 'test' });
      expect(id1).not.toBe(id2);
    });

    it('defaults max_attempts to 3', () => {
      const id = enqueueTask({ type: 'test' });
      expect(getTask(id)!.max_attempts).toBe(3);
    });

    it('respects custom max_attempts', () => {
      const id = enqueueTask({ type: 'test', max_attempts: 5 });
      expect(getTask(id)!.max_attempts).toBe(5);
    });
  });

  describe('dequeueTask', () => {
    it('returns next pending task (FIFO)', () => {
      enqueueTask({ id: 'first', type: 'a' });
      enqueueTask({ id: 'second', type: 'b' });
      const task = dequeueTask()!;
      expect(task.id).toBe('first');
    });

    it('marks dequeued task as running', () => {
      enqueueTask({ id: 'run-me', type: 'test' });
      const task = dequeueTask()!;
      expect(task.status).toBe('running');
      expect(task.started_at).toBeDefined();
    });

    it('returns null when queue is empty', () => {
      expect(dequeueTask()).toBeNull();
    });

    it('skips non-pending tasks', () => {
      const id = enqueueTask({ id: 'skip', type: 'test' });
      dequeueTask(); // now running
      completeTask(id); // now completed
      expect(dequeueTask()).toBeNull();
    });
  });

  describe('completeTask', () => {
    it('marks task as completed', () => {
      const id = enqueueTask({ type: 'test' });
      dequeueTask(); // running
      completeTask(id);
      expect(getTask(id)!.status).toBe('completed');
    });

    it('sets completed_at timestamp', () => {
      const id = enqueueTask({ type: 'test' });
      dequeueTask();
      completeTask(id);
      expect(getTask(id)!.completed_at).toBeDefined();
    });

    it('throws for non-existent task', () => {
      expect(() => completeTask('nope')).toThrow('not found');
    });
  });

  describe('failTask', () => {
    it('increments attempts counter', () => {
      const id = enqueueTask({ type: 'test' });
      dequeueTask();
      failTask(id, 'connection timeout');
      expect(getTask(id)!.attempts).toBe(1);
    });

    it('records error message', () => {
      const id = enqueueTask({ type: 'test' });
      dequeueTask();
      failTask(id, 'LLM unavailable');
      expect(getTask(id)!.error).toBe('LLM unavailable');
    });

    it('resets to pending when under max_attempts', () => {
      const id = enqueueTask({ type: 'test', max_attempts: 3 });
      dequeueTask();
      failTask(id, 'error');
      expect(getTask(id)!.status).toBe('pending'); // can retry
    });

    it('stays failed when at max_attempts', () => {
      const id = enqueueTask({ type: 'test', max_attempts: 1 });
      dequeueTask();
      failTask(id, 'error');
      expect(getTask(id)!.status).toBe('failed'); // exhausted
    });
  });

  describe('recoverStaleTasks', () => {
    it('resets stale running tasks to pending', () => {
      const id = enqueueTask({ type: 'test' });
      const task = dequeueTask()!;
      // Simulate started 10 minutes ago
      task.started_at = Math.floor(Date.now() / 1000) - 600;
      const recovered = recoverStaleTasks(300); // 5-min timeout
      expect(recovered).toBe(1);
      expect(getTask(id)!.status).toBe('pending');
    });

    it('does not recover non-running tasks', () => {
      enqueueTask({ type: 'test' }); // pending, not running
      expect(recoverStaleTasks(300)).toBe(0);
    });

    it('does not recover recent running tasks', () => {
      enqueueTask({ type: 'test' });
      dequeueTask(); // just started
      expect(recoverStaleTasks(300)).toBe(0);
    });
  });

  describe('deadLetterExhausted', () => {
    it('moves failed tasks with attempts >= max to dead_letter', () => {
      const id = enqueueTask({ type: 'test', max_attempts: 1 });
      dequeueTask();
      failTask(id, 'error'); // attempts=1 >= max_attempts=1 → failed
      const count = deadLetterExhausted();
      expect(count).toBe(1);
      expect(getTask(id)!.status).toBe('dead_letter');
    });

    it('does not dead-letter tasks within retry limit', () => {
      const id = enqueueTask({ type: 'test', max_attempts: 3 });
      dequeueTask();
      failTask(id, 'error'); // attempts=1, pending (can retry)
      expect(deadLetterExhausted()).toBe(0);
    });
  });

  describe('full lifecycle', () => {
    it('enqueue → dequeue → complete', () => {
      const id = enqueueTask({ type: 'sync' });
      const task = dequeueTask()!;
      expect(task.status).toBe('running');
      completeTask(id);
      expect(getTask(id)!.status).toBe('completed');
    });

    it('enqueue → dequeue → fail → retry → complete', () => {
      const id = enqueueTask({ type: 'sync', max_attempts: 3 });
      dequeueTask();
      failTask(id, 'timeout'); // attempt 1, back to pending
      expect(getTask(id)!.status).toBe('pending');
      dequeueTask(); // retry
      completeTask(id);
      expect(getTask(id)!.status).toBe('completed');
    });

    it('enqueue → fail × max → dead_letter', () => {
      const id = enqueueTask({ type: 'sync', max_attempts: 2 });
      dequeueTask();
      failTask(id, 'err1'); // attempt 1, pending
      dequeueTask();
      failTask(id, 'err2'); // attempt 2 >= max, failed
      deadLetterExhausted();
      expect(getTask(id)!.status).toBe('dead_letter');
    });
  });
});
