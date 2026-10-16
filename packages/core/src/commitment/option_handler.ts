/**
 * The `commitment.option` family wired to this node (COMMITMENT_KERNEL §6,
 * §11, §15 step 7): the stores on the identity database, the receive handler
 * for both roles, opening smaller deals with known shippers, the owner's
 * clearance of a version resting on an option, the fallback when a run ends
 * without fault, and the seller's tick. The decisions are `options.ts`.
 */

import { appendAudit } from '../audit/service';
import { deliveryDayOf } from '../commerce/deal_kinds';
import { listContacts } from '../contacts/directory';
import { preferredForKey } from '../contacts/preferred_for';
import { contactDisclosureTier } from '../coordination/disclosure_policy';
import { setFallbackRecipientCheck } from '../d2d/gates';
import { getD2DSender, sendOutcomeOf } from '../server/routes/d2d_msg';
import { getOwnerTimeZone } from '../settings/owner_settings';
import { WorkflowTaskKind, WorkflowTaskState } from '../workflow/domain';
import { getWorkflowService } from '../workflow/service';

import { fieldAdmitted } from './disclosure';
import { getValueModelStore } from './model_store';
import {
  admitOptionAnswer,
  admitReceipt,
  answerOptionRequest,
  answerOptionTakeUp,
  askShippers,
  OPTION_MESSAGE,
  optionLinkWork,
  OrderFallbackStore,
  parseOptionMessage,
  parseOrderRef,
  partnerAlternativeId,
  SellerOptionStore,
  ShipperOptionStore,
  type FallbackBody,
  type OnwardGrant,
  type OptionLink,
} from './options';

import type { DatabaseAdapter } from '../storage/db_adapter';
import type { ApprovalDecisionHandler, WorkflowHooks } from '../workflow/service';

let sellerStore: SellerOptionStore | null = null;
let shipperStore: ShipperOptionStore | null = null;
let fallbackStore: OrderFallbackStore | null = null;

/** Storage boot installs all three on the identity database; null in tests that do not. */
export function installOptionStores(db: DatabaseAdapter | null): void {
  sellerStore = db === null ? null : new SellerOptionStore(db);
  shipperStore = db === null ? null : new ShipperOptionStore(db);
  fallbackStore = db === null ? null : new OrderFallbackStore(db);
  // A fallback notice may go to the buyer of an order this node recorded a
  // fallback for, contact or not; nothing else in the family is waived.
  setFallbackRecipientCheck(
    db === null
      ? null
      : (recipient, notice) => {
          const po = (notice as { purchase_order_id?: unknown } | null)?.purchase_order_id;
          return typeof po === 'string' && fallbackStore?.get(recipient, po)?.role === 'seller';
        },
  );
}

export function getSellerOptionStore(): SellerOptionStore | null {
  return sellerStore;
}

export function getShipperOptionStore(): ShipperOptionStore | null {
  return shipperStore;
}

export function getOrderFallbackStore(): OrderFallbackStore | null {
  return fallbackStore;
}

/**
 * Has this order's partner run ended without fault, so it now stands on the
 * quote's own terms? Read wherever an order's version is priced or exported.
 */
export function fallbackApplied(buyerDid: string, purchaseOrderId: string): boolean {
  return fallbackStore?.get(buyerDid, purchaseOrderId) != null;
}

/** May a pincode go to this contact under the owner's disclosure rules (§11)? */
function pincodeAdmitted(did: string): boolean {
  return fieldAdmitted(contactDisclosureTier(did, 'location'), {
    category: 'location',
    grain: 'pincode',
  });
}

/** The owner's known shippers: contacts, not blocked, whose `preferredFor` names the role. */
export function knownShippers(): string[] {
  const role = preferredForKey('shipper');
  return listContacts()
    .filter(
      (c) =>
        c.trustLevel !== 'blocked' &&
        (c.preferredFor ?? []).some((p) => preferredForKey(p) === role),
    )
    .map((c) => c.did);
}

