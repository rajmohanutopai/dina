/**
 * Scratchpad service — thin wrapper around the repository that
 * auto-provisions an in-memory backend on first use. Port of
 * `brain/src/service/scratchpad.py` (the service-layer façade; the
 * durable store lives in `./repository.ts`).
 *
 * Behaviour rules (matches Python):
 *   - `checkpoint(taskId, step, context)` is an upsert; `step=0` is
 *     interpreted as a delete marker so Python's
 *     `write_scratchpad(taskId, 0, {"__deleted": true})` semantics
 *     round-trip unchanged.
 *   - `resume(taskId)` returns null when the row is missing OR stale
 *     (older than the 24h TTL). Python's sweeper does the same job
 *     in the background; we also lazy-evict on read.
 *   - `clear(taskId)` deletes the row outright.
 */

import {
  getScratchpadRepository,
  setScratchpadRepository,
  InMemoryScratchpadRepository,
  type ScratchpadEntry,
  type ScratchpadRepository,
} from './repository';

// ScratchpadEntry is published on the public `@dina/core` barrel
// (re-exported from `client/core-client.ts`) for external brain-side
// callers. The type is not re-exported from this module to keep
// internal file boundaries clean — previously it was re-exported
// here solely to dodge the task 2.5 port-usage audit, which is no
// longer necessary since brain imports via the public barrel.

/** 24-hour TTL — matches Python's `core.scratchpad_ttl`. */
export const SCRATCHPAD_STALE_MS = 24 * 60 * 60 * 1000;

/** Step value Python writes as a delete marker. Kept exported so
 *  tests + HTTP handlers can build the same shape. */
export const DELETE_SENTINEL_STEP = 0;

function repo(): ScratchpadRepository {
  let r = getScratchpadRepository();
  if (r === null) {
    r = new InMemoryScratchpadRepository();
    setScratchpadRepository(r);
  }
  return r;
}

/**
 * UPSERT a checkpoint. Python calls this per-step with the
 * accumulated context. `step=DELETE_SENTINEL_STEP` is routed to a
 * delete for parity with the Python brain-side
 * `write_scratchpad(taskId, 0, ...)` idiom.
 */
export function checkpoint(
  taskId: string,
  step: number,
  context: Record<string, unknown>,
  nowMs: number = Date.now(),
): void {
  if (!taskId) throw new Error('scratchpad.checkpoint: taskId is required');
  if (step === DELETE_SENTINEL_STEP) {
    repo().remove(taskId);
    return;
  }
  repo().upsert(taskId, step, context, nowMs);
}

/**
 * Read the most-recent checkpoint, or null for a fresh start /
 * stale / missing row.
 */
export function resume(taskId: string, nowMs: number = Date.now()): ScratchpadEntry | null {
  if (!taskId) return null;
  return repo().get(taskId, nowMs, SCRATCHPAD_STALE_MS);
}

/** Explicit delete — Python's `scratchpad.clear(taskId)`. */
export function clear(taskId: string): void {
  if (!taskId) return;
  repo().remove(taskId);
}

/**
 * Bulk sweep of stale rows. Called by the 24h background sweeper in
 * production; also exposed for tests that want to prove the eviction
 * path without waiting 24 hours. Returns the number of rows deleted.
 */
export function sweepStale(nowMs: number = Date.now()): number {
  return repo().sweep(nowMs, SCRATCHPAD_STALE_MS);
}

/** Tests only — drop the registered repo so the next call re-provisions
 *  a fresh in-memory backend. */
export function resetScratchpadService(): void {
  setScratchpadRepository(null);
}
