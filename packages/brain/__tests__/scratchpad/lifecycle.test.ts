/**
 * T2B.8 — Scratchpad: checkpoint/resume for multi-step reasoning.
 *
 * Category B: contract test.
 *
 * Source: brain/tests/test_scratchpad.py
 */

import {
  writeCheckpoint,
  readCheckpoint,
  deleteCheckpoint,
  isCheckpointStale,
  clearCheckpoints,
} from '../../src/scratchpad/lifecycle';
import type { Checkpoint } from '../../src/scratchpad/lifecycle';

describe('Scratchpad Lifecycle', () => {
  beforeEach(() => clearCheckpoints());

  describe('writeCheckpoint', () => {
    it('writes checkpoint after step 1', async () => {
      await writeCheckpoint('task-001', 1, { query: 'test' });
      const cp = await readCheckpoint('task-001');
      expect(cp).not.toBeNull();
      expect(cp!.step).toBe(1);
      expect(cp!.context).toEqual({ query: 'test' });
    });

    it('writes checkpoint after step 2', async () => {
      await writeCheckpoint('task-001', 2, { query: 'test', results: [] });
      const cp = await readCheckpoint('task-001');
      expect(cp!.step).toBe(2);
      expect(cp!.context).toEqual({ query: 'test', results: [] });
    });

    it('overwrites previous checkpoint for same task', async () => {
      await writeCheckpoint('task-001', 1, { query: 'old' });
      await writeCheckpoint('task-001', 3, { final: true });
      const cp = await readCheckpoint('task-001');
      expect(cp!.step).toBe(3);
      expect(cp!.context).toEqual({ final: true });
    });

    it('preserves createdAt on overwrite', async () => {
      await writeCheckpoint('task-001', 1, { a: 1 });
      const cp1 = await readCheckpoint('task-001');
      const created = cp1!.createdAt;

      await writeCheckpoint('task-001', 2, { a: 2 });
      const cp2 = await readCheckpoint('task-001');
      expect(cp2!.createdAt).toBe(created);
      expect(cp2!.updatedAt).toBeGreaterThanOrEqual(cp2!.createdAt);
    });

    it('checkpoint includes all prior context', async () => {
      await writeCheckpoint('task-001', 2, { step1: 'done', step2: 'in_progress' });
      const cp = await readCheckpoint('task-001');
      expect(cp!.context.step1).toBe('done');
      expect(cp!.context.step2).toBe('in_progress');
    });
  });

  describe('readCheckpoint', () => {
    it('resumes from last checkpoint', async () => {
      await writeCheckpoint('task-001', 1, { a: 1 });
      await writeCheckpoint('task-001', 2, { a: 2 });
      await writeCheckpoint('task-001', 3, { a: 3 });
      const cp = await readCheckpoint('task-001');
      expect(cp!.step).toBe(3);
    });

    it('returns null when no checkpoint exists (fresh start)', async () => {
      const cp = await readCheckpoint('task-nonexistent');
      expect(cp).toBeNull();
    });

    it('stale checkpoint returns null (expired 24h)', async () => {
      const baseTime = 1700000000000;
      jest.spyOn(Date, 'now').mockReturnValue(baseTime);
      await writeCheckpoint('task-stale', 1, { x: 1 });

      // Advance time by 25 hours
      jest.spyOn(Date, 'now').mockReturnValue(baseTime + 25 * 60 * 60 * 1000);
      const cp = await readCheckpoint('task-stale');
      expect(cp).toBeNull();

      jest.restoreAllMocks();
    });

    it('uses accumulated context from all prior steps', async () => {
      await writeCheckpoint('task-001', 1, { step1: 'done' });
      await writeCheckpoint('task-001', 2, { step1: 'done', step2: 'done' });
      const cp = await readCheckpoint('task-001');
      expect(cp!.context).toEqual({ step1: 'done', step2: 'done' });
    });

    it('multiple tasks resume independently', async () => {
      await writeCheckpoint('task-A', 2, { taskA: true });
      await writeCheckpoint('task-B', 5, { taskB: true });
      const cpA = await readCheckpoint('task-A');
      const cpB = await readCheckpoint('task-B');
      expect(cpA!.step).toBe(2);
      expect(cpB!.step).toBe(5);
      expect(cpA!.context).toEqual({ taskA: true });
      expect(cpB!.context).toEqual({ taskB: true });
    });
  });

  describe('deleteCheckpoint', () => {
    it('deletes on task completion', async () => {
      await writeCheckpoint('task-001', 3, { done: true });
      await deleteCheckpoint('task-001');
      const cp = await readCheckpoint('task-001');
      expect(cp).toBeNull();
    });

    it('no error when deleting non-existent checkpoint', async () => {
      await expect(deleteCheckpoint('task-none')).resolves.toBeUndefined();
    });
  });

  describe('isCheckpointStale', () => {
    it('checkpoint from 12 hours ago → not stale', () => {
      const now = 1700000000000;
      const cp: Checkpoint = {
        taskId: 'task-001',
        step: 1,
        context: {},
        createdAt: now - 43200_000,
        updatedAt: now - 43200_000,
      };
      expect(isCheckpointStale(cp, now)).toBe(false);
    });

    it('checkpoint from 25 hours ago → stale', () => {
      const now = 1700000000000;
      const cp: Checkpoint = {
        taskId: 'task-001',
        step: 1,
        context: {},
        createdAt: now - 90_000_000,
        updatedAt: now - 90_000_000,
      };
      expect(isCheckpointStale(cp, now)).toBe(true);
    });

    it('exactly 24 hours → stale', () => {
      const now = 1700000000000;
      const cp: Checkpoint = {
        taskId: 'task-001',
        step: 1,
        context: {},
        createdAt: now - 86_400_000,
        updatedAt: now - 86_400_000,
      };
      expect(isCheckpointStale(cp, now)).toBe(true);
    });

    it('large checkpoint still subject to TTL', () => {
      const now = 1700000000000;
      const cp: Checkpoint = {
        taskId: 'task-001',
        step: 10,
        context: { data: 'x'.repeat(10000) },
        createdAt: now - 90_000_000,
        updatedAt: now - 90_000_000,
      };
      expect(isCheckpointStale(cp, now)).toBe(true);
    });

    it('recently updated checkpoint → not stale', () => {
      const now = 1700000000000;
      const cp: Checkpoint = {
        taskId: 'task-001',
        step: 5,
        context: {},
        createdAt: now - 90_000_000,
        updatedAt: now - 3_600_000, // created 25h ago, updated 1h ago
      };
      expect(isCheckpointStale(cp, now)).toBe(false);
    });

    it('defaults to Date.now() when now not provided', () => {
      const cp: Checkpoint = {
        taskId: 'task-001',
        step: 1,
        context: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      expect(isCheckpointStale(cp)).toBe(false);
    });
  });
});
