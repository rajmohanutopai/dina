/**
 * Interactive-run data hook (ISVC-9) — list runs + steer them (pause / resume /
 * stop).
 *
 * Every call goes through the owner-only control client (`getOwnerRunClient`,
 * INTERACTIVE_SERVICES §12.5): an owner-marked in-process dispatch → the
 * `/v1/run/*` route guards → durable command receipts. It does NOT read the raw
 * `getRunService()` global — that global is reachable by Brain on this same JS
 * VM, and "trusted-in-process" is explicitly NOT the owner boundary (§20). The
 * client also returns safe display DTOs, so the full `RunRecord` (config + crypto
 * fields) never reaches the UI.
 *
 * A run is a bounded, owner-authorized interactive session with a provider
 * (INTERACTIVE_SERVICES §5). This surface shows the live runs and lets the owner
 * pause/resume the pull loop or stop a run; per-message decisions (approve/deny)
 * surface through the Activity approval inbox, not here.
 */

import { type RunListItem } from '@dina/core';

import { getOwnerRunClient } from '../services/owner_run_client';

export type RunUIItem = RunListItem & {
  /** Human progress, e.g. "3 / 10" or "3" (unbounded). */
  progressLabel: string;
};

function progressLabel(produced: number, max: number | null): string {
  return max === null ? String(produced) : `${produced} / ${max}`;
}

/** The active (non-terminal-first) runs. */
export async function getActiveRuns(): Promise<RunUIItem[]> {
  const client = getOwnerRunClient();
  if (client === null) return [];
  try {
    const { runs } = await client.runList();
    return runs.map((r) => ({ ...r, progressLabel: progressLabel(r.produced_count, r.max_count) }));
  } catch {
    return [];
  }
}

/** Pause the pull loop (keeps the run). Returns the new state, or null. */
export async function pauseRun(runId: string): Promise<string | null> {
  try {
    return (await getOwnerRunClient()?.runPause(runId))?.state ?? null;
  } catch {
    return null;
  }
}

/** Resume a paused run. Returns the new state, or null. */
export async function resumeRun(runId: string): Promise<string | null> {
  try {
    return (await getOwnerRunClient()?.runResume(runId))?.state ?? null;
  } catch {
    return null;
  }
}

/** Stop a run (drains, then terminates). Returns the new state, or null. */
export async function stopRun(runId: string): Promise<string | null> {
  try {
    return (await getOwnerRunClient()?.runStop(runId))?.state ?? null;
  } catch {
    return null;
  }
}
