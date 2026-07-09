/**
 * Activity tab / approval-inbox page helper.
 *
 * The owner's approval decisions are HUMAN-VISIBLE behavior and must be driven
 * through the browser (§8: backstage never stands in for the human-visible
 * behavior). This opens Activity → Needs-action so a pending approval card is
 * on screen to tap. Shared by MRS-07 (agent_vault_read) and MRS-08
 * (agent_approvals). (MRS-06 delegation approvals are backstage by owner
 * ruling, so they don't use this surface.)
 */

import { type Page } from '@playwright/test';

/** Open Activity → "Needs action" (the pending-approval inbox). */
export async function openApprovalInbox(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Activity tab' }).click();
  await page.getByTestId('filter-needs_action').click();
}

/**
 * Tap the Approve button on a specific approval card and wait for it to leave
 * the pending list. `vault_read` + `MODERATE intent_validation` cards approve
 * with a session scope directly (no confirm dialog); the 2-button cards (HIGH,
 * and every deny) confirm via a browser dialog — callers that hit those must
 * register a `page.on('dialog', d => d.accept())` first (RN-Web Alert.alert →
 * window.confirm on web).
 */
export async function tapApprove(page: Page, taskId: string): Promise<void> {
  const btn = page.getByTestId(`approvals-approve-${taskId}`);
  await btn.waitFor({ state: 'visible', timeout: 40_000 });
  await btn.click();
}

// NB: no shared `tapDeny` — deny ALWAYS confirms via a browser dialog, so a
// caller must register `page.on('dialog', d => d.accept())` and tap
// `approvals-deny-<id>` itself (see agent_approvals.spec.ts). A dialog-less
// helper would silently no-op on RN-Web, so it is deliberately not provided.
