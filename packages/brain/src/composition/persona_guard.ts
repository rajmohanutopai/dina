/**
 * `createPersonaGuard` — builds a `VaultPersonaGuard` that mints
 * (or consumes) per-ask approvals via the shared `ApprovalManager`.
 *
 * **Why this lives here, not in `vault_tool.ts`**: the tool factory
 * is framework-free + unit-testable with a plain function stub
 * (5.21-D). Wiring an `ApprovalManager` + persona registry is
 * composition-layer logic — multiple build targets (mobile in-process,
 * brain-server HTTP) construct one of these, then thread it into
 * `buildAgenticAskPipeline` (5.21-E).
 *
 * **Tier policy** (matches `checkPersonaGate` in `persona_gate.ts`):
 *   - `default` / `standard` → null (allow). These tiers auto-open on
 *     boot; the LLM reads freely.
 *   - `sensitive` / `locked` → require approval. The guard mints (or
 *     looks up) a pending approval and returns its id. The agentic
 *     loop bails with `ApprovalRequiredError`; `AskApprovalResumer`
 *     parks the ask in `pending_approval`. Operator approves via UI;
 *     resume re-runs the bailing tool, which now finds the approval
 *     in `approved` state, consumes the single-scope grant, and
 *     proceeds.
 *
 * **Approval-id derivation**: `appr-<askId>-<persona>` —
 * deterministic so the resume's second tool call finds the SAME
 * approval the first call minted. Includes the persona so a
 * multi-persona ask can carry a separate approval per persona
 * (one bail, one approve, one resume — repeated for each).
 *
 * **Resume cycle pinned by tests**:
 *   1. First read on `sensitive` → mints pending → returns id.
 *   2. Operator calls `approvalManager.approveRequest(id, 'single', ...)`.
 *   3. Second read finds approved → `consumeSingle()` → returns null
 *      (single-scope grant used; if the LLM tries to read again it'll
 *      mint a fresh pending approval — correct one-shot semantics).
 *
 * **Unknown persona** (`getPersona` returns null) → null. The vault
 * tool's existing accessibility check produces an empty result.
 * Fabricating an approval for a non-existent persona would confuse
 * the operator UI ("approve read of /nonexistent?").
 *
 * **Idempotency on collision**: a pending approval with the same id
 * already exists → return its id without re-minting. Happens when
 * the same persona is hit twice in one batch (the loop bails on the
 * first; the resumer eventually re-runs and we see the still-pending
 * approval).
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md task 5.21-E.
 */

import { getPersona, type ApprovalManager } from '@dina/core';

/**
 * The guard returned here is synchronous — `ApprovalManager` is
 * in-memory and persona lookup is local, so no async I/O is needed.
 * `VaultPersonaGuard` accepts either shape (sync or Promise);
 * narrowing to sync keeps callers from accidentally awaiting a
 * non-promise.
 */
export type SyncPersonaGuard = (persona: string) => string | null;

export interface CreatePersonaGuardOptions {
  /** Shared `ApprovalManager` singleton — same instance UI + handler use. */
  approvalManager: ApprovalManager;
  /** Current ask id; embedded in the deterministic approval id. */
  askId: string;
  /** DID of the original requester — written into the approval record. */
  requesterDid: string;
  /** Optional clock injection for tests. Defaults to `Date.now`. */
  nowMsFn?: () => number;
}

/**
 * Build a `VaultPersonaGuard` bound to the given ask context.
 * The returned guard is synchronous — the underlying
 * `ApprovalManager` is in-memory + all persona lookups are local.
 */
export function createPersonaGuard(opts: CreatePersonaGuardOptions): SyncPersonaGuard {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('createPersonaGuard: options object is required');
  }
  if (!opts.approvalManager) {
    throw new TypeError('createPersonaGuard: approvalManager is required');
  }
  if (typeof opts.askId !== 'string' || opts.askId.trim() === '') {
    throw new TypeError('createPersonaGuard: askId must be a non-empty string');
  }
  if (typeof opts.requesterDid !== 'string' || opts.requesterDid.trim() === '') {
    throw new TypeError('createPersonaGuard: requesterDid must be a non-empty string');
  }
  const { approvalManager, askId, requesterDid } = opts;
  const now = opts.nowMsFn ?? ((): number => Date.now());

  return (persona: string): string | null => {
    const personaState = getPersona(persona);
    if (personaState === null) {
      // Unknown persona — let the vault tool's accessibility check
      // produce its empty result. Approval would be meaningless here.
      return null;
    }

    if (personaState.tier === 'default' || personaState.tier === 'standard') {
      // Open tiers — vault is freely accessible.
      return null;
    }

    // Sensitive / locked tier — approval required.
    const approvalId = approvalIdFor(askId, persona);

    const existing = approvalManager.getRequest(approvalId);
    if (existing) {
      if (existing.status === 'approved') {
        // Resume case: consume the single-scope grant and allow this
        // read. `consumeSingle` returns false for session-scope or
        // already-consumed approvals — in either case we still allow
        // (session means "blanket grant", consumed means we already
        // honoured a prior consume).
        approvalManager.consumeSingle(approvalId);
        return null;
      }
      if (existing.status === 'denied') {
        // Operator explicitly refused — short-circuit. Surface as
        // approval_required so the loop bails predictably; the next
        // resume cycle will see the same denied state. Caller can
        // detect via `approvalManager.getRequest(id).status === 'denied'`
        // and translate to a hard failure if needed.
        return approvalId;
      }
      // status === 'pending' — re-use the existing id (idempotent).
      return approvalId;
    }

    // Fresh approval — mint a pending request.
    approvalManager.requestApproval({
      id: approvalId,
      action: 'vault_read',
      requester_did: requesterDid,
      persona,
      reason: `Agentic /ask ${askId} requires read of persona "${persona}"`,
      preview: '',
      created_at: now(),
    });
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
