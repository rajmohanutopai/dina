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
import { openApprovalInbox, tapApprove } from '../fixtures/pages/activity';

// The agent works inside a named session (dina session start). Grants are
// keyed on it (dina_details §3.6), so a later fresh session must re-prompt.
const SESSION_A = 'sess-vault-a';

test.describe('MRS-07 — Agent vault-read persona gate', () => {
  test('agent gated on a sensitive persona, served on a default one; owner never gated; approval unblocks', async ({
    human,
  }) => {
    const { backstage, page } = human;
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
      session: SESSION_A,
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

    // The OWNER (in-app) is NEVER gated on the same sensitive persona. Prove it
    // MEANINGFULLY — `listVault` coerces every wire shape to [], so "is an
    // array" is vacuous. Instead run the EXACT route + persona the agent got 403
    // on, as the owner (backstage `dispatch` returns the status without throwing),
    // and assert 200. Same route: agent → 403, owner → 200 — the load-bearing
    // owner-vs-agent discrimination, with no dependency on live classification.
    const ownerRead = await backstage.dispatch('POST', '/v1/vault/query', {
      query: { persona: 'health' },
      body: { text: 'lab results' },
    });
    expect(
      ownerRead.status,
      'owner-in-app reads the same sensitive persona the agent was gated on (never gated)',
    ).toBe(200);

    // ── The owner APPROVES in the BROWSER (Activity → Needs action) ──────
    // The human-visible decision is driven through the UI, NOT backstage (§8:
    // backstage never stands in for human-visible behavior). F4 made the web
    // approval inbox faithful, so the vault-read card surfaces here and the tap
    // flips it. (vault_read approves with a session scope directly — no confirm
    // dialog.)
    await openApprovalInbox(page);
    await tapApprove(page, taskId);
    await expect(async () => {
      const retry = await agent.signedFetch('POST', '/v1/vault/query', {
        query: { persona: 'health' },
        body: { text: 'lab results' },
        session: SESSION_A,
      });
      expect(retry.status, 'after the browser approval the agent read succeeds').toBe(200);
    }).toPass({ timeout: 15_000 });

    // ── C3: cross-vault isolation — the health grant does NOT unlock finance.
    // A read of a DIFFERENT gated persona (finance) is still gated (403), never
    // served on the health grant. This is the "no cross-vault leak" invariant
    // (access.ts: "a health grant never unlocks finance").
    const financeGated = await agent.signedFetch('POST', '/v1/vault/query', {
      query: { persona: 'finance' },
      body: { text: 'account balance' },
      session: SESSION_A,
    });
    expect(
      financeGated.status,
      'C3: a health grant must NOT unlock finance (still gated, no cross-vault leak)',
    ).toBe(403);
    // Prove it RE-PROMPTS (a fresh gate), not merely "not served": a distinct
    // finance vault-read approval task is raised, not the health one. (Both
    // sensitive + locked tiers return approval_required for an ungranted agent
    // — access.ts:144.)
    const fbody = financeGated.body as { error?: string; task_id?: string };
    expect(fbody.error, 'C3: finance re-prompts (fresh approval), not served').toBe(
      'approval_required',
    );
    expect(fbody.task_id, 'C3: a distinct finance vault-read task is raised').toBeTruthy();
    expect(fbody.task_id, 'C3: the finance task is DISTINCT from the health task').not.toBe(taskId);

    // ── C4: session-scoped grants — a FRESH session RE-PROMPTS (dina_details §3.6).
    // The health grant was approved under SESSION_A. The SAME agent + SAME
    // persona on a DIFFERENT session does NOT inherit it — `dina session start`
    // mints a new session id, the grant doesn't match, and the owner sees a
    // fresh card. (This is the behaviour the grant model was changed to enforce:
    // findActiveGrant is now keyed on the session too.)
    const newSession = await agent.signedFetch('POST', '/v1/vault/query', {
      query: { persona: 'health' },
      body: { text: 'lab results' },
      session: 'sess-vault-b',
    });
    expect(
      newSession.status,
      'C4: a new session does NOT inherit the prior session’s health grant',
    ).toBe(403);
    const nbody = newSession.body as { error?: string; task_id?: string };
    expect(nbody.error, 'C4: a fresh session re-prompts (approval_required)').toBe(
      'approval_required',
    );
    expect(nbody.task_id, 'C4: a distinct approval task is raised for the new session').toBeTruthy();
    expect(nbody.task_id, 'C4: the new-session task is distinct from the approved one').not.toBe(
      taskId,
    );
  });
});
