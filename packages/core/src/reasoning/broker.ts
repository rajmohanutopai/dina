/**
 * Core-owned connected-Brain broker.
 *
 * Backends receive bounded, claim-fenced reasoning work. They never receive
 * storage handles, policy authority, or a direct effect surface.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  isOwnerAuthority,
  parseAuthorityOrigin,
  type AuthorityOrigin,
} from '../agent/gating_policy';
import {
  isTerminal,
  WorkflowTaskPriority,
  WorkflowTaskState,
  type WorkflowTask,
} from '../workflow/domain';
import { WorkflowConflictError, type WorkflowRepository } from '../workflow/repository';
import { WorkflowService, WorkflowTransitionError } from '../workflow/service';

import {
  parseModelContextProjection,
  parseReasoningEnvelope,
  reasoningHash,
  reasoningRunner,
  sensitivityAllows,
  type ModelContextItem,
  type ModelContextProjection,
  type ReasoningAuthorityPolicyRef,
  type ReasoningBackendBinding,
  type ReasoningClaim,
  type ReasoningEvidencePolicy,
  type ReasoningSensitivity,
  type ReasoningTaskEnvelopeV1,
  type ReasoningTaskKind,
} from './domain';
import { projectOwnerReasoningJob, type OwnerReasoningJobView } from './job_projection';
import {
  getReasoningSchemaContract,
  inspectJsonResources,
  validateReasoningInput,
  validateReasoningResult,
} from './schema_registry';

import type { ReasoningBackendRepository } from './backend_repository';
import type {
  ReasoningContextRepository,
  ReasoningContextTicket,
  ReasoningProjection,
} from './context_repository';

const DEFAULT_LEASE_MS = 60_000;
const MAX_LEASE_MS = 5 * 60_000;
const DEFAULT_DEADLINE_MS = 10 * 60_000;
const MAX_DEADLINE_MS = 60 * 60_000;
const MAX_ACTIVE_REASONING_JOBS_PER_OWNER = 100;
const MAX_PURPOSE_LENGTH = 512;
const MAX_REASONING_ERROR_LENGTH = 2_048;
const MAX_COMMIT_RECEIPT_BYTES = 8 * 1024;
const MAX_COMMIT_RECOVERY_ATTEMPTS = 10;
const MAX_COMMIT_RECOVERY_BACKOFF_MS = 5 * 60_000;
const OWNER_JOB_STATES: readonly WorkflowTaskState[] = [
  WorkflowTaskState.Created,
  WorkflowTaskState.Pending,
  WorkflowTaskState.Queued,
  WorkflowTaskState.Claimed,
  WorkflowTaskState.Running,
  WorkflowTaskState.Awaiting,
  WorkflowTaskState.PendingApproval,
  WorkflowTaskState.Scheduled,
  WorkflowTaskState.Completed,
  WorkflowTaskState.Failed,
  WorkflowTaskState.Cancelled,
  WorkflowTaskState.OutcomeUnknown,
  WorkflowTaskState.Recorded,
];

export type ReasoningPriority = 'user_blocking' | 'normal' | 'background';

export interface CreateReasoningJobInput {
  taskKind: ReasoningTaskKind;
  ownerDid: string;
  authorityOrigin: AuthorityOrigin;
  /** Core-only mutable authority reference; never projected to the backend. */
  authorityPolicyRef?: ReasoningAuthorityPolicyRef | null;
  input: unknown;
  context?: {
    items: ModelContextItem[];
    scrubbed: boolean;
    sensitivity: ReasoningSensitivity;
  };
  sensitivity: ReasoningSensitivity;
  evidencePolicy?: ReasoningEvidencePolicy;
  purpose: string;
  backendBindingId?: string | null;
  idempotencyKey?: string;
  priority?: ReasoningPriority;
  deadlineAtMs?: number;
  maxAttempts?: number;
  origin?: 'api' | 'd2d' | 'system' | 'cli' | 'dinamobile' | 'agent';
  sessionName?: string;
}

export interface ReasoningSubmission {
  taskId: string;
  executionId: string;
  state: string;
  deduplicated: boolean;
  deadlineAtMs: number;
}

export interface ClaimReasoningJobInput {
  backendId: string;
  principalDid: string;
  /** Core-authenticated host session; absent for managed always-on workers. */
  authenticatedSessionId?: string;
  leaseMs?: number;
  /**
   * Core-internal exact-task fence for inline begin-and-claim. Public worker
   * claim routes never copy a caller-supplied task id into this field.
   */
  taskId?: string;
}

export interface HeartbeatReasoningJobInput {
  taskId: string;
  claimId: string;
  contextTicketId: string;
  backendId: string;
  principalDid: string;
  authenticatedSessionId?: string;
  leaseMs?: number;
}

export interface CompleteReasoningJobInput {
  taskId: string;
  claimId: string;
  contextTicketId: string;
  backendId: string;
  principalDid: string;
  executionId: string;
  contextProjectionHash: string | null;
  policySnapshotHash: string;
  result: unknown;
  evidenceIds?: string[];
  /**
   * Authenticated host session resolved by the route. This is never accepted
   * as authority from the JSON body and is available only to Core commit
   * bridges that must bind a follow-on operation to the live host session.
   */
  authenticatedSessionId?: string;
}

export type ReasoningCommitState = 'committed' | 'pending_approval';

export interface ReasoningCommitReceipt {
  state: ReasoningCommitState;
  /**
   * Bounded, non-secret identifiers/status for owner projection and recovery.
   * Raw input/context and credentials must never be returned here.
   */
  receipt?: Record<string, unknown>;
}

export interface ReasoningCompletion {
  accepted: boolean;
  state: 'completed' | 'rejected';
  code:
    | 'completed'
    | 'stale_claim'
    | 'stale_policy'
    | 'invalid_result'
    | 'invalid_evidence'
    | 'backend_unavailable'
    | 'ticket_invalid';
  committed: boolean;
  commitState?: ReasoningCommitState | 'failed';
  commitError?: string;
}

export interface FailReasoningJobInput {
  taskId: string;
  claimId: string;
  contextTicketId: string;
  backendId: string;
  principalDid: string;
  authenticatedSessionId?: string;
  error: string;
  retryable: boolean;
}

export interface ReasoningFailure {
  accepted: boolean;
  state: 'queued' | 'failed' | 'rejected';
  code: 'requeued' | 'failed' | 'stale_claim' | 'ticket_invalid';
}

export interface ReasoningStatus {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  backendIds: string[];
}

export interface ReasoningCommitReconcileResult {
  scanned: number;
  committed: number;
  pendingApproval: number;
  failed: number;
  skipped: number;
}

export interface ReasoningPolicySnapshotInput {
  envelope: Omit<ReasoningTaskEnvelopeV1, 'policySnapshotHash'>;
}

export interface ReasoningValidatedProposal {
  task: WorkflowTask;
  envelope: ReasoningTaskEnvelopeV1;
  input: unknown;
  context: ModelContextProjection | null;
  result: unknown;
  evidenceIds: string[];
  backendPrincipalDid: string;
  authenticatedSessionId?: string;
}

export interface ReasoningOutputGuardInput {
  taskKind: ReasoningTaskKind;
  input: unknown;
  context: ModelContextProjection | null;
  result: unknown;
  evidenceIds: string[];
}

export type ReasoningOutputGuardResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export interface ReasoningBrokerOptions {
  workflowService: WorkflowService;
  workflowRepository: WorkflowRepository;
  backendRepository: ReasoningBackendRepository;
  contextRepository: ReasoningContextRepository;
  nowMs?: () => number;
  idBytes?: (length: number) => Uint8Array;
  resolvePolicySnapshotHash?: (input: ReasoningPolicySnapshotInput) => string;
  outputGuard?: (
    input: ReasoningOutputGuardInput,
  ) => Promise<ReasoningOutputGuardResult> | ReasoningOutputGuardResult;
  /**
   * Revalidate the exact Core session carried by a connected-host claim.
   *
   * Routes validate and renew the session before handing work to the broker,
   * but completion and crash recovery need a second, non-renewing check at
   * their own authority boundary. Managed backends do not carry a host
   * session and never call this seam.
   */
  isAuthenticatedSessionActive?: (input: {
    sessionId: string;
    principalDid: string;
    ownerDid: string;
    authorityOrigin: AuthorityOrigin;
  }) => boolean;
  /**
   * Atomically reserve a connected-host session for one exact non-owner
   * authority origin. Owner-origin claims are only revalidated and never bind.
   */
  activateAuthenticatedSessionAuthority?: (input: {
    sessionId: string;
    principalDid: string;
    ownerDid: string;
    authorityOrigin: AuthorityOrigin;
  }) => boolean;
  /**
   * Release the exact non-owner reservation after its claim, commit, retry, or
   * cancellation lifecycle ends. Implementations must ignore stale origins.
   */
  releaseAuthenticatedSessionAuthority?: (input: {
    sessionId: string;
    principalDid: string;
    ownerDid: string;
    authorityOrigin: AuthorityOrigin;
  }) => boolean;
  /**
   * Core-owned, idempotent bridge. It runs only after the exact workflow claim
   * wins completion. A failure never grants authority to the backend; it is
   * recorded as a separate commit failure and can be retried by a supervisor.
   */
  commitValidatedProposal?: (
    proposal: ReasoningValidatedProposal,
  ) => Promise<ReasoningCommitReceipt> | ReasoningCommitReceipt;
}

