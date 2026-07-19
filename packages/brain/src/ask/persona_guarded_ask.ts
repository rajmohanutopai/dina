/**
 * Persona-guarded executeFn for the `POST /api/v1/ask` handler.
 *
 * Wires three primitives that already exist into the seam the ask
 * handler expects:
 *
 *   1. `personaResolver(question)` → which persona this question is
 *      about (e.g. "balance" → "financial", everything else →
 *      "general"). Real builds use an LLM classifier; tests inject a
 *      stub.
 *   2. `personaLookup(name)` → the persona's tier + open state. Real
 *      builds read from the persona registry; tests inject a fixed
 *      table.
 *   3. `checkPersonaGate(...)` (already in `persona_gate.ts`) →
 *      decides whether `callerRole` may run `op='read'` on this
 *      persona right now.
 *
 * The result is plugged into `createAskHandler({registry, executeFn})`
 * — the existing handler already knows how to translate a
 * `{kind: 'approval', approvalId}` outcome into a 200 +
 * `pending_approval` response, and a `{kind: 'answer', ...}` outcome
 * into a 200 + `complete` response. This module is *only* the
 * decision logic that sits between "ask comes in" and "answer / ask
 * for approval".
 *
 * **Re-entry**: an ask in `pending_approval` resumes to `in_flight`
 * via `AskApprovalGateway.approve(...)`. The handler then re-issues
 * the executeFn (the test does this manually; production wires a
 * subscriber on `approval_resumed`). On the second call the gate
 * still says "approval required" — but we look up the workflow task
 * first; if it is in `queued` state (operator-approved), we consume
 * it (complete the task) and skip the gate. That's the only deviation
 * from the pure gate result.
 *
 * **Per-ask approval id derivation**: `appr-<askId>`. Deterministic
 * so the second executeFn call can find the previously-issued
 * approval without storing extra state.
 *
 * **Why workflow tasks**: Go Core uses `dina_tasks` for every approval
 * gate. The mobile Approvals tab polls workflow tasks, so vault-read
 * approvals appear there automatically — no separate HTTP surface needed.
 */

import {
  checkPersonaGate,
  type PersonaGateCaller,
  type PersonaGateInput,
  type PersonaGateOutcome,
  type PersonaGateTier,
} from './persona_gate';

import type { AskExecuteFn, ExecuteOutcome } from './ask_handler';
import type { VaultApprovalWorkflowClient } from '../composition/persona_guard';

/** Persona shape the gate cares about. */
export interface PersonaInfo {
  name: string;
  tier: PersonaGateTier;
  /** DEK loaded in RAM (key-management state). */
  open: boolean;
}

/** Pluggable LLM — gets the question + the persona it's allowed to use. */
export type GuardedLLM = (input: {
  question: string;
  persona: PersonaInfo;
  askId: string;
}) => Promise<Record<string, unknown>>;

export interface BuildPersonaGuardedExecuteFnOptions {
  /** Map a question to the persona name responsible for it. */
  personaResolver: (question: string) => string;
  /** Fetch tier + open state for a persona name. */
  personaLookup: (name: string) => PersonaInfo | null;
  /** CoreClient subset for vault-read approval workflow tasks. */
  coreClient: VaultApprovalWorkflowClient;
  /** LLM the executeFn calls once the gate clears. */
  llm: GuardedLLM;
  /**
   * Who the executeFn is acting as when it touches the vault. The
   * `/ask` HTTP handler runs in Brain's process; Brain reads the
   * vault on the user's behalf, so the gate sees `callerRole='brain'`
   * here. Tests can override.
   */
  callerRole?: PersonaGateCaller;
  /** Injectable clock for the gate's session-grant comparison. */
  nowSec?: () => number;
}

/**
 * Build the executeFn passed into `createAskHandler`.
 */
