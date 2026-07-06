/**
 * MRS-06 — Task via agent (delegation lifecycle).
 * docs/E2E_TESTING.md §7; behaviour spec dina_details.md §3.4.
 *
 * A delegation task requiring approval is staged; the owner approves it, and
 * a REAL paired `role='agent'` device then CLAIMS → RUNS → COMPLETES it over
 * signed RPCs — the actual task-queue lifecycle a runner drives. Before
 * approval the task is not claimable; only the holding agent may complete it
 * (agentCompletionGuard). Uses a scoped `runner_filter` so the claim can only
 * take THIS test's task.
 */

import { pairAgent } from '../fixtures/dina_agent';
import { expect, test } from '../fixtures/human_session';

const RUNNER = 'e2e-deleg-runner';

test.describe('MRS-06 — Agent task delegation lifecycle', () => {
  test('owner approves a delegation task; a paired agent claims, runs, and completes it', async ({
    human,
  }) => {
    const { backstage } = human;
    const agent = await pairAgent('e2e-delegation-agent');

    const nowSec = Math.floor(Date.now() / 1000);
    const taskId = `e2e-deleg-${Date.now().toString(36)}`;

    // ── Owner stages a delegation task requiring approval ───────────────
    await backstage.dispatchOk('POST', '/v1/workflow/tasks', {
      body: {
        id: taskId,
        kind: 'delegation',
        description: 'summarize my inbox',
        payload: JSON.stringify({ type: 'delegation', capability: 'summarize' }),
        expires_at: nowSec + 3600,
        initial_state: 'pending_approval',
        requested_runner: RUNNER,
        priority: 'normal',
      },
    });
    expect(
      await backstage.approvalTaskInState(taskId, 'pending_approval', 'delegation'),
      'the delegation task is pending approval',
    ).toBe(true);

    // Before approval the agent CANNOT claim it (it isn't queued yet).
    const early = await agent.signedFetch('POST', '/v1/workflow/tasks/claim', {
      body: { runner_filter: RUNNER },
    });
    expect(early.status, 'nothing is claimable before the owner approves').toBe(204);

    // ── Owner APPROVES → the task becomes queued (claimable) ────────────
    await backstage.ownerApprove(taskId);
    await expect(async () => {
      expect(await backstage.approvalTaskInState(taskId, 'queued', 'delegation')).toBe(true);
    }).toPass({ timeout: 15_000 });

    // ── Agent CLAIMS the approved task → running, held by the agent ─────
    const claim = await agent.signedFetch('POST', '/v1/workflow/tasks/claim', {
      body: { runner_filter: RUNNER },
    });
    expect(claim.status, 'the agent claims the queued task').toBe(200);
    expect((claim.body as { id?: string }).id, 'it claimed THIS task').toBe(taskId);
    expect(
      await backstage.approvalTaskInState(taskId, 'running', 'delegation'),
      'the claimed task is running',
    ).toBe(true);

    // ── Agent COMPLETES with a result → completed ───────────────────────
    const complete = await agent.signedFetch('POST', `/v1/workflow/tasks/${taskId}/complete`, {
      body: { result: 'Summary: 3 unread, 1 urgent.' },
    });
    expect(complete.status, 'the agent completes the running task').toBe(200);
    await expect(async () => {
      expect(await backstage.approvalTaskInState(taskId, 'completed', 'delegation')).toBe(true);
    }).toPass({ timeout: 15_000 });
  });
});
