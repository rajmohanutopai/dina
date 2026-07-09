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

import { expect, test } from '../fixtures/human_session';
import { openApprovalInbox } from '../fixtures/pages/activity';

// A stable synthetic agent DID (not a real paired device — backstage stages
// the intent as if this agent submitted it).
const AGENT = 'did:key:z6MkE2EAgentApprovals0000000000000000000000';

test.describe('MRS-08 — Agent risk ladder + approval state machine', () => {
  test('SAFE auto-approves, BLOCKED denies, HIGH/MODERATE need approval; owner decision flips state', async ({
    human,
  }) => {
    const { backstage, page } = human;
    // The confirm-dialog Approve/Deny (HIGH card, and every deny) surface as a
    // browser confirm (RN-Web Alert.alert → window.confirm on web). RECORD each
    // one before accepting so we can assert, per tap, whether the decision
    // actually flowed THROUGH a real confirmation — otherwise a state flip
    // could pass even if the confirm gate were silently bypassed.
    const dialogs: { type: string; message: string }[] = [];
    page.on('dialog', (d) => {
      dialogs.push({ type: d.type(), message: d.message() });
      void d.accept();
    });

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

    // A SECOND HIGH intent so the confirm-dialog APPROVE (the most
    // safety-critical web tap) is exercised alongside the HIGH deny.
    const high2 = await backstage.stageAgentIntent({
      action: 'transfer_money',
      target: '250 to Carol',
      agentDid: AGENT,
      session: 's3',
    });
    expect(high2.action, 'HIGH#2 (transfer_money) flags for review').toBe('flag_for_review');
    const high2Id = high2.proposal_id ?? '';
    expect(high2Id, 'HIGH#2 creates a proposal task').toBeTruthy();

    // All three are pending server-side.
    expect(await backstage.approvalTaskInState(highId, 'pending_approval')).toBe(true);
    expect(await backstage.approvalTaskInState(modId, 'pending_approval')).toBe(true);
    expect(await backstage.approvalTaskInState(high2Id, 'pending_approval')).toBe(true);

    // ── The owner DECIDES in the browser (Activity → Needs action) ───────
    // F4 fixed: the web inbox now surfaces Core-side pending approvals via the
    // brain's /api/v1/workflow/tasks proxy, so the human Approve/Deny TAP works
    // end-to-end — no longer deferred to Maestro.
    await openApprovalInbox(page);

    // UI half of "NO card for SAFE/BLOCKED": the inbox surfaces cards ONLY for
    // the three GATED intents (MODERATE + 2×HIGH) — each has exactly one deny
    // button. SAFE (auto-approved) and BLOCKED (auto-denied) raised no task, so
    // no card renders for them. Wait for the gated cards to arrive, then assert
    // the exact count (a SAFE/BLOCKED card would push it past 3).
    await page.getByTestId(`approvals-deny-${highId}`).waitFor({ state: 'visible', timeout: 40_000 });
    expect(
      await page.getByTestId(/^approvals-deny-/).count(),
      'only the 3 gated intents raise cards — SAFE + BLOCKED never render one',
    ).toBe(3);

    // (a) DIRECT approve — a MODERATE card offers a session-approve with NO
    //     confirmation. Assert the state flips AND that zero dialogs fired.
    let dialogsBefore = dialogs.length;
    const approveMod = page.getByTestId(`approvals-approve-${modId}`);
    await approveMod.waitFor({ state: 'visible', timeout: 40_000 });
    await approveMod.click();
    await expect(async () => {
      expect(await backstage.approvalTaskInState(modId, 'queued')).toBe(true);
    }).toPass({ timeout: 20_000 });
    expect(
      dialogs.length - dialogsBefore,
      'MODERATE session-approve is the direct path — no confirm dialog',
    ).toBe(0);

    // (b) CONFIRM approve — a HIGH card is 2-button; its Approve routes through
    //     window.confirm. The single most safety-critical web tap: a human
    //     confirming a HIGH-risk (transfer_money) agent action. Assert it flips
    //     to queued AND passed through exactly one confirm dialog.
    dialogsBefore = dialogs.length;
    const approveHigh2 = page.getByTestId(`approvals-approve-${high2Id}`);
    await approveHigh2.waitFor({ state: 'visible', timeout: 40_000 });
    await approveHigh2.click();
    await expect(async () => {
      expect(await backstage.approvalTaskInState(high2Id, 'queued')).toBe(true);
    }).toPass({ timeout: 20_000 });
    expect(
      dialogs.length - dialogsBefore,
      'HIGH confirm-approve passes through exactly one confirm dialog',
    ).toBe(1);

    // (c) CONFIRM deny — deny always confirms. Assert the POSITIVE terminal
    //     state only a real deny produces (cancelled), so a transient
    //     workflow-list blip (which reads as "not in that state") RETRIES
    //     instead of greening a deny that never took effect.
    dialogsBefore = dialogs.length;
    const denyHigh = page.getByTestId(`approvals-deny-${highId}`);
    await denyHigh.waitFor({ state: 'visible', timeout: 40_000 });
    await denyHigh.click();
    await expect(async () => {
      expect(await backstage.approvalTaskInState(highId, 'cancelled')).toBe(true);
    }).toPass({ timeout: 20_000 });
    expect(
      dialogs.length - dialogsBefore,
      'HIGH deny passes through exactly one confirm dialog',
    ).toBe(1);
    expect(
      await backstage.approvalTaskInState(highId, 'queued'),
      'denied HIGH task never becomes queued (the agent is blocked)',
    ).toBe(false);
  });
});
