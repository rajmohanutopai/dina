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
 * (INTERACTIVE_SERVICES §5). This surface shows the live runs, lets the owner
 * pause/resume the pull loop or stop a run, AND (E76-11) surfaces each run's
 * classified messages for the owner to approve/deny/acknowledge + confirm a
 * MODERATE/HIGH action's risk — every decision through the owner-only client.
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

/** #7 — owner-initiated start of an interactive run. Mints a stable
 *  `idempotency_key` and starts the run through the owner-only `/v1/run/start`
 *  route. Returns the new run id, or null on failure. */
export interface StartRunInput {
  serviceUri: string;
  providerDid: string;
  persona: string;
  ttlSeconds: number;
  intervalMs?: number;
  maxCount?: number;
}

export async function startRun(input: StartRunInput): Promise<string | null> {
  const client = getOwnerRunClient();
  if (client === null) return null;
  try {
    const idempotencyKey = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await client.runStart({
      service_uri: input.serviceUri,
      provider_did: input.providerDid,
      persona: input.persona,
      idempotency_key: idempotencyKey,
      ttl_seconds: input.ttlSeconds,
      ...(input.intervalMs !== undefined ? { interval_ms: input.intervalMs } : {}),
      ...(input.maxCount !== undefined ? { max_count: input.maxCount } : {}),
    });
    return res.run_id;
  } catch {
    return null;
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

// --- E76-11: the owner decision surface for a run's classified messages -------

export interface RunPendingItem {
  message_id: string;
  kind: 'informational' | 'action';
  sequence: number;
  action_type?: string | null;
  content_digest?: string | null;
  decision_revision?: number;
  // 81B-06 — the bounded, Core-rendered CardSpec view (never `params`/vault). Empty
  // when the persona is locked / the payload was shredded.
  title?: string;
  body?: string;
}

/** R5-01/§7 — a slot whose held-by-lock response proved unrecoverable. */
export interface RunLostItem {
  reservation_id: string;
  cursor: number;
  reason?: string | null;
}

export interface RunDecisions {
  /** Classified messages awaiting the owner's approve/deny/acknowledge. */
  pending: RunPendingItem[];
  /** Owner-approved actions parked awaiting MODERATE/HIGH risk confirmation. */
  pendingRisk: RunPendingItem[];
  /** R5-01 — lost slots pausing fetch until a provider resend or an owner skip. */
  lost: RunLostItem[];
  /** 81B-06 — service attribution: which provider/service these decisions belong to. */
  serviceUri?: string;
  providerDid?: string;
}

/** Fetch a run's pending owner decisions (via the owner-only `/status`, §11/§12.5). */
export async function getRunDecisions(runId: string): Promise<RunDecisions> {
  const client = getOwnerRunClient();
  if (client === null) return { pending: [], pendingRisk: [], lost: [] };
  try {
    const status = await client.runStatus(runId);
    const pending = Array.isArray(status.pending) ? (status.pending as RunPendingItem[]) : [];
    const pendingRisk = Array.isArray(status.pending_risk)
      ? (status.pending_risk as RunPendingItem[])
      : [];
    const lost = Array.isArray(status.lost) ? (status.lost as RunLostItem[]) : [];
    return {
      pending,
      pendingRisk,
      lost,
      serviceUri: typeof status.service_uri === 'string' ? status.service_uri : undefined,
      providerDid: typeof status.provider_did === 'string' ? status.provider_did : undefined,
    };
  } catch {
    return { pending: [], pendingRisk: [], lost: [] };
  }
}

/** Owner approve/deny/acknowledge a classified message (§12.5). New state, or null. */
export async function decideRunMessage(
  runId: string,
  messageId: string,
  decision: 'approve' | 'deny' | 'acknowledge',
  decisionRevision: number,
): Promise<string | null> {
  try {
    const res = await getOwnerRunClient()?.runDecide(runId, {
      message_id: messageId,
      decision,
      decision_revision: decisionRevision,
    });
    return res?.state ?? null;
  } catch {
    return null;
  }
}

/** Owner confirm of a MODERATE/HIGH action: risk_pending → risk_authorized (E76-08). */
export async function confirmRunRisk(runId: string, messageId: string): Promise<string | null> {
  try {
    return (await getOwnerRunClient()?.confirmRisk(runId, messageId))?.state ?? null;
  } catch {
    return null;
  }
}

/** R5-01/§7 — owner gives up on a `response_lost` slot. New state, or null. */
export async function skipLostReservation(
  runId: string,
  reservationId: string,
): Promise<string | null> {
  try {
    return (await getOwnerRunClient()?.skipLost(runId, reservationId))?.state ?? null;
  } catch {
    return null;
  }
}
