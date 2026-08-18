/**
 * The §5.1 dispatch-intent replay tick (PHOTO_COMMERCE_LANES_DESIGN).
 *
 * "Restart-recoverable from the row alone" is true only if something READS
 * the row: this is that reader. A crash between the orchestrator's step 1
 * (intent persisted, competitors closed) and step 3 (outcome recorded)
 * leaves a conversation in `submitting` with a live intent; this tick
 * resumes it. A transient refusal (the node itself briefly cannot act)
 * leaves the same shape on purpose; this tick is also the retry.
 *
 * REPLAY CANNOT CLASSIFY BY DISPATCH ANSWER ALONE (§5.1). The poisoned
 * case: dispatch succeeded, the approval was consumed at the send boundary,
 * the crash landed before step 3 — a naive replay now meets a
 * consumed-approval 409 and reads it as definitive refusal, reopening
 * competitors against an order that is durably on its way: a double
 * purchase by misclassification. So replay FIRST resolves the intent
 * against the buyer-order record (the record, when one exists, wins over
 * everything); only when no record exists does it dispatch again and apply
 * the four-class map.
 *
 * Shape follows `ReconcilePollSweeper`: injectable clock and timer,
 * idempotent start/stop, no overlapping passes, observer hooks that cannot
 * break the loop.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  classifyDispatchAnswer,
  dispatchUnderRetainedApproval,
  resolveIntentAgainstRecord,
} from './order_dispatch';
import { OrderDraftService } from './order_draft_service';
import { sweepOrderDraftLifecycle } from './order_lifecycle';
import { getCommerceRuntime } from './runtime';

import type { DispatchClass } from './order_dispatch';
import type { LifecycleEvent } from './order_lifecycle';

export interface DispatchReplayOutcome {
  draftId: string;
  conversationId: string;
  kind: DispatchClass['kind'];
  reason?: string;
}

export interface DispatchIntentSweeperOptions {
  /** How often live intents are replayed. Default `60_000` ms. */
  intervalMs?: number;
  now?: () => number;
  /** Fired once per intent resolved or retried on a pass. */
  onOutcome?: (outcome: DispatchReplayOutcome) => void;
  /** Fired once per §5.5 lifecycle transition the same pass made durable. */
  onLifecycle?: (event: LifecycleEvent) => void;
  onError?: (err: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;

export class DispatchIntentSweeper {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly onOutcome: (outcome: DispatchReplayOutcome) => void;
  private readonly onLifecycle: (event: LifecycleEvent) => void;
  private readonly onError: (err: unknown) => void;
  private readonly setIntervalFn: NonNullable<DispatchIntentSweeperOptions['setInterval']>;
  private readonly clearIntervalFn: NonNullable<DispatchIntentSweeperOptions['clearInterval']>;

  private handle: unknown | null = null;
  private inFlight = false;

  constructor(options: DispatchIntentSweeperOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (this.intervalMs <= 0) {
      throw new Error(
        `DispatchIntentSweeper: intervalMs must be > 0 (got ${String(this.intervalMs)})`,
      );
    }
    this.now = options.now ?? (() => Date.now());
    this.onOutcome =
      options.onOutcome ??
      (() => {
        /* silenced */
      });
    this.onLifecycle =
      options.onLifecycle ??
      (() => {
        /* silenced */
      });
    this.onError =
      options.onError ??
      (() => {
        /* silenced */
      });
    this.setIntervalFn = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn =
      options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.setIntervalFn(() => {
      // One pass in flight at a time; a slow pass delays the next rather
      // than stacking sends against a struggling transport.
      if (this.inFlight) return;
      this.inFlight = true;
      void this.tick()
        .catch((err: unknown) => this.onError(err))
        .finally(() => {
          this.inFlight = false;
        });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  /** One replay pass. Exposed for tests and for a boot-time catch-up call. */
  async tick(): Promise<DispatchReplayOutcome[]> {
    const runtime = getCommerceRuntime();
    if (runtime === null) return [];
    // §5.5's clock-driven rows run on the same tick the intent replay does
    // — one reader for every duty "restart-recoverable" hangs on.
    try {
      for (const event of sweepOrderDraftLifecycle(runtime, this.now())) {
        this.onLifecycle(event);
      }
    } catch (err) {
      this.onError(err);
    }
    const service = new OrderDraftService({
      drafts: runtime.orderDrafts,
      now: this.now,
      sha256: (data) => sha256(data),
      // Replay performs no ceremony; nothing on this path may ask for one.
      userPresent: () => false,
      attributionBoundary: runtime.attributionBoundary,
      // No person is here — a replay must never mint a vouch, and a null
      // voucher makes any confirm attempt on this path refuse (§6.4).
      vouchedBy: () => null,
    });

    const outcomes: DispatchReplayOutcome[] = [];
    for (const draft of runtime.orderDrafts.list()) {
      if (draft.abandoned) continue;
      for (const conversation of draft.conversations) {
        if (conversation.state !== 'submitting' || conversation.dispatchIntent === null) {
          continue;
        }
        const intent = conversation.dispatchIntent;
        const where = { draftId: draft.draftId, conversationId: conversation.conversationId };
        try {
          // THE RECORD WINS OVER EVERYTHING (§5.1).
          const fromRecord = resolveIntentAgainstRecord(
            runtime,
            conversation.supplierDid,
            intent.purchaseOrderId,
          );
          if (fromRecord !== null && (fromRecord.kind === 'uncertain' || fromRecord.kind === 'confirmed')) {
            runtime.runInTransaction(() => {
              service.recordSubmitOutcome(draft.draftId, {
                conversationId: conversation.conversationId,
                kind: fromRecord.kind,
              });
            });
            outcomes.push({ ...where, kind: fromRecord.kind });
            this.onOutcome({ ...where, kind: fromRecord.kind });
            continue;
          }

          const approvalId = conversation.approvalId;
          if (approvalId === null) {
            // `beginSubmit` keeps the reference while `submitting`; a row
            // without it cannot be replayed and must not wedge the draft.
            runtime.runInTransaction(() => {
              service.recordSubmitOutcome(draft.draftId, {
                conversationId: conversation.conversationId,
                kind: 'refused',
                reason: 'missing_approval_reference',
              });
            });
            outcomes.push({ ...where, kind: 'refused', reason: 'missing_approval_reference' });
            this.onOutcome({ ...where, kind: 'refused', reason: 'missing_approval_reference' });
            continue;
          }

          const answer = await dispatchUnderRetainedApproval(runtime, approvalId, this.now());
          const klass = classifyDispatchAnswer(answer);
          runtime.runInTransaction(() => {
            service.recordSubmitOutcome(draft.draftId, {
              conversationId: conversation.conversationId,
              ...(klass.kind === 'refused'
                ? { kind: 'refused' as const, reason: klass.reason }
                : klass.kind === 'transient'
                  ? { kind: 'transient' as const, reason: klass.reason }
                  : { kind: klass.kind }),
            });
            // A pre-send refusal never consumed the card, and the card bound
            // a quote context that is now dead: invalidate it (the courtesy
            // half of §5.4 stage 4; the submit-time check is the enforcement).
            if (klass.kind === 'refused') {
              runtime.orderApprovals.consume(approvalId, this.now());
            }
          });
          const reported: DispatchReplayOutcome = {
            ...where,
            kind: klass.kind,
            ...(klass.kind === 'refused' || klass.kind === 'transient'
              ? { reason: klass.reason }
              : {}),
          };
          outcomes.push(reported);
          this.onOutcome(reported);
        } catch (err) {
          this.onError(err);
        }
      }
    }
    return outcomes;
  }
}
