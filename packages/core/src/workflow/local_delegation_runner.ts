/**
 * Local delegation runner — the in-process execution plane.
 *
 * Two production roles:
 *   1. **Tier 1 prompt-provider lane** (docs/SERVICE_PROVIDER_TIERS.md):
 *      capabilities with no MCP/agent binding route their tasks to the
 *      reserved `dina.local` runner, and THIS runner claims that lane —
 *      the provider's own Dina answers from instruction + vault. This is
 *      the default `runnerFilter`.
 *   2. Demos / single-process tests (`runnerFilter: ''` claims any lane).
 *
 * Agent-bound capabilities still follow the external topology: tasks sit
 * in the workflow store until a paired `dina-agent` claims them via
 * `POST /v1/workflow/tasks/claim` with its own runner_filter.
 *
 * The loop: claim → invoke the caller-supplied
 * `runCapability(capability, params, task) => Promise<result>` →
 * heartbeat while it runs → complete / fail the task at the end.
 *
 * Design contract:
 *   - One runner == one agent DID. Each runner claims for itself only.
 *   - Heartbeats fire on a fraction of the lease (default every 10 s).
 *   - Completions go through `WorkflowService.complete` so the Response
 *     Bridge fires and the requester actually receives a service.response
 *     (issue #6). The runner DOES NOT call repository methods directly.
 *   - Capability errors go through `WorkflowService.fail` which now
 *     ALSO fires the bridge with an `{status:'error', error}` envelope
 *     (issue #7) — the requester gets a real signal, not a TTL wait.
 *   - Runner only claims delegations whose payload is tagged
 *     `service_query_execution` (issue #14). Other delegation kinds
 *     are released back so another specialized runner can pick them up.
 *   - Start/stop are idempotent. `runTick()` runs a single claim
 *     attempt for deterministic tests.
 */

import { LOCAL_RUNNER_NAME } from '@dina/protocol';

import type { WorkflowTask } from './domain';
import type { WorkflowRepository } from './repository';
import type { WorkflowService } from './service';

/**
 * Caller-supplied capability handler. Receives the parsed payload's
 * capability + params and returns the result to attach to the
 * workflow task. Throwing marks the task failed.
 */
export type LocalCapabilityRunner = (
  capability: string,
  params: unknown,
  task: WorkflowTask,
) => Promise<unknown>;

export interface LocalDelegationRunnerOptions {
  repository: WorkflowRepository;
  /**
   * Workflow service — completions + failures go through this so the
   * Response Bridge fires the service.response D2D back to the
   * requester. The repo alone is not enough (issue #6).
   */
  workflowService: WorkflowService;
  /** DID this runner claims under — stamped on claimed tasks. */
  agentDID: string;
  /** Capability dispatcher. */
  runner: LocalCapabilityRunner;
  /**
   * Which `requested_runner` lane to claim. Defaults to the reserved
   * `dina.local` (Tier 1 prompt-provider tasks — the lane external agent
   * daemons can never claim). The reserved lane is EXACT-match: untagged
   * delegations (e.g. delegate_to_agent free_form_task) belong to the
   * paired external agent, never to this runner. Pass `''` to claim ANY
   * lane (single-process test/demo nodes where this is the sole
   * executor) — but never run that alongside external per-capability
   * daemons: being unfiltered it would race them for routed tasks.
   */
  runnerFilter?: string;
  /** How often to poll for new claims. Default 5_000 ms. */
  pollIntervalMs?: number;
  /** Initial lease length (ms). Default 30_000. */
  leaseMs?: number;
  /** How often to heartbeat during a long-running capability. Default 10_000 ms. */
  heartbeatIntervalMs?: number;
  /** Wall-clock source. Default `Date.now`. */
  nowMsFn?: () => number;
  /** Injectable timer pair. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  /** Observability hooks. */
  onClaimed?: (task: WorkflowTask) => void;
  onCompleted?: (task: WorkflowTask, result: unknown) => void;
  onFailed?: (task: WorkflowTask, err: unknown) => void;
  onError?: (err: unknown) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

export class LocalDelegationRunner {
  private readonly repo: WorkflowRepository;
  private readonly service: WorkflowService;
  private readonly agentDID: string;
  private readonly runCapability: LocalCapabilityRunner;
  private readonly runnerFilter: string;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly nowMsFn: () => number;
  private readonly setIntervalFn: NonNullable<LocalDelegationRunnerOptions['setInterval']>;
  private readonly clearIntervalFn: NonNullable<LocalDelegationRunnerOptions['clearInterval']>;
  private readonly onClaimed: (t: WorkflowTask) => void;
  private readonly onCompleted: (t: WorkflowTask, r: unknown) => void;
  private readonly onFailed: (t: WorkflowTask, e: unknown) => void;
  private readonly onError: (e: unknown) => void;

