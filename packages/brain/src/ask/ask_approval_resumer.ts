/**
 * Brain-side auto-resumer: when the operator approves an ask via
 * `AskApprovalGateway.approve`, the gateway transitions the registry
 * record `pending_approval → in_flight` and emits an
 * `approval_resumed` event — but stops there. The handler that
 * originally produced the ask is supposed to subscribe to that event
 * and re-issue the LLM call. This module is that subscriber.
 *
 * **Two resume patterns** — the resumer dispatches to whichever the
 * caller wired:
 *
 *   - **Pattern A (suspend/resume)**: when the registry record carries
 *     a `pausedStateJson` blob (the agentic loop's serialized
 *     `PausedAgenticState`) AND the caller supplied
 *     `resumeFromPausedFn`, the resumer deserialises the paused state
 *     and resumes the loop at the bail point. The LLM never knows
 *     there was a gap; the previous tool result lands; the run
 *     continues. Zero re-LLM cost. This is what mobile's in-process
 *     agentic loop produces.
 *
 *   - **Pattern B (re-run from scratch)**: when no `pausedStateJson`
 *     is present (or no `resumeFromPausedFn` configured), the resumer
 *     calls `executeFn({id, question, requesterDid})` — the same
 *     shape `createAskHandler` uses. The pipeline re-runs from the
 *     original question; the now-consumed approval lets the gated
 *     read return real data this time. Higher LLM cost but lower
 *     state-tracking complexity. This is what the persona-guarded
 *     HTTP `/api/v1/ask` path produces today.
 *
 * Both patterns can be wired together. Records with paused state go
 * Pattern A; legacy records without go Pattern B; legacy callers that
 * don't supply `resumeFromPausedFn` keep working unchanged.
 *
 * **Loop safety**: if either path returns another `approval_required`
 * outcome (LLM hits a different locked persona on the second pass),
 * the resumer transitions back to `pending_approval` with the new
 * approval id (and, for Pattern A, the new paused state). The
 * operator approves again; this resumer fires again. Termination is
 * guaranteed by the registry's TTL reaper — an ask can't bounce
 * between approval states indefinitely without expiring.
 *
 * **Crash safety**: this module is stateless. After a restart, any
 * ask still in `in_flight` (because we crashed mid-resume) is owned
 * by the registry's `restoreOnStartup` summary; the boot code can
 * either re-issue manually or let the TTL reaper expire it.
 *
 * **Idempotency**: registry transitions are first-writer-wins (they
 * throw on terminal state). If two resumers were somehow wired to
 * the same registry (composition error), the loser's `markComplete`
 * would throw; we catch + log + don't propagate.
 *
 * **Trace correlation**: deliberately absent — see the docstring
 * comment for the rationale.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5b — closes the
 * "no auto re-issuer on approval_resumed" gap.
 */

import type {
  AgenticLoopResult,
  PausedAgenticState,
} from '../reasoning/agentic_loop';
import type { AskExecuteFn, ExecuteOutcome } from './ask_handler';
import type { AskEvent, AskRegistry } from './ask_registry';

export type AskApprovalResumerEvent =
  | { kind: 'resumed_completed'; askId: string }
  | { kind: 'resumed_failed'; askId: string; failureKind: string }
  | { kind: 'resumed_re_approval'; askId: string; approvalId: string }
  | { kind: 'record_missing'; askId: string }
  | {
      kind: 'skipped_unexpected_status';
      askId: string;
      observed: string;
    }
  | { kind: 'execute_crashed'; askId: string; detail: string }
  | { kind: 'apply_failed'; askId: string; detail: string }
  | { kind: 'paused_state_invalid'; askId: string; detail: string }
  | { kind: 'no_resumer_configured'; askId: string };

/**
 * Per-ask context passed to `ResumeFromPausedFn`. Carries enough state
 * for the resumer to build a per-ask tool registry (5.21-E) without
 * having to re-read the AskRegistry record itself.
 */
export interface ResumeContext {
  /** Ask record id — same as the registry key. */
  askId: string;
  /** DID of the original requester — needed for `createPersonaGuard`. */
  requesterDid: string;
}

/**
 * Pattern A resume function — resumes the agentic loop from a paused
 * state. Returns the loop's result, which the resumer translates into
 * the right registry transition.
 *
 * Receives the ask `context` so the closure can build a per-ask tool
 * registry via `pipeline.buildToolsForAsk(context)` — the
 * `personaGuard` baked into the vault tools mints/consumes approvals
 * that are scoped to this ask.
 */
