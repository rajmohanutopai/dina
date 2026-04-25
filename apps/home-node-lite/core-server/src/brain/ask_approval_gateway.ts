/**
 * Brain-side approval gateway — composes `AskRegistry` (task 5.19) with
 * an external approval source so the ask state machine can be driven
 * by operator decisions.
 *
 * The Python Brain has an in-process approval queue for fiduciary asks
 * that need human sign-off before vault access. The TS side has the
 * pieces — `AskRegistry.markPendingApproval` / `resumeAfterApproval`
 * / `markFailed` and Core's `ApprovalRegistry` (task 4.72) — but no
 * primitive that orchestrates them. ADMIN_GAP.md flagged this as the
 * missing seam between the two.
 *
 * **What this primitive does**:
 *
 *   1. Operator-facing actions (`approve` / `deny`) — drive BOTH the
 *      external approval source AND the `AskRegistry` transition in
 *      one call. The two operations stay consistent: if the source
 *      rejects, the ask doesn't move; if the registry rejects, the
 *      source isn't touched.
 *   2. Reconciliation (`reconcile`) — sweeps every ask in
 *      `pending_approval` state, queries the external source for
 *      terminal status, and drives the corresponding ask transition.
 *      Closes the loop when the external source resolves an approval
 *      out-of-band (e.g. operator approves via a different surface).
 *   3. Listing (`listOpenApprovals`) — admin-UI feed of pending asks
 *      paired with their approval-source view.
 *
 * **What this primitive does NOT do**:
 *
 *   - It does NOT trigger re-execution of the ask after resume. The
 *     handler that originally produced the ask must subscribe to the
 *     `approval_resumed` event on `AskRegistry` (or run its own
 *     in_flight watcher) and re-issue the LLM call. This module is a
 *     state bridge, not a job queue.
 *   - It does NOT mutate `AskRecord.approvalId` directly — that field
 *     is owned by `AskRegistry` and only set via `markPendingApproval`.
 *     The gateway uses it as a read-only key when reconciling.
 *
 * **ApprovalSource interface** is the seam where Core's HTTP routes
 * will plug in. Today the in-process `ApprovalRegistry` from the
 * persona module satisfies it directly (no HTTP hop). When Core
 * exposes `/v1/approvals/*` over HTTP, the brain-server will adapt
 * `CoreClient.approve(id)` into the same interface — zero changes
 * here.
 *
 * **Failure taxonomy** (every operation returns a structured outcome,
 * never throws on operational failure):
 *
 *   - `unknown_approval` — the approvalId is not registered with any
 *     `pending_approval` ask. Either the operator typed a stale id,
 *     the ask already resolved, or the registry was wiped.
 *   - `source_rejected` — the external source declined the action
 *     (e.g. terminal-already, expired, denied). Caller pattern-matches
 *     on `detail` for the upstream reason.
 *   - `ask_state_invalid` — the ask was in an unexpected state when
 *     we tried to transition it. Shouldn't happen under normal
 *     orchestration but pinned for tests.
 *
 * **Idempotency**: `reconcile()` is idempotent — calling it twice in
 * a row when no source state changed is a no-op (every ask is still
 * in `pending_approval` per the source). The single-ask `approve` /
 * `deny` operations are NOT idempotent — calling them on an
 * already-resolved approval returns `source_rejected`.
 *
 * Source: `apps/home-node-lite/brain-server/ADMIN_GAP.md` §"Approval
 * registry — ❌". Closes the missing-primitive flag.
 */

import type { AskRecord, AskRegistry } from './ask_registry';

/**
 * Terminal + intermediate statuses the gateway recognises from an
 * approval source. `unknown` is distinct from `expired` so the
 * gateway can report "the source has no record of this id" separately
 * from "this id was previously valid but is now expired".
 */
export type ApprovalSourceStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'unknown';

/**
 * Minimal contract for a backing approval store. The in-process
 * `ApprovalRegistry` (task 4.72) and a future HTTP-backed adapter
 * both implement this surface. Methods that mutate state return
 * `void` on success and throw on hard failure (id not found,
 * already-terminal). The gateway catches and translates throws into
 * structured `source_rejected` outcomes.
 */
export interface ApprovalSource {
  /** Read current status for an id. Returns `'unknown'` when not present. */
  getStatus(approvalId: string): Promise<ApprovalSourceStatus> | ApprovalSourceStatus;
  /** Drive the source from `pending → approved`. Throws on transition failure. */
  approve(approvalId: string): Promise<void> | void;
  /** Drive the source from `pending → denied`. Throws on transition failure. */
  deny(approvalId: string): Promise<void> | void;
}

export interface AskApprovalGatewayOptions {
  askRegistry: AskRegistry;
  approvalSource: ApprovalSource;
  /** Diagnostic hook — fires after every gateway-driven transition. */
  onEvent?: (event: AskApprovalEvent) => void;
}

