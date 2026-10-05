/**
 * Raising an order's interruptions (UCP plan §3.14, U3.4): the reconciler
 * writes each one beside the answer that caused it (`notices_json`, in the
 * answer's transaction); this pass turns them into `ucp_order_notice` cards
 * and clears them, in one transaction with the cards. One card per
 * interruption ever (its idempotency key), so a crash between the two raises
 * nothing twice. The owner's "Seen" completes the card.
 */

import { isPlainObject } from '@dina/a2a';

import { WorkflowTaskKind, WorkflowTaskPriority, WorkflowTaskState } from '../../workflow/domain';
import { WorkflowConflictError } from '../../workflow/repository';

import { settleCard } from './card_settle';
import {
  checkoutNoticeCard,
  orderCorrelationId,
  orderNoticeCard,
  type OrderNoticeCard,
  orderNoticeDescription,
  orderNoticeKey,
  readOrderNoticeCard,
} from './order_notice_card';
import { storedNotices, type UcpOrderStore } from './order_store';

import type { UcpCheckoutStore } from './checkout_store';
import type { OrderNotice } from './orders';
import type { WorkflowTask } from '../../workflow/domain';
import type { ApprovalDecision, WorkflowService } from '../../workflow/service';

/**
 * How long a notice card waits for "Seen" before it lapses: the order itself
 * stays in My Orders, and a mirror to the phone needs an end.
 */
export const ORDER_NOTICE_TTL_MS = 30 * 24 * 60 * 60_000;
/** Orders whose notices one pass raises; the rest wait for the next. */
const PASS_LIMIT = 20;
const REASONS = new Set(['new', 'settled', 'failed']);

/** A stored notice read back as one; null when it does not read. */
function readNotice(n: Record<string, unknown>): OrderNotice | null {
  if (typeof n.id !== 'string' || typeof n.type !== 'string' || !Number.isSafeInteger(n.at))
    return null;
  const at = n.at as number;
  if (n.kind === 'event') return { kind: 'event', id: n.id, type: n.type, at };
  if (n.kind === 'adjustment' && typeof n.reason === 'string' && REASONS.has(n.reason))
    return {
      kind: 'adjustment',
      id: n.id,
      type: n.type,
      reason: n.reason as 'new' | 'settled' | 'failed',
      at,
    };
  return null;
}

export interface OrderNoticeDeps {
  store: UcpOrderStore;
  /** Sessions that ended unconfirmed are told of on the same card (§3.7). */
  checkouts?: UcpCheckoutStore;
  workflow: () => WorkflowService | null;
  nowMs: () => number;
  newId: () => string;
}

export class UcpOrderNotices {
  constructor(private readonly deps: OrderNoticeDeps) {}

  /** Raise every waiting interruption as a card. Nothing without a workflow service: they wait. */
  raise(): void {
    const workflow = this.deps.workflow();
    if (workflow === null) return;
    this.raiseCheckouts(workflow);
    const { store } = this.deps;
    for (const row of store.withNotices(PASS_LIMIT)) {
      store.transaction(() => {
        for (const stored of storedNotices(row.notices_json)) {
          if (!isPlainObject(stored)) continue;
          const notice = readNotice(stored);
          if (notice === null) continue;
          this.create(workflow, orderNoticeCard(row, notice));
        }
        store.takeNotices(row, row.notices_json);
      });
    }
  }

  /** Tell the owner, once, of each checkout that ended without Dina knowing what the merchant holds. */
  private raiseCheckouts(workflow: WorkflowService): void {
    const checkouts = this.deps.checkouts;
    if (checkouts === undefined) return;
    for (const session of checkouts.untold(PASS_LIMIT)) {
      checkouts.transaction(() => {
        if (!checkouts.markTold(session.session_id, this.deps.nowMs())) return;
        this.create(workflow, checkoutNoticeCard(session, this.deps.nowMs()));
      });
    }
  }

  private create(workflow: WorkflowService, card: OrderNoticeCard): void {
    try {
      workflow.create({
        id: `ucp-order-notice-${this.deps.newId()}`,
        kind: WorkflowTaskKind.Approval,
        description: orderNoticeDescription(card),
        idempotencyKey: orderNoticeKey(card),
        payload: JSON.stringify(card),
        correlationId: orderCorrelationId(card),
        priority: WorkflowTaskPriority.UserBlocking,
        expiresAtSec: Math.floor((this.deps.nowMs() + ORDER_NOTICE_TTL_MS) / 1000),
        origin: 'system',
        initialState: WorkflowTaskState.PendingApproval,
      });
    } catch (err) {
      // Raised already (a pass that crashed after its cards, before clearing).
      if (!(err instanceof WorkflowConflictError)) throw err;
    }
  }

  /** The owner's "Seen": the card completes. A no, or a lapse, ends it as the workflow says. */
  decide(task: WorkflowTask, decision: ApprovalDecision): 'seen' | 'ignored' {
    const card = readOrderNoticeCard(task.payload);
    if (card === null || task.idempotency_key !== orderNoticeKey(card)) return 'ignored';
    if (decision !== 'approved') return 'ignored';
    const workflow = this.deps.workflow();
    if (workflow === null) return 'ignored';
    if (workflow.store().getById(task.id)?.status !== WorkflowTaskState.Queued) return 'ignored';
    settleCard(workflow, task.id, this.deps.nowMs(), { ok: true, result: { seen: 'true' } });
    return 'seen';
  }
}