export class ReasoningBrokerError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'queue_full'
      | 'backend_not_found'
      | 'backend_not_allowed'
      | 'authority_unavailable'
      | 'not_found'
      | 'forbidden'
      | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'ReasoningBrokerError';
  }
}

function isDid(value: string): boolean {
  return /^did:[^:\s]+:\S+$/.test(value) && value.length <= 512;
}

function isBackendActive(binding: ReasoningBackendBinding, nowMs: number): boolean {
  return (
    binding.enabled &&
    binding.revokedAtMs === null &&
    (binding.expiresAtMs === null || binding.expiresAtMs > nowMs)
  );
}

function capError(error: string): string {
  return [...error].slice(0, MAX_REASONING_ERROR_LENGTH).join('');
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isReasoningTaskForOwner(task: WorkflowTask, ownerDid: string): boolean {
  const envelope = parseReasoningEnvelope(task.payload);
  return envelope !== null && envelope.ownerDid === ownerDid;
}

function canonicalEvidenceIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length > 128 || unique.some((id) => !/^[A-Za-z0-9._:-]{1,256}$/.test(id))) {
    throw new ReasoningBrokerError('invalid_request', 'invalid evidence identifiers');
  }
  return unique.sort();
}

function submissionForIdempotentReplay(
  task: WorkflowTask,
  requestFingerprint: string,
): ReasoningSubmission {
  const envelope = parseReasoningEnvelope(task.payload);
  if (envelope === null || envelope.requestFingerprint !== requestFingerprint) {
    throw new ReasoningBrokerError(
      'conflict',
      'idempotency key already represents different reasoning work',
    );
  }
  return {
    taskId: task.id,
    executionId: envelope.executionId,
    state: task.status,
    deduplicated: true,
    deadlineAtMs: envelope.deadlineAtMs,
  };
}

export function deriveReasoningPolicySnapshotHash(
  envelope: Omit<ReasoningTaskEnvelopeV1, 'policySnapshotHash'>,
): string {
  return reasoningHash({
    version: 1,
    taskKind: envelope.taskKind,
    ownerDid: envelope.ownerDid,
    authorityOrigin: envelope.authorityOrigin,
    authorityPolicyRef: envelope.authorityPolicyRef,
    backendBindingId: envelope.backendBindingId,
    requestSchemaId: envelope.requestSchemaId,
    resultSchemaId: envelope.resultSchemaId,
    inputProjectionHash: envelope.inputProjectionHash,
    contextProjectionHash: envelope.contextProjectionHash,
    sensitivity: envelope.sensitivity,
    evidencePolicy: envelope.evidencePolicy,
    allowedEvidenceIdsHash: envelope.allowedEvidenceIdsHash,
    purpose: envelope.purpose,
  });
}

export class CoreReasoningBroker {
  private readonly nowMs: () => number;
  private readonly idBytes: (length: number) => Uint8Array;
  private readonly resolvePolicySnapshotHash: (input: ReasoningPolicySnapshotInput) => string;
  private commitRecoveryInFlight: Promise<ReasoningCommitReconcileResult> | null = null;
  private readonly commitTasksInFlight = new Set<string>();

  constructor(private readonly options: ReasoningBrokerOptions) {
    this.nowMs = options.nowMs ?? Date.now;
    this.idBytes = options.idBytes ?? randomBytes;
    this.resolvePolicySnapshotHash =
      options.resolvePolicySnapshotHash ??
      ((input) => deriveReasoningPolicySnapshotHash(input.envelope));
  }

  submit(input: CreateReasoningJobInput): ReasoningSubmission {
    const now = this.nowMs();
    const origin = parseAuthorityOrigin(input.authorityOrigin);
    if (
      !isDid(input.ownerDid) ||
      origin === null ||
      origin.ownerDid !== input.ownerDid ||
      input.purpose.length < 1 ||
      input.purpose.length > MAX_PURPOSE_LENGTH
    ) {
      throw new ReasoningBrokerError('invalid_request', 'invalid reasoning authority');
    }

    const contract = getReasoningSchemaContract(input.taskKind);
    const inputCheck = validateReasoningInput(contract, input.input);
    if (!inputCheck.ok) {
      throw new ReasoningBrokerError(
        'invalid_request',
        `invalid reasoning input: ${inputCheck.error ?? 'schema mismatch'}`,
      );
    }
    if (
      input.maxAttempts !== undefined &&
      (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 20)
    ) {
      throw new ReasoningBrokerError('invalid_request', 'invalid reasoning attempt budget');
    }
    const deadlineAtMs = input.deadlineAtMs ?? now + DEFAULT_DEADLINE_MS;
    if (
      !Number.isSafeInteger(deadlineAtMs) ||
      deadlineAtMs <= now ||
      deadlineAtMs > now + MAX_DEADLINE_MS
    ) {
      throw new ReasoningBrokerError('invalid_request', 'invalid reasoning deadline');
    }

    const taskId = this.id('reason');
    const executionId = this.id('rexec');
    const inputProjectionId = this.id('rinput');
    const contextProjectionId = input.context ? this.id('rctx') : null;
    const inputProjectionHash = reasoningHash(input.input);
    const projectionExpiresAtMs = deadlineAtMs;

    let contextProjection: ModelContextProjection | null = null;
    let contextSemanticHash: string | null = null;
    if (input.context !== undefined) {
      if (contextProjectionId === null) {
        throw new ReasoningBrokerError('invalid_request', 'reasoning context id is unavailable');
      }
      contextProjection = {
        projectionId: contextProjectionId,
        purpose: input.purpose,
        items: input.context.items,
        scrubbed: input.context.scrubbed,
        sensitivity: input.context.sensitivity,
        expiresAtMs: projectionExpiresAtMs,
      };
      if (
        !sensitivityAllows(input.sensitivity, input.context.sensitivity) ||
        parseModelContextProjection(contextProjection) === null
      ) {
        throw new ReasoningBrokerError('invalid_request', 'invalid reasoning context');
      }
      const contextResources = inspectJsonResources(contextProjection, {
        maxBytes: 128 * 1024,
        maxDepth: 12,
        maxProperties: 2_048,
      });
      if (!contextResources.ok) {
        throw new ReasoningBrokerError(
          'invalid_request',
          `invalid reasoning context: ${contextResources.error ?? 'resource limit'}`,
        );
      }
      contextSemanticHash = reasoningHash({
        purpose: contextProjection.purpose,
        items: contextProjection.items,
        scrubbed: contextProjection.scrubbed,
        sensitivity: contextProjection.sensitivity,
      });
    }

    const allowedEvidenceIds = canonicalEvidenceIds(
      contextProjection?.items.map((item) => item.sourceId) ?? [],
    );
    const evidencePolicy = input.evidencePolicy ?? 'optional';
    if (evidencePolicy === 'required' && allowedEvidenceIds.length === 0) {
      throw new ReasoningBrokerError(
        'invalid_request',
        'required evidence policy has no allowed evidence',
      );
    }
    const allowedEvidenceIdsHash =
      evidencePolicy === 'none' ? null : reasoningHash(allowedEvidenceIds);
    const targetBackendId = input.backendBindingId ?? null;
    const authorityPolicyRef = input.authorityPolicyRef ?? null;
    if (
      authorityPolicyRef !== null &&
      (origin.kind !== 'service_request' || origin.requesterDid !== authorityPolicyRef.requesterDid)
    ) {
      throw new ReasoningBrokerError(
        'invalid_request',
        'reasoning authority policy does not match authenticated origin',
      );
    }
    const maxAttempts = input.maxAttempts ?? 3;
    const requestFingerprint = reasoningHash({
      version: 1,
      ownerDid: input.ownerDid,
      authority: {
        kind: origin.kind,
        ownerDid: origin.ownerDid,
        requesterDid: origin.requesterDid ?? null,
        ingress: origin.ingress,
        correlationId: origin.correlationId,
        evidenceHash: origin.evidenceHash ?? null,
      },
      taskKind: input.taskKind,
      inputProjectionHash,
      contextSemanticHash,
      sensitivity: input.sensitivity,
      evidencePolicy,
      allowedEvidenceIdsHash,
      purpose: input.purpose,
      backendBindingId: targetBackendId,
      authorityPolicyRef,
      maxAttempts,
    });
    const contextProjectionHash =
      contextProjection === null ? null : reasoningHash(contextProjection);
    const rawIdempotency =
      input.idempotencyKey ??
      reasoningHash({
        ownerDid: input.ownerDid,
        taskKind: input.taskKind,
        executionId,
      });
    const idempotencyKey = `reason:${reasoningHash({
      ownerDid: input.ownerDid,
      taskKind: input.taskKind,
      raw: rawIdempotency,
    })}`;

    const existing = this.options.workflowRepository.getByIdempotencyKey(idempotencyKey);
    if (existing !== null) {
      return submissionForIdempotentReplay(existing, requestFingerprint);
    }

    if (targetBackendId !== null) {
      const binding = this.options.backendRepository.get(targetBackendId);
      if (binding === null || !isBackendActive(binding, now)) {
        throw new ReasoningBrokerError('backend_not_found', 'reasoning backend unavailable');
      }
      if (
        binding.selectedByOwnerDid !== input.ownerDid ||
        !binding.allowedTaskKinds.includes(input.taskKind) ||
        !sensitivityAllows(binding.maxSensitivity, input.sensitivity)
      ) {
        throw new ReasoningBrokerError(
          'backend_not_allowed',
          'reasoning backend is not authorized for this task',
        );
      }
    }

    if (this.countActiveForOwner(input.ownerDid) >= MAX_ACTIVE_REASONING_JOBS_PER_OWNER) {
      throw new ReasoningBrokerError('queue_full', 'reasoning queue is full');
    }

    const withoutPolicy: Omit<ReasoningTaskEnvelopeV1, 'policySnapshotHash'> = {
      version: 1,
      taskId,
      taskKind: input.taskKind,
      ownerDid: input.ownerDid,
      authorityOrigin: origin,
      authorityPolicyRef,
      backendBindingId: targetBackendId,
      requestSchemaId: contract.requestSchemaId,
      resultSchemaId: contract.resultSchemaId,
      inputProjectionId,
      inputProjectionHash,
      contextProjectionId,
      contextProjectionHash,
      sensitivity: input.sensitivity,
      evidencePolicy,
      allowedEvidenceIdsHash,
      requestFingerprint,
      purpose: input.purpose,
      executionId,
      idempotencyKey,
      createdAtMs: now,
      deadlineAtMs,
      maxAttempts,
    };
    const policySnapshotHash = this.resolvePolicySnapshotHash({
      envelope: withoutPolicy,
    });
    if (policySnapshotHash === '') {
      throw new ReasoningBrokerError(
        'authority_unavailable',
        'reasoning authority is no longer available',
      );
    }
    if (!/^[0-9a-f]{64}$/.test(policySnapshotHash)) {
      throw new ReasoningBrokerError('invalid_request', 'invalid policy snapshot hash');
    }
    const envelope: ReasoningTaskEnvelopeV1 = {
      ...withoutPolicy,
      policySnapshotHash,
    };

    try {
      this.options.workflowService.create({
        id: taskId,
        kind: 'reasoning',
        description: `Reasoning: ${input.taskKind}`,
        payload: JSON.stringify(envelope),
        expiresAtSec: Math.ceil(deadlineAtMs / 1000),
        correlationId: origin.correlationId,
        priority: input.priority ?? WorkflowTaskPriority.Normal,
        origin: input.origin ?? 'agent',
        sessionName: input.sessionName,
        idempotencyKey,
        initialState: WorkflowTaskState.Queued,
        requestedRunner: targetBackendId === null ? undefined : reasoningRunner(targetBackendId),
      });
    } catch (error) {
      if (error instanceof WorkflowConflictError && error.code === 'duplicate_idempotency') {
        const existing = this.options.workflowRepository.getActiveByIdempotencyKey(idempotencyKey);
        if (existing !== null) return submissionForIdempotentReplay(existing, requestFingerprint);
      }
      throw error;
    }

    try {
      const inputProjection: ReasoningProjection = {
        projectionId: inputProjectionId,
        taskId,
        kind: 'input',
        ownerDid: input.ownerDid,
        purpose: input.purpose,
        sensitivity: input.sensitivity,
        content: input.input,
        contentHash: inputProjectionHash,
        scrubbed: false,
        allowedEvidenceIds: [],
        createdAtMs: now,
        expiresAtMs: projectionExpiresAtMs,
        revokedAtMs: null,
      };
      this.options.contextRepository.createProjection(inputProjection);
      if (contextProjection !== null) {
        if (contextProjectionHash === null) {
          throw new Error('reasoning context hash is unavailable');
        }
        this.options.contextRepository.createProjection({
          projectionId: contextProjection.projectionId,
          taskId,
          kind: 'context',
          ownerDid: input.ownerDid,
          purpose: input.purpose,
          sensitivity: contextProjection.sensitivity,
          content: contextProjection,
          contentHash: contextProjectionHash,
          scrubbed: contextProjection.scrubbed,
          allowedEvidenceIds,
          createdAtMs: now,
          expiresAtMs: projectionExpiresAtMs,
          revokedAtMs: null,
        });
      }
    } catch (error) {
      this.options.contextRepository.revokeProjectionsForTask(taskId, now);
      try {
        this.options.workflowService.cancel(taskId, 'reasoning projection persistence failed');
      } catch {
        // The task is already unusable without its hash-bound projection.
      }
      throw error;
    }

    return {
      taskId,
      executionId,
      state: 'queued',
      deduplicated: false,
      deadlineAtMs,
    };
  }

