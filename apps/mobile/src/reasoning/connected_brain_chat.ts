/**
 * Trusted mobile projection for connected-Brain Ask jobs.
 *
 * The authoritative job and validated result live in Core. Chat keeps only a
 * task-linked lifecycle row so queued work survives navigation/restart and can
 * morph into the final answer without creating duplicate bubbles.
 */

import { useEffect, useRef } from 'react';

import {
  addLifecycleMessage,
  addMessage,
  addUserMessage,
  findMessageByReasoningTaskId,
  getMessage,
  getThread,
  hydrateThread,
  readLifecycle,
  updateReasoningJobLifecycle,
  type ReasoningJobLifecycle,
} from '@dina/brain/chat';

import { getOwnerRunClient, type OwnerControlClient } from '../services/owner_run_client';

import type {
  OwnerReasoningBackendView,
  OwnerReasoningJobView,
  OwnerReasoningSubmitResult,
} from '@dina/core';

const PURPOSE_PREFIX = 'mobile-chat';
const POLL_MS = 2_500;
const OWNER_JOB_LIMIT = 100;

export interface ConnectedBrainAskResult {
  handled: boolean;
  taskId?: string;
}

function isManagedAnswerBackend(backend: OwnerReasoningBackendView): boolean {
  return backend.allowed_task_kinds.includes('answer.compose');
}

function isLiveBackend(backend: OwnerReasoningBackendView, nowMs: number): boolean {
  return (
    isManagedAnswerBackend(backend) &&
    backend.enabled &&
    backend.revoked_at === null &&
    (backend.expires_at === null || backend.expires_at > nowMs)
  );
}

function purposeFor(threadId: string, userMessageId: string): string {
  return `${PURPOSE_PREFIX}:${threadId}:${userMessageId}`;
}

