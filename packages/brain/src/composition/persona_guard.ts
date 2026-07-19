/**
 * `createPersonaGuard` — builds a `VaultPersonaGuard` that mints
 * (or consumes) per-ask approvals via workflow tasks, exactly as Go
 * Core uses `dina_tasks` for every approval gate.
 *
 * **Why workflow tasks (not ApprovalManager)**: the mobile Approvals tab
 * polls `listWorkflowTasks({kind:'approval', state:'pending_approval'})`.
 * Routing vault-read approvals through the same workflow task store means
 * they appear there automatically with zero extra transport — no separate
 * ApprovalManager HTTP surface needed.
 *
 * **Why this lives here, not in `vault_tool.ts`**: the tool factory
 * is framework-free + unit-testable with a plain function stub
 * (5.21-D). Wiring a CoreClient + persona registry is
 * composition-layer logic — multiple build targets (mobile in-process,
 * brain-server HTTP) construct one of these, then thread it into
 * `buildAgenticAskPipeline` (5.21-E).
 *
 * **Tier policy** (matches `checkPersonaGate` in `persona_gate.ts`):
 *   - `default` / `standard` → null (allow). These tiers auto-open on
 *     boot; the LLM reads freely.
 *   - `sensitive` / `locked` → require approval. The guard mints (or
 *     looks up) a pending workflow task and returns its id. The agentic
 *     loop bails with `ApprovalRequiredError`; `AskApprovalResumer`
 *     parks the ask in `pending_approval`. Operator approves via UI;
 *     resume re-runs the bailing tool, which now finds the task in
 *     `queued` state (operator-approved), completes it (consumes),
 *     and proceeds.
 *
 * **Approval-id derivation**: `appr-<askId>-<persona>` —
 * deterministic so the resume's second tool call finds the SAME
 * workflow task the first call minted. Includes the persona so a
 * multi-persona ask can carry a separate approval per persona
 * (one bail, one approve, one resume — repeated for each).
 *
 * **Resume cycle**:
 *   1. First read on `sensitive` → task not found → create workflow task
 *      (kind=approval, status=pending_approval) → return approvalId.
 *   2. Operator taps Approve → `approveWorkflowTask(id)` → status=queued.
 *   3. Second read finds task status=queued → `completeWorkflowTask(id)`
 *      (mark consumed) → return null (allow vault read).
 *
 * **Unknown persona** (`getPersona` returns null) → null. The vault
 * tool's existing accessibility check produces an empty result.
 * Fabricating an approval for a non-existent persona would confuse
 * the operator UI ("approve read of /nonexistent?").
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md task 5.21-E.
 */

import { getPersona, isVaultReadSessionApproved } from '@dina/core';

import type { CreateWorkflowTaskInput, CreateWorkflowTaskResult, WorkflowTask } from '@dina/core';

/**
 * Minimal CoreClient surface persona_guard needs for vault-read approvals.
 * Satisfied by the full `CoreClient` and by test fakes (3 methods only).
 */
export interface VaultApprovalWorkflowClient {
  createWorkflowTask(input: CreateWorkflowTaskInput): Promise<CreateWorkflowTaskResult>;
  getWorkflowTask(id: string): Promise<WorkflowTask | null>;
  completeWorkflowTask(id: string, result: string, resultSummary: string, agentDID?: string): Promise<WorkflowTask>;
}

/**
 * The guard returned here is async — workflow task operations are async
 * (in-process router dispatch or HTTP hop). `VaultPersonaGuard` accepts
 * either sync or async return values.
 */
export type AsyncPersonaGuard = (persona: string) => Promise<string | null>;