export type AskApprovalEvent =
  | {
      kind: 'approved';
      askId: string;
      approvalId: string;
    }
  | {
      kind: 'denied';
      askId: string;
      approvalId: string;
      reason: string;
    }
  | {
      kind: 'reconciled_terminal';
      askId: string;
      approvalId: string;
      sourceStatus: 'approved' | 'denied' | 'expired';
    }
  | {
      kind: 'reconcile_skipped';
      askId: string;
      approvalId: string;
      sourceStatus: 'pending' | 'unknown';
    }
  | {
      /** Source.getStatus threw mid-sweep — caller might want to alert. */
      kind: 'reconcile_source_error';
      askId: string;
      approvalId: string;
      detail: string;
    }
  | {
      /** AskRegistry transition threw mid-sweep — caller might want to alert. */
      kind: 'reconcile_transition_error';
      askId: string;
      approvalId: string;
      sourceStatus: 'approved' | 'denied' | 'expired';
      detail: string;
    };

export type ApprovalActionFailure =
  | { reason: 'unknown_approval'; detail?: string }
  | { reason: 'source_rejected'; detail: string }
  | { reason: 'ask_state_invalid'; detail: string };

export type ApprovalActionOutcome =
  | { ok: true; askId: string; approvalId: string }
  | { ok: false; failure: ApprovalActionFailure };

export interface OpenApprovalEntry {
  /** The pending ask. */
  ask: AskRecord;
  /** Live status from the approval source. */
  sourceStatus: ApprovalSourceStatus;
}

export interface ReconciliationSummary {
  /** Total pending_approval asks examined. */
  examined: number;
  /** Asks whose source was approved → `resumeAfterApproval` driven. */
  resumed: number;
  /** Asks whose source was denied → `markFailed` driven. */
  denied: number;
  /** Asks whose source was expired → `markFailed` driven with expired reason. */
  expired: number;
  /** Asks left in pending_approval (source still pending or unknown). */
  unchanged: number;
  /** Asks the gateway tried to transition but the registry rejected. */
  errors: number;
}

export class AskApprovalGateway {
  private readonly askRegistry: AskRegistry;
  private readonly approvalSource: ApprovalSource;
  private readonly onEvent?: (event: AskApprovalEvent) => void;

  constructor(opts: AskApprovalGatewayOptions) {
    if (!opts.askRegistry) {
      throw new Error('AskApprovalGateway: askRegistry is required');
    }
    if (!opts.approvalSource) {
      throw new Error('AskApprovalGateway: approvalSource is required');
    }
    this.askRegistry = opts.askRegistry;
    this.approvalSource = opts.approvalSource;
    this.onEvent = opts.onEvent;
  }

  /**
   * Operator-driven approval. Drives the source first; on success,
   * transitions the ask to in_flight via `resumeAfterApproval`.
   *
   * Failure modes:
   *   - Source throws → ask stays in pending_approval, returns
   *     `source_rejected`. Most common cause: another surface
   *     (Telegram bot, dina-admin CLI) already approved/denied.
   *   - Registry throws AFTER source success → returns
   *     `ask_state_invalid`. Source is already approved; the ask
   *     stays in pending_approval. The next `reconcile()` sweep
   *     observes the source-approved status and drives the
   *     transition to converge state. This is the failure mode that
   *     the reconcile loop exists to recover from.
   *
   * Order is deliberate (source first): if we transitioned the ask
   * first and the source rejected, we'd have a stuck ask in
   * in_flight with no path back to pending_approval — corrupt state
   * the reconcile loop can't repair.
   */
  async approve(approvalId: string): Promise<ApprovalActionOutcome> {
    if (!approvalId || approvalId.length === 0) {
      return { ok: false, failure: { reason: 'unknown_approval', detail: 'empty approvalId' } };
    }
    const ask = await this.findAskByApprovalId(approvalId);
    if (ask === null) {
      return { ok: false, failure: { reason: 'unknown_approval' } };
    }
    try {
      await this.approvalSource.approve(approvalId);
    } catch (err) {
      return { ok: false, failure: { reason: 'source_rejected', detail: stringifyError(err) } };
    }
    try {
      await this.askRegistry.resumeAfterApproval(ask.id);
    } catch (err) {
      return {
        ok: false,
        failure: { reason: 'ask_state_invalid', detail: stringifyError(err) },
      };
    }
    this.onEvent?.({ kind: 'approved', askId: ask.id, approvalId });
    return { ok: true, askId: ask.id, approvalId };
  }

  /**
   * Operator-driven denial. Drives the source first; on success,
   * fails the ask with a structured error JSON so the requester
   * polling `/api/v1/ask/:id/status` sees `failed` with a
   * machine-readable reason.
   *
   * `reason` is the operator's note shown to the requester; defaults
   * to `"Operator denied approval"` when not supplied.
   */
  async deny(approvalId: string, reason?: string): Promise<ApprovalActionOutcome> {
    if (!approvalId || approvalId.length === 0) {
      return { ok: false, failure: { reason: 'unknown_approval', detail: 'empty approvalId' } };
    }
    const ask = await this.findAskByApprovalId(approvalId);
    if (ask === null) {
      return { ok: false, failure: { reason: 'unknown_approval' } };
    }
    try {
      await this.approvalSource.deny(approvalId);
    } catch (err) {
      return { ok: false, failure: { reason: 'source_rejected', detail: stringifyError(err) } };
    }
    const operatorReason = reason ?? 'Operator denied approval';
    const errorJson = JSON.stringify({
      reason: 'denied',
      detail: operatorReason,
    });
    try {
      await this.askRegistry.markFailed(ask.id, errorJson);
    } catch (err) {
      return {
        ok: false,
        failure: { reason: 'ask_state_invalid', detail: stringifyError(err) },
      };
    }
    this.onEvent?.({ kind: 'denied', askId: ask.id, approvalId, reason: operatorReason });
    return { ok: true, askId: ask.id, approvalId };
  }

