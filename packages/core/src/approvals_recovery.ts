/**
 * Boot recovery for owner approvals a crash cut short (REAL_LIFE_FIXES_2
 * §4, §14, §15): forget jobs, purchases not yet counted, standing replies
 * and budgets not yet turned on, and their cards not yet settled.
 *
 * Run it once each host has installed the workflow service and the
 * repositories: without the service, a card's fate cannot be read. Each
 * part is safe to repeat.
 */

import { reconcileEarnedRoomAtBoot } from './commitment/earned_room';
import { reconcileModelChangesAtBoot } from './commitment/model_changes';
import { reconcileOwnerQuestionsAtBoot } from './commitment/owner_questions';
import { getBookingStore, reconcileBookingReminders } from './coordination/group_booking';
import { resumeForgetJobs } from './forget/forget';
import { reconcileSpend } from './spend/allowance';
import { reconcileStandingReplies } from './standing/standing_replies';
import { getWorkflowService } from './workflow/service';

export async function recoverOwnerApprovals(): Promise<{ ran: boolean }> {
  if (getWorkflowService() === null) return { ran: false };
  await resumeForgetJobs();
  await reconcileSpend();
  await reconcileStandingReplies();
  // COMMITMENT_KERNEL §15 step 5: value-model changes the owner approved.
  await reconcileModelChangesAtBoot();
  // §15 step 13: wider room the owner said yes to.
  await reconcileEarnedRoomAtBoot();
  // §15 step 14: Brain's questions whose cards a crash left decided.
  await reconcileOwnerQuestionsAtBoot();
  // COMMITMENT_KERNEL §15 step 6: each group booking's reminder follows its record.
  const bookings = getBookingStore();
  if (bookings !== null) await reconcileBookingReminders(bookings, Date.now());
  return { ran: true };
}