export interface CreatePersonaGuardOptions {
  /** CoreClient subset for vault-read approval workflow tasks. */
  coreClient: VaultApprovalWorkflowClient;
  /** Current ask id; embedded in the deterministic approval id. */
  askId: string;
  /** DID of the original requester — written into the approval record. */
  requesterDid: string;
  /**
   * Owner DID — the home node's own `did:plc:...`. When set, the
   * guard becomes a no-op for asks whose `requesterDid` matches.
   * This implements `feedback_user_vs_agent_persona_access`: the
   * owner's chat tab gets free access to every persona (sensitive
   * tiers included), while external dina-agents (different DID) are
   * gated as documented in dina_details.md §13.4.
   *
   * Omitting it preserves the legacy "every caller is untrusted"
   * behaviour — useful for tests that exercise the gate path
   * regardless of caller identity.
   */
  ownerDid?: string;
  /**
   * Dina-agent CLI session id (`sess-...`) from the `X-Session` header.
   * Threaded through to the vault-read session-grant map so a grant
   * minted for `(requesterDid, sessionId, persona)` is consulted on the
   * SAME tuple. A new `dina session start` mints a fresh sessionId →
   * fresh approval — matches dina_details §13.4. Without a sessionId
   * (older clients), the guard never short-circuits via the session map
   * and instead always raises a fresh workflow task.
   */
  sessionId?: string;
  /** Optional clock injection for tests. Defaults to `Date.now`. */
  nowMsFn?: () => number;
}

/**
 * Build a `VaultPersonaGuard` bound to the given ask context.
 * The returned guard is async — workflow task dispatch requires I/O.
 */
export function createPersonaGuard(opts: CreatePersonaGuardOptions): AsyncPersonaGuard {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('createPersonaGuard: options object is required');
  }
  if (!opts.coreClient) {
    throw new TypeError('createPersonaGuard: coreClient is required');
  }
  if (typeof opts.askId !== 'string' || opts.askId.trim() === '') {
    throw new TypeError('createPersonaGuard: askId must be a non-empty string');
  }
  if (typeof opts.requesterDid !== 'string' || opts.requesterDid.trim() === '') {
    throw new TypeError('createPersonaGuard: requesterDid must be a non-empty string');
  }
  const { coreClient, askId, requesterDid } = opts;
  const ownerDid = typeof opts.ownerDid === 'string' && opts.ownerDid !== '' ? opts.ownerDid : null;
  const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId : '';
  const now = opts.nowMsFn ?? ((): number => Date.now());

  return async (persona: string): Promise<string | null> => {
    // Allow/deny (owner shortcut, tier check, session-grant shortcut) is
    // shared with the pre-flight planner filter via
    // `personaReadRequiresApproval` so the two paths can never drift.
    if (
      !personaReadRequiresApproval(persona, {
        requesterDid,
        ...(ownerDid !== null ? { ownerDid } : {}),
        sessionId,
      })
    ) {
      return null;
    }

    // Sensitive / locked tier, non-owner, no session grant — approval required.
    const approvalId = approvalIdFor(askId, persona);

    const existing = await coreClient.getWorkflowTask(approvalId);
    if (existing !== null) {
      if (existing.status === 'queued' || existing.status === 'running') {
        // Resume case: operator approved the workflow task.
        // Complete (consume) the task and allow this vault read.
        await coreClient.completeWorkflowTask(
          approvalId,
          '{}',
          `vault_read consumed: persona "${persona}" for ask ${askId}`,
        );
        return null;
      }
      if (existing.status === 'cancelled' || existing.status === 'failed') {
        // Operator explicitly refused — short-circuit. Surface as
        // approval_required so the loop bails predictably.
        return approvalId;
      }
      if (existing.status === 'pending_approval') {
        // Still waiting — re-use the existing approval id (idempotent).
        return approvalId;
      }
      // completed (already consumed) or other terminal — fall through
      // to mint a fresh task (the prior approval was used up).
    }

    // Fresh approval — create a workflow task in pending_approval state.
    // idempotencyKey prevents duplicate tasks on concurrent re-entries.
    // `session` rides on the payload so the workflow approve route can
    // grant a session-scoped approval to the SAME (agent, session,
    // persona) tuple — see `intent.ts` `grantVaultReadSessionApproval`.
    try {
      const payload: Record<string, unknown> = {
        type: 'vault_read_request',
        persona,
        source_ask_id: askId,
        requester_did: requesterDid,
        agent_did: requesterDid,
        reason: `Agentic /ask ${askId} requires read of persona "${persona}"`,
        preview: '',
        created_at: now(),
      };
      if (sessionId !== '') payload.session = sessionId;
      await coreClient.createWorkflowTask({
        id: approvalId,
        kind: 'approval',
        description: `Vault read: persona "${persona}" for ask ${askId}`,
        payload: JSON.stringify(payload),
        initialState: 'pending_approval',
        idempotencyKey: `vault-read-${approvalId}`,
      });
    } catch {
      // Idempotent: task already exists (same id/idempotency key).
      // Continue — the existing task is in the right state.
    }
    return approvalId;
  };
}

