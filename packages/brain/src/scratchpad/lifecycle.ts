/**
 * Scratchpad lifecycle (brain-side façade).
 *
 * Before the Python-parity port this file held an in-process `Map`
 * that was silently lost on process exit. Python's
 * `brain/src/service/scratchpad.py` persists via Core, and mobile
 * IS a home node, so the in-memory stub dropped agent-approval
 * state + mid-flight nudge checkpoints on every app background /
 * RN foreground kill.
 *
 * New contract: every call delegates to `checkpoint` / `resume` /
 * `clear` in `packages/core/src/scratchpad/service.ts`. When Core is
 * wired in-process (mobile boot, test fixtures), that service talks
 * to a real `ScratchpadRepository` (SQLite in production, in-memory
 * in tests). The brain code never touches the store directly —
 * matches the vault / staging pattern where brain is an untrusted
 * tenant going through Core's API.
 *
 * TTL + delete-marker semantics (`step=0`) match Python.
 */

// `ScratchpadEntry` is the wire/data shape, correctly imported from
// `@dina/core`'s public surface. The scratchpad runtime functions
// (`checkpoint`/`resume`/`clear`/`sweepStale`) are Core internals we
// reach via the in-process service module — Brain can't call them
// through `CoreClient` because mobile runs Core in the same JS VM
// and the scratchpad service is a synchronous module-global. When
// home-node-lite's brain-server lands, it'll route those three calls
// through `CoreClient.scratchpadCheckpoint/Resume/Clear` over HTTP;
// for now the direct imports reflect the in-process-only reality.
import type { ScratchpadEntry } from '@dina/core';
import {
  checkpoint as coreCheckpoint,
  clear as coreClear,
  resume as coreResume,
  sweepStale as coreSweep,
} from '../../../core/src/scratchpad/service';

export interface Checkpoint {
  taskId: string;
  step: number;
  context: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/**
 * Write-through to Core's scratchpad service. Python's
 * `ScratchpadService.checkpoint` semantics — overwrites the row for
 * `taskId`, preserving `createdAt` on update. `step=0` triggers a
 * delete (parity with `write_scratchpad(taskId, 0, {"__deleted":true})`).
 */
export async function writeCheckpoint(
  taskId: string,
  step: number,
  context: Record<string, unknown>,
): Promise<void> {
  coreCheckpoint(taskId, step, context);
}

/** Read the latest checkpoint for `taskId`, or null on missing /
 *  stale / TTL expired. */
export async function readCheckpoint(taskId: string): Promise<Checkpoint | null> {
  const entry = coreResume(taskId);
  if (entry === null) return null;
  return entryToCheckpoint(entry);
}

/** Delete the checkpoint outright. Matches Python's `clear(taskId)`. */
export async function deleteCheckpoint(taskId: string): Promise<void> {
  coreClear(taskId);
}

/**
 * Drop every checkpoint. Used only by tests (production has no
 * use-case for "wipe everything"; the 24h sweeper is the right tool
 * for stale cleanup). Implemented by sweeping with a stale window of
 * 0ms so every row is considered expired.
 */
export function clearCheckpoints(): void {
  coreSweep(Number.POSITIVE_INFINITY);
}

/** Retained for code that introspected the old in-memory map's TTL. */
const STALE_TTL_MS = 24 * 60 * 60 * 1000;

export function isCheckpointStale(checkpoint: Checkpoint, now?: number): boolean {
  const currentTime = now ?? Date.now();
  return currentTime - checkpoint.updatedAt >= STALE_TTL_MS;
}

function entryToCheckpoint(entry: ScratchpadEntry): Checkpoint {
  return {
    taskId: entry.taskId,
    step: entry.step,
    context: entry.context,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}
