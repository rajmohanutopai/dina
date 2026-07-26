/**
 * Owner-safe projection of a reasoning workflow task.
 *
 * Workflow payloads contain authority, projection, and policy bindings that
 * are useful to Core but inappropriate for UI clients. This module exposes
 * only lifecycle, validated result, and durable commit receipt state.
 */

import { getItem as getStagingItem } from '../staging/service';

import { parseReasoningEnvelope, type ReasoningTaskKind } from './domain';
import { getReasoningSchemaContract, validateReasoningResult } from './schema_registry';

import type { WorkflowEvent, WorkflowTask } from '../workflow/domain';

export type ReasoningJobCommitState =
  | 'not_applicable'
  | 'pending'
  | 'pending_approval'
  | 'committed'
  | 'failed';

export interface OwnerReasoningJobView {
  taskId: string;
  taskKind: ReasoningTaskKind;
  state: string;
  purpose: string;
  backendId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  deadlineAtMs: number;
  attempt: number;
  commitState: ReasoningJobCommitState;
  result?: unknown;
  error?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(value: string | undefined): unknown | null {
  if (value === undefined || value === '') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function boundedError(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, 2_048) : undefined;
}

function validatedResult(task: WorkflowTask, taskKind: ReasoningTaskKind): unknown | undefined {
  const stored = record(parseJson(task.result));
  if (stored === null || stored.version !== 1 || stored.result === undefined) return undefined;
  return validateReasoningResult(getReasoningSchemaContract(taskKind), stored.result).ok
    ? stored.result
    : undefined;
}

function commitProjection(
  task: WorkflowTask,
  events: readonly WorkflowEvent[],
): { state: ReasoningJobCommitState; error?: string } {
  if (task.status !== 'completed') return { state: 'not_applicable' };
  const commitEvents = events
    .filter((event) => event.event_kind.startsWith('reasoning_commit_'))
    .sort((left, right) => left.at - right.at || left.event_id - right.event_id);
  const latest = commitEvents[commitEvents.length - 1];
  if (latest === undefined) return { state: 'pending' };
  if (latest.event_kind === 'reasoning_commit_succeeded') {
    return { state: 'committed' };
  }
  if (latest.event_kind === 'reasoning_commit_failed') {
    const details = record(parseJson(latest.details));
    return {
      state: 'failed',
      ...(details === null ? {} : { error: boundedError(details.error) }),
    };
  }
  if (latest.event_kind === 'reasoning_commit_stale_authority') {
    return {
      state: 'failed',
      error: 'Reasoning authority expired before the result could be saved.',
    };
  }
  if (latest.event_kind === 'reasoning_commit_pending_approval') {
    const details = record(parseJson(latest.details));
    const receipt = details === null ? null : record(details.receipt);
    const proposalId =
      receipt !== null && typeof receipt.proposal_id === 'string' ? receipt.proposal_id : null;
    if (proposalId !== null) {
      const staging = getStagingItem(proposalId);
      if (staging?.status === 'stored') return { state: 'committed' };
      if (staging?.status === 'failed') {
        return { state: 'failed', error: boundedError(staging.error) };
      }
    }
    return { state: 'pending_approval' };
  }
  return { state: 'pending' };
}

export function projectOwnerReasoningJob(
  task: WorkflowTask,
  events: readonly WorkflowEvent[],
): OwnerReasoningJobView | null {
  if (task.kind !== 'reasoning') return null;
  const envelope = parseReasoningEnvelope(task.payload);
  if (envelope === null) return null;
  const commit = commitProjection(task, events);
  const result = validatedResult(task, envelope.taskKind);
  const taskError = boundedError(task.error);
  return {
    taskId: task.id,
    taskKind: envelope.taskKind,
    state: task.status,
    purpose: envelope.purpose,
    backendId: envelope.backendBindingId,
    createdAtMs: task.created_at,
    updatedAtMs: task.updated_at,
    deadlineAtMs: envelope.deadlineAtMs,
    attempt: task.attempt ?? 0,
    commitState: commit.state,
    ...(result === undefined ? {} : { result }),
    ...(commit.error !== undefined
      ? { error: commit.error }
      : taskError === undefined
        ? {}
        : { error: taskError }),
  };
}
