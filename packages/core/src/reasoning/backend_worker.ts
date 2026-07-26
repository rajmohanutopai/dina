/**
 * Runtime-neutral worker for an owner-authorized reasoning backend.
 *
 * Platform adapters supply only the model-specific `execute` function. This
 * class owns the shared claim/complete/fail choreography so internal Brain,
 * local models, remote providers, and test backends cannot drift on lease
 * fencing, context tickets, evidence, or retry behavior.
 */

import { CoreHttpError } from '../client/http-transport';

import {
  CoreReasoningBroker,
  type ClaimReasoningJobInput,
  type CompleteReasoningJobInput,
  type FailReasoningJobInput,
  type HeartbeatReasoningJobInput,
  type ReasoningCompletion,
  type ReasoningFailure,
} from './broker';

import type { ReasoningClaim } from './domain';
import type { CoreClient } from '../client/core-client';

const MAX_ERROR_LENGTH = 2_048;
const DEFAULT_LEASE_MS = 60_000;
const MIN_HEARTBEAT_INTERVAL_MS = 1_000;

export interface ReasoningExecutionProposal {
  result: unknown;
  evidenceIds?: string[];
}

export type ReasoningBackendExecutor = (
  claim: ReasoningClaim,
  context?: { signal: AbortSignal },
) => Promise<ReasoningExecutionProposal>;

/**
 * The worker's authority port. A mobile process adapts its local broker while
 * split Home Node Brain adapts a signed `CoreClient`; execution logic is shared.
 */
export interface ReasoningBackendAuthority {
  claim(input: ClaimReasoningJobInput): Promise<ReasoningClaim | null>;
  heartbeat(input: HeartbeatReasoningJobInput): Promise<boolean>;
  complete(input: CompleteReasoningJobInput): Promise<ReasoningCompletion>;
  fail(input: FailReasoningJobInput): Promise<ReasoningFailure>;
}

export interface ReasoningBackendWorkerOptions {
  /** Direct authority for mobile/tests. Mutually exclusive with `authority`. */
  broker?: CoreReasoningBroker;
  /** Transport-neutral authority for split-process workers. */
  authority?: ReasoningBackendAuthority;
  backendId: string;
  principalDid: string;
  execute: ReasoningBackendExecutor;
  leaseMs?: number;
  heartbeatIntervalMs?: number;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  classifyError?: (error: unknown) => { message: string; retryable: boolean };
}

export type ReasoningWorkerResult =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'lost'; taskId: string }
  | { state: 'outcome_unknown'; taskId: string; error: string }
  | { state: 'completed'; taskId: string; completion: ReasoningCompletion }
  | { state: 'failed'; taskId: string; failure: ReasoningFailure };

function defaultClassifyError(error: unknown): { message: string; retryable: boolean } {
  const message = error instanceof Error ? error.message : 'reasoning backend failed';
  // Unknown adapter errors do not retry automatically. An adapter that knows a
  // timeout/rate-limit is transient must classify it explicitly.
  return { message: message.slice(0, MAX_ERROR_LENGTH), retryable: false };
}

export function createBrokerReasoningAuthority(
  broker: CoreReasoningBroker,
): ReasoningBackendAuthority {
  return {
    claim: async (input) => broker.claim(input),
    heartbeat: async (input) => broker.heartbeat(input),
    complete: async (input) => broker.complete(input),
    fail: async (input) => broker.fail(input),
  };
}

/**
 * Bind the worker port to a signed/in-process CoreClient. Principal identity is
 * transport-authenticated, never copied into the request body.
 */
export function createCoreClientReasoningAuthority(
  client: CoreClient,
  options: { sessionId?: string } = {},
): ReasoningBackendAuthority {
  const session = options.sessionId === undefined ? {} : { sessionId: options.sessionId };
  return {
    claim: async (input) => {
      if (input.taskId !== undefined) {
        throw new Error('exact-task reasoning claims are Core-internal only');
      }
      try {
        return await client.reasoningClaim({
          backendId: input.backendId,
          ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
          ...session,
        });
      } catch (error) {
        // A disabled/revoked backend is intentionally indistinguishable from a
        // missing one. Treat it as no eligible work so an explicitly disabled
        // built-in worker remains quiet without being revived.
        if (
          error instanceof CoreHttpError &&
          error.status === 404 &&
          error.message.includes('reasoning_backend_unavailable')
        ) {
          return null;
        }
        throw error;
      }
    },
    heartbeat: async (input) =>
      client.reasoningHeartbeat(input.taskId, {
        backendId: input.backendId,
        claimId: input.claimId,
        contextTicketId: input.contextTicketId,
        ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
        ...session,
      }),
    complete: async (input) =>
      client.reasoningComplete(input.taskId, {
        backendId: input.backendId,
        claimId: input.claimId,
        contextTicketId: input.contextTicketId,
        executionId: input.executionId,
        contextProjectionHash: input.contextProjectionHash,
        policySnapshotHash: input.policySnapshotHash,
        result: input.result,
        ...(input.evidenceIds === undefined ? {} : { evidenceIds: input.evidenceIds }),
        ...session,
      }),
    fail: async (input) =>
      client.reasoningFail(input.taskId, {
        backendId: input.backendId,
        claimId: input.claimId,
        contextTicketId: input.contextTicketId,
        error: input.error,
        retryable: input.retryable,
        ...session,
      }),
  };
}

