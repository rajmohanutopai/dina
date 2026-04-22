/**
 * Task queue — state machine for background jobs.
 *
 * States: pending → running → completed | failed | dead_letter
 * Retry: up to max_attempts (default 3), then dead-letter.
 * Recovery: running tasks past timeout reset to pending.
 * Ordering: FIFO within pending tasks (by created_at).
 *
 * Source: core/test/taskqueue_test.go
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface TaskRecord {
  id: string;
  type: string;
  payload: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'dead_letter';
  attempts: number;
  max_attempts: number;
  scheduled_at: number;
  started_at?: number;
  completed_at?: number;
  error: string;
  created_at: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const tasks = new Map<string, TaskRecord>();

/** Enqueue a new task. Returns task ID. */
export function enqueueTask(task: Partial<TaskRecord>): string {
  const id = task.id ?? `task-${bytesToHex(randomBytes(8))}`;
  const now = Math.floor(Date.now() / 1000);

  tasks.set(id, {
    id,
    type: task.type ?? 'unknown',
    payload: task.payload ?? '{}',
    status: 'pending',
    attempts: 0,
    max_attempts: task.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
    scheduled_at: task.scheduled_at ?? now,
    error: '',
    created_at: now,
  });

  return id;
}

/** Dequeue the next pending task (FIFO by created_at). Marks as running. */
export function dequeueTask(): TaskRecord | null {
  let oldest: TaskRecord | null = null;
  for (const task of tasks.values()) {
    if (task.status !== 'pending') continue;
    if (!oldest || task.created_at < oldest.created_at) {
      oldest = task;
    }
  }
  if (!oldest) return null;

  oldest.status = 'running';
  oldest.started_at = Math.floor(Date.now() / 1000);
  return oldest;
}

/** Mark a task as completed. */
export function completeTask(taskId: string): void {
  const task = tasks.get(taskId);
  if (!task) throw new Error(`task_queue: task "${taskId}" not found`);
  task.status = 'completed';
  task.completed_at = Math.floor(Date.now() / 1000);
}

/** Mark a task as failed. Increments attempts. Resets to pending if under max. */
export function failTask(taskId: string, reason: string): void {
  const task = tasks.get(taskId);
  if (!task) throw new Error(`task_queue: task "${taskId}" not found`);
  task.attempts++;
  task.error = reason;
  task.status = task.attempts >= task.max_attempts ? 'failed' : 'pending';
  task.started_at = undefined;
}

/** Recover running tasks past timeout — reset to pending. Returns count. */
export function recoverStaleTasks(timeoutSeconds: number): number {
  const now = Math.floor(Date.now() / 1000);
  let recovered = 0;
  for (const task of tasks.values()) {
    if (task.status !== 'running') continue;
    if (task.started_at && now - task.started_at > timeoutSeconds) {
      task.status = 'pending';
      task.started_at = undefined;
      recovered++;
    }
  }
  return recovered;
}

/** Move failed tasks with attempts >= max_attempts to dead_letter. */
export function deadLetterExhausted(): number {
  let count = 0;
  for (const task of tasks.values()) {
    if (task.status === 'failed' && task.attempts >= task.max_attempts) {
      task.status = 'dead_letter';
      count++;
    }
  }
  return count;
}

/** Get a task by ID (for testing). */
export function getTask(taskId: string): TaskRecord | undefined {
  return tasks.get(taskId);
}

/** Clear all tasks (for testing). */
export function clearTasks(): void {
  tasks.clear();
}
