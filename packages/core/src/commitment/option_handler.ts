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
import { setExitRecipientCheck, setFallbackRecipientCheck } from '../d2d/gates';
import { getNodeDID } from '../pairing/ceremony';
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
  ExitAskStore,
  OPTION_MESSAGE,
  optionLinkWork,
  OrderFallbackStore,
  parseOptionMessage,
  parseOrderRef,
  partnerAlternativeId,
  RESEND_EVERY_MS,
  SellerOptionStore,
  ShipperOptionStore,
  type DeclineBody,
  type FallbackBody,
  type OnwardGrant,
  type OptionBody,
  type OptionLink,
  type OptionRequestBody,
} from './options';
import { projectModel } from './strategy';
import { getStrategyStore } from './strategy_store';
import { StrategyTurnStore } from './strategy_turns';

import type { NegotiationSubmitter } from './strategy_submit';
import type { ValueModel } from './value_model';
import type { DatabaseAdapter } from '../storage/db_adapter';
import type { ApprovalDecisionHandler, WorkflowHooks } from '../workflow/service';

let sellerStore: SellerOptionStore | null = null;
let shipperStore: ShipperOptionStore | null = null;
let fallbackStore: OrderFallbackStore | null = null;
let feeTurns: StrategyTurnStore | null = null;
let exitAsks: ExitAskStore | null = null;
let feeSubmitter: NegotiationSubmitter | null = null;

/** The shipper's deal kind: its fee is Brain's when the owner chose Brain (§15 step 11). */
const SHIPPER_KIND = 'delivery.shipper';

/** How long the shipper waits for Brain's fee: under the seller's hourly resend. */
export const SHIPPER_FEE_WAIT_MS = 50 * 60 * 1000;

/** A resend may come a little after its hour: room for that before the hold stops fitting. */
const RESEND_MARGIN_MS = 15 * 60 * 1000;

let feeClock: () => number = Date.now;

/** The door to the owner's reasoning backend for a shipper's fee; null: the asking fee goes. */
export function setShipperFeeSubmitter(
  submit: NegotiationSubmitter | null,
  nowMs: () => number = Date.now,
): void {
  feeSubmitter = submit;
  feeClock = nowMs;
}