/**
 * Deterministic approval id for a (askId, persona) pair. Exported so
 * the resumer + UI can derive the same id without round-tripping
 * through this module.
 */
export function approvalIdFor(askId: string, persona: string): string {
  return `appr-${askId}-${persona}`;
}

/** Read-only context for the allow/deny decision (no I/O, no task mint). */
export interface PersonaReadContext {
  /** DID of whoever is asking (agent did:key, or the owner's did:plc). */
  requesterDid: string;
  /** The home node's owner DID — owner calls bypass the gate entirely. */
  ownerDid?: string;
  /** dina-agent CLI session id, for the session-grant shortcut. */
  sessionId?: string;
}

/**
 * Pure allow/deny decision: does a vault read of `persona` by this
 * requester require user approval? Mirrors the tier/owner/session logic
 * inside `createPersonaGuard` exactly — both paths call this so they can
 * never drift — but creates NO workflow task (read-only). `true` ⇒
 * sensitive/locked tier, non-owner caller, no active session grant.
 *
 * Used by the agentic loop's on-demand `vault_search` guard AND the
 * pre-flight retrieval planner's persona filter (F-AGENT-VAULT-GATE
 * round-3: the planner used to pre-fetch sensitive personas for external
 * agents, bypassing the on-demand guard).
 */
export function personaReadRequiresApproval(persona: string, ctx: PersonaReadContext): boolean {
  const ownerDid = typeof ctx.ownerDid === 'string' && ctx.ownerDid !== '' ? ctx.ownerDid : null;
  // Owner-on-app: free access to every persona, sensitive tiers included.
  if (ownerDid !== null && ctx.requesterDid === ownerDid) return false;
  const personaState = getPersona(persona);
  // Unknown persona — the vault tool's accessibility check produces an
  // empty result; approval would be meaningless.
  if (personaState === null) return false;
  // Open tiers — freely accessible.
  if (personaState.tier === 'default' || personaState.tier === 'standard') return false;
  // Active session grant for this (agent, session, persona).
  const sessionId = typeof ctx.sessionId === 'string' ? ctx.sessionId : '';
  if (sessionId !== '' && isVaultReadSessionApproved(ctx.requesterDid, sessionId, persona)) {
    return false;
  }
  // Sensitive / locked, non-owner, no grant → approval required.
  return true;
}

/**
 * Build the persona filter the pre-flight retrieval planner applies
 * before pre-fetching: returns `false` for any persona this caller may
 * NOT pre-fetch without approval. Sensitive/locked personas are skipped
 * for external agents so their content is never pre-fetched ungated; the
 * agent reaches them only through the on-demand `vault_search` tool,
 * which raises the approval card + parks/resumes. Owner calls allow all.
 */
export function buildPreFlightPersonaAllowed(
  ctx: PersonaReadContext,
): (persona: string) => boolean {
  return (persona: string): boolean => !personaReadRequiresApproval(persona, ctx);
}