  claim(input: ClaimReasoningJobInput): ReasoningClaim | null {
    const now = this.nowMs();
    const leaseMs = this.validLease(input.leaseMs);
    const binding = this.requireActiveBinding(input.backendId, input.principalDid, now);
    const task = this.options.workflowRepository.claimReasoningTask(
      input.principalDid,
      input.backendId,
      binding.selectedByOwnerDid,
      binding.allowedTaskKinds,
      binding.maxSensitivity,
      now,
      leaseMs,
      input.taskId,
    );
    if (task === null) return null;

    const envelope = parseReasoningEnvelope(task.payload);
    if (
      envelope === null ||
      envelope.taskId !== task.id ||
      envelope.ownerDid !== binding.selectedByOwnerDid
    ) {
      this.failClaim(task, input.principalDid, 'malformed reasoning envelope', now);
      return null;
    }
    if (!this.policySnapshotCurrent(envelope)) {
      this.failClaim(task, input.principalDid, 'stale reasoning policy', now);
      return null;
    }
    // A previous lease for the same job may have died without ending its host
    // session. Clear that exact stale reservation before binding the winning
    // replacement claim.
    this.releaseSessionAuthoritiesForTask(task, input.authenticatedSessionId ?? null);

    const projections = this.loadLiveProjections(envelope, task, now);
    if (projections === null) {
      this.failClaim(task, input.principalDid, 'reasoning projection unavailable', now);
      return null;
    }
    const parsedContext =
      projections.context === null
        ? null
        : parseModelContextProjection(projections.context.content);
    if (projections.context !== null && parsedContext === null) {
      this.failClaim(task, input.principalDid, 'malformed reasoning context', now);
      return null;
    }
    const allowedEvidenceIds = canonicalEvidenceIds([
      ...projections.input.allowedEvidenceIds,
      ...(projections.context?.allowedEvidenceIds ?? []),
    ]);
    if (
      envelope.allowedEvidenceIdsHash !==
      (envelope.evidencePolicy === 'none' ? null : reasoningHash(allowedEvidenceIds))
    ) {
      this.failClaim(task, input.principalDid, 'reasoning evidence set mismatch', now);
      return null;
    }

    const claimId = task.claim_id;
    const leaseExpiresAtMs = task.lease_expires_at;
    if (claimId === undefined || leaseExpiresAtMs === undefined || leaseExpiresAtMs <= now) {
      this.failClaim(task, input.principalDid, 'invalid reasoning claim', now);
      return null;
    }
    const ticketId = this.id('rticket');
    const ticketExpiresAtMs = Math.min(
      leaseExpiresAtMs,
      envelope.deadlineAtMs,
      projections.input.expiresAtMs,
      projections.context?.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
    );
    const ticket: ReasoningContextTicket = {
      ticketId,
      taskId: task.id,
      claimId,
      backendId: binding.backendId,
      principalDid: binding.principalDid,
      authenticatedSessionId: input.authenticatedSessionId ?? null,
      ownerDid: envelope.ownerDid,
      purpose: envelope.purpose,
      policyVersion: binding.policyVersion,
      inputProjectionId: envelope.inputProjectionId,
      contextProjectionId: envelope.contextProjectionId,
      createdAtMs: now,
      expiresAtMs: ticketExpiresAtMs,
      consumedAtMs: null,
      revokedAtMs: null,
    };
    try {
      this.options.contextRepository.revokeTicketsForTask(task.id, claimId, now);
      this.options.contextRepository.createTicket(ticket);
    } catch {
      this.options.contextRepository.revokeTicket(ticketId, now);
      this.options.workflowRepository.requeueClaimedTask(
        task.id,
        input.principalDid,
        claimId,
        Math.ceil((now + 5_000) / 1000),
        'context ticket persistence failed',
        now,
      );
      return null;
    }
    /*
     * Persist the ticket before reserving the connected-host session. The
     * ticket is the durable backlink used by restart reconciliation and lease
     * cleanup. Reserving first leaves an unrecoverable orphan if Core crashes
     * between the two writes.
     */
    if (!this.activateSessionAuthority(binding, input.authenticatedSessionId ?? null, envelope)) {
      this.options.contextRepository.revokeTicket(ticketId, now);
      this.failClaim(task, input.principalDid, 'stale session authority', now);
      return null;
    }
    const contract = getReasoningSchemaContract(envelope.taskKind);
    return {
      taskId: task.id,
      claimId,
      contextTicketId: ticketId,
      leaseExpiresAtMs: ticketExpiresAtMs,
      taskKind: envelope.taskKind,
      purpose: envelope.purpose,
      authorityOrigin: envelope.authorityOrigin,
      input: projections.input.content,
      context: parsedContext,
      allowedEvidenceIds,
      resultSchema: contract.resultSchema,
      resultSchemaId: contract.resultSchemaId,
      executionId: envelope.executionId,
      contextProjectionHash: envelope.contextProjectionHash,
      policySnapshotHash: envelope.policySnapshotHash,
    };
  }