export function buildPersonaGuardedExecuteFn(
  opts: BuildPersonaGuardedExecuteFnOptions,
): AskExecuteFn {
  if (!opts.personaResolver) {
    throw new TypeError('buildPersonaGuardedExecuteFn: personaResolver is required');
  }
  if (!opts.personaLookup) {
    throw new TypeError('buildPersonaGuardedExecuteFn: personaLookup is required');
  }
  if (!opts.coreClient) {
    throw new TypeError('buildPersonaGuardedExecuteFn: coreClient is required');
  }
  if (!opts.llm) {
    throw new TypeError('buildPersonaGuardedExecuteFn: llm is required');
  }
  const callerRole: PersonaGateCaller = opts.callerRole ?? 'brain';
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));

  return async function executeFn(input): Promise<ExecuteOutcome> {
    const personaName = opts.personaResolver(input.question);
    const persona = opts.personaLookup(personaName);
    if (!persona) {
      return {
        kind: 'failure',
        failure: {
          kind: 'persona_unknown',
          message: `executeFn: persona ${JSON.stringify(personaName)} not found`,
        },
      };
    }

    // Pre-flight: if a previous turn already requested approval and
    // the operator approved it (workflow task is in `queued` state),
    // consume the task (complete it) and skip the gate.
    const approvalId = approvalIdForAsk(input.id);
    const existing = await opts.coreClient.getWorkflowTask(approvalId);
    if (existing !== null && (existing.status === 'queued' || existing.status === 'running')) {
      await opts.coreClient.completeWorkflowTask(
        approvalId,
        '{}',
        `vault_read consumed: persona "${persona.name}" for ask ${input.id}`,
      );
      const answer = await opts.llm({
        question: input.question,
        persona,
        askId: input.id,
      });
      return { kind: 'answer', answer };
    }

    const gateInput: PersonaGateInput = {
      persona: { name: persona.name, tier: persona.tier, open: persona.open },
      caller: { role: callerRole, did: input.requesterDid },
      op: 'read',
      nowSec: nowSec(),
    };
    const gate: PersonaGateOutcome = checkPersonaGate(gateInput);

    if (gate.allow) {
      const answer = await opts.llm({
        question: input.question,
        persona,
        askId: input.id,
      });
      return { kind: 'answer', answer };
    }

    // Deny path — translate the gate's required-step into either an
    // approval request (operator unlocks per-call) or a hard failure
    // (the user has to do something the operator can't help with —
    // type a passphrase, open a session, become an admin).
    if (gate.required === 'approval' || gate.required === 'passphrase') {
      // Both `passphrase` (locked) and `approval` (sensitive) reach
      // the same UX surface for now: operator confirms via the
      // approvals screen, the ask resumes and answers. A future
      // refinement can distinguish the two — locked needs an actual
      // passphrase entry, not a tap-to-approve.
      try {
        await opts.coreClient.createWorkflowTask({
          id: approvalId,
          kind: 'approval',
          description: `Vault read: persona "${persona.name}" for ask ${input.id}`,
          payload: JSON.stringify({
            type: 'vault_read_request',
            persona: persona.name,
            source_ask_id: input.id,
            requester_did: input.requesterDid,
            reason: gate.reason,
            preview: input.question.slice(0, 200),
            created_at: Date.now(),
          }),
          initialState: 'pending_approval',
          idempotencyKey: `vault-read-${approvalId}`,
        });
      } catch {
        // Idempotent: task already exists (same id/idempotency key).
        // Surface via the same pending response so the handler holds
        // the same state.
      }
      return { kind: 'approval', approvalId };
    }

    return {
      kind: 'failure',
      failure: {
        kind: 'gate_denied',
        message: `Access to persona ${JSON.stringify(persona.name)} denied: ${gate.reason}`,
        detail: { reason: gate.reason, required: gate.required ?? null },
      },
    };
  };
}

/**
 * Deterministic per-ask approval id. Living the lifetime of one
 * AskRecord: the operator approves *this specific question*, not a
 * standing grant. A second ask on the same locked persona gets a new
 * approval id and a fresh prompt.
 */
export function approvalIdForAsk(askId: string): string {
  return `appr-${askId}`;
}
