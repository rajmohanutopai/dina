/**
 * Core-owned commit bridge for connected-Brain proposals.
 *
 * A reasoning backend may only produce a schema-valid proposal. This bridge
 * turns the winning proposal into Dina state through the existing durable
 * services. Every write is keyed by the reasoning task id so replay after a
 * crash is idempotent.
 */

import {
  persistConnectedBrainMemoryProposal,
  type PersistConnectedBrainMemoryResult,
} from '../agent/connected_brain_facades';
import { resolvePersonaName } from '../persona/names';
import { isPersonaOpen, personaExists } from '../persona/service';
import { createReminderDurable } from '../reminders/service';

import type { ReasoningCommitReceipt, ReasoningValidatedProposal } from './broker';
import type { AuthorityOrigin } from '../agent/gating_policy';

export interface ReasoningServiceCommitInput {
  taskId: string;
  ownerDid: string;
  authorityOrigin: AuthorityOrigin;
  input: unknown;
  result: unknown;
  evidenceIds: string[];
}

export interface ReasoningCommitBridgeOptions {
  /**
   * Injected existing Response Bridge. Core boot must provide this before
   * service.respond is enabled for a backend; absent wiring fails closed.
   */
  commitServiceResponse?: (
    input: ReasoningServiceCommitInput,
  ) => Promise<ReasoningCommitReceipt> | ReasoningCommitReceipt;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ownerInteractive(proposal: ReasoningValidatedProposal): boolean {
  const origin = proposal.envelope.authorityOrigin;
  return (
    origin.kind === 'owner_interactive' &&
    origin.ownerDid === proposal.envelope.ownerDid &&
    (origin.requesterDid === undefined || origin.requesterDid === proposal.envelope.ownerDid)
  );
}

function boundedReceipt(result: PersistConnectedBrainMemoryResult): Record<string, unknown> {
  const body = result.body;
  const receipt: Record<string, unknown> = {};
  for (const key of ['proposal_id', 'request_id', 'persona', 'status', 'task_id']) {
    const value = body[key];
    if (typeof value === 'string' && value.length <= 512) receipt[key] = value;
  }
  return receipt;
}

async function commitMemory(proposal: ReasoningValidatedProposal): Promise<ReasoningCommitReceipt> {
  if (!ownerInteractive(proposal)) {
    throw new Error('memory commit requires direct owner authority');
  }
  const input = record(proposal.input);
  if (input === null || typeof input.text !== 'string') {
    throw new Error('memory commit input is unavailable');
  }
  const persisted = await persistConnectedBrainMemoryProposal({
    requestId: `reason-${proposal.task.id}`,
    sourceText: input.text,
    proposal: proposal.result,
    producerDid: proposal.backendPrincipalDid,
    sessionId: proposal.authenticatedSessionId ?? '',
    stagingSource: 'reasoning_memory_proposal',
  });
  if (persisted.status !== 200 && persisted.status !== 202) {
    const error =
      typeof persisted.body.error === 'string'
        ? persisted.body.error
        : 'memory proposal was not durably accepted';
    throw new Error(error);
  }
  const state = persisted.body.status;
  return {
    state: state === 'stored' ? 'committed' : 'pending_approval',
    receipt: boundedReceipt(persisted),
  };
}

async function commitReminders(
  proposal: ReasoningValidatedProposal,
): Promise<ReasoningCommitReceipt> {
  if (!ownerInteractive(proposal)) {
    throw new Error('reminder commit requires direct owner authority');
  }
  const input = record(proposal.input);
  const result = record(proposal.result);
  if (input === null || result === null || !Array.isArray(result.reminders)) {
    throw new Error('reminder commit payload is unavailable');
  }
  const preferred =
    typeof input.preferredPersona === 'string' && input.preferredPersona.trim() !== ''
      ? input.preferredPersona
      : 'general';
  const persona = resolvePersonaName(preferred.trim());
  if (persona === '' || !personaExists(persona)) {
    throw new Error('unknown reminder persona');
  }
  if (!isPersonaOpen(persona)) {
    throw new Error('reminder persona is locked');
  }
  const committedIds: string[] = [];
  for (let index = 0; index < result.reminders.length; index += 1) {
    const candidate = record(result.reminders[index]);
    if (
      candidate === null ||
      typeof candidate.text !== 'string' ||
      !Number.isSafeInteger(candidate.dueAtMs)
    ) {
      throw new Error('invalid reminder proposal');
    }
    const reminder = await createReminderDurable({
      message: candidate.text,
      due_at: candidate.dueAtMs as number,
      persona,
      kind: 'manual',
      source_item_id: `reason-${proposal.task.id}-${index}`,
      source: 'connected_brain_reasoning',
    });
    committedIds.push(reminder.id);
  }
  return {
    state: 'committed',
    receipt: {
      persona,
      reminder_count: committedIds.length,
      // IDs are owner-local receipts, never model input or vault content.
      reminder_ids: committedIds,
    },
  };
}

/**
 * Create the single task-kind switch used by mobile and Home Node boots.
 * Proposal-only tasks are committed by preserving their validated workflow
 * result; effectful task kinds route through a dedicated existing subsystem.
 */
export function createReasoningCommitBridge(
  options: ReasoningCommitBridgeOptions = {},
): (proposal: ReasoningValidatedProposal) => Promise<ReasoningCommitReceipt> {
  return async (proposal) => {
    switch (proposal.envelope.taskKind) {
      case 'answer.compose':
      case 'intent.route':
      case 'review.summarize':
        return { state: 'committed' };
      case 'memory.structure':
        return commitMemory(proposal);
      case 'reminder.extract':
        return commitReminders(proposal);
      case 'service.respond':
        if (options.commitServiceResponse === undefined) {
          throw new Error('service response commit bridge is unavailable');
        }
        return options.commitServiceResponse({
          taskId: proposal.task.id,
          ownerDid: proposal.envelope.ownerDid,
          authorityOrigin: proposal.envelope.authorityOrigin,
          input: proposal.input,
          result: proposal.result,
          evidenceIds: proposal.evidenceIds,
        });
    }
  };
}