export type ResumeFromPausedFn = (
  pausedState: PausedAgenticState,
  context: ResumeContext,
) => Promise<AgenticLoopResult>;

export interface AskApprovalResumerOptions {
  registry: AskRegistry;
  /**
   * Pattern B re-run path. Used when the record has no
   * `pausedStateJson` OR `resumeFromPausedFn` is absent. Optional iff
   * `resumeFromPausedFn` is provided.
   */
  executeFn?: AskExecuteFn;
  /**
   * Pattern A resume path. Used when the record carries a
   * `pausedStateJson` blob from the agentic loop. Optional iff
   * `executeFn` is provided.
   */
  resumeFromPausedFn?: ResumeFromPausedFn;
  /** Diagnostic hook — fires on every resumer decision. */
  onEvent?: (event: AskApprovalResumerEvent) => void;
}

export class AskApprovalResumer {
  private readonly registry: AskRegistry;
  private readonly executeFn?: AskExecuteFn;
  private readonly resumeFromPausedFn?: ResumeFromPausedFn;
  private readonly onEvent?: (event: AskApprovalResumerEvent) => void;

  constructor(opts: AskApprovalResumerOptions) {
    if (!opts?.registry) {
      throw new TypeError('AskApprovalResumer: registry is required');
    }
    const hasExecute = typeof opts.executeFn === 'function';
    const hasResume = typeof opts.resumeFromPausedFn === 'function';
    if (!hasExecute && !hasResume) {
      throw new TypeError(
        'AskApprovalResumer: at least one of executeFn / resumeFromPausedFn must be provided',
      );
    }
    this.registry = opts.registry;
    if (hasExecute) this.executeFn = opts.executeFn;
    if (hasResume) this.resumeFromPausedFn = opts.resumeFromPausedFn;
    this.onEvent = opts.onEvent;
  }

  /**
   * Event handler — compose into `AskRegistry.onEvent`. Ignores every
   * event kind except `approval_resumed`. Returns a promise so tests
   * can `await` the resume cycle deterministically; production wires
   * this into the registry's sync onEvent hook (`(e) => { void
   * resumer.handle(e); }`) where the return value is discarded —
   * keeping the registry's emit path strictly synchronous while
   * letting tests skip the microtask race.
   */
  readonly handle = async (event: AskEvent): Promise<void> => {
    if (event.kind !== 'approval_resumed') return;
    await this.resume(event.id);
  };

  /**
   * Public for tests + boot-time recovery: callers can drive a
   * resume manually (e.g. after `restoreOnStartup` finds an
   * already-`in_flight` record from before the crash). Idempotent
   * when the registry is already terminal — `applyOutcome` swallows
   * the second-writer error.
   */
  async resume(askId: string): Promise<void> {
    const record = await this.registry.get(askId);
    if (record === null) {
      this.onEvent?.({ kind: 'record_missing', askId });
      return;
    }
    if (record.status !== 'in_flight') {
      // Race: someone else (TTL reaper, denial path, terminal write)
      // moved the record between event emission and our handler. Skip
      // — re-issuing now would either fight the other writer or
      // produce an answer for an already-resolved ask.
      this.onEvent?.({
        kind: 'skipped_unexpected_status',
        askId,
        observed: record.status,
      });
      return;
    }

    // Pattern A: record carries paused state AND we have a resumer wired.
    if (record.pausedStateJson !== undefined && this.resumeFromPausedFn) {
      let pausedState: PausedAgenticState;
      try {
        pausedState = JSON.parse(record.pausedStateJson) as PausedAgenticState;
      } catch (err) {
        const detail = stringifyError(err);
        this.onEvent?.({ kind: 'paused_state_invalid', askId, detail });
        await this.markFailedSafe(askId, {
          kind: 'paused_state_invalid',
          message: detail,
        });
        return;
      }

      let result: AgenticLoopResult;
      try {
        result = await this.resumeFromPausedFn(pausedState, {
          askId: record.id,
          requesterDid: record.requesterDid,
        });
      } catch (err) {
        const detail = stringifyError(err);
        this.onEvent?.({ kind: 'execute_crashed', askId, detail });
        await this.markFailedSafe(askId, {
          kind: 'execute_crashed',
          message: detail,
        });
        return;
      }
      await this.applyAgenticResult(askId, result);
      return;
    }

    // Pattern B: re-run the pipeline from scratch.
    if (this.executeFn) {
      let outcome: ExecuteOutcome;
      try {
        outcome = await this.executeFn({
          id: record.id,
          question: record.question,
          requesterDid: record.requesterDid,
        });
      } catch (err) {
        const detail = stringifyError(err);
        this.onEvent?.({ kind: 'execute_crashed', askId, detail });
        outcome = {
          kind: 'failure',
          failure: { kind: 'execute_crashed', message: detail },
        };
      }
      await this.applyOutcome(askId, outcome);
      return;
    }

    // Record has paused state but no resumer wired — or vice versa.
    // Composition error: surface, don't fight.
    this.onEvent?.({ kind: 'no_resumer_configured', askId });
  }