/**
 * Send one message; true only when the sender took it: delivered, buffered
 * or queued for retry when it reports an outcome, or no throw when it reports
 * none. False on a refusal; a throw is the caller's to catch.
 */
async function send(to: string, body: object): Promise<boolean> {
  const sender = getD2DSender();
  if (sender === null) throw new Error('d2d sender not wired');
  const outcome = sendOutcomeOf(await sender(to, OPTION_MESSAGE, body as Record<string, unknown>));
  return outcome === undefined || outcome.delivered || outcome.buffered || outcome.queued;
}

function raiseCard(args: {
  id: string;
  description: string;
  payload: Record<string, unknown>;
  correlationId: string;
}): boolean {
  const workflow = getWorkflowService();
  if (workflow === null) return false;
  if (workflow.store().getById(args.id) !== null) return true;
  try {
    workflow.create({
      id: args.id,
      kind: WorkflowTaskKind.Approval,
      description: args.description,
      payload: JSON.stringify(args.payload),
      idempotencyKey: args.id,
      correlationId: args.correlationId,
      origin: 'system',
      initialState: WorkflowTaskState.PendingApproval,
    });
    return true;
  } catch {
    return workflow.store().getById(args.id) !== null;
  }
}

/**
 * Open the smaller deals beneath one larger deal: ask every known shipper the
 * owner's disclosure rules let a pincode go to, carrying the buyer's pincode
 * only under the buyer's grant. A known shipper the rules do not admit is not
 * asked; the owner gets one card naming it. The requests are stored before
 * anything is sent; the tick sends again any that went unanswered.
 */
export async function openSmallerDeals(args: {
  dealRef: string;
  grant: OnwardGrant | null;
  postalCode: string;
  serviceAt: string;
  crates: number;
  nowMs: number;
}): Promise<'asked' | 'no_grant' | 'no_partner' | 'not_wired'> {
  const store = sellerStore;
  if (store === null) return 'not_wired';
  const known = knownShippers();
  for (const did of known.filter((d) => !pincodeAdmitted(d)))
    raiseCard({
      id: `option-disclose-${did}`,
      description:
        'One of your shippers could carry your buyers’ orders, but your sharing rules keep pincodes from them. To ask them, set their location sharing to “pincode only” in their contact.',
      payload: { type: 'option_disclosure', shipper_did: did },
      correlationId: 'option_disclosure',
    });
  const asked = askShippers({ store, shippers: known.filter(pincodeAdmitted), ...args });
  if (!asked.ok) {
    appendAudit('owner', 'option_ask_refused', args.dealRef, `reason=${asked.reason}`);
    return asked.reason;
  }
  for (const m of asked.send) {
    try {
      if (await send(m.to, m.body)) store.sent(m.body.request_id, args.nowMs);
    } catch {
      /* the tick sends it again */
    }
  }
  return 'asked';
}

/**
 * A held option: offered to buyers only once the seller's owner clears it
 * (§6 step 3) — at once when the owner has made the goods kind firm,
 * otherwise on the owner's card.
 */
async function askClearance(
  store: SellerOptionStore,
  link: OptionLink,
  nowMs: number,
): Promise<void> {
  const models = await getValueModelStore();
  if (models?.form('goods.seller').form.binding === 'firm') {
    store.clear(link.requestId, nowMs);
    return;
  }
  const option = link.option;
  if (option === null) return;
  // The owner already said yes, and a crash came before the clearance was
  // kept: the card stands approved (queued, running or completed). Finish it.
  const cardId = `option-clear-${link.requestId}`;
  const workflow = getWorkflowService();
  const card = workflow?.store().getById(cardId) ?? null;
  if (
    card !== null &&
    (card.status === WorkflowTaskState.Queued ||
      card.status === WorkflowTaskState.Running ||
      card.status === WorkflowTaskState.Completed)
  ) {
    store.clear(link.requestId, nowMs);
    try {
      if (card.status === WorkflowTaskState.Queued)
        workflow
          ?.store()
          .transition(cardId, WorkflowTaskState.Queued, WorkflowTaskState.Running, nowMs);
      if (card.status !== WorkflowTaskState.Completed)
        workflow?.complete(cardId, JSON.stringify({ seen: true }), 'option cleared');
    } catch {
      /* closed meanwhile */
    }
    return;
  }
  const rupees = (BigInt(option.fee_minor) / 100n).toString(10);
  raiseCard({
    id: `option-clear-${link.requestId}`,
    description: `A shipper can run one of your orders on ${option.service_at.slice(0, 10)} for ₹${rupees}, held until ${option.hold_until.slice(0, 16).replace('T', ' ')} UTC. Offer the buyer that day, passing on your chosen share of what it saves you? A yes the buyer gives in time binds the run.`,
    payload: { type: OPTION_CLEAR_TYPE, request_id: link.requestId },
    correlationId: link.dealRef,
  });
}