  heartbeat(input: HeartbeatReasoningJobInput): boolean {
    const now = this.nowMs();
    const leaseMs = this.validLease(input.leaseMs);
    const binding = this.options.backendRepository.get(input.backendId);
    const task = this.options.workflowRepository.getById(input.taskId);
    const ticket = this.options.contextRepository.getTicket(input.contextTicketId);
    if (
      binding === null ||
      !isBackendActive(binding, now) ||
      binding.principalDid !== input.principalDid ||
      ticket === null ||
      !this.ticketMatchesLiveClaim(ticket, task, input, now) ||
      ticket.policyVersion !== binding.policyVersion
    ) {
      return false;
    }
    if (task === null) return false;
    const envelope = parseReasoningEnvelope(task.payload);
    if (envelope === null) {
      this.options.contextRepository.revokeTicket(input.contextTicketId, now);
      return false;
    }
    if (!this.sessionAuthorityActive(binding, ticket.authenticatedSessionId, envelope)) {
      this.options.contextRepository.revokeTicket(input.contextTicketId, now);
      return false;
    }
    const projections = this.loadLiveProjections(envelope, task, now);
    if (projections === null) {
      this.options.contextRepository.revokeTicket(input.contextTicketId, now);
      return false;
    }
    const nextExpiry = Math.min(
      now + leaseMs,
      envelope.deadlineAtMs,
      projections.input.expiresAtMs,
      projections.context?.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
    );
    if (
      !this.options.contextRepository.extendTicket(input.contextTicketId, input.claimId, nextExpiry)
    ) {
      return false;
    }
    const extended = this.options.workflowRepository.heartbeatTask(
      input.taskId,
      input.principalDid,
      now,
      nextExpiry - now,
      input.claimId,
    );
    if (!extended) this.options.contextRepository.revokeTicket(input.contextTicketId, now);
    return extended;
  }

  async complete(input: CompleteReasoningJobInput): Promise<ReasoningCompletion> {
    const now = this.nowMs();
    const binding = this.options.backendRepository.get(input.backendId);
    const task = this.options.workflowRepository.getById(input.taskId);
    const ticket = this.options.contextRepository.getTicket(input.contextTicketId);
    if (ticket === null || !this.ticketMatchesLiveClaim(ticket, task, input, now)) {
      return this.rejectedCompletion('ticket_invalid');
    }
    if (
      binding === null ||
      !isBackendActive(binding, now) ||
      binding.principalDid !== input.principalDid ||
      binding.policyVersion !== ticket.policyVersion
    ) {
      this.options.contextRepository.revokeTicket(input.contextTicketId, now);
      return this.rejectedCompletion('backend_unavailable');
    }
    if (task === null) {
      this.options.contextRepository.revokeTicket(input.contextTicketId, now);
      return this.rejectedCompletion('ticket_invalid');
    }
    const envelope = parseReasoningEnvelope(task.payload);
    if (envelope === null) {
      this.options.contextRepository.revokeTicket(input.contextTicketId, now);
      return this.rejectedCompletion('ticket_invalid');
    }
    if (
      input.executionId !== envelope.executionId ||
      input.contextProjectionHash !== envelope.contextProjectionHash
    ) {
      return this.rejectedCompletion('stale_claim');
    }
    if (
      input.policySnapshotHash !== envelope.policySnapshotHash ||
      !this.policySnapshotCurrent(envelope)
    ) {
      this.options.contextRepository.revokeTicket(input.contextTicketId, now);
      this.failClaim(task, input.principalDid, 'stale_authority', now);
      return this.rejectedCompletion('stale_policy');
    }

    const projections = this.loadLiveProjections(envelope, task, now);
    if (projections === null) {
      this.options.contextRepository.revokeTicket(input.contextTicketId, now);
      return this.rejectedCompletion('ticket_invalid');
    }
    let evidenceIds: string[];
    try {
      evidenceIds = canonicalEvidenceIds(input.evidenceIds ?? []);
    } catch {
      return this.rejectedCompletion('invalid_evidence');
    }
    const allowed = new Set([
      ...projections.input.allowedEvidenceIds,
      ...(projections.context?.allowedEvidenceIds ?? []),
    ]);
    const allowedEvidenceIds = [...allowed].sort();
    if (
      envelope.allowedEvidenceIdsHash !==
        (envelope.evidencePolicy === 'none' ? null : reasoningHash(allowedEvidenceIds)) ||
      (envelope.evidencePolicy === 'none'
        ? evidenceIds.length !== 0
        : evidenceIds.some((id) => !allowed.has(id)) ||
          (envelope.evidencePolicy === 'required' && evidenceIds.length === 0))
    ) {
      return this.rejectedCompletion('invalid_evidence');
    }
    const resultEvidenceIds = this.resultEvidenceIds(input.result);
    if (
      resultEvidenceIds !== null &&
      reasoningHash(resultEvidenceIds) !== reasoningHash(evidenceIds)
    ) {
      return this.rejectedCompletion('invalid_evidence');
    }
    if (
      envelope.evidencePolicy === 'required' &&
      !this.satisfiesTaskEvidenceRule(envelope.taskKind, evidenceIds, projections.context)
    ) {
      return this.rejectedCompletion('invalid_evidence');
    }

    const contract = getReasoningSchemaContract(envelope.taskKind);
    const resultCheck = validateReasoningResult(contract, input.result);
    if (!resultCheck.ok) {
      await this.fail({
        taskId: input.taskId,
        claimId: input.claimId,
        contextTicketId: input.contextTicketId,
        backendId: input.backendId,
        principalDid: input.principalDid,
        ...(input.authenticatedSessionId === undefined
          ? {}
          : { authenticatedSessionId: input.authenticatedSessionId }),
        error: `invalid result: ${resultCheck.error ?? 'schema mismatch'}`,
        retryable: true,
      });
      return this.rejectedCompletion('invalid_result');
    }
    const parsedContext =
      projections.context === null
        ? null
        : parseModelContextProjection(projections.context.content);
    if (projections.context !== null && parsedContext === null) {
      return this.rejectedCompletion('ticket_invalid');
    }
    let guarded: ReasoningOutputGuardResult;
    try {
      guarded = (await this.options.outputGuard?.({
        taskKind: envelope.taskKind,
        input: projections.input.content,
        context: parsedContext,
        result: input.result,
        evidenceIds,
      })) ?? {
        ok: true as const,
        result: input.result,
      };
    } catch {
      await this.fail({
        taskId: input.taskId,
        claimId: input.claimId,
        contextTicketId: input.contextTicketId,
        backendId: input.backendId,
        principalDid: input.principalDid,
        ...(input.authenticatedSessionId === undefined
          ? {}
          : { authenticatedSessionId: input.authenticatedSessionId }),
        error: 'reasoning output policy unavailable',
        retryable: false,
      });
      return this.rejectedCompletion('invalid_result');
    }
    if (!guarded.ok) {
      await this.fail({
        taskId: input.taskId,
        claimId: input.claimId,
        contextTicketId: input.contextTicketId,
        backendId: input.backendId,
        principalDid: input.principalDid,
        ...(input.authenticatedSessionId === undefined
          ? {}
          : { authenticatedSessionId: input.authenticatedSessionId }),
        error: `unsafe result: ${guarded.error}`,
        retryable: false,
      });
      return this.rejectedCompletion('invalid_result');
    }
    const guardedResultCheck = validateReasoningResult(contract, guarded.result);
    if (!guardedResultCheck.ok) {
      await this.fail({
        taskId: input.taskId,
        claimId: input.claimId,
        contextTicketId: input.contextTicketId,
        backendId: input.backendId,
        principalDid: input.principalDid,
        ...(input.authenticatedSessionId === undefined
          ? {}
          : { authenticatedSessionId: input.authenticatedSessionId }),
        error: `output guard produced invalid result: ${
          guardedResultCheck.error ?? 'schema mismatch'
        }`,
        retryable: false,
      });
      return this.rejectedCompletion('invalid_result');
    }

    /*
     * The output guard may be asynchronous. Re-read every authority row after
     * it returns, then consume the exact ticket as the final CAS before the
     * synchronous workflow transition. With no await between the CAS and
     * completion, session end/backend revoke/cancel cannot interleave on the
     * JS event loop and publish a result after authority was withdrawn.
     */
    const completionAuthority = this.currentCompletionAuthority(input, envelope);
    if (!completionAuthority.ok) {
      this.options.contextRepository.revokeTicket(input.contextTicketId, this.nowMs());
      if (completionAuthority.terminalize && completionAuthority.task !== null) {
        this.failClaim(
          completionAuthority.task,
          input.principalDid,
          'stale_authority',
          this.nowMs(),
        );
      }
      return this.rejectedCompletion(completionAuthority.code);
    }
    const completionNow = this.nowMs();
    if (
      !this.options.contextRepository.consumeTicket(
        input.contextTicketId,
        input.claimId,
        completionNow,
      )
    ) {
      return this.rejectedCompletion('ticket_invalid');
    }

    let completed: WorkflowTask;
    try {
      completed = this.options.workflowService.complete(
        input.taskId,
        JSON.stringify({
          version: 1,
          executionId: envelope.executionId,
          result: guarded.result,
          evidenceIds,
          backendId: completionAuthority.binding.backendId,
          backendPolicyVersion: completionAuthority.ticket.policyVersion,
          authenticatedSessionId: completionAuthority.ticket.authenticatedSessionId,
        }),
        `Reasoning completed: ${envelope.taskKind}`,
        input.principalDid,
        input.claimId,
      );
    } catch (error) {
      this.options.contextRepository.revokeTicket(input.contextTicketId, now);
      if (error instanceof WorkflowTransitionError) {
        return this.rejectedCompletion('stale_claim');
      }
      throw error;
    }

    let committed = this.options.commitValidatedProposal === undefined;
    let commitState: ReasoningCompletion['commitState'] =
      this.options.commitValidatedProposal === undefined ? 'committed' : undefined;
    let commitError: string | undefined;
    if (this.options.commitValidatedProposal !== undefined) {
      this.commitTasksInFlight.add(input.taskId);
      try {
        const receipt = this.validateCommitReceipt(
          await this.options.commitValidatedProposal({
            task: completed,
            envelope,
            input: projections.input.content,
            context:
              projections.context === null
                ? null
                : parseModelContextProjection(projections.context.content),
            result: guarded.result,
            evidenceIds,
            backendPrincipalDid: input.principalDid,
            ...(completionAuthority.ticket.authenticatedSessionId === null
              ? {}
              : {
                  authenticatedSessionId: completionAuthority.ticket.authenticatedSessionId,
                }),
          }),
        );
        committed = receipt.state === 'committed';
        commitState = receipt.state;
        this.appendCommitReceipt(input.taskId, receipt);
        // The durable commit receipt now owns any remaining approval/retry
        // state. Raw model projections no longer need to remain readable.
        this.options.contextRepository.revokeProjectionsForTask(input.taskId, now);
      } catch (error) {
        commitError = capError(error instanceof Error ? error.message : String(error));
        commitState = 'failed';
        this.options.workflowRepository.appendEvent({
          task_id: input.taskId,
          at: this.nowMs(),
          event_kind: 'reasoning_commit_failed',
          needs_delivery: false,
          delivery_attempts: 0,
          delivery_failed: false,
          details: JSON.stringify({ error: commitError }),
        });
      } finally {
        this.commitTasksInFlight.delete(input.taskId);
      }
    } else {
      this.options.contextRepository.revokeProjectionsForTask(input.taskId, now);
    }
    if (commitState !== 'failed') {
      this.releaseSessionAuthority(
        completionAuthority.binding,
        completionAuthority.ticket.authenticatedSessionId,
        envelope,
      );
    }
    return {
      accepted: true,
      state: 'completed',
      code: 'completed',
      committed,
      ...(commitState === undefined ? {} : { commitState }),
      ...(commitError ? { commitError } : {}),
    };
  }