  private async applyOutcome(askId: string, outcome: ExecuteOutcome): Promise<void> {
    try {
      if (outcome.kind === 'answer') {
        await this.registry.markComplete(askId, JSON.stringify(outcome.answer));
        this.onEvent?.({ kind: 'resumed_completed', askId });
        return;
      }
      if (outcome.kind === 'approval') {
        await this.registry.markPendingApproval(askId, outcome.approvalId);
        this.onEvent?.({
          kind: 'resumed_re_approval',
          askId,
          approvalId: outcome.approvalId,
        });
        return;
      }
      await this.registry.markFailed(askId, JSON.stringify(outcome.failure));
      this.onEvent?.({
        kind: 'resumed_failed',
        askId,
        failureKind: outcome.failure.kind,
      });
    } catch (err) {
      // Registry already terminal (concurrent writer, expired
      // sweeper, or status drifted between status check and write).
      // Don't fight it; surface the conflict for telemetry.
      this.onEvent?.({
        kind: 'apply_failed',
        askId,
        detail: stringifyError(err),
      });
    }
  }

  /**
   * Pattern A bridge: translate an `AgenticLoopResult` into the right
   * registry transition.
   *
   *   - `completed`        → markComplete with `{text: result.answer}`
   *   - `approval_required` → markPendingApproval with the new
   *     approval id AND the new paused state (the resume cycle can
   *     bail again on a different persona; we re-park with the
   *     fresh blob so the next resume picks up at the new bail point).
   *   - everything else    → markFailed with structured failure.
   */
  private async applyAgenticResult(askId: string, result: AgenticLoopResult): Promise<void> {
    try {
      if (result.finishReason === 'completed') {
        await this.registry.markComplete(askId, JSON.stringify({ text: result.answer }));
        this.onEvent?.({ kind: 'resumed_completed', askId });
        return;
      }
      if (result.finishReason === 'approval_required') {
        if (!result.pausedState) {
          // Loop spec violation — should never happen in practice.
          await this.registry.markFailed(
            askId,
            JSON.stringify({
              kind: 'paused_state_missing',
              message: 'agentic loop returned approval_required without pausedState',
            }),
          );
          this.onEvent?.({
            kind: 'resumed_failed',
            askId,
            failureKind: 'paused_state_missing',
          });
          return;
        }
        const pausedJson = JSON.stringify(result.pausedState);
        await this.registry.markPendingApproval(askId, result.pausedState.approvalId, pausedJson);
        this.onEvent?.({
          kind: 'resumed_re_approval',
          askId,
          approvalId: result.pausedState.approvalId,
        });
        return;
      }
      // Any other finish reason → terminal failure.
      const failureKind = result.finishReason;
      await this.registry.markFailed(
        askId,
        JSON.stringify({
          kind: failureKind,
          message: `agentic loop terminated with ${failureKind}`,
        }),
      );
      this.onEvent?.({ kind: 'resumed_failed', askId, failureKind });
    } catch (err) {
      this.onEvent?.({
        kind: 'apply_failed',
        askId,
        detail: stringifyError(err),
      });
    }
  }

  /**
   * Helper for the early-fail paths inside `resume()` (paused-state
   * parse failure, resumer crash). Wraps `markFailed` in a swallow so
   * a concurrent terminal writer doesn't propagate.
   */
  private async markFailedSafe(
    askId: string,
    failure: { kind: string; message: string },
  ): Promise<void> {
    try {
      await this.registry.markFailed(askId, JSON.stringify(failure));
      this.onEvent?.({ kind: 'resumed_failed', askId, failureKind: failure.kind });
    } catch (err) {
      this.onEvent?.({
        kind: 'apply_failed',
        askId,
        detail: stringifyError(err),
      });
    }
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
