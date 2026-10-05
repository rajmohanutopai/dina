/**
 * Ending a Core-minted UCP card the owner said yes to: from `queued` (where
 * the approval left it) through `running` to its outcome, so the card's
 * surfaces see it finished with what was done.
 */

import { WorkflowTaskState } from '../../workflow/domain';

import type { WorkflowService } from '../../workflow/service';

export function settleCard(
  workflow: WorkflowService,
  reviewId: string,
  now: number,
  outcome: { ok: true; result: Record<string, string> } | { ok: false; reason: string },
): void {
  workflow.store().transition(reviewId, WorkflowTaskState.Queued, WorkflowTaskState.Running, now);
  if (outcome.ok) workflow.complete(reviewId, JSON.stringify(outcome.result), 'approved');
  else workflow.fail(reviewId, outcome.reason);
}