  private handle: unknown | null = null;
  private tickInFlight: Promise<void> | null = null;
  private busy = false;

  constructor(options: LocalDelegationRunnerOptions) {
    if (!options.repository) throw new Error('LocalDelegationRunner: repository is required');
    if (!options.workflowService)
      throw new Error('LocalDelegationRunner: workflowService is required');
    if (!options.agentDID) throw new Error('LocalDelegationRunner: agentDID is required');
    if (!options.runner) throw new Error('LocalDelegationRunner: runner is required');
    this.repo = options.repository;
    this.service = options.workflowService;
    this.agentDID = options.agentDID;
    this.runCapability = options.runner;
    this.runnerFilter = options.runnerFilter ?? LOCAL_RUNNER_NAME;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.nowMsFn = options.nowMsFn ?? Date.now;
    this.setIntervalFn = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn =
      options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.onClaimed =
      options.onClaimed ??
      (() => {
        /* silent */
      });
    this.onCompleted =
      options.onCompleted ??
      (() => {
        /* silent */
      });
    this.onFailed =
      options.onFailed ??
      (() => {
        /* silent */
      });
    this.onError =
      options.onError ??
      (() => {
        /* silent */
      });
  }

  start(): void {
    if (this.handle !== null) return;
    // Immediate tick — demo/test nodes shouldn't wait a full poll cycle
    // for the first claim.
    this.tickInFlight = this.runTick();
    this.handle = this.setIntervalFn(() => {
      // While an execution is in flight, runTick() is a busy no-op
      // promise — do NOT let it overwrite tickInFlight, or flush()
      // awaits the no-op and returns while the real LLM run and its
      // completion write are still pending.
      if (this.busy) return;
      this.tickInFlight = this.runTick();
    }, this.pollIntervalMs);
    const maybe = this.handle as { unref?: () => void };
    if (typeof maybe.unref === 'function') maybe.unref();
  }