function parsePurpose(purpose: string): { threadId: string; userMessageId: string } | null {
  const prefix = `${PURPOSE_PREFIX}:`;
  if (!purpose.startsWith(prefix)) return null;
  const rest = purpose.slice(prefix.length);
  const separator = rest.lastIndexOf(':');
  if (separator <= 0 || separator === rest.length - 1) return null;
  const threadId = rest.slice(0, separator);
  const userMessageId = rest.slice(separator + 1);
  return threadId === '' || userMessageId === '' ? null : { threadId, userMessageId };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function projectedStatus(job: OwnerReasoningJobView): ReasoningJobLifecycle['status'] {
  if (job.commitState === 'failed') return 'failed';
  if (job.commitState === 'pending_approval' || job.state === 'pending_approval') {
    return 'pending_approval';
  }
  switch (job.state) {
    case 'claimed':
    case 'running':
      return 'working';
    case 'completed':
      return job.commitState === 'committed' ? 'complete' : 'working';
    case 'failed':
    case 'outcome_unknown':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return Date.now() >= job.deadlineAtMs ? 'expired' : 'queued';
  }
}

function answerFrom(job: OwnerReasoningJobView): string | null {
  if (projectedStatus(job) !== 'complete') return null;
  const result = record(job.result);
  return result !== null && typeof result.answer === 'string' && result.answer.trim() !== ''
    ? result.answer
    : null;
}

function contentFor(job: OwnerReasoningJobView): string {
  const answer = answerFrom(job);
  if (answer !== null) return answer;
  switch (projectedStatus(job)) {
    case 'queued':
      return 'Dina is preparing your answer...';
    case 'working':
      return 'Dina is working on this...';
    case 'pending_approval':
      return 'Waiting for your approval...';
    case 'cancelled':
      return 'Reasoning request cancelled.';
    case 'expired':
      return 'This reasoning request expired before it could be completed.';
    case 'failed':
      return 'Dina could not complete this reasoning request.';
    case 'complete':
      return 'Dina received an invalid reasoning result.';
  }
}

function projectJobIntoChat(
  job: OwnerReasoningJobView,
  threadId: string,
  userMessageId: string,
): void {
  const status = projectedStatus(job);
  const content = contentFor(job);
  const existing = findMessageByReasoningTaskId(threadId, job.taskId);
  if (existing === null) {
    addLifecycleMessage(threadId, content, {
      kind: 'reasoning_job',
      status,
      taskId: job.taskId,
      taskKind: 'answer.compose',
      userMessageId,
      backendId: job.backendId ?? 'policy-selected',
      ...(job.error === undefined ? {} : { error: job.error }),
    });
    return;
  }
  updateReasoningJobLifecycle(
    threadId,
    job.taskId,
    {
      status,
      ...(job.error === undefined ? {} : { error: job.error }),
    },
    content,
  );
}

function reasoningClient(
  client: OwnerControlClient | null,
): Required<
  Pick<
    OwnerControlClient,
    'reasoningBackends' | 'reasoningSubmit' | 'reasoningList' | 'reasoningGet' | 'reasoningCancel'
  >
> | null {
  if (
    client?.reasoningBackends === undefined ||
    client.reasoningSubmit === undefined ||
    client.reasoningList === undefined ||
    client.reasoningGet === undefined ||
    client.reasoningCancel === undefined
  ) {
    return null;
  }
  return {
    reasoningBackends: client.reasoningBackends.bind(client),
    reasoningSubmit: client.reasoningSubmit.bind(client),
    reasoningList: client.reasoningList.bind(client),
    reasoningGet: client.reasoningGet.bind(client),
    reasoningCancel: client.reasoningCancel.bind(client),
  };
}

/**
 * Submit through the managed reasoning plane whenever the owner has a backend
 * binding for answers. Core selects the eligible backend after deriving the
 * actual sensitivity. `handled:false` is reserved for pre-migration/degraded
 * installs with no managed answer backend, where the legacy direct Brain path
 * remains the compatibility fallback.
 */
export async function trySubmitConnectedBrainAsk(
  query: string,
  threadId = 'main',
): Promise<ConnectedBrainAskResult> {
  const client = reasoningClient(getOwnerRunClient());
  if (client === null) return { handled: false };

  let backends: OwnerReasoningBackendView[];
  try {
    backends = (await client.reasoningBackends()).backends;
  } catch {
    const userMessage = addUserMessage(threadId, query, {
      mode: 'ask',
      reasoningBackendId: 'policy-selected',
    });
    addMessage(
      threadId,
      'error',
      'Dina could not check your approved reasoning backends. Please try again.',
      { sources: [userMessage.id] },
    );
    return { handled: true };
  }
  const managed = backends.filter(isManagedAnswerBackend);
  if (managed.length === 0) return { handled: false };

  // Persist the user turn first. Its stable id is the crash-recovery and
  // idempotency anchor; Core stores no duplicate raw chat context.
  const userMessage = addUserMessage(threadId, query, {
    mode: 'ask',
    reasoningBackendId: 'policy-selected',
  });
  const purpose = purposeFor(threadId, userMessage.id);
  if (!managed.some((backend) => isLiveBackend(backend, Date.now()))) {
    addMessage(threadId, 'error', 'No approved reasoning backend is currently available.', {
      sources: [userMessage.id],
    });
    return { handled: true };
  }

  let submitted: OwnerReasoningSubmitResult;
  try {
    submitted = await client.reasoningSubmit({
      task_kind: 'answer.compose',
      input: { query },
      idempotency_key: `mobile-${userMessage.id}`,
      purpose,
    });
  } catch {
    addMessage(
      threadId,
      'error',
      'Dina could not queue this reasoning request. Please try again.',
      { sources: [userMessage.id] },
    );
    return { handled: true };
  }

  if (submitted.job !== null) {
    projectJobIntoChat(submitted.job, threadId, userMessage.id);
  } else {
    addLifecycleMessage(threadId, 'Dina is preparing your answer...', {
      kind: 'reasoning_job',
      status: 'queued',
      taskId: submitted.submission.taskId,
      taskKind: 'answer.compose',
      userMessageId: userMessage.id,
      backendId: 'policy-selected',
    });
  }
  return { handled: true, taskId: submitted.submission.taskId };
}

/** Reconcile persisted chat rows and heal the job-created/chat-row crash seam. */
export async function reconcileConnectedBrainChat(threadId = 'main'): Promise<number> {
  const client = reasoningClient(getOwnerRunClient());
  if (client === null) return 0;
  await hydrateThread(threadId);

  let recentJobs: OwnerReasoningJobView[];
  try {
    recentJobs = (await client.reasoningList(OWNER_JOB_LIMIT)).jobs;
  } catch {
    return 0;
  }

  const jobsById = new Map(recentJobs.map((job) => [job.taskId, job]));
  const linkedTaskIds = getThread(threadId)
    .map(readLifecycle)
    .filter(
      (lifecycle): lifecycle is ReasoningJobLifecycle =>
        lifecycle !== null && lifecycle.kind === 'reasoning_job',
    )
    .map((lifecycle) => lifecycle.taskId);

  // The recent scan heals the job-created/chat-row crash seam. Exact reads
  // keep older persisted rows current even after newer terminal jobs push
  // them outside the bounded owner list.
  await Promise.all(
    [...new Set(linkedTaskIds)]
      .filter((taskId) => !jobsById.has(taskId))
      .map(async (taskId) => {
        try {
          const { job } = await client.reasoningGet(taskId);
          jobsById.set(taskId, job);
        } catch {
          // A foreign/deleted task is not enough reason to block other rows.
        }
      }),
  );

  let changed = 0;
  for (const job of jobsById.values()) {
    if (job.taskKind !== 'answer.compose') continue;
    const correlation = parsePurpose(job.purpose);
    if (correlation === null || correlation.threadId !== threadId) continue;
    const userMessage = getMessage(correlation.userMessageId);
    if (userMessage === null || userMessage.threadId !== threadId || userMessage.type !== 'user') {
      continue;
    }
    const existing = findMessageByReasoningTaskId(threadId, job.taskId);
    const before = existing === null ? null : readLifecycle(existing);
    const beforeStatus = before !== null && before.kind === 'reasoning_job' ? before.status : null;
    const nextStatus = projectedStatus(job);
    if (existing === null || beforeStatus !== nextStatus || existing.content !== contentFor(job)) {
      projectJobIntoChat(job, threadId, correlation.userMessageId);
      changed += 1;
    }
  }
  return changed;
}

export async function cancelConnectedBrainChatJob(
  taskId: string,
  threadId = 'main',
): Promise<boolean> {
  const client = reasoningClient(getOwnerRunClient());
  if (client === null) return false;
  try {
    const { ok } = await client.reasoningCancel(taskId, 'cancelled from chat');
    if (ok) {
      updateReasoningJobLifecycle(
        threadId,
        taskId,
        { status: 'cancelled' },
        'Reasoning request cancelled.',
      );
    }
    return ok;
  } catch {
    return false;
  }
}

/** Poll only while the Chat screen is mounted; Core remains authoritative. */
export function useConnectedBrainChatReconciler(threadId = 'main'): void {
  const running = useRef(false);
  useEffect(() => {
    let disposed = false;
    const tick = async (): Promise<void> => {
      if (disposed || running.current) return;
      running.current = true;
      try {
        await reconcileConnectedBrainChat(threadId);
      } finally {
        running.current = false;
      }
    };
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [threadId]);
}

/** Test helper: return task-linked lifecycle rows without exposing raw jobs. */
export function connectedBrainChatRows(threadId = 'main'): ReasoningJobLifecycle[] {
  return getThread(threadId)
    .map(readLifecycle)
    .filter(
      (lifecycle): lifecycle is ReasoningJobLifecycle =>
        lifecycle !== null && lifecycle.kind === 'reasoning_job',
    );
}