export class ReasoningBackendWorker {
  private running = false;
  private readonly authority: ReasoningBackendAuthority;

  constructor(private readonly options: ReasoningBackendWorkerOptions) {
    if (options.backendId.trim() === '' || options.principalDid.trim() === '') {
      throw new Error('reasoning worker requires backend identity');
    }
    if ((options.broker === undefined) === (options.authority === undefined)) {
      throw new Error('reasoning worker requires exactly one authority');
    }
    if (options.authority !== undefined) {
      this.authority = options.authority;
    } else if (options.broker !== undefined) {
      this.authority = createBrokerReasoningAuthority(options.broker);
    } else {
      throw new Error('reasoning worker authority is unavailable');
    }
  }

  /**
   * Claim and process at most one job.
   *
   * `taskId` is an in-process exact-task hint. Public transports do not expose
   * it; they continue using the broker's policy-filtered next-job claim.
   */
  async runOne(taskId?: string): Promise<ReasoningWorkerResult> {
    if (this.running) return { state: 'busy' };
    this.running = true;
    try {
      const claim = await this.authority.claim({
        backendId: this.options.backendId,
        principalDid: this.options.principalDid,
        ...(this.options.leaseMs === undefined ? {} : { leaseMs: this.options.leaseMs }),
        ...(taskId === undefined ? {} : { taskId }),
      });
      if (claim === null) return { state: 'idle' };

      const abort = new AbortController();
      let lostClaim = false;
      let heartbeatRunning = false;
      const leaseMs = this.options.leaseMs ?? DEFAULT_LEASE_MS;
      const heartbeatIntervalMs =
        this.options.heartbeatIntervalMs ??
        Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.floor(leaseMs / 3));
      const setTimer =
        this.options.setInterval ??
        ((callback: () => void, ms: number): unknown => setInterval(callback, ms));
      const clearTimer =
        this.options.clearInterval ??
        ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>));
      const heartbeat = async (): Promise<void> => {
        if (heartbeatRunning || lostClaim) return;
        heartbeatRunning = true;
        try {
          const live = await this.authority.heartbeat({
            taskId: claim.taskId,
            claimId: claim.claimId,
            contextTicketId: claim.contextTicketId,
            backendId: this.options.backendId,
            principalDid: this.options.principalDid,
            leaseMs,
          });
          if (!live) {
            lostClaim = true;
            abort.abort(new Error('reasoning claim lease lost'));
          }
        } catch {
          // A transport error does not prove the lease was lost. Core's exact
          // claim fence still rejects a stale completion; retry next interval.
        } finally {
          heartbeatRunning = false;
        }
      };
      const heartbeatHandle = setTimer(() => {
        void heartbeat();
      }, heartbeatIntervalMs);

      let proposal: ReasoningExecutionProposal;
      try {
        proposal = await this.options.execute(claim, { signal: abort.signal });
      } catch (error) {
        clearTimer(heartbeatHandle);
        if (lostClaim) return { state: 'lost', taskId: claim.taskId };
        const classified = (this.options.classifyError ?? defaultClassifyError)(error);
        const failure = await this.authority.fail({
          taskId: claim.taskId,
          claimId: claim.claimId,
          contextTicketId: claim.contextTicketId,
          backendId: this.options.backendId,
          principalDid: this.options.principalDid,
          error: classified.message.slice(0, MAX_ERROR_LENGTH),
          retryable: classified.retryable,
        });
        return { state: 'failed', taskId: claim.taskId, failure };
      }

      clearTimer(heartbeatHandle);
      if (lostClaim) return { state: 'lost', taskId: claim.taskId };

      try {
        const completion = await this.authority.complete({
          taskId: claim.taskId,
          claimId: claim.claimId,
          contextTicketId: claim.contextTicketId,
          backendId: this.options.backendId,
          principalDid: this.options.principalDid,
          executionId: claim.executionId,
          contextProjectionHash: claim.contextProjectionHash,
          policySnapshotHash: claim.policySnapshotHash,
          result: proposal.result,
          ...(proposal.evidenceIds === undefined ? {} : { evidenceIds: proposal.evidenceIds }),
        });
        if (!completion.accepted) return { state: 'lost', taskId: claim.taskId };
        return { state: 'completed', taskId: claim.taskId, completion };
      } catch (error) {
        // Core may have accepted and committed before the response was lost.
        // Requeueing here would make an unknown outcome look like a safe retry.
        const classified = defaultClassifyError(error);
        return {
          state: 'outcome_unknown',
          taskId: claim.taskId,
          error: classified.message,
        };
      }
    } finally {
      this.running = false;
    }
  }
}
