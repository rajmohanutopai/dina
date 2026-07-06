/**
 * MRS-07 — Security / agent reads a sensitive vault (persona-access gate).
 * docs/E2E_TESTING.md §7; behaviour spec dina_details.md §3.6.
 *
 * The load-bearing agent-safety guarantee: a REAL paired `role='agent'`
 * device (canonical-signed RPCs → `callerType='agent'`) reading a SENSITIVE
 * persona through the agent-reachable `/v1/vault/query` route is GATED by the
 * agentGate (`requireAgentPersonaAccess`) — it gets `approval_required` + a
 * vault-read approval task and the vault is NOT touched. A DEFAULT-tier
 * persona is served (the gate discriminates by tier, it is not a blanket
 * deny). The OWNER in-app is never gated. After the owner APPROVES, the
 * agent's retry is served (the grant is issued).
 *
 * NB (corrected after review): agents ARE on the `/v1/vault/query` allowlist
 * (authz.ts) — the perimeter that blocks a sensitive read is the agentGate,
 * NOT the per-role allowlist. A POSITIVE CONTROL (agent succeeds on an
 * allowlisted route) proves the 403 is gate-specific, not a blanket
 * unlisted-path deny.
 */

import { pairAgent } from '../fixtures/dina_agent';
import { expect, test } from '../fixtures/human_session';

test.describe('MRS-07 — Agent vault-read persona gate', () => {
  test('agent gated on a sensitive persona, served on a default one; owner never gated; approval unblocks', async ({
    human,
  }) => {
    const { backstage } = human;
    const agent = await pairAgent('e2e-vault-read-agent');

    // POSITIVE CONTROL: the agent's signature + role really resolve to
    // callerType='agent' — an allowlisted agent route works (claim returns
    // 204 when there's nothing to claim). If this 204s, a later 403 on the
    // vault route is a gate decision, not a blanket unlisted-path deny.
    const claim = await agent.signedFetch('POST', '/v1/workflow/tasks/claim', { body: {} });
    expect(claim.status, 'paired agent is authorized on /v1/workflow/tasks/*').toBe(204);

    // A DEFAULT-tier persona (general) is SERVED — the gate allows a free tier.
    const general = await agent.signedFetch('POST', '/v1/vault/query', {
      query: { persona: 'general' },
      body: { text: 'anything' },
    });
    expect(general.status, 'agent query of a default persona is served (gate allows)').toBe(200);

    // A SENSITIVE persona (health) is GATED by agentGate → 403 approval_required + task.
    const gated = await agent.signedFetch('POST', '/v1/vault/query', {
      query: { persona: 'health' },
      body: { text: 'lab results' },
    });
    expect(gated.status, 'agent query of a sensitive persona is gated').toBe(403);
    const body = gated.body as { error?: string; approval_required?: boolean; task_id?: string };
    expect(body.error, 'gated with approval_required (agentGate, not blanket deny)').toBe(
      'approval_required',
    );
    expect(body.approval_required).toBe(true);
    const taskId = body.task_id ?? '';
    expect(taskId, 'a vault-read approval task was created').toBeTruthy();
    expect(
      await backstage.approvalTaskInState(taskId, 'pending_approval'),
      'the vault-read task is pending server-side',
    ).toBe(true);

    // The OWNER (in-app / backstage) is NEVER gated on the same sensitive
    // persona — the owner-vs-agent rule (in-process owner accesses freely).
    const ownerItems = await backstage.listVault('health');
    expect(Array.isArray(ownerItems), 'owner-in-app reads health freely (no gate)').toBe(true);

    // Owner APPROVES the vault-read → the agent's retry is now served (grant issued).
    await backstage.ownerApprove(taskId);
    await expect(async () => {
      const retry = await agent.signedFetch('POST', '/v1/vault/query', {
        query: { persona: 'health' },
        body: { text: 'lab results' },
      });
      expect(retry.status, 'after approval the agent read succeeds').toBe(200);
    }).toPass({ timeout: 15_000 });
  });
});