  stop(): void {
    if (this.handle === null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  /** Wait for the in-flight tick to finish (tests + shutdown). */
  async flush(): Promise<void> {
    while (this.tickInFlight !== null) {
      const current = this.tickInFlight;
      try {
        await current;
      } catch {
        /* surfaced via onError */
      }
      if (this.tickInFlight === current) {
        this.tickInFlight = null;
        return;
      }
    }
  }

  /** Run a single claim attempt. Exposed for deterministic tests. */
  async runTick(): Promise<void> {
    if (this.busy) return; // don't overlap
    this.busy = true;
    try {
      const nowMs = this.nowMsFn();
      let task: WorkflowTask | null;
      try {
        // Default claim lane is the reserved `dina.local` (Tier 1
        // prompt-provider tasks — docs/SERVICE_PROVIDER_TIERS.md),
        // matched EXACTLY: untagged delegations belong to the paired
        // external agent. Single-process test/demo nodes that need to
        // claim EVERY lane pass `runnerFilter: ''` — but never alongside
        // external per-capability daemons (an unfiltered claim would
        // race them for routed tasks; the external-daemon claim path
        // always passes its own filter).
        task = this.repo.claimDelegationTask(
          this.agentDID,
          nowMs,
          this.leaseMs,
          this.runnerFilter,
        );
      } catch (err) {
        this.onError(err);
        return;
      }
      if (task === null) return;

      const payload = this.parsePayload(task);
      // Issue #14: only claim service_query_execution delegations.
      // Anything else we fail so the sweeper + downstream consumers
      // know this runner can't handle it. Non-matching payloads get a
      // descriptive failure so operators can diagnose cross-feature
      // conflicts.
      if (payload === null) {
        // Malformed payload — route through service.fail so the
        // Response Bridge still emits an error envelope for any
        // service_query_execution caller waiting on this task.
        const err = new Error(`malformed payload for task ${task.id}`);
        this.safeFail(task, err);
        this.onFailed(task, err);
        return;
      }
      if (payload.type !== 'service_query_execution') {
        const err = new Error(
          `task ${task.id} payload.type=${payload.type ?? '(missing)'}: runner only handles service_query_execution`,
        );
        this.safeFail(task, err);
        this.onFailed(task, err);
        return;
      }

      this.onClaimed(task);

      // Lease fence: when a heartbeat write fails (returns false), the
      // lease-expiry sweeper has re-queued the task and another claim
      // may already be executing it. Writing OUR result after that
      // would race the rightful executor — discard it instead (the
      // re-queued task re-runs cleanly) and say so via onError.
      const claimedId = task.id;
      let leaseLost = false;
      const hbHandle = this.setIntervalFn(() => {
        try {
          const ok = this.repo.heartbeatTask(claimedId, this.agentDID, this.nowMsFn(), this.leaseMs);
          if (!ok && !leaseLost) {
            leaseLost = true;
            this.onError(
              new Error(
                `lease lost for task ${claimedId} (heartbeat rejected) — result will be discarded; the re-queued task re-runs`,
              ),
            );
          }
        } catch (e) {
          this.onError(e);
        }
      }, this.heartbeatIntervalMs);

      try {
        const result = await this.runCapability(payload.capability, payload.params, task);
        this.clearIntervalFn(hbHandle);
        if (leaseLost) return; // fenced — see above
        // safeComplete is responsible for both serialization failure
        // (issue #15) and status derivation (issue #16).
        const completed = this.safeComplete(task, result);
        if (completed) {
          this.onCompleted(task, result);
        }
      } catch (err) {
        this.clearIntervalFn(hbHandle);
        if (leaseLost) return; // fenced — don't fail a task we no longer own
        this.safeFail(task, err);
        this.onFailed(task, err);
      }
    } finally {
      this.busy = false;
    }
  }

  private parsePayload(task: WorkflowTask): {
    type?: string;
    capability: string;
    params: unknown;
  } | null {
    try {
      const p = JSON.parse(task.payload) as {
        type?: unknown;
        capability?: unknown;
        params?: unknown;
      };
      if (typeof p.capability !== 'string' || p.capability === '') return null;
      return {
        type: typeof p.type === 'string' ? p.type : undefined,
        capability: p.capability,
        params: p.params,
      };
    } catch {
      return null;
    }
  }

  /**
   * Complete a task through `WorkflowService` so the Response Bridge
   * fires (issue #6). Returns `true` on success, `false` when
   * something went sideways (serialization failure, tx failure) and
   * the caller should NOT treat it as a successful completion. Issues
   * #15 + #16 handled here: serialize-then-complete is atomic, and
   * event details carry a derived status instead of hardcoded success.
   */
  private safeComplete(task: WorkflowTask, result: unknown): boolean {
    let resultJSON: string;
    try {
      resultJSON = JSON.stringify(result ?? null);
    } catch (err) {
      // Result wasn't JSON-serializable (circular ref, BigInt, etc.).
      // Don't leave the task running — route through fail so the bridge
      // still gets a chance to notify the requester. Issue #15.
      this.safeFail(task, err);
      this.onFailed(task, err);
      return false;
    }

    try {
      this.service.complete(task.id, resultJSON, this.deriveResultSummary(result), this.agentDID);
      return true;
    } catch (err) {
      // Completion itself failed (e.g. task already terminal). The
      // bridge didn't fire; try to fail the task as a fallback — at
      // worst the fail() also no-ops on terminal state.
      this.onError(err);
      this.safeFail(task, err);
      return false;
    }
  }

  private safeFail(task: WorkflowTask, err: unknown): void {
    try {
      const msg = err instanceof Error ? err.message : String(err);
      this.service.fail(task.id, msg, this.agentDID);
    } catch (e) {
      // fail() throws when the task is already terminal. That's OK —
      // there's nothing else to do.
      this.onError(e);
    }
  }

  /**
   * Short result summary for operator dashboards. Mirrors the
   * hand-written server-side summary shape ("responded" / "recovered"
   * / "local_runner"). When the capability tagged its result with a
   * non-success status, surface that in the summary.
   */
  private deriveResultSummary(result: unknown): string {
    if (result !== null && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      if (typeof r.status === 'string' && r.status !== 'success') {
        return `local_runner:${r.status}`;
      }
    }
    return 'local_runner';
  }
}
