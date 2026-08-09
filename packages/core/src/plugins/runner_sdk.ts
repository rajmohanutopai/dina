/**
 * Plugin runner SDK (§6, §8.1, §8.2) — the supported way a runner-mode plugin
 * claims work and answers it.
 *
 * WHY THIS EXISTS. Every piece a runner needs already existed and none of them
 * were assembled: `claimPluginTask` hands back a raw `WorkflowTask`, the
 * envelope is a JSON string on it, the pinned schemas live inside that
 * envelope, and `WorkflowService.complete` takes a `resultJSON` string it does
 * not check. A runner author was therefore expected to parse the payload, find
 * the right half of the schema snapshot, validate against it, re-serialise,
 * and remember the claim id — correctly, on the first try, outside the trust
 * boundary. Every one of those steps is a place to be subtly wrong, and being
 * wrong there means a malformed answer reaching a buyer under this supplier's
 * name.
 *
 * WHAT THIS IS NOT. It is not a security boundary and must never be read as
 * one. A runner is out-of-process, holds its own key, and can call
 * `WorkflowService` directly; Core re-validates everything at the bridge
 * regardless (§11.2a step 4). This SDK exists so the CORRECT path is the easy
 * one, and so a runner learns about its own mistake at the point it makes it
 * rather than as a rejection the buyer sees. The checks here are duplicated
 * inside the trust boundary on purpose — that is the difference between a
 * convenience and a guarantee, and only the inner copy is the guarantee.
 *
 * THE ONE RULE IT ENFORCES LOCALLY: a runner may not answer with a shape its
 * OWN manifest does not declare. The envelope pins the schema at dispatch, so
 * an update that lands mid-flight cannot retroactively widen or narrow what a
 * claimed task may return (§9.13).
 */

import { parsePluginEnvelope } from '../workflow/plugin_envelope';

import { claimPluginTask } from './claim_guard';
import { validateAgainstSchema } from './schema_validate';

import type { PluginInstall } from './registry';
import type { PluginTaskEnvelope } from '../workflow/plugin_envelope';
import type { WorkflowRepository } from '../workflow/repository';
import type { WorkflowService } from '../workflow/service';

/** A claimed unit of work, already parsed and schema-checked. */
export interface RunnerJob {
  taskId: string;
  /** Required by `complete`/`fail`: the §9.1 CAS token for this claim. */
  claimId: string;
  capabilityId: string;
  /** Validated against the PINNED params schema before the runner sees it. */
  params: unknown;
  context: unknown;
  /** Stable across lease-recovery retries — the logical execution. */
  executionId: string;
  /** The provider dedup key: the same external effect must reuse it. */
  idempotencyKey: string;
  manifestCid: string;
  /** Present only for work that arrived as an inbound D2D service query. */
  ingress?: {
    fromDid: string;
    queryId: string;
    capability: string;
  };
  /**
   * The pinned RESULT schema this job's answer must satisfy — the envelope's
   * `schema_snapshot`, which is the capability's `result_schema` and nothing
   * else. Named `resultSchema` here so no caller can repeat the mistake of
   * reading a `.params` half off it.
   */
  resultSchema: unknown;
}

export type RunnerClaim =
  | { kind: 'job'; job: RunnerJob; terminalized: string[] }
  /**
   * Nothing claimable on this lane right now.
   *
   * `terminalized` is NOT noise and is deliberately not folded into "idle":
   * the claim guard KILLS tasks that fail its six checks, and a runner whose
   * lane is quiet because its work is being rejected looks exactly like one
   * with nothing to do. Reporting the ids is the difference between
   * diagnosing a consent mismatch in a minute and staring at an empty queue.
   */
  | { kind: 'idle'; terminalized: string[] }
  /**
   * A task was claimed and could not be turned into a job — the envelope did
   * not parse, or its params contradict the schema the envelope itself pins.
   *
   * Surfaced rather than thrown, and NOT retried: the same bytes will fail the
   * same way for ever, so a retry loop would spin. The task is failed so it
   * leaves the queue with a reason attached instead of holding a lease until
   * it expires and comes back.
   */
  | { kind: 'unprocessable'; taskId: string; reason: string; terminalized: string[] };

export type RunnerAnswer =
  | { kind: 'result'; result: unknown; summary?: string }
  | { kind: 'failed'; reason: string }
  /**
   * §12.7 — the runner cannot say whether the external effect happened. A
   * socket can die after the bytes left, and guessing either way is worse than
   * saying so: `failed` invites a retry that could double-charge, `result`
   * asserts an outcome nobody observed.
   */
  | { kind: 'outcome_unknown'; reason: string };

export interface RunnerSdkOptions {
  workflow: WorkflowService;
  repo: WorkflowRepository;
  /** Resolved per call, because an install can be paused or revoked between them. */
  install: () => PluginInstall | null;
  /** This runner's paired device DID. The lane binding is checked against it. */
  deviceDid: string;
  nowMs: () => number;
  /** How long a claim is held before the lease sweeper reclaims it. */
  leaseMs?: number;
}

const DEFAULT_LEASE_MS = 60_000;

export class PluginRunner {
  private readonly opts: RunnerSdkOptions;

  constructor(options: RunnerSdkOptions) {
    this.opts = options;
  }

