/**
 * `setAskApprovalGateway` / `getAskApprovalGateway` — module-level
 * indirection that lets the mobile chat UI's approval-card buttons
 * drive the Pattern A `AskApprovalGateway` without holding a direct
 * reference to the coordinator.
 *
 * **Why this exists**: chat-tab approval cards are written by the
 * coordinator-bridge factory (`createCoordinatorAskHandler`) when the
 * agentic loop bails on a sensitive persona. The ApprovalManager
 * singleton already carries the pending entry, so the legacy
 * `useChatApprovals.approveCard` flow could flip the manager to
 * `approved` — but that ALONE does not fire the registry's
 * `resumeAfterApproval`, so the resumer never runs and the user
 * never gets the late answer back. The gateway IS the seam that
 * drives both sides:
 *
 *   gateway.approve(approvalId) → approvalSource.approve(...)
 *                                + registry.resumeAfterApproval(...)
 *                                → resumer fires → late answer
 *
 * The bridge installs this singleton on construction and clears it
 * on dispose. Mobile UI hooks call `getAskApprovalGateway()` and
 * prefer it over the bare `ApprovalManager` when present; in tests
 * or test-harness boots without a coordinator, the singleton stays
 * null and the legacy path still works.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md task 5.21-H follow-up #1.
 */

import type { AskApprovalGateway } from '../ask/ask_approval_gateway';

let installed: AskApprovalGateway | null = null;

/** Install the gateway. Called by `createCoordinatorAskHandler`. */
export function setAskApprovalGateway(gateway: AskApprovalGateway | null): void {
  installed = gateway;
}

/**
 * Retrieve the currently installed gateway, or null when no
 * coordinator-bridge is wired (e.g. the legacy `agenticAsk` path or
 * test harnesses that don't construct a coordinator). UI hooks
 * branch on this to decide between `gateway.approve` (Pattern A
 * resume) and bare `ApprovalManager.approveRequest` (no-resume).
 */
export function getAskApprovalGateway(): AskApprovalGateway | null {
  return installed;
}

/** Clear the singleton — used by tests and on bridge `dispose()`. */
export function resetAskApprovalGateway(): void {
  installed = null;
}