/** Storage boot installs all three on the identity database; null in tests that do not. */
export function installOptionStores(db: DatabaseAdapter | null): void {
  sellerStore = db === null ? null : new SellerOptionStore(db);
  shipperStore = db === null ? null : new ShipperOptionStore(db);
  fallbackStore = db === null ? null : new OrderFallbackStore(db);
  feeTurns = db === null ? null : new StrategyTurnStore(db);
  exitAsks = db === null ? null : new ExitAskStore(db);
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
  // §15 step 12: the buyer's exit may go to the supplier whose fallback notice
  // it kept for that very order.
  setExitRecipientCheck(
    db === null
      ? null
      : (recipient, exit) => {
          const po = (exit as { cancellation?: { purchase_order_id?: unknown } } | null)?.cancellation
            ?.purchase_order_id;
          const self = getNodeDID();
          const kept =
            typeof po === 'string' && self !== null ? (fallbackStore?.get(self, po) ?? null) : null;
          return kept !== null && kept.role === 'buyer' && kept.supplierDid === recipient;
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
    description: `A shipper can run one of your orders on ${option.service_at.slice(0, 10)} for ₹${rupees}, held until ${option.hold_until.slice(0, 16).replace('T', ' ')} UTC. Offer the buyer that day, passing on your chosen share of what it saves you? A yes the buyer gives in time binds the run.${
      // §15 step 12: the right this version will carry is part of what the owner clears.
      exitPort?.quoteGrantsExit(link.dealRef) === true
        ? ' The buyer asked, and your settings agree, that if the run falls through they may cancel the order without charge.'
        : ''
    }`,
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
  // §15 step 12: the buyer's choice to take the exit right; the owner's alone.
  'option_exit',
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
    // §15 step 12: the owner takes the exit right: the cancellation goes to
    // the seller. A no keeps the order on the quote's own terms.
    if (payload.type === OPTION_EXIT_TYPE) {
      takeExit(task.id, payload as Record<string, unknown>, deps.nowMs());
      return;
    }
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
/**
 * The owner took the exit right: the cancellation is kept first (so neither
 * a failed send nor a restart loses the yes), the card closes, and the send
 * goes now and again on each tick until the transport takes it.
 */
function takeExit(taskId: string, payload: Record<string, unknown>, nowMs: number, sendNow = true): void {
  const supplierDid = typeof payload.supplier_did === 'string' ? payload.supplier_did : '';
  const po = typeof payload.purchase_order_id === 'string' ? payload.purchase_order_id : '';
  const cancellation = exitPort?.buyerCancellation(supplierDid, po, nowMs) ?? null;
  if (cancellation !== null) exitAsks?.ask(supplierDid, po, cancellation, nowMs);
  const kept = exitAsks?.has(supplierDid, po) === true;
  appendAudit(supplierDid, 'option_exit_taken', po, `kept=${String(kept)}`);
  const workflow = getWorkflowService();
  try {
    // A card a crash left running is completed as it stands.
    if (workflow?.store().getById(taskId)?.status === WorkflowTaskState.Queued)
      workflow.store().transition(taskId, WorkflowTaskState.Queued, WorkflowTaskState.Running, nowMs);
    workflow?.complete(
      taskId,
      JSON.stringify({ exit: kept ? 'asked' : 'no_order' }),
      kept ? 'cancellation on its way to the supplier' : 'this node holds no such order',
    );
  } catch {
    /* closed already */
  }
  if (kept && sendNow) void sendExits(nowMs);
}

/** Exits being sent now: a tick and an approval never send one twice at once. */
const exitsInFlight = new Set<string>();

/** Send every approved exit the transport has not taken; one that fails goes on the next tick. */
async function sendExits(nowMs: number): Promise<number> {
  const store = exitAsks;
  if (store === null) return 0;
  let sent = 0;
  for (const ask of store.unsent()) {
    const key = `${ask.supplierDid}|${ask.purchaseOrderId}`;
    if (exitsInFlight.has(key)) continue;
    exitsInFlight.add(key);
    try {
      if (!(await send(ask.supplierDid, { v: 1, kind: 'exit', cancellation: ask.cancellation }))) continue;
      store.sent(ask.supplierDid, ask.purchaseOrderId, nowMs);
      sent += 1;
    } catch {
      /* the tick sends it again */
    } finally {
      exitsInFlight.delete(key);
    }
  }
  return sent;
}

/**
 * Repair what a crash can leave: an exit card the owner approved and that
 * never finished (queued: the handler did not run, or ran only as far as
 * keeping the cancellation; running: it stopped before completing). The
 * cancellation is kept if it was not, and the card is completed.
 */
function repairApprovedExits(nowMs: number): void {
  const workflow = getWorkflowService();
  if (workflow === null || fallbackStore === null) return;
  for (const f of fallbackStore.asBuyer()) {
    const id = `option-exit-${f.supplierDid}-${f.purchaseOrderId}`;
    const task = workflow.store().getById(id);
    if (task === null) continue;
    if (task.status !== WorkflowTaskState.Queued && task.status !== WorkflowTaskState.Running) continue;
    // Sent by the tick that called this. The kept cancellation stands
    // (first kept wins); only the card is finished.
    takeExit(id, { supplier_did: f.supplierDid, purchase_order_id: f.purchaseOrderId }, nowMs, false);
  }
}

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
}) => { buyerDid: string; exitRight: boolean } | null;

let fallbackCheck: FallbackNoticeCheck | null = null;

export function installFallbackNoticeCheck(check: FallbackNoticeCheck | null): void {
  fallbackCheck = check;
}

/**
 * COMMITMENT_KERNEL §15 step 12 — the exit right, through the commerce
 * runtime's own records: whether an order this node sold holds it, the
 * cancellation a buyer sends for an order it placed, and the seller's
 * cancellation of an order that holds it. Installed with the runtime.
 */
export interface ExitRightPort {
  sellerOrderHoldsExit: (buyerDid: string, purchaseOrderId: string) => boolean;
  /** On the seller's node: will versions resting on runs for this quote carry the right? */
  quoteGrantsExit: (quoteId: string) => boolean;
  buyerCancellation: (supplierDid: string, purchaseOrderId: string, nowMs: number) => Record<string, unknown> | null;
  cancelForExit: (buyerDid: string, cancellation: Record<string, unknown>) => string;
}

let exitPort: ExitRightPort | null = null;

export function installExitRightPort(port: ExitRightPort | null): void {
  exitPort = port;
}

/** The buyer's card: cancel without charge, or keep the order on the quote's own terms. */
export const OPTION_EXIT_TYPE = 'option_exit';

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
      // §15 step 12: an order that holds the exit right says so.
      ...(exitPort?.sellerOrderHoldsExit(f.buyerDid, f.purchaseOrderId) === true ? { exit: true as const } : {}),
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
 * The shipper's answer to one request: its option already issued, a new one,
 * a decline, or null while Brain chooses the fee. `mayAsk`: whether this call
 * may hand the fee to Brain (not when applying Brain's own answer).
 */
async function answerRequest(
  sellerDid: string,
  request: OptionRequestBody,
  nowMs: number,
  mayAsk: boolean,
): Promise<OptionBody | DeclineBody | null | 'refused'> {
  const store = shipperStore;
  const models = await getValueModelStore();
  if (store === null || models === null) return 'refused';
  const loaded = models.load(SHIPPER_KIND, ['delivery_day', 'run', 'fee']);
  const asking = models.form(SHIPPER_KIND).form.asking;
  const chooseFee = await brainFee(sellerDid, request, nowMs, mayAsk, () => models.loadForBrain(SHIPPER_KIND));
  return answerOptionRequest({
    store,
    view: { model: loaded.model, closedPersonas: loaded.closedPersonas, asking },
    sellerDid,
    request,
    timeZone: (await getOwnerTimeZone()).timezone,
    nowMs,
    deliveryDayOf,
    ...(chooseFee === undefined ? {} : { chooseFee }),
  });
}

/** One shipper turn per seller and request: a seller names its own request ids. */
export function shipperTurnId(sellerDid: string, requestId: string): string {
  return `${sellerDid}|${requestId}`;
}

/**
 * COMMITMENT_KERNEL §15 step 11 — the fee for a run is Brain's when the owner
 * chose Brain for shipping. Asked once per seller and request, only after Core
 * found the run possible (day, rules that need no fee, room, hold), and only
 * while the hold would still fit after Brain's longest wait. Brain sees the
 * day, the crates and the owner's values (never the asking fee or the
 * limits). Until it answers the shipper sends nothing; past
 * `SHIPPER_FEE_WAIT_MS`, or with no budget, or with no door to Brain, the
 * asking fee goes. Undefined: the asking fee, no Brain at all.
 */
async function brainFee(
  sellerDid: string,
  request: OptionRequestBody,
  nowMs: number,
  mayAsk: boolean,
  brainModel: () => ValueModel,
): Promise<((bounds: { day: string; crates: number; slackMs: number }) => bigint | 'asking' | 'wait') | undefined> {
  const turns = feeTurns;
  const strategies = await getStrategyStore();
  if (turns === null || strategies === null) return undefined;
  const settings = strategies.settings(SHIPPER_KIND);
  const turnId = shipperTurnId(sellerDid, request.request_id);
  const turn = turns.get(SHIPPER_KIND, turnId, 0);
  // An answer Brain already gave stands, whoever the strategy is now: the
  // seller's resend must get the same option.
  if (turn !== null && turn.state === 'applied') {
    const fee = turn.result.fee;
    if (typeof fee === 'string' && /^(0|[1-9][0-9]{0,17})$/.test(fee)) return () => BigInt(fee);
  }
  if (settings.strategy !== 'brain') return undefined;
  return ({ day, crates, slackMs }) => {
    if (turn !== null) {
      if (turn.state !== 'pending') return 'asking';
      if (nowMs - turn.createdAt < SHIPPER_FEE_WAIT_MS && slackMs > 0) return 'wait';
      turns.close(SHIPPER_KIND, turnId, 0, 'fallen_back');
      return 'asking';
    }
    // Too near the run to wait for Brain: the asking fee goes at once. With no
    // answer, the asking fee goes on the seller's next resend, an hour on, so
    // the hold must still fit then.
    if (!mayAsk || feeSubmitter === null || slackMs < RESEND_EVERY_MS + RESEND_MARGIN_MS) return 'asking';
    const model = brainModel();
    if (!strategies.canSpend({ kind: SHIPPER_KIND, negotiationId: turnId, nowMs, thresholdVersion: model.version }).ok)
      return 'asking';
    const submitted = feeSubmitter({
      kind: SHIPPER_KIND,
      ref: { negotiationId: turnId, turn: 0 },
      side: 'seller',
      parts: [{ name: 'fee', kind: 'money', payer: 'buyer', payee: 'seller' }],
      table: { service_day: day, crates },
      history: [],
      model: { ...projectModel(model, { valuesOn: settings.valuesOn, firstOfferOut: false }) },
      roundsLeft: 0,
      rules: [
        'You speak for a shipper. A known seller asks for a run on this day for these crates.',
        'Propose your fee in minor units, one version; Core keeps it within the owner’s limits.',
        'Never set a price for anyone outside the deal.',
      ],
    });
    if (submitted === null) return 'asking';
    turns.put({
      kind: SHIPPER_KIND,
      negotiationId: turnId,
      turn: 0,
      taskId: submitted.taskId,
      result: { seller_did: sellerDid, request },
      createdAt: nowMs,
    });
    return 'wait';
  };
}

/**
 * The commit bridge's door for Brain's fee (§15 step 11). The ids come from
 * Core's own input. One verdict is charged; a move that is not a fee, a spent
 * budget, or the owner back on the fixed style lets the asking fee go. The
 * fee is kept with the turn before anything else, and the shipper answers
 * now; the commit reports done only once the answer is decided and kept, so
 * a crash before then leaves the turn pending for the next resend.
 */
export async function commitShipperFeeMove(input: { input: unknown; result: unknown }): Promise<{
  state: 'committed';
  receipt: Record<string, unknown>;
}> {
  const turns = feeTurns;
  if (turns === null) throw new Error('shipper stores unavailable');
  const ref = (input.input as { ref?: { negotiationId?: unknown; turn?: unknown } }).ref;
  const turnId = ref?.negotiationId;
  if (typeof turnId !== 'string' || ref?.turn !== 0) throw new Error('shipper fee move: no ref');
  const turn = turns.get(SHIPPER_KIND, turnId, 0);
  if (turn === null || turn.state !== 'pending') return { state: 'committed', receipt: { outcome: 'already_applied' } };
  const sellerDid = String(turn.result.seller_did ?? '');
  const request = turn.result.request as OptionRequestBody | undefined;
  if (request === undefined || sellerDid === '' || shipperTurnId(sellerDid, request.request_id) !== turnId)
    throw new Error('shipper fee move: turn does not name its request');
  const move = (input.result as { move?: { kind?: unknown; versions?: unknown } } | null)?.move;
  const versions = Array.isArray(move?.versions) ? (move.versions as { terms?: unknown }[]) : [];
  const fee = (Array.isArray(versions[0]?.terms) ? (versions[0].terms as { name?: unknown; value?: unknown }[]) : []).find(
    (t) => t.name === 'fee' && typeof t.value === 'string' && /^(0|[1-9][0-9]{0,17})$/.test(t.value),
  )?.value as string | undefined;
  const strategies = await getStrategyStore();
  const models = await getValueModelStore();
  const nowMs = feeClock();
  let outcome = 'fixed_style';
  if (
    move?.kind === 'propose' &&
    fee !== undefined &&
    strategies !== null &&
    models !== null &&
    strategies.settings(SHIPPER_KIND).strategy === 'brain' &&
    strategies.charge({
      kind: SHIPPER_KIND,
      negotiationId: turnId,
      count: 1,
      nowMs,
      thresholdVersion: models.loadForBrain(SHIPPER_KIND).version,
    }).ok &&
    turns.close(SHIPPER_KIND, turnId, 0, 'applied', { ...turn.result, fee })
  )
    outcome = 'answered';
  if (outcome !== 'answered') turns.close(SHIPPER_KIND, turnId, 0, 'fallen_back');
  // The answer is decided now (and the option kept by the store); sending
  // is the D2D outbox's, and a lost send is replayed on the seller's resend.
  const answer = await answerRequest(sellerDid, request, nowMs, false);
  if (answer !== null && answer !== 'refused') {
    appendAudit(sellerDid, 'option_answered', request.request_id, `answer=${answer.kind} by=${outcome}`);
    await send(sellerDid, answer).catch(() => undefined);
  }
  return { state: 'committed', receipt: { outcome } };
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
      const answer = await answerRequest(fromDid, body, nowMs, true);
      if (answer === 'refused') return 'refused';
      if (answer === null) {
        // §15 step 11: Brain is choosing the fee; the seller's resend, or
        // Brain's answer, sends it.
        appendAudit(fromDid, 'option_waiting', body.request_id, 'on=brain');
        return 'kept';
      }
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
      // §15 step 12: an order that holds the exit right (by this node's own
      // copy of the quote, not the notice's word) lets the owner cancel.
      if (body.exit === true && checked.exitRight) {
        raiseCard({
          id: `option-exit-${fromDid}-${body.purchase_order_id}`,
          description:
            'A partner run your supplier booked for one of your orders ended without fault. Your order lets you cancel without charge. Approve to cancel; deny to keep it on the quote’s own terms: standard delivery, at the price without the run’s discount.',
          payload: {
            type: OPTION_EXIT_TYPE,
            supplier_did: fromDid,
            purchase_order_id: body.purchase_order_id,
          },
          correlationId: body.quote_id,
        });
        return 'kept';
      }
      raiseCard({
        id: `option-fallback-${fromDid}-${body.purchase_order_id}`,
        description:
          'A partner run your supplier booked for one of your orders ended without fault. The order stands on the quote’s own terms: standard delivery, at the price without the run’s discount.',
        payload: { type: 'option_fallback', purchase_order_id: body.purchase_order_id },
        correlationId: body.quote_id,
      });
      return 'kept';
    }
    case 'exit': {
      // The seller's side: only an order that holds the exit right and whose
      // fallback this node recorded is cancelled this way; Core cancels it
      // without asking the runner (the race against dispatch still applies).
      const store = fallbackStore;
      const po = typeof body.cancellation.purchase_order_id === 'string' ? body.cancellation.purchase_order_id : '';
      const recorded = store?.get(fromDid, po) ?? null;
      if (
        exitPort === null ||
        recorded === null ||
        recorded.role !== 'seller' ||
        !exitPort.sellerOrderHoldsExit(fromDid, po)
      )
        return 'refused';
      const outcome = exitPort.cancelForExit(fromDid, body.cancellation);
      appendAudit(fromDid, 'option_exit_resolved', po, `outcome=${outcome}`);
      return outcome === 'error' ? 'refused' : 'kept';
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
  // §15 step 12: the buyer's side — approved exits are kept and sent.
  repairApprovedExits(nowMs);
  await sendExits(nowMs);
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
