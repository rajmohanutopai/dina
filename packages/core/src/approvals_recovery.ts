/**
 * Boot recovery for owner approvals a crash cut short (REAL_LIFE_FIXES_2
 * §4, §14, §15): forget jobs, purchases not yet counted, standing replies
 * and budgets not yet turned on, and their cards not yet settled.
 *
 * Run it once each host has installed the workflow service and the
 * repositories: without the service, a card's fate cannot be read. Each
 * part is safe to repeat.
 */

import { resumeForgetJobs } from './forget/forget';
import { reconcileSpend } from './spend/allowance';
import { reconcileStandingReplies } from './standing/standing_replies';
import { getWorkflowService } from './workflow/service';

export async function recoverOwnerApprovals(): Promise<{ ran: boolean }> {
  if (getWorkflowService() === null) return { ran: false };
  await resumeForgetJobs();
  await reconcileSpend();
  await reconcileStandingReplies();
  return { ran: true };
}