  async fail(input: FailReasoningJobInput): Promise<ReasoningFailure> {
    const now = this.nowMs();
    const task = this.options.workflowRepository.getById(input.taskId);
    const ticket = this.options.contextRepository.getTicket(input.contextTicketId);
    if (ticket === null || !this.ticketMatchesLiveClaim(ticket, task, input, now)) {
      return { accepted: false, state: 'rejected', code: 'ticket_invalid' };
    }
    if (task === null) {
      return { accepted: false, state: 'rejected', code: 'ticket_invalid' };
    }
    const envelope = parseReasoningEnvelope(task.payload);
    if (envelope === null) {
      this.options.contextRepository.revokeTicket(input.contextTicketId, now);
      return { accepted: false, state: 'rejected', code: 'ticket_invalid' };
    }
    const error = capError(input.error);
    this.options.contextRepository.revokeTicket(input.contextTicketId, now);
    if (
      input.retryable &&
      (task.attempt ?? 0) < envelope.maxAttempts &&
      envelope.deadlineAtMs > now + 1_000
    ) {
      const backoffMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, (task.attempt ?? 1) - 1));
      const requeued = this.options.workflowRepository.requeueClaimedTask(
        input.taskId,
        input.principalDid,
        input.claimId,
        Math.ceil((now + backoffMs) / 1000),
        error,
        now,
      );
      if (requeued) {
        this.releaseSessionAuthorityForTicket(ticket, envelope);
      }
      return requeued
        ? { accepted: true, state: 'queued', code: 'requeued' }
        : { accepted: false, state: 'rejected', code: 'stale_claim' };
    }
    try {
      this.options.workflowService.fail(input.taskId, error, input.principalDid, input.claimId);
      this.options.contextRepository.revokeProjectionsForTask(input.taskId, now);
      this.releaseSessionAuthorityForTicket(ticket, envelope);
      return { accepted: true, state: 'failed', code: 'failed' };
    } catch (failure) {
      if (failure instanceof WorkflowTransitionError) {
        return { accepted: false, state: 'rejected', code: 'stale_claim' };
      }
      throw failure;
    }
  }

  status(requester: { did: string; ownerDid?: string }): ReasoningStatus {
    const isOwner = requester.ownerDid !== undefined && requester.did === requester.ownerDid;
    const bindingIds = isOwner
      ? this.options.backendRepository
          .list()
          .filter((binding) => binding.selectedByOwnerDid === requester.did)
          .map((binding) => binding.backendId)
      : this.options.backendRepository
          .getActiveForPrincipal(requester.did, this.nowMs())
          .map((binding) => binding.backendId);
    if (!isOwner && bindingIds.length === 0) {
      throw new ReasoningBrokerError('forbidden', 'reasoning backend is not bound');
    }
    let ownerDid = requester.ownerDid;
    if (ownerDid === undefined) {
      const firstBindingId = bindingIds[0];
      if (firstBindingId !== undefined) {
        ownerDid = this.options.backendRepository.get(firstBindingId)?.selectedByOwnerDid;
      }
    }
    if (ownerDid === undefined) {
      throw new ReasoningBrokerError('forbidden', 'reasoning owner is unavailable');
    }
    return {
      queued: this.countStateForOwner(ownerDid, WorkflowTaskState.Queued),
      running: this.countStateForOwner(ownerDid, WorkflowTaskState.Running),
      completed: this.countStateForOwner(ownerDid, WorkflowTaskState.Completed),
      failed: this.countStateForOwner(ownerDid, WorkflowTaskState.Failed),
      cancelled: this.countStateForOwner(ownerDid, WorkflowTaskState.Cancelled),
      backendIds: bindingIds,
    };
  }

  getOwnerJob(taskId: string, ownerDid: string): OwnerReasoningJobView | null {
    const task = this.options.workflowRepository.getById(taskId);
    if (task === null || task.kind !== 'reasoning' || !isReasoningTaskForOwner(task, ownerDid)) {
      return null;
    }
    return projectOwnerReasoningJob(
      task,
      this.options.workflowRepository.listEventsForTask(task.id),
    );
  }

  listOwnerJobs(ownerDid: string, limit = 50): OwnerReasoningJobView[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new ReasoningBrokerError('invalid_request', 'invalid reasoning job limit');
    }
    const scanLimit = Math.max(limit, this.options.workflowRepository.size() + 1);
    const byId = new Map<string, WorkflowTask>();
    for (const state of OWNER_JOB_STATES) {
      for (const task of this.options.workflowRepository.listByKindAndState(
        'reasoning',
        state,
        scanLimit,
      )) {
        if (isReasoningTaskForOwner(task, ownerDid)) byId.set(task.id, task);
      }
    }
    return [...byId.values()]
      .sort((left, right) => right.updated_at - left.updated_at || right.id.localeCompare(left.id))
      .slice(0, limit)
      .map((task) =>
        projectOwnerReasoningJob(task, this.options.workflowRepository.listEventsForTask(task.id)),
      )
      .filter((view): view is OwnerReasoningJobView => view !== null);
  }

  /**
   * Replay completed proposals whose Core-owned commit did not durably finish.
   *
   * Model execution is never repeated here. The reconciler reads the exact
   * hash-bound projections and schema-valid result that already won the
   * workflow claim, then invokes the idempotent commit bridge with the same
   * task id. A single-flight guard prevents boot/foreground ticks from racing.
   */
  reconcilePendingCommits(limit = 20): Promise<ReasoningCommitReconcileResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      return Promise.reject(
        new ReasoningBrokerError('invalid_request', 'invalid commit recovery limit'),
      );
    }
    if (this.commitRecoveryInFlight !== null) return this.commitRecoveryInFlight;
    const operation = this.runCommitRecovery(limit);
    this.commitRecoveryInFlight = operation;
    void operation.then(
      () => {
        if (this.commitRecoveryInFlight === operation) {
          this.commitRecoveryInFlight = null;
        }
      },
      () => {
        if (this.commitRecoveryInFlight === operation) {
          this.commitRecoveryInFlight = null;
        }
      },
    );
    return operation;
  }

  /**
   * Purge consumed authority tickets and projections outside the bounded
   * commit-recovery window. Platform schedulers call this only after a commit
   * reconciliation pass so cleanup can never race ahead of recovery.
   */
  sweepContextRecords(nowMs: number = this.nowMs()): number {
    return this.options.contextRepository.sweep(nowMs);
  }

  /**
   * Reconcile durable host reservations after process restart.
   *
   * A crash can occur after Core persisted a session origin but before normal
   * completion/failure cleanup. Keep only a live claim or a completed proposal
   * that still needs commit recovery; release every other exact reservation.
   */
  reconcileSessionAuthorities(): void {
    const now = this.nowMs();
    const scanLimit = Math.min(Math.max(1, this.options.workflowRepository.size() + 1), 10_000);
    const byId = new Map<string, WorkflowTask>();
    for (const state of OWNER_JOB_STATES) {
      for (const task of this.options.workflowRepository.listByKindAndState(
        'reasoning',
        state,
        scanLimit,
      )) {
        byId.set(task.id, task);
      }
    }
    for (const task of byId.values()) {
      if (this.options.contextRepository.listTicketsForTask(task.id).length === 0) {
        continue;
      }
      const hasLiveClaim =
        (task.status === WorkflowTaskState.Running || task.status === WorkflowTaskState.Claimed) &&
        task.claim_id !== undefined &&
        task.lease_expires_at !== undefined &&
        task.lease_expires_at > now;
      if (hasLiveClaim) continue;

      if (
        task.status === WorkflowTaskState.Completed &&
        this.options.commitValidatedProposal !== undefined
      ) {
        const commitEvents = this.options.workflowRepository
          .listEventsForTask(task.id)
          .filter((event) => event.event_kind.startsWith('reasoning_commit_'))
          .sort((left, right) => left.at - right.at || left.event_id - right.event_id);
        const latest = commitEvents.at(-1);
        const failures = commitEvents.filter(
          (event) => event.event_kind === 'reasoning_commit_failed',
        ).length;
        const commitStillRecoverable =
          latest?.event_kind !== 'reasoning_commit_succeeded' &&
          latest?.event_kind !== 'reasoning_commit_pending_approval' &&
          latest?.event_kind !== 'reasoning_commit_stale_authority' &&
          failures < MAX_COMMIT_RECOVERY_ATTEMPTS;
        if (commitStillRecoverable) continue;
      }

      this.releaseSessionAuthorityForTask(task);
    }
  }

  cancel(taskId: string, ownerDid: string, reason = 'cancelled by owner'): boolean {
    const task = this.options.workflowRepository.getById(taskId);
    if (task === null) return false;
    const envelope = parseReasoningEnvelope(task.payload);
    if (
      task.kind !== 'reasoning' ||
      envelope === null ||
      envelope.ownerDid !== ownerDid ||
      isTerminal(task.status as WorkflowTaskState)
    ) {
      return false;
    }
    this.options.workflowService.cancel(taskId, capError(reason));
    const now = this.nowMs();
    this.releaseSessionAuthoritiesForTask(task);
    this.options.contextRepository.revokeTicketsForTask(taskId, undefined, now);
    this.options.contextRepository.revokeProjectionsForTask(taskId, now);
    return true;
  }

  /**
   * Release a reasoning task's durable connected-host reservation.
   *
   * Workflow lease/deadline sweepers call this after they transition a task;
   * the exact-origin compare makes duplicate or stale calls harmless.
   */
  releaseSessionAuthorityForTask(task: WorkflowTask): void {
    if (task.kind !== 'reasoning') return;
    this.releaseSessionAuthoritiesForTask(task);
    this.options.contextRepository.revokeTicketsForTask(task.id, undefined, this.nowMs());
  }

  private id(prefix: string): string {
    return `${prefix}-${bytesToHex(this.idBytes(16))}`;
  }

  private validLease(value: number | undefined): number {
    const lease = value ?? DEFAULT_LEASE_MS;
    if (!Number.isSafeInteger(lease) || lease < 1_000 || lease > MAX_LEASE_MS) {
      throw new ReasoningBrokerError('invalid_request', 'invalid reasoning lease');
    }
    return lease;
  }

  private async runCommitRecovery(limit: number): Promise<ReasoningCommitReconcileResult> {
    const result: ReasoningCommitReconcileResult = {
      scanned: 0,
      committed: 0,
      pendingApproval: 0,
      failed: 0,
      skipped: 0,
    };
    if (this.options.commitValidatedProposal === undefined) return result;

    const scanLimit = Math.min(Math.max(limit, this.options.workflowRepository.size() + 1), 10_000);
    const tasks = this.options.workflowRepository.listByKindAndState(
      'reasoning',
      WorkflowTaskState.Completed,
      scanLimit,
    );
    let attempted = 0;
    for (const task of tasks) {
      result.scanned += 1;
      if (this.commitTasksInFlight.has(task.id)) {
        result.skipped += 1;
        continue;
      }
      const events = this.options.workflowRepository
        .listEventsForTask(task.id)
        .filter((event) => event.event_kind.startsWith('reasoning_commit_'))
        .sort((left, right) => left.at - right.at || left.event_id - right.event_id);
      const latest = events[events.length - 1];
      if (
        latest?.event_kind === 'reasoning_commit_succeeded' ||
        latest?.event_kind === 'reasoning_commit_pending_approval' ||
        latest?.event_kind === 'reasoning_commit_stale_authority'
      ) {
        this.releaseSessionAuthoritiesForTask(task);
        this.options.contextRepository.revokeProjectionsForTask(task.id, this.nowMs());
        result.skipped += 1;
        continue;
      }
      const failures = events.filter((event) => event.event_kind === 'reasoning_commit_failed');
      if (failures.length >= MAX_COMMIT_RECOVERY_ATTEMPTS) {
        this.releaseSessionAuthoritiesForTask(task);
        result.skipped += 1;
        continue;
      }
      if (latest?.event_kind === 'reasoning_commit_failed') {
        const backoffMs = Math.min(
          MAX_COMMIT_RECOVERY_BACKOFF_MS,
          1_000 * 2 ** Math.max(0, failures.length - 1),
        );
        if (latest.at + backoffMs > this.nowMs()) {
          result.skipped += 1;
          continue;
        }
      }
      if (attempted >= limit) break;
      attempted += 1;

      try {
        const recovered = await this.recoverValidatedProposal(task);
        if (recovered === null) {
          throw new Error('validated reasoning proposal is unavailable');
        }
        if (recovered.kind === 'stale_authority') {
          this.options.workflowRepository.appendEvent({
            task_id: task.id,
            at: this.nowMs(),
            event_kind: 'reasoning_commit_stale_authority',
            needs_delivery: false,
            delivery_attempts: 0,
            delivery_failed: false,
            details: JSON.stringify({ error: 'reasoning authority is no longer active' }),
          });
          this.releaseSessionAuthoritiesForTask(task);
          this.options.contextRepository.revokeProjectionsForTask(task.id, this.nowMs());
          result.failed += 1;
          continue;
        }
        const receipt = this.validateCommitReceipt(
          await this.options.commitValidatedProposal(recovered.proposal),
        );
        this.appendCommitReceipt(task.id, receipt);
        this.releaseSessionAuthoritiesForTask(task);
        this.options.contextRepository.revokeProjectionsForTask(task.id, this.nowMs());
        if (receipt.state === 'committed') result.committed += 1;
        else result.pendingApproval += 1;
      } catch (error) {
        const message = capError(error instanceof Error ? error.message : String(error));
        this.options.workflowRepository.appendEvent({
          task_id: task.id,
          at: this.nowMs(),
          event_kind: 'reasoning_commit_failed',
          needs_delivery: false,
          delivery_attempts: 0,
          delivery_failed: false,
          details: JSON.stringify({ error: message }),
        });
        if (failures.length + 1 >= MAX_COMMIT_RECOVERY_ATTEMPTS) {
          this.releaseSessionAuthoritiesForTask(task);
        }
        result.failed += 1;
      }
    }
    return result;
  }

  private async recoverValidatedProposal(
    task: WorkflowTask,
  ): Promise<
    { kind: 'ready'; proposal: ReasoningValidatedProposal } | { kind: 'stale_authority' } | null
  > {
    const envelope = parseReasoningEnvelope(task.payload);
    if (
      envelope === null ||
      envelope.taskId !== task.id ||
      task.status !== WorkflowTaskState.Completed
    ) {
      return null;
    }
    const projections = this.loadLiveProjections(envelope, task, this.nowMs(), true);
    const stored = record(this.parseJson(task.result));
    if (
      projections === null ||
      stored === null ||
      stored.version !== 1 ||
      stored.executionId !== envelope.executionId ||
      stored.result === undefined ||
      !Array.isArray(stored.evidenceIds) ||
      stored.evidenceIds.some((id) => typeof id !== 'string') ||
      typeof stored.backendId !== 'string' ||
      stored.backendId.length < 1 ||
      stored.backendId.length > 256 ||
      !Number.isSafeInteger(stored.backendPolicyVersion) ||
      (stored.backendPolicyVersion as number) < 1 ||
      !(
        stored.authenticatedSessionId === null ||
        (typeof stored.authenticatedSessionId === 'string' &&
          stored.authenticatedSessionId.length > 0 &&
          stored.authenticatedSessionId.length <= 256)
      )
    ) {
      return null;
    }
    const backendPrincipalDid = task.agent_did;
    if (backendPrincipalDid === undefined || !isDid(backendPrincipalDid)) {
      return null;
    }
    const binding = this.options.backendRepository.get(stored.backendId as string);
    const recoveredSessionId =
      typeof stored.authenticatedSessionId === 'string' ? stored.authenticatedSessionId : null;
    if (
      binding === null ||
      !isBackendActive(binding, this.nowMs()) ||
      binding.principalDid !== backendPrincipalDid ||
      binding.selectedByOwnerDid !== envelope.ownerDid ||
      binding.policyVersion !== stored.backendPolicyVersion ||
      !this.policySnapshotCurrent(envelope) ||
      !this.sessionAuthorityActive(binding, recoveredSessionId, envelope)
    ) {
      return { kind: 'stale_authority' };
    }
    let evidenceIds: string[];
    try {
      evidenceIds = canonicalEvidenceIds(stored.evidenceIds as string[]);
    } catch {
      return null;
    }
    const allowedEvidenceIds = canonicalEvidenceIds([
      ...projections.input.allowedEvidenceIds,
      ...(projections.context?.allowedEvidenceIds ?? []),
    ]);
    const allowed = new Set(allowedEvidenceIds);
    if (
      envelope.allowedEvidenceIdsHash !==
        (envelope.evidencePolicy === 'none' ? null : reasoningHash(allowedEvidenceIds)) ||
      (envelope.evidencePolicy === 'none'
        ? evidenceIds.length !== 0
        : evidenceIds.some((id) => !allowed.has(id)) ||
          (envelope.evidencePolicy === 'required' && evidenceIds.length === 0))
    ) {
      return null;
    }
    const parsedContext =
      projections.context === null
        ? null
        : parseModelContextProjection(projections.context.content);
    if (
      (projections.context !== null && parsedContext === null) ||
      (envelope.evidencePolicy === 'required' &&
        !this.satisfiesTaskEvidenceRule(envelope.taskKind, evidenceIds, projections.context))
    ) {
      return null;
    }
    const contract = getReasoningSchemaContract(envelope.taskKind);
    if (!validateReasoningResult(contract, stored.result).ok) return null;
    const resultEvidenceIds = this.resultEvidenceIds(stored.result);
    if (
      resultEvidenceIds !== null &&
      reasoningHash(resultEvidenceIds) !== reasoningHash(evidenceIds)
    ) {
      return null;
    }
    let guarded: ReasoningOutputGuardResult;
    try {
      guarded = (await this.options.outputGuard?.({
        taskKind: envelope.taskKind,
        input: projections.input.content,
        context: parsedContext,
        result: stored.result,
        evidenceIds,
      })) ?? {
        ok: true as const,
        result: stored.result,
      };
    } catch {
      return null;
    }
    if (!guarded.ok || !validateReasoningResult(contract, guarded.result).ok) return null;
    return {
      kind: 'ready',
      proposal: {
        task,
        envelope,
        input: projections.input.content,
        context: parsedContext,
        result: guarded.result,
        evidenceIds,
        backendPrincipalDid,
        ...(recoveredSessionId === null ? {} : { authenticatedSessionId: recoveredSessionId }),
      },
    };
  }

  private parseJson(value: string | undefined): unknown {
    if (value === undefined || value === '') return null;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }

  private validateCommitReceipt(receipt: ReasoningCommitReceipt): ReasoningCommitReceipt {
    if (receipt.state !== 'committed' && receipt.state !== 'pending_approval') {
      throw new Error('invalid reasoning commit state');
    }
    if (receipt.receipt === undefined) return { state: receipt.state };
    if (record(receipt.receipt) === null) {
      throw new Error('invalid reasoning commit receipt');
    }
    const resources = inspectJsonResources(receipt.receipt, {
      maxBytes: MAX_COMMIT_RECEIPT_BYTES,
      maxDepth: 6,
      maxProperties: 128,
    });
    if (!resources.ok) throw new Error('reasoning commit receipt exceeds limits');
    return {
      state: receipt.state,
      receipt: JSON.parse(JSON.stringify(receipt.receipt)) as Record<string, unknown>,
    };
  }

  private appendCommitReceipt(taskId: string, receipt: ReasoningCommitReceipt): void {
    this.options.workflowRepository.appendEvent({
      task_id: taskId,
      at: this.nowMs(),
      event_kind:
        receipt.state === 'committed'
          ? 'reasoning_commit_succeeded'
          : 'reasoning_commit_pending_approval',
      // Owner projections read these directly. Generic Brain delivery must not
      // receive duplicate internal commit lifecycle events.
      needs_delivery: false,
      delivery_attempts: 0,
      delivery_failed: false,
      details: JSON.stringify({
        state: receipt.state,
        ...(receipt.receipt === undefined ? {} : { receipt: receipt.receipt }),
      }),
    });
  }

  private requireActiveBinding(
    backendId: string,
    principalDid: string,
    nowMs: number,
  ): ReasoningBackendBinding {
    const binding = this.options.backendRepository.get(backendId);
    if (
      binding === null ||
      !isBackendActive(binding, nowMs) ||
      binding.principalDid !== principalDid
    ) {
      throw new ReasoningBrokerError('forbidden', 'reasoning backend is not active');
    }
    return binding;
  }

  private policySnapshotCurrent(envelope: ReasoningTaskEnvelopeV1): boolean {
    const { policySnapshotHash: _stored, ...withoutPolicy } = envelope;
    return (
      this.resolvePolicySnapshotHash({ envelope: withoutPolicy }) === envelope.policySnapshotHash
    );
  }

  private currentCompletionAuthority(
    input: CompleteReasoningJobInput,
    expectedEnvelope: ReasoningTaskEnvelopeV1,
  ):
    | {
        ok: true;
        task: WorkflowTask;
        ticket: ReasoningContextTicket;
        binding: ReasoningBackendBinding;
      }
    | {
        ok: false;
        code: 'ticket_invalid' | 'backend_unavailable' | 'stale_claim' | 'stale_policy';
        terminalize: boolean;
        task: WorkflowTask | null;
      } {
    const now = this.nowMs();
    const task = this.options.workflowRepository.getById(input.taskId);
    const ticket = this.options.contextRepository.getTicket(input.contextTicketId);
    if (ticket === null || !this.ticketMatchesLiveClaim(ticket, task, input, now)) {
      return { ok: false, code: 'ticket_invalid', terminalize: false, task };
    }
    const binding = this.options.backendRepository.get(input.backendId);
    if (
      binding === null ||
      !isBackendActive(binding, now) ||
      binding.principalDid !== input.principalDid ||
      binding.selectedByOwnerDid !== expectedEnvelope.ownerDid ||
      binding.policyVersion !== ticket.policyVersion
    ) {
      return { ok: false, code: 'backend_unavailable', terminalize: true, task };
    }
    if (task === null) {
      return { ok: false, code: 'stale_claim', terminalize: false, task };
    }
    const currentEnvelope = parseReasoningEnvelope(task.payload);
    if (
      currentEnvelope === null ||
      currentEnvelope.executionId !== expectedEnvelope.executionId ||
      currentEnvelope.policySnapshotHash !== expectedEnvelope.policySnapshotHash
    ) {
      return { ok: false, code: 'stale_claim', terminalize: false, task };
    }
    if (
      !this.policySnapshotCurrent(currentEnvelope) ||
      !this.sessionAuthorityActive(binding, ticket.authenticatedSessionId, currentEnvelope)
    ) {
      return { ok: false, code: 'stale_policy', terminalize: true, task };
    }
    return { ok: true, task, ticket, binding };
  }

  private sessionAuthorityActive(
    binding: ReasoningBackendBinding,
    authenticatedSessionId: string | null,
    envelope: ReasoningTaskEnvelopeV1,
  ): boolean {
    if (binding.kind !== 'connected_host') {
      return authenticatedSessionId === null;
    }
    if (authenticatedSessionId === null) return false;
    return (
      this.options.isAuthenticatedSessionActive?.({
        sessionId: authenticatedSessionId,
        principalDid: binding.principalDid,
        ownerDid: envelope.ownerDid,
        authorityOrigin: envelope.authorityOrigin,
      }) ?? false
    );
  }

  private activateSessionAuthority(
    binding: ReasoningBackendBinding,
    authenticatedSessionId: string | null,
    envelope: ReasoningTaskEnvelopeV1,
  ): boolean {
    if (binding.kind !== 'connected_host') {
      return authenticatedSessionId === null;
    }
    if (authenticatedSessionId === null) return false;
    const request = {
      sessionId: authenticatedSessionId,
      principalDid: binding.principalDid,
      ownerDid: envelope.ownerDid,
      authorityOrigin: envelope.authorityOrigin,
    };
    if (isOwnerAuthority(envelope.authorityOrigin)) {
      return this.options.isAuthenticatedSessionActive?.(request) ?? false;
    }
    try {
      return (
        this.options.activateAuthenticatedSessionAuthority?.(request) ??
        this.options.isAuthenticatedSessionActive?.(request) ??
        false
      );
    } catch {
      return false;
    }
  }

  private releaseSessionAuthority(
    binding: ReasoningBackendBinding,
    authenticatedSessionId: string | null,
    envelope: ReasoningTaskEnvelopeV1,
  ): void {
    if (
      binding.kind !== 'connected_host' ||
      authenticatedSessionId === null ||
      isOwnerAuthority(envelope.authorityOrigin)
    ) {
      return;
    }
    try {
      this.options.releaseAuthenticatedSessionAuthority?.({
        sessionId: authenticatedSessionId,
        principalDid: binding.principalDid,
        ownerDid: envelope.ownerDid,
        authorityOrigin: envelope.authorityOrigin,
      });
    } catch {
      // Releasing narrows authority. A persistence failure leaves the session
      // safely reserved and owner work blocked until retry/session expiry.
    }
  }

  private releaseSessionAuthorityForTicket(
    ticket: ReasoningContextTicket,
    envelope: ReasoningTaskEnvelopeV1,
  ): void {
    if (ticket.authenticatedSessionId === null || isOwnerAuthority(envelope.authorityOrigin)) {
      return;
    }
    try {
      this.options.releaseAuthenticatedSessionAuthority?.({
        sessionId: ticket.authenticatedSessionId,
        principalDid: ticket.principalDid,
        ownerDid: envelope.ownerDid,
        authorityOrigin: envelope.authorityOrigin,
      });
    } catch {
      // Fail safely reserved; see releaseSessionAuthority.
    }
  }

  private releaseSessionAuthoritiesForTask(
    task: WorkflowTask,
    exceptSessionId: string | null = null,
  ): void {
    const envelope = parseReasoningEnvelope(task.payload);
    if (envelope === null || isOwnerAuthority(envelope.authorityOrigin)) return;
    for (const ticket of this.options.contextRepository.listTicketsForTask(task.id)) {
      if (
        ticket.authenticatedSessionId !== null &&
        ticket.authenticatedSessionId !== exceptSessionId
      ) {
        this.releaseSessionAuthorityForTicket(ticket, envelope);
      }
    }
  }

  private loadLiveProjections(
    envelope: ReasoningTaskEnvelopeV1,
    task: WorkflowTask,
    nowMs: number,
    allowExpired = false,
  ): { input: ReasoningProjection; context: ReasoningProjection | null } | null {
    const input = this.options.contextRepository.getProjection(envelope.inputProjectionId);
    const context =
      envelope.contextProjectionId === null
        ? null
        : this.options.contextRepository.getProjection(envelope.contextProjectionId);
    if (
      input === null ||
      input.taskId !== task.id ||
      input.ownerDid !== envelope.ownerDid ||
      input.kind !== 'input' ||
      input.purpose !== envelope.purpose ||
      input.revokedAtMs !== null ||
      (!allowExpired && input.expiresAtMs <= nowMs) ||
      input.contentHash !== envelope.inputProjectionHash ||
      reasoningHash(input.content) !== envelope.inputProjectionHash ||
      (envelope.contextProjectionId !== null &&
        (context === null ||
          context.taskId !== task.id ||
          context.ownerDid !== envelope.ownerDid ||
          context.kind !== 'context' ||
          context.purpose !== envelope.purpose ||
          context.revokedAtMs !== null ||
          (!allowExpired && context.expiresAtMs <= nowMs) ||
          context.contentHash !== envelope.contextProjectionHash ||
          reasoningHash(context.content) !== envelope.contextProjectionHash))
    ) {
      return null;
    }
    return { input, context };
  }

  private ticketMatchesLiveClaim(
    ticket: ReasoningContextTicket,
    task: WorkflowTask | null,
    input: {
      taskId: string;
      claimId: string;
      contextTicketId: string;
      backendId: string;
      principalDid: string;
      authenticatedSessionId?: string;
    },
    nowMs: number,
  ): boolean {
    if (
      task === null ||
      task.kind !== 'reasoning' ||
      task.status !== WorkflowTaskState.Running ||
      task.claim_id !== input.claimId ||
      task.agent_did !== input.principalDid ||
      task.assigned_runner !== reasoningRunner(input.backendId) ||
      task.lease_expires_at === undefined ||
      task.lease_expires_at <= nowMs ||
      ticket.ticketId !== input.contextTicketId ||
      ticket.taskId !== input.taskId ||
      ticket.claimId !== input.claimId ||
      ticket.backendId !== input.backendId ||
      ticket.principalDid !== input.principalDid ||
      (ticket.authenticatedSessionId ?? undefined) !== input.authenticatedSessionId ||
      ticket.consumedAtMs !== null ||
      ticket.revokedAtMs !== null ||
      ticket.expiresAtMs <= nowMs
    ) {
      return false;
    }
    const envelope = parseReasoningEnvelope(task.payload);
    return (
      envelope !== null &&
      ticket.ownerDid === envelope.ownerDid &&
      ticket.purpose === envelope.purpose &&
      ticket.inputProjectionId === envelope.inputProjectionId &&
      ticket.contextProjectionId === envelope.contextProjectionId
    );
  }

  private failClaim(task: WorkflowTask, principalDid: string, reason: string, nowMs: number): void {
    if (task.claim_id === undefined) return;
    try {
      this.options.workflowService.fail(task.id, reason, principalDid, task.claim_id);
    } catch {
      // A concurrent cancellation/reclaim already removed this claim.
    }
    this.releaseSessionAuthoritiesForTask(task);
    this.options.contextRepository.revokeTicketsForTask(task.id, undefined, nowMs);
    this.options.contextRepository.revokeProjectionsForTask(task.id, nowMs);
  }

  private rejectedCompletion(
    code: Exclude<ReasoningCompletion['code'], 'completed'>,
  ): ReasoningCompletion {
    return {
      accepted: false,
      state: 'rejected',
      code,
      committed: false,
    };
  }

  private resultEvidenceIds(result: unknown): string[] | null {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
    const raw = (result as Record<string, unknown>).evidenceIds;
    if (raw === undefined) return null;
    if (!Array.isArray(raw)) return [];
    try {
      return canonicalEvidenceIds(
        raw.filter((value): value is string => typeof value === 'string'),
      );
    } catch {
      return [];
    }
  }

  private satisfiesTaskEvidenceRule(
    taskKind: ReasoningTaskKind,
    evidenceIds: readonly string[],
    context: ReasoningProjection | null,
  ): boolean {
    if (taskKind !== 'review.summarize') return evidenceIds.length > 0;
    if (context === null) return false;
    const projection = parseModelContextProjection(context.content);
    if (projection === null) return false;
    const reviewIds = new Set(
      projection.items.filter((item) => item.sourceType === 'review').map((item) => item.sourceId),
    );
    return evidenceIds.some((id) => reviewIds.has(id));
  }

  private countStateForOwner(ownerDid: string, state: WorkflowTaskState): number {
    const limit = Math.max(
      MAX_ACTIVE_REASONING_JOBS_PER_OWNER + 1,
      this.options.workflowRepository.size() + 1,
    );
    return this.options.workflowRepository
      .listByKindAndState('reasoning', state, limit)
      .filter((task) => isReasoningTaskForOwner(task, ownerDid)).length;
  }

  private countActiveForOwner(ownerDid: string): number {
    return (
      this.countStateForOwner(ownerDid, WorkflowTaskState.Queued) +
      this.countStateForOwner(ownerDid, WorkflowTaskState.Running) +
      this.countStateForOwner(ownerDid, WorkflowTaskState.Pending) +
      this.countStateForOwner(ownerDid, WorkflowTaskState.Awaiting)
    );
  }
}

let broker: CoreReasoningBroker | null = null;

export function setReasoningBroker(next: CoreReasoningBroker | null): void {
  broker = next;
}

export function getReasoningBroker(): CoreReasoningBroker | null {
  return broker;
}
