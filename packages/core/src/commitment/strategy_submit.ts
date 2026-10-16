/**
 * Hand a negotiation turn to the strategy slot (COMMITMENT_KERNEL §11): a
 * `negotiate.move` job for the owner's reasoning backend, built from Core's
 * one projection. Core alone decides what the move becomes: the job's result
 * comes back through the commit bridge to the negotiation's engine.
 *
 * Returns null when no backend can take it now (none bound for the owner,
 * none allowed the task, the queue full): the pack's fixed style plays the
 * turn instead.
 */

import {
  getReasoningBackendRepository,
  type ReasoningBackendRepository,
} from '../reasoning/backend_repository';
import { selectReasoningBackend } from '../reasoning/backend_selection';
import { getReasoningBroker, type CoreReasoningBroker } from '../reasoning/broker';

import type { AuthorityOrigin } from '../agent/gating_policy';

export interface NegotiationBrief {
  kind: string;
  ref: { negotiationId: string; turn: number };
  side: 'buyer' | 'seller';
  parts: readonly Record<string, unknown>[];
  table: Record<string, unknown>;
  history: readonly Record<string, unknown>[];
  model: Record<string, unknown>;
  roundsLeft: number;
  deadlineAt?: string;
  rules?: readonly string[];
}

export type NegotiationSubmitter = (brief: NegotiationBrief) => { taskId: string } | null;

export function createNegotiationSubmitter(options: {
  ownerDid: () => string;
  nowMs?: () => number;
  getBroker?: () => CoreReasoningBroker | null;
  getBackendRepository?: () => ReasoningBackendRepository | null;
}): NegotiationSubmitter {
  const brokerFor = options.getBroker ?? getReasoningBroker;
  const repositoryFor = options.getBackendRepository ?? getReasoningBackendRepository;
  const nowMs = options.nowMs ?? Date.now;
  return (brief) => {
    try {
      return submitOnce(brief);
    } catch {
      // Any failure to hand the turn over lets the fixed style play it: the
      // negotiation never waits on, or rolls back for, the reasoning system.
      return null;
    }
  };

  function submitOnce(brief: NegotiationBrief): { taskId: string } | null {
    const broker = brokerFor();
    const repository = repositoryFor();
    if (broker === null || repository === null) return null;
    const ownerDid = options.ownerDid();
    const now = nowMs();
    const authorityOrigin: AuthorityOrigin = {
      kind: 'background_job',
      ownerDid,
      ingress: 'workflow',
      correlationId: `${brief.ref.negotiationId}:${String(brief.ref.turn)}`,
      authenticatedAtMs: now,
    };
    const selected = selectReasoningBackend(repository.list(), {
      ownerDid,
      taskKind: 'negotiate.move',
      sensitivity: 'personal',
      nowMs: now,
      // The built-in Brain only (§16 item 2): outside agents, connected hosts
      // among them, fill the slot in a later step, never now.
      isRuntimeAvailable: (binding) => binding.kind === 'internal_brain',
    });
    if (selected === null) return null;
    const submitted = broker.submit({
      taskKind: 'negotiate.move',
      ownerDid,
      authorityOrigin,
      input: { ...brief } as unknown as Record<string, unknown>,
      sensitivity: 'personal',
      evidencePolicy: 'none',
      purpose: `negotiate:${brief.kind}`.slice(0, 512),
      backendBindingId: selected.backendId,
      idempotencyKey: `negotiate:${brief.kind}:${brief.ref.negotiationId}:${String(brief.ref.turn)}`,
      priority: 'normal',
      deadlineAtMs: now + 20 * 60 * 1000,
      maxAttempts: 2,
      origin: 'system',
    });
    return { taskId: submitted.taskId };
  }
}