  /**
   * Sweep every ask in `pending_approval`; for each one whose source
   * is now terminal, drive the matching ask transition. Catches the
   * race where the operator resolved an approval through a different
   * surface (Telegram bot, dina-admin CLI) without going through the
   * gateway.
   *
   * Idempotent — running twice when nothing changed reports zero
   * counts in every "active" bucket. Errors transitioning individual
   * asks are isolated: one bad ask doesn't poison the whole sweep.
   */
  async reconcile(): Promise<ReconciliationSummary> {
    const summary: ReconciliationSummary = {
      examined: 0,
      resumed: 0,
      denied: 0,
      expired: 0,
      unchanged: 0,
      errors: 0,
    };

    const all = await this.askRegistry.listAll();
    for (const ask of all) {
      if (ask.status !== 'pending_approval' || !ask.approvalId) continue;
      summary.examined += 1;
      const approvalId = ask.approvalId;
      let sourceStatus: ApprovalSourceStatus;
      try {
        sourceStatus = await this.approvalSource.getStatus(approvalId);
      } catch (err) {
        // Treat source errors as unchanged + emit a diagnostic event.
        // We don't want a transient source failure to fail asks unrelated to
        // operator intent — but operators need visibility into bad rows
        // that a counter alone wouldn't expose.
        summary.unchanged += 1;
        this.onEvent?.({
          kind: 'reconcile_source_error',
          askId: ask.id,
          approvalId,
          detail: stringifyError(err),
        });
        continue;
      }

      if (sourceStatus === 'pending' || sourceStatus === 'unknown') {
        summary.unchanged += 1;
        this.onEvent?.({
          kind: 'reconcile_skipped',
          askId: ask.id,
          approvalId,
          sourceStatus,
        });
        continue;
      }

      try {
        if (sourceStatus === 'approved') {
          await this.askRegistry.resumeAfterApproval(ask.id);
          summary.resumed += 1;
        } else if (sourceStatus === 'denied') {
          const errorJson = JSON.stringify({
            reason: 'denied',
            detail: 'Approval denied (reconciled out-of-band)',
          });
          await this.askRegistry.markFailed(ask.id, errorJson);
          summary.denied += 1;
        } else {
          // expired
          const errorJson = JSON.stringify({
            reason: 'approval_expired',
            detail: 'Approval expired before operator decision',
          });
          await this.askRegistry.markFailed(ask.id, errorJson);
          summary.expired += 1;
        }
        this.onEvent?.({
          kind: 'reconciled_terminal',
          askId: ask.id,
          approvalId,
          sourceStatus,
        });
      } catch (err) {
        summary.errors += 1;
        this.onEvent?.({
          kind: 'reconcile_transition_error',
          askId: ask.id,
          approvalId,
          sourceStatus,
          detail: stringifyError(err),
        });
      }
    }

    return summary;
  }

  /**
   * Snapshot every ask in `pending_approval` paired with its
   * source-side status. Powers the admin UI's approval queue view.
   *
   * Source-status read failures degrade to `unknown` per-row so a
   * single bad row doesn't break the whole list. Asks with no
   * `approvalId` are skipped (defensively — the registry shouldn't
   * produce them, but a paranoid filter avoids surprising entries).
   */
  async listOpenApprovals(): Promise<OpenApprovalEntry[]> {
    const all = await this.askRegistry.listAll();
    const entries: OpenApprovalEntry[] = [];
    for (const ask of all) {
      if (ask.status !== 'pending_approval' || !ask.approvalId) continue;
      let sourceStatus: ApprovalSourceStatus;
      try {
        sourceStatus = await this.approvalSource.getStatus(ask.approvalId);
      } catch {
        sourceStatus = 'unknown';
      }
      entries.push({ ask, sourceStatus });
    }
    return entries;
  }

  /**
   * Reverse lookup: given an approvalId, find the ask it belongs to.
   * Returns null when no ask in `pending_approval` carries that id.
   *
   * Linear scan over `listAll()` — fine for the expected scale (a
   * handful of pending approvals at any time). If pending volumes
   * grow, swap in an indexed cache here without touching the public
   * API.
   */
  private async findAskByApprovalId(approvalId: string): Promise<AskRecord | null> {
    const all = await this.askRegistry.listAll();
    for (const ask of all) {
      if (ask.status === 'pending_approval' && ask.approvalId === approvalId) {
        return ask;
      }
    }
    return null;
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
