/**
 * Scratchpad — checkpoint/resume for multi-step reasoning tasks.
 *
 * Write checkpoints after each step. Resume from last checkpoint on crash.
 * Auto-expire after 24 hours. Delete on task completion.
 * Multiple tasks resume independently.
 *
 * Source: brain/tests/test_scratchpad.py
 */

export interface Checkpoint {
  taskId: string;
  step: number;
  context: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

const STALE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** In-memory checkpoint store keyed by taskId. */
const checkpoints = new Map<string, Checkpoint>();

/** Clear all checkpoints (for testing). */
export function clearCheckpoints(): void {
  checkpoints.clear();
}

/** Write a checkpoint for a task at a given step. Overwrites previous. */
export async function writeCheckpoint(
  taskId: string,
  step: number,
  context: Record<string, unknown>,
): Promise<void> {
  const now = Date.now();
  const existing = checkpoints.get(taskId);
  checkpoints.set(taskId, {
    taskId,
    step,
    context,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

/** Read the latest checkpoint for a task. Returns null if none or stale. */
export async function readCheckpoint(taskId: string): Promise<Checkpoint | null> {
  const cp = checkpoints.get(taskId);
  if (!cp) return null;
  if (isCheckpointStale(cp)) {
    checkpoints.delete(taskId);
    return null;
  }
  return cp;
}

/** Delete checkpoint on task completion. */
export async function deleteCheckpoint(taskId: string): Promise<void> {
  checkpoints.delete(taskId);
}

/** Check if a checkpoint is stale (older than 24 hours). */
export function isCheckpointStale(checkpoint: Checkpoint, now?: number): boolean {
  const currentTime = now ?? Date.now();
  return currentTime - checkpoint.updatedAt >= STALE_TTL_MS;
}
