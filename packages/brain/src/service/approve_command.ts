/**
 * Default wiring for the `/service_approve` and `/service_deny` chat
 * commands.
 *
 * `/service_approve <taskId>` → `POST /v1/workflow/tasks/:id/approve`. Core
 * moves the approval task `pending_approval → queued` and emits the
 * `approved` workflow-event that Guardian consumes to spawn the delegation
 * task (via `ServiceHandler.executeAndRespond`).
 *
 * `/service_deny <taskId> [reason]` → best-effort `unavailable` response
 * via `POST /v1/service/respond` (so the requester doesn't wait for TTL
 * expiry) followed by `POST /v1/workflow/tasks/:id/cancel`. Mirrors the
 * cleanup order in `ApprovalReconciler.runTick` — errors from respond are
 * isolated since cancel is the authoritative state change.
 *
 * Kept in a separate module from the orchestrator so the orchestrator stays
 * core-client-agnostic (useful for unit tests that stub the handler directly).
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md BRAIN-P2-W02, BRAIN-P2-W04, BRAIN-P2-W05.
 */

import type { ServiceApproveCommandHandler, ServiceDenyCommandHandler } from '../chat/orchestrator';
import type { BrainCoreClient } from '../core_client/http';

/** Minimal subset of `BrainCoreClient` the approve handler needs. */
export type ServiceApproveCoreClient = Pick<BrainCoreClient, 'approveWorkflowTask'>;

/** Minimal subset of `BrainCoreClient` the deny handler needs. */
export type ServiceDenyCoreClient = Pick<
  BrainCoreClient,
  'cancelWorkflowTask' | 'sendServiceRespond'
>;

/**
 * Build a `ServiceApproveCommandHandler` that forwards to Core. The returned
 * handler is safe to install with `setServiceApproveCommandHandler`.
 *
 * Errors from Core (404, 409, network) propagate as-is; the orchestrator's
 * `formatApprovalError` translates them into user-friendly strings.
 */
export function makeServiceApproveHandler(
  coreClient: ServiceApproveCoreClient,
): ServiceApproveCommandHandler {
  if (!coreClient) {
    throw new Error('makeServiceApproveHandler: coreClient is required');
  }
  return async (taskId: string) => {
    await coreClient.approveWorkflowTask(taskId);
    return {
      // BRAIN-P2-W04: operator sees the execution plane kicking in.
      ack: `Approved — "${taskId}" executing via delegation…`,
    };
  };
}

/**
 * Build a `ServiceDenyCommandHandler` that forwards to Core. Sends the
 * `unavailable` response first (best-effort) so the requester's TTL doesn't
 * silently elapse, then cancels the approval task.
 *
 * If the operator omits a reason, we default to `denied_by_operator` so
 * downstream audit + requester-visible error strings carry a meaningful tag.
 */
export function makeServiceDenyHandler(
  coreClient: ServiceDenyCoreClient,
): ServiceDenyCommandHandler {
  if (!coreClient) {
    throw new Error('makeServiceDenyHandler: coreClient is required');
  }
  return async (taskId: string, reason: string) => {
    const denyReason = reason.trim() === '' ? 'denied_by_operator' : reason.trim();
    // `/v1/service/respond` ALREADY claims the approval task and
    // transitions it to `completed`. Calling `cancelWorkflowTask`
    // after a successful respond double-terminates — the second call
    // races the task's terminal state and can return 409, which the
    // operator sees as a failed deny even though the requester got
    // their denial (review #1). Only cancel when respond itself
    // failed, so the approval doesn't sit in `running` forever.
    let respondFailed: Error | null = null;
    try {
      await coreClient.sendServiceRespond(taskId, {
        status: 'unavailable',
        error: denyReason,
      });
    } catch (err) {
      respondFailed = err instanceof Error ? err : new Error(String(err));
    }
    if (respondFailed !== null) {
      await coreClient.cancelWorkflowTask(taskId, denyReason);
      return {
        ack: `Denied — "${taskId}" cancelled locally (respond failed: ${respondFailed.message}).`,
      };
    }
    return {
      ack: `Denied — "${taskId}" (${denyReason}).`,
    };
  };
}
