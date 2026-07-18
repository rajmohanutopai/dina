/**
 * Interactive-run data hook (ISVC-9) — list runs + steer them (pause / resume /
 * stop). Reads the in-process `RunService` singleton directly (mobile owner is
 * trusted in-process), the same pattern `useSubscriptions` uses for watches.
 *
 * A run is a bounded, owner-authorized interactive session with a provider
 * (INTERACTIVE_SERVICES §5). This surface shows the live runs and lets the
 * owner pause/resume the pull loop or stop a run; per-message decisions
 * (approve/deny) surface through the Activity approval inbox, not here.
 */

import { getRunService, runToListItem, type RunListItem } from '@dina/core';

export type RunUIItem = RunListItem & {
  /** Human progress, e.g. "3 / 10" or "3" (unbounded). */
  progressLabel: string;
};

function progressLabel(produced: number, max: number | null): string {
  return max === null ? String(produced) : `${produced} / ${max}`;
}

/** The active (non-terminal-first) runs. */
export async function getActiveRuns(): Promise<RunUIItem[]> {
  const svc = getRunService();
  if (svc === null) return [];
  return svc
    .store()
    .listActive()
    .map(runToListItem)
    .map((r) => ({ ...r, progressLabel: progressLabel(r.produced_count, r.max_count) }));
}

/** Pause the pull loop (keeps the run). Returns the new state, or null. */
export async function pauseRun(runId: string): Promise<string | null> {
  try {
    return getRunService()?.pause(runId).state ?? null;
  } catch {
    return null;
  }
}

/** Resume a paused run. Returns the new state, or null. */
export async function resumeRun(runId: string): Promise<string | null> {
  try {
    return getRunService()?.resume(runId).state ?? null;
  } catch {
    return null;
  }
}

/** Stop a run (drains, then terminates). Returns the new state, or null. */
export async function stopRun(runId: string): Promise<string | null> {
  try {
    return getRunService()?.stop(runId).state ?? null;
  } catch {
    return null;
  }
}