export const OPTION_CLEAR_TYPE = 'option_clear';

/**
 * Every card this family puts to the owner: Core's to mint and the owner's
 * to answer (Brain may neither create nor decide one). Only the clearance
 * asks anything; the others are notices.
 */
export const OPTION_CARD_TYPES = [
  OPTION_CLEAR_TYPE,
  'option_link',
  'option_disclosure',
  'option_fallback',
] as const;

/** The owner's yes on a clearance card clears the option; the card closes. */
export const makeOptionClearDecisionHandler =
  (deps: { nowMs: () => number }): ApprovalDecisionHandler =>
  ({ task, decision }) => {
    let payload: { type?: unknown; request_id?: unknown };
    try {
      payload = JSON.parse(task.payload) as typeof payload;
    } catch {
      return;
    }
    if (!(OPTION_CARD_TYPES as readonly unknown[]).includes(payload.type)) return;
    if (decision !== 'approved') return;
    // A notice asks nothing: a yes only marks it seen. The clearance clears.
    if (payload.type === OPTION_CLEAR_TYPE && typeof payload.request_id === 'string')
      sellerStore?.clear(payload.request_id, deps.nowMs());
    const workflow = getWorkflowService();
    try {
      workflow
        ?.store()
        .transition(task.id, WorkflowTaskState.Queued, WorkflowTaskState.Running, deps.nowMs());
      workflow?.complete(
        task.id,
        JSON.stringify({ seen: true }),
        payload.type === OPTION_CLEAR_TYPE ? 'option cleared' : 'notice seen',
      );
    } catch {
      /* already closed */
    }
  };

/** The option family's contribution to the workflow service, composed at every host. */
export function optionWorkflowHooks(over: { nowMs?: () => number } = {}): WorkflowHooks {
  return {
    responseEgressGate: () => ({ kind: 'passthrough' }),
    approvalDecisionHandler: makeOptionClearDecisionHandler({ nowMs: over.nowMs ?? Date.now }),
  };
}

/**
 * The buyer's node checks a fallback notice before keeping it: from this
 * order's supplier, for an order that took that alternative, which the quote
 * marked as resting on a run. Supplied by the commerce runtime's composition.
 */
export type FallbackNoticeCheck = (args: {
  supplierDid: string;
  notice: FallbackBody;
}) => { buyerDid: string } | null;

let fallbackCheck: FallbackNoticeCheck | null = null;

export function installFallbackNoticeCheck(check: FallbackNoticeCheck | null): void {
  fallbackCheck = check;
}

/** An order's digest, from the commerce runtime's own records; installed with it. */
let orderDigestOf: ((buyerDid: string, purchaseOrderId: string) => string | null) | null = null;

export function installOrderDigestLookup(
  lookup: ((buyerDid: string, purchaseOrderId: string) => string | null) | null,
): void {
  orderDigestOf = lookup;
}

