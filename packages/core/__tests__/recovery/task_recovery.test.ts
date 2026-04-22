/**
 * T3.1 — Task recovery: timeout reset to pending, dead-letter transition.
 *
 * Source: core/test/watchdog_test.go + taskqueue_test.go
 */

import {
  enqueueTask,
  dequeueTask,
  failTask,
  recoverStaleTasks,
  deadLetterExhausted,
  getTask,
  clearTasks,
} from '../../src/task/queue';

describe('Task Recovery (Mobile-Specific)', () => {
  beforeEach(() => clearTasks());

  describe('timeout reset', () => {
    it('running task past timeout → reset to pending', () => {
      const id = enqueueTask({ type: 'test' });
      const task = dequeueTask()!;
      task.started_at = Math.floor(Date.now() / 1000) - 600;
      const count = recoverStaleTasks(300);
      expect(count).toBe(1);
      expect(getTask(id)!.status).toBe('pending');
    });

    it('only running tasks are recovered', () => {
      enqueueTask({ type: 'test' }); // pending, not running
      expect(recoverStaleTasks(300)).toBe(0);
    });
  });

  describe('dead-letter transition', () => {
    it('failed + exhausted → dead_letter', () => {
      const id = enqueueTask({ type: 'test', max_attempts: 1 });
      dequeueTask();
      failTask(id, 'error');
      const count = deadLetterExhausted();
      expect(count).toBe(1);
      expect(getTask(id)!.status).toBe('dead_letter');
    });

    it('dead-lettered tasks preserved (not deleted)', () => {
      const id = enqueueTask({ type: 'test', max_attempts: 1 });
      dequeueTask();
      failTask(id, 'error');
      deadLetterExhausted();
      expect(getTask(id)).toBeDefined();
      expect(getTask(id)!.status).toBe('dead_letter');
    });
  });
});
