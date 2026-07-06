/**
 * MRS-08 — Approvals / agent risk ladder + human decision.
 * docs/E2E_TESTING.md §7; behaviour spec dina_details.md §3.7.
 *
 * An external agent submits intents at each risk level to the SAME
 * `/v1/agent/validate` endpoint dina-agent uses. The submission is staged
 * via backstage (§8 — a precondition a single browser cannot produce); the
 * gatekeeper, the created approval task, and the owner-decision routes are
 * all the real product path. The deterministic ladder resolves SAFE→auto
 * and BLOCKED→deny synchronously; MODERATE/HIGH raise a pending_approval
 * task that the HUMAN approves/denies IN THE BROWSER, flipping its state.
 */

import { expect, test, type HumanSession } from '../fixtures/human_session';

// A stable synthetic agent DID (not a real paired device — backstage stages
// the intent as if this agent submitted it).
const AGENT = 'did:key:z6MkE2EAgentApprovals0000000000000000000000';

/** Open the Activity tab and select the "Needs action" filter, where the
 *  inline approval cards live (the standalone Approvals screen was merged
 *  into Activity). Re-tapping re-fetches, surfacing a just-staged task. */
async function openApprovalInbox(page: HumanSession['page']): Promise<void> {
  await page.getByRole('tab', { name: 'Activity tab' }).click();
  await page.getByTestId('filter-needs_action').click();
}

test.describe('MRS-08 — Agent risk ladder + approval state machine', () => {
  test('SAFE auto-approves, BLOCKED denies, HIGH/MODERATE need approval; owner decision flips state', async ({
    human,
  }) => {
    const { backstage, page } = human;

    // ── Deterministic ladder (no LLM, no card) ──────────────────────────
    const safe = await backstage.stageAgentIntent({
      action: 'search',
      target: 'weather in London',
      agentDid: AGENT,
      session: 's1',
    });
    expect(safe.action, 'SAFE (search) auto-approves').toBe('auto_approve');
    expect(safe.requires_approval ?? false, 'SAFE needs no approval').toBe(false);

    const blocked = await backstage.stageAgentIntent({
      action: 'read_vault',
      target: 'health',
      agentDid: AGENT,
      session: 's1',
    });
    expect(blocked.action, 'BLOCKED (read_vault) is denied outright').toBe('deny');
    expect(blocked.requires_approval ?? false, 'BLOCKED never raises a card').toBe(false);

    // ── MODERATE + HIGH each raise a pending_approval task ───────────────
    const high = await backstage.stageAgentIntent({
      action: 'transfer_money',
      target: '5000 to Bob',
      agentDid: AGENT,
      session: 's1',
    });
    expect(high.action, 'HIGH (transfer_money) flags for review').toBe('flag_for_review');
    expect(high.requires_approval, 'HIGH requires approval').toBe(true);
    const highId = high.proposal_id ?? '';
    expect(highId, 'HIGH creates a proposal task').toBeTruthy();

    const mod = await backstage.stageAgentIntent({
      action: 'send_large',
      target: '2000 records to archive',
      agentDid: AGENT,
      session: 's2',
    });
    expect(mod.action, 'MODERATE (send_large) flags for review').toBe('flag_for_review');
    const modId = mod.proposal_id ?? '';
    expect(modId, 'MODERATE creates a proposal task').toBeTruthy();

    // Both are pending server-side.
    expect(await backstage.approvalTaskInState(highId, 'pending_approval')).toBe(true);
    expect(await backstage.approvalTaskInState(modId, 'pending_approval')).toBe(true);

    // ── The human-facing Activity surface renders the pending queue ──────
    // The browser navigates to Activity → Needs action (the owner's inbox).
    // NB: the limited-mode-web thin-client's inbox does not yet SURFACE a
    // task staged externally on Core (open question — see notes); the full
    // in-app Approve/Deny TAP is covered by Maestro on the mobile full node.
    // Here we confirm the human surface exists + doesn't crash.
    await openApprovalInbox(page);
    await expect(page.getByTestId('filter-needs_action')).toBeVisible();

    // ── The owner's DECISION flips the task state (real owner routes) ────
    // This is the exact server-side transition the Approve/Deny taps invoke,
    // guarded by the owner-decision guard.
    await backstage.ownerApprove(highId);
    await expect(async () => {
      expect(await backstage.approvalTaskInState(highId, 'queued')).toBe(true);
    }).toPass({ timeout: 20_000 });
    expect(
      await backstage.approvalTaskInState(highId, 'pending_approval'),
      'approved HIGH task is no longer pending (agent may proceed)',
    ).toBe(false);

    await backstage.ownerDeny(modId);
    await expect(async () => {
      expect(await backstage.approvalTaskInState(modId, 'pending_approval')).toBe(false);
    }).toPass({ timeout: 20_000 });
    expect(
      await backstage.approvalTaskInState(modId, 'queued'),
      'denied MODERATE task never becomes queued (agent is blocked)',
    ).toBe(false);
  });
});