/** The seller applies the fallback to the order a lapsed run belonged to, and tells the buyer. */
async function applyFallback(link: OptionLink, nowMs: number): Promise<void> {
  const store = fallbackStore;
  const order = link.orderRef === null ? null : parseOrderRef(link.orderRef);
  if (store === null || order === null) return;
  store.record({
    buyerDid: order.buyerDid,
    purchaseOrderId: order.purchaseOrderId,
    supplierDid: 'self',
    quoteId: link.dealRef,
    alternativeId: partnerAlternativeId(link.requestId),
    role: 'seller',
    appliedAt: nowMs,
    orderDigest: orderDigestOf?.(order.buyerDid, order.purchaseOrderId) ?? '',
  });
  await tellBuyers(nowMs);
}

/** Send every untold fallback notice; one that fails is sent on the next tick. */
async function tellBuyers(nowMs: number): Promise<void> {
  const store = fallbackStore;
  if (store === null) return;
  for (const f of store.untold()) {
    const notice: FallbackBody = {
      v: 1,
      kind: 'fallback',
      purchase_order_id: f.purchaseOrderId,
      quote_id: f.quoteId,
      alternative_id: f.alternativeId,
      at: new Date(f.appliedAt).toISOString(),
    };
    try {
      if (!(await send(f.buyerDid, notice))) continue;
      store.told(f.buyerDid, f.purchaseOrderId);
      appendAudit(f.buyerDid, 'option_fallback_told', f.purchaseOrderId, `at=${String(nowMs)}`);
    } catch {
      /* the tick sends it again */
    }
  }
}

/**
 * A `commitment.option` message from a contact. Data, never an instruction:
 * each kind is checked against what this node asked for, issued or ordered.
 */
export async function handleOptionMessage(
  fromDid: string,
  raw: unknown,
  nowMs: number,
): Promise<'kept' | 'refused'> {
  const body = parseOptionMessage(raw);
  if (body === null) return 'refused';
  switch (body.kind) {
    case 'request': {
      const store = shipperStore;
      const models = await getValueModelStore();
      if (store === null || models === null) return 'refused';
      const loaded = models.load('delivery.shipper', ['delivery_day', 'run', 'fee']);
      const answer = answerOptionRequest({
        store,
        view: {
          model: loaded.model,
          closedPersonas: loaded.closedPersonas,
          asking: models.form('delivery.shipper').form.asking,
        },
        sellerDid: fromDid,
        request: body,
        timeZone: (await getOwnerTimeZone()).timezone,
        nowMs,
        deliveryDayOf,
      });
      appendAudit(fromDid, 'option_answered', body.request_id, `answer=${answer.kind}`);
      await send(fromDid, answer).catch(() => undefined);
      return 'kept';
    }
    case 'acceptance':
    case 'status_query': {
      const store = shipperStore;
      if (store === null) return 'refused';
      const receipt = answerOptionTakeUp({
        store,
        sellerDid: fromDid,
        optionId: body.option_id,
        isQuery: body.kind === 'status_query',
        nowMs,
      });
      if (receipt === null) return 'refused';
      appendAudit(fromDid, 'option_receipt', body.option_id, `answer=${receipt.answer}`);
      await send(fromDid, receipt).catch(() => undefined);
      return 'kept';
    }
    case 'option':
    case 'decline': {
      const store = sellerStore;
      if (store === null) return 'refused';
      const kept = admitOptionAnswer({ store, fromDid, body, nowMs });
      appendAudit(fromDid, 'option_admitted', body.request_id, `outcome=${kept}`);
      if (kept === 'held') {
        const link = store.get(body.request_id);
        if (link !== null) await askClearance(store, link, nowMs);
      }
      return kept === 'refused' ? 'refused' : 'kept';
    }
    case 'receipt': {
      const store = sellerStore;
      if (store === null) return 'refused';
      const link = admitReceipt({ store, fromDid, body, nowMs });
      if (link === null) return 'refused';
      appendAudit(fromDid, 'option_link', link.dealRef, `state=${link.state}`);
      if (link.state === 'lapsed_no_fault') {
        raiseLinkCard(link, 'lapsed');
        await applyFallback(link, nowMs);
      }
      return 'kept';
    }
    case 'fallback': {
      const store = fallbackStore;
      const checked = fallbackCheck?.({ supplierDid: fromDid, notice: body }) ?? null;
      if (store === null || checked === null) return 'refused';
      store.record({
        buyerDid: checked.buyerDid,
        purchaseOrderId: body.purchase_order_id,
        supplierDid: fromDid,
        quoteId: body.quote_id,
        alternativeId: body.alternative_id,
        role: 'buyer',
        appliedAt: nowMs,
      });
      appendAudit(fromDid, 'option_fallback_kept', body.purchase_order_id, '');
      raiseCard({
        id: `option-fallback-${fromDid}-${body.purchase_order_id}`,
        description:
          'A partner run your supplier booked for one of your orders ended without fault. The order stands on the quote’s own terms: standard delivery, at the price without the run’s discount.',
        payload: { type: 'option_fallback', purchase_order_id: body.purchase_order_id },
        correlationId: body.quote_id,
      });
      return 'kept';
    }
  }
}