  /**
   * Claim the next task on this install's lane.
   *
   * The lane is derived from the install id inside `claimPluginTask` and can
   * never be supplied by the caller — a runner cannot ask for another
   * plugin's work, which is why this method takes no lane argument.
   */
  claim(): RunnerClaim {
    const install = this.opts.install();
    // Paused, revoked, or not installed. Indistinguishable from idle ON
    // PURPOSE: a runner learns its install state from the owner surface, not
    // by inferring it from the shape of a queue response.
    if (install === null) return { kind: 'idle', terminalized: [] };

    const claimed = claimPluginTask({
      repo: this.opts.repo,
      install,
      deviceDid: this.opts.deviceDid,
      nowMs: this.opts.nowMs(),
      leaseMs: this.opts.leaseMs ?? DEFAULT_LEASE_MS,
    });
    const terminalized = claimed.terminalized;
    const task = claimed.task;
    if (task === null) return { kind: 'idle', terminalized };

    const claimId = task.claim_id ?? '';
    if (claimId === '') {
      // A claimed task with no claim id cannot be completed under the §9.1
      // CAS, so it can only ever expire. Failing it now converts a silent
      // stall into a visible one.
      return this.unprocessable(task.id, '', 'claimed task carries no claim id', terminalized);
    }

    // UNREACHABLE in practice, and kept because `parsePluginEnvelope` returns
    // `| null` and a total function is the only honest way to consume that.
    // The claim guard parses the payload with THIS SAME function and
    // terminalizes a malformed one before it is ever handed over, so the two
    // cannot disagree. Left as a refusal rather than a `throw` so that if the
    // guard's parse is ever relaxed, the runner reports instead of crashing.
    const envelope = parsePluginEnvelope(task.payload);
    if (envelope === null) {
      return this.unprocessable(
        task.id,
        claimId,
        'task payload is not a plugin envelope',
        terminalized,
      );
    }

    // NO PARAMS RE-VALIDATION HERE, deliberately.
    //
    // The first version of this file validated params against
    // `schema_snapshot.params`. That field does not exist: the envelope's
    // `schema_snapshot` IS the capability's RESULT schema, and the claim
    // guard enforces exactly that (`canonicalJson(schema_snapshot) ===
    // canonicalJson(cap.result_schema)`). So the check read `undefined`,
    // skipped itself, and looked like a guard while being nothing — the
    // precise failure this SDK exists to spare a runner author, made while
    // writing the SDK. The real claim guard is what caught it.
    //
    // Params are already checked TWICE inside the trust boundary before a
    // runner sees them: `buildPluginEnvelope` validates at enqueue, and claim
    // check 3g re-validates against the CONSENTED `params_schema` so a
    // producer that skipped the first cannot dispatch off-contract params. A
    // third copy out here would add no safety and one more place to drift.

    const ingress = envelope.service_ingress;
    return {
      kind: 'job',
      terminalized,
      job: {
        taskId: task.id,
        claimId,
        capabilityId: envelope.capability_id,
        params: envelope.params,
        context: envelope.context,
        executionId: envelope.execution_id,
        idempotencyKey: envelope.idempotency_key,
        manifestCid: envelope.manifest_cid,
        ...(ingress === undefined
          ? {}
          : {
              ingress: {
                fromDid: ingress.from_did,
                queryId: ingress.query_id,
                capability: ingress.capability,
              },
            }),
        resultSchema: envelope.schema_snapshot,
      },
    };
  }

  /**
   * Answer a claimed job.
   *
   * A `result` is validated against the job's PINNED result schema first and
   * REFUSED locally if it does not fit. That refusal is the whole point of the
   * method: without it the runner discovers its mistake as a rejection at
   * Core's bridge, by which time the buyer has been waiting and the log entry
   * blames the wrong side.
   */
  answer(job: RunnerJob, answer: RunnerAnswer): { ok: true } | { ok: false; error: string } {
    if (answer.kind === 'result') {
      if (job.resultSchema !== undefined) {
        const verdict = validateAgainstSchema(answer.result, job.resultSchema);
        if (!verdict.ok) {
          // NOT completed and NOT failed. The job keeps its lease, so a runner
          // that can produce a conforming answer still may. Failing here would
          // spend the buyer's only attempt on a bug the runner can fix in the
          // next line of its own code.
          return {
            ok: false,
            error: `result violates the pinned schema: ${verdict.error ?? 'shape mismatch'}`,
          };
        }
      }
      try {
        this.opts.workflow.complete(
          job.taskId,
          JSON.stringify(answer.result),
          answer.summary ?? `${job.capabilityId} completed`,
          this.opts.deviceDid,
          job.claimId,
        );
        return { ok: true };
      } catch (err) {
        // A lost CAS is the ordinary case here, not corruption: the lease
        // expired and another claim owns the task. The runner must not retry
        // the effect on the strength of this answer.
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // `failed` and `outcome_unknown` are DIFFERENT terminal answers and the
    // difference is the whole of §12.7. Core reads the reason prefix to keep
    // them apart, so the SDK must not collapse them into one call.
    try {
      this.opts.workflow.fail(
        job.taskId,
        answer.kind === 'outcome_unknown' ? `outcome_unknown: ${answer.reason}` : answer.reason,
        this.opts.deviceDid,
        job.claimId,
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Fail a task that can never be processed, so it leaves the queue. */
  private unprocessable(
    taskId: string,
    claimId: string,
    reason: string,
    terminalized: string[],
  ): RunnerClaim {
    try {
      this.opts.workflow.fail(
        taskId,
        `unprocessable: ${reason}`,
        this.opts.deviceDid,
        claimId === '' ? undefined : claimId,
      );
    } catch {
      // Already terminal, or the CAS was lost. Either way the task is no
      // longer this runner's problem and the caller still gets the reason.
    }
    return { kind: 'unprocessable', taskId, reason, terminalized };
  }
}

export type { PluginTaskEnvelope };