/** The seller's owner hears of a link that ended without fault, or whose delivery is still unknown. */
function raiseLinkCard(link: OptionLink, why: 'lapsed' | 'unknown'): boolean {
  return raiseCard({
    id: `option-link-${why}-${link.requestId}`,
    description:
      why === 'lapsed'
        ? 'A shipper’s run for one of your orders ended without fault: your acceptance reached them after the time agreed. The order now stands on the quote’s own terms (standard shipping), and the buyer has been told.'
        : 'A shipper has not yet confirmed a run you took up for one of your orders, and the run is close. Check with them, or plan standard shipping.',
    payload: { type: 'option_link', state: why, deal_ref: link.dealRef },
    correlationId: link.dealRef,
  });
}

/**
 * The seller's tick: send again any request still unanswered (to a shipper
 * still known and still admitted for a pincode), resend or ask after each
 * link it took up, raise the owner's card when due (marked only once the
 * card exists), and tell any buyer not yet told of a fallback.
 */
export async function runOptionLinkTick(nowMs: number): Promise<number> {
  const store = sellerStore;
  if (store === null) return 0;
  // Repair what a crash between two writes could leave: a held option with
  // no clearance asked (the card id is fixed, so asking again is safe), and a
  // lapsed run with no fallback on its order (recording is first-wins).
  for (const link of store.forState(['held']))
    if (link.clearedAt === null) await askClearance(store, link, nowMs);
  for (const link of store.forState(['lapsed_no_fault'])) await applyFallback(link, nowMs);
  const work = optionLinkWork({ store, nowMs });
  for (const link of work.cards)
    if (raiseLinkCard(link, 'unknown')) store.cardRaised(link.requestId);
  const known = new Set(knownShippers().filter(pincodeAdmitted));
  let sent = 0;
  for (const m of work.send) {
    if (m.body.kind === 'request' && !known.has(m.to)) continue;
    try {
      if (await send(m.to, m.body)) sent += 1;
    } catch {
      /* sent again after RESEND_EVERY_MS */
    }
  }
  await tellBuyers(nowMs);
  return sent;
}

export interface OptionLinkSweeperOptions {
  intervalMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** Runs the seller's tick; started with the other commerce ticks, on both hosts. */
export class OptionLinkSweeper {
  private handle: unknown = null;
  private running = false;

  constructor(private readonly options: OptionLinkSweeperOptions = {}) {}

  start(): void {
    if (this.handle !== null) return;
    const every = this.options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.handle = every(() => {
      void this.runTick().catch((err: unknown) => this.options.onError?.(err));
    }, this.options.intervalMs ?? 60_000);
    (this.handle as { unref?: () => void } | null)?.unref?.();
  }

  stop(): void {
    if (this.handle === null) return;
    const clear =
      this.options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    clear(this.handle);
    this.handle = null;
  }

  async runTick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await runOptionLinkTick((this.options.now ?? Date.now)());
    } finally {
      this.running = false;
    }
  }
}
