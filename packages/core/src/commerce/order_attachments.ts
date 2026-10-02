/**
 * Order attachments (JIFFY_MERCHANT_INTEGRATION_PLAN §3.3, Piece C) — the
 * money-line module for connector evidence bound to an accepted order.
 *
 * THE ONE RULE. An attachment is authored by an INTEGRATION (a paired staff
 * device under an `integration_trade_evidence` grant) and attributed to it.
 * It is never a supplier's act and never a buyer's: it advances no
 * `OrderState` (dispatch and delivery stay the owner's `preparing` /
 * `dispatched` / `delivered`), folds into no khata balance, and records no
 * payment. What it does is put a fact in front of the buyer — a checkout
 * link, "the processor says captured", "production started" — and the
 * buyer's node turns two of those into the OWNER's questions: open this
 * link? record this as paid? A yes to the second authors a `PaymentNote`
 * under the buyer's own key, the ordinary khata document, and the supplier
 * acknowledges it as they acknowledge any other. Four facts, four authors.
 *
 * BOTH SIDES RETAIN. The supplier keeps what its connector attached (with
 * the command id, for idempotency, and the device it came from); the buyer
 * keeps what arrived (with the signed envelope). Each verifies the
 * attachment against the order IT holds: the digest, the parties, the
 * acceptance, and for a checkout the accepted total to the paisa. A
 * receiver trusts none of it on the sender's word.
 *
 * Why the MONEY line: an attachment carries amounts and a payment link, a
 * yes to it authors a khata document, and the Commerce Pack's status rail
 * may weigh it. So it rides `commerce.trade`, spools with the khata while
 * the pack is off, and lives in `CommerceMoneyStores`.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  MAX_EVIDENCE_REFS,
  ORDER_ATTACHMENT_KINDS,
  readOrderAttachment,
  tradeRecordDigest,
  verifyOrderAttachmentAgainstOrder,
  type Money,
  type OrderAttachment,
  type OrderAttachmentKind,
  type PaymentMethod,
  type PurchaseOrderProposal,
  type Sha256Fn,
} from '@dina/commerce-protocol';
import { canonicalJson } from '@dina/protocol';

import { appendAudit } from '../audit/service';
import { getContact } from '../contacts/directory';
import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../workflow/domain';
import { WorkflowConflictError } from '../workflow/repository';
import {
  getWorkflowService,
  type ApprovalDecisionHandler,
  type WorkflowHooks,
  type WorkflowService,
} from '../workflow/service';

import { ORDER_CHECKOUT_LINK_TYPE, PAYMENT_EVIDENCE_RECORD_TYPE } from './integration';
import { rehydrateOrderAttachment, rehydratePaymentNote } from './money_rehydrate';
import { rehydrateAcknowledgement, rehydratePurchaseOrder } from './rehydrate';
import { getCommerceRuntime, type CommerceMoneyStores, type CommerceRuntime } from './runtime';
import { getTradeDocumentDispatcher } from './trade_dispatch';
import { TradeLedgerService } from './trade_ledger_service';
import { tradeRelationshipReaders } from './trade_readers';

import type { TradeIngest } from './trade_ledger';
import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

const hash: Sha256Fn = (data) => sha256(data);

function hexDigest(text: string): string {
  return bytesToHex(hash(new TextEncoder().encode(text)));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface OrderAttachmentRow {
  attachmentDigest: string;
  kind: OrderAttachmentKind;
  orderDigest: string;
  purchaseOrderId: string;
  /** The OTHER party: the buyer on the supplier's node, the supplier on the buyer's. */
  counterpartyDid: string;
  direction: 'inbound' | 'outbound';
  /** The integration device the supplier node attributes the document to. */
  sourceDeviceDid: string;
  /** The connector's command id — authoring side only; null on the buyer's rows. */
  commandId: string | null;
  recordJson: string;
  evidenceJson: string;
  createdAt: number;
}

export interface OrderAttachmentRepository {
  /** First-writer-wins on the attachment digest. False when already stored. */
  put(row: OrderAttachmentRow): boolean;
  get(attachmentDigest: string): OrderAttachmentRow | null;
  getByCommandId(commandId: string): OrderAttachmentRow | null;
  /** Every attachment on one order, oldest first. */
  listByOrder(orderDigest: string): OrderAttachmentRow[];
}

function rowFromDb(row: DBRow): OrderAttachmentRow {
  const kind = String(row.kind);
  return {
    attachmentDigest: String(row.attachment_digest),
    kind: (ORDER_ATTACHMENT_KINDS as readonly string[]).includes(kind)
      ? (kind as OrderAttachmentKind)
      : 'fulfilment_evidence',
    orderDigest: String(row.order_digest),
    purchaseOrderId: String(row.purchase_order_id),
    counterpartyDid: String(row.counterparty_did),
    direction: String(row.direction) === 'outbound' ? 'outbound' : 'inbound',
    sourceDeviceDid: String(row.source_device_did),
    commandId:
      row.command_id === null || row.command_id === undefined ? null : String(row.command_id),
    recordJson: String(row.record_json),
    evidenceJson: String(row.evidence_json ?? '{}'),
    createdAt: Number(row.created_at),
  };
}

export class SQLiteOrderAttachmentRepository implements OrderAttachmentRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  put(row: OrderAttachmentRow): boolean {
    try {
      return (
        this.db.run(
          `INSERT INTO commerce_order_attachments
             (attachment_digest, kind, order_digest, purchase_order_id, counterparty_did,
              direction, source_device_did, command_id, record_json, evidence_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(attachment_digest) DO NOTHING`,
          [
            row.attachmentDigest,
            row.kind,
            row.orderDigest,
            row.purchaseOrderId,
            row.counterpartyDid,
            row.direction,
            row.sourceDeviceDid,
            row.commandId,
            row.recordJson,
            row.evidenceJson,
            row.createdAt,
          ],
        ) > 0
      );
    } catch {
      // The command-id unique index: a second attachment under a command id
      // that already minted one. The author checks first; this is the race.
      return false;
    }
  }

  get(attachmentDigest: string): OrderAttachmentRow | null {
    const rows = this.db.query(
      `SELECT * FROM commerce_order_attachments WHERE attachment_digest = ?`,
      [attachmentDigest],
    );
    return rows[0] === undefined ? null : rowFromDb(rows[0]);
  }

  getByCommandId(commandId: string): OrderAttachmentRow | null {
    const rows = this.db.query(`SELECT * FROM commerce_order_attachments WHERE command_id = ?`, [
      commandId,
    ]);
    return rows[0] === undefined ? null : rowFromDb(rows[0]);
  }

  listByOrder(orderDigest: string): OrderAttachmentRow[] {
    return this.db
      .query(
        `SELECT * FROM commerce_order_attachments WHERE order_digest = ? ORDER BY created_at, attachment_digest`,
        [orderDigest],
      )
      .map(rowFromDb);
  }
}

export class InMemoryOrderAttachmentRepository implements OrderAttachmentRepository {
  private readonly rows = new Map<string, OrderAttachmentRow>();

  put(row: OrderAttachmentRow): boolean {
    if (this.rows.has(row.attachmentDigest)) return false;
    if (row.commandId !== null && this.getByCommandId(row.commandId) !== null) return false;
    this.rows.set(row.attachmentDigest, { ...row });
    return true;
  }

  get(attachmentDigest: string): OrderAttachmentRow | null {
    const row = this.rows.get(attachmentDigest);
    return row === undefined ? null : { ...row };
  }

  getByCommandId(commandId: string): OrderAttachmentRow | null {
    for (const row of this.rows.values()) if (row.commandId === commandId) return { ...row };
    return null;
  }

  listByOrder(orderDigest: string): OrderAttachmentRow[] {
    return [...this.rows.values()]
      .filter((row) => row.orderDigest === orderDigest)
      .map((row) => ({ ...row }))
      .sort(
        (a, b) => a.createdAt - b.createdAt || a.attachmentDigest.localeCompare(b.attachmentDigest),
      );
  }
}

/** Every readable attachment on an order; a row that fails rehydration is skipped, never half-believed. */
export function listOrderAttachments(
  stores: Pick<CommerceMoneyStores, 'orderAttachments'>,
  orderDigest: string,
): { row: OrderAttachmentRow; attachment: OrderAttachment }[] {
  const out: { row: OrderAttachmentRow; attachment: OrderAttachment }[] = [];
  for (const row of stores.orderAttachments.listByOrder(orderDigest)) {
    const read = rehydrateOrderAttachment(row.recordJson, hash);
    if (read.ok && read.value.attachment_digest === row.attachmentDigest)
      out.push({ row, attachment: read.value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Supplier: a connector attaches evidence
// ---------------------------------------------------------------------------

export type AttachOutcome =
  | { ok: true; attachment: OrderAttachment; replayed: boolean }
  | { ok: false; status: 400 | 404 | 409; refusal: string; detail?: string };

/** The content a command commits to; a replay must match it exactly. */
function attachmentContentDigest(input: {
  order_digest: string;
  kind: string;
  payload: unknown;
  expires_at?: string;
}): string {
  return hexDigest(canonicalJson(input));
}

/**
 * The accepted order this node SUPPLIES, by digest — the retained receipt
 * (re-validated) and the durable reference with a retained `accepted`
 * acknowledgement. Anything less is not an order a connector may attach to.
 */
function acceptedOrderByDigest(
  runtime: Pick<CommerceRuntime, 'receipts' | 'orders' | 'nodeDid'>,
  orderDigest: string,
): { ok: true; order: PurchaseOrderProposal } | { ok: false; status: 404 | 409; refusal: string } {
  const receipt = runtime.receipts.get(orderDigest);
  if (receipt === null || receipt.domain !== 'order')
    return { ok: false, status: 404, refusal: 'unknown_order' };
  const order = rehydratePurchaseOrder(receipt.recordJson, hash);
  if (
    !order.ok ||
    order.value.order_digest !== orderDigest ||
    order.value.supplier_did !== runtime.nodeDid()
  ) {
    return { ok: false, status: 404, refusal: 'unknown_order' };
  }
  const ref =
    runtime.orders.load(order.value.buyer_did, order.value.purchase_order_id)?.ref ?? null;
  if (ref === null || ref.orderDigest !== orderDigest || ref.state !== 'decided') {
    return { ok: false, status: 409, refusal: 'order_not_accepted' };
  }
  const ack = rehydrateAcknowledgement(ref.acknowledgementJson, hash);
  if (!ack.ok || ack.value.kind !== 'accepted')
    return { ok: false, status: 409, refusal: 'order_not_accepted' };
  return { ok: true, order: order.value };
}

/** Whether this node SUPPLIES the order a digest names — the read door's bound for a staff caller. */
export function isSuppliedOrder(
  runtime: Pick<CommerceRuntime, 'receipts' | 'nodeDid'>,
  orderDigest: string,
): boolean {
  const receipt = runtime.receipts.get(orderDigest);
  if (receipt === null || receipt.domain !== 'order') return false;
  const order = rehydratePurchaseOrder(receipt.recordJson, hash);
  return (
    order.ok &&
    order.value.order_digest === orderDigest &&
    order.value.supplier_did === runtime.nodeDid()
  );
}

export function attachOrderEvidence(
  runtime: Pick<CommerceRuntime, 'receipts' | 'orders' | 'nodeDid' | 'now'>,
  stores: Pick<CommerceMoneyStores, 'orderAttachments'>,
  args: {
    /** The integration device that is calling — attribution comes from HERE, never the body. */
    deviceDid: string;
    provider: string;
    commandId: string;
    orderDigest: string;
    kind: string;
    payload: unknown;
    expiresAt?: string;
  },
): AttachOutcome {
  let content: string;
  try {
    content = attachmentContentDigest({
      order_digest: args.orderDigest,
      kind: args.kind,
      payload: args.payload,
      ...(args.expiresAt !== undefined ? { expires_at: args.expiresAt } : {}),
    });
  } catch {
    // `1e400` parses to Infinity and has no canonical spelling: refused, not thrown.
    return {
      ok: false,
      status: 400,
      refusal: 'invalid_attachment',
      detail: 'payload is not canonicalizable',
    };
  }
  const recorded = stores.orderAttachments.getByCommandId(args.commandId);
  if (recorded !== null) {
    const held = rehydrateOrderAttachment(recorded.recordJson, hash);
    if (!held.ok)
      return {
        ok: false,
        status: 409,
        refusal: 'command_conflict',
        detail: 'the retained attachment for this command is unreadable',
      };
    const same =
      attachmentContentDigest({
        order_digest: held.value.order_digest,
        kind: held.value.kind,
        payload: held.value.payload,
        ...(held.value.expires_at !== undefined ? { expires_at: held.value.expires_at } : {}),
      }) === content;
    return same
      ? { ok: true, attachment: held.value, replayed: true }
      : {
          ok: false,
          status: 409,
          refusal: 'command_conflict',
          detail: 'this command id was used with different content',
        };
  }
  const bound = acceptedOrderByDigest(runtime, args.orderDigest);
  if (!bound.ok) return bound;
  const order = bound.order;
  const draft = {
    protocol_version: order.protocol_version,
    attachment_id: `att_${hexDigest(`${runtime.nodeDid()}\n${args.commandId}`).slice(0, 24)}`,
    purchase_order_id: order.purchase_order_id,
    buyer_did: order.buyer_did,
    supplier_did: order.supplier_did,
    order_digest: order.order_digest,
    kind: args.kind,
    source: { kind: 'integration', device_did: args.deviceDid, provider: args.provider },
    payload: args.payload,
    issued_at: new Date(runtime.now()).toISOString(),
    ...(args.expiresAt !== undefined ? { expires_at: args.expiresAt } : {}),
  };
  let sealed: Record<string, unknown>;
  try {
    sealed = { ...draft, attachment_digest: tradeRecordDigest('order_attachment', draft, hash) };
  } catch {
    return {
      ok: false,
      status: 400,
      refusal: 'invalid_attachment',
      detail: 'payload is not canonicalizable',
    };
  }
  const read = readOrderAttachment(sealed, hash);
  if (!read.ok)
    return { ok: false, status: 400, refusal: 'invalid_attachment', detail: read.error };
  const binding = verifyOrderAttachmentAgainstOrder(read.attachment, order);
  if (binding !== null) {
    return read.attachment.kind === 'checkout_handoff' && binding.includes('total')
      ? { ok: false, status: 409, refusal: 'amount_mismatch', detail: binding }
      : { ok: false, status: 409, refusal: 'order_binding', detail: binding };
  }
  const stored = stores.orderAttachments.put({
    attachmentDigest: read.attachment.attachment_digest,
    kind: read.attachment.kind,
    orderDigest: order.order_digest,
    purchaseOrderId: order.purchase_order_id,
    counterpartyDid: order.buyer_did,
    direction: 'outbound',
    sourceDeviceDid: args.deviceDid,
    commandId: args.commandId,
    recordJson: JSON.stringify(read.attachment),
    evidenceJson: '{}',
    createdAt: runtime.now(),
  });
  if (stored) {
    appendAudit(
      'integration',
      'order_attachment_authored',
      read.attachment.attachment_digest,
      `kind=${read.attachment.kind} device=${args.deviceDid} provider=${args.provider}`,
    );
    return { ok: true, attachment: read.attachment, replayed: false };
  }
  // The same bytes under another command id, or a raced command: whatever
  // is retained is the answer.
  const held =
    stores.orderAttachments.get(read.attachment.attachment_digest) ??
    stores.orderAttachments.getByCommandId(args.commandId);
  const value = held === null ? null : rehydrateOrderAttachment(held.recordJson, hash);
  if (value !== null && value.ok) return { ok: true, attachment: value.value, replayed: true };
  return { ok: false, status: 409, refusal: 'command_conflict' };
}

/**
 * The attachment digests a supplier's next status carries (plan §3.3):
 * captured payments and started production, oldest first, bounded the way
 * the wire bounds `evidence_refs` — the most recent stay when there are
 * more. Evidence only: nothing here moves the state.
 */
export function pendingEvidenceRefs(
  stores: Pick<CommerceMoneyStores, 'orderAttachments'>,
  orderDigest: string,
): string[] {
  const refs: string[] = [];
  for (const { row, attachment } of listOrderAttachments(stores, orderDigest)) {
    if (row.direction !== 'outbound') continue;
    const counts =
      (attachment.kind === 'payment_evidence' && attachment.payload.state === 'captured') ||
      (attachment.kind === 'fulfilment_evidence' &&
        attachment.payload.state === 'production_started');
    if (counts) refs.push(attachment.attachment_digest);
  }
  return refs.slice(-MAX_EVIDENCE_REFS);
}

// ---------------------------------------------------------------------------
// Buyer: an attachment arrives
// ---------------------------------------------------------------------------

export function verifyInboundOrderAttachment(args: {
  senderDid: string;
  selfDid: string;
  attachment: unknown;
  repository: OrderAttachmentRepository;
  readOrder: (counterpartyDid: string, purchaseOrderId: string) => PurchaseOrderProposal | null;
  readAcceptance: (
    counterpartyDid: string,
    purchaseOrderId: string,
  ) => { acceptedAt: string } | null;
  evidenceJson: string;
  nowMs: number;
}): TradeIngest & { attachment?: OrderAttachment } {
  const read = readOrderAttachment(args.attachment, hash);
  if (!read.ok) return { outcome: 'unreadable', detail: read.error };
  const attachment = read.attachment;
  if (attachment.supplier_did !== args.senderDid) {
    return {
      outcome: 'not_ours',
      detail: 'attachment: supplier_did is not the authenticated sender',
    };
  }
  if (attachment.buyer_did !== args.selfDid) {
    return { outcome: 'not_ours', detail: 'attachment: buyer_did is not this node' };
  }
  const order = args.readOrder(args.senderDid, attachment.purchase_order_id);
  if (order === null)
    return { outcome: 'refused', detail: 'attachment: no retained order with that id' };
  const binding = verifyOrderAttachmentAgainstOrder(attachment, order);
  if (binding !== null) return { outcome: 'refused', detail: binding };
  // The acceptance may still be on its way (the connector saw `accepted` on the
  // supplier before the acknowledgement reached this node). The attachment
  // binds to the order this node holds, so it is RETAINED; the owner's card
  // waits for the acceptance, which `notifyAcceptanceRetained` announces.
  const accepted = args.readAcceptance(args.senderDid, attachment.purchase_order_id) !== null;
  const stored = args.repository.put({
    attachmentDigest: attachment.attachment_digest,
    kind: attachment.kind,
    orderDigest: attachment.order_digest,
    purchaseOrderId: attachment.purchase_order_id,
    counterpartyDid: args.senderDid,
    direction: 'inbound',
    sourceDeviceDid: attachment.source.device_did,
    commandId: null,
    recordJson: JSON.stringify(attachment),
    evidenceJson: args.evidenceJson,
    createdAt: args.nowMs,
  });
  if (!stored) return { outcome: 'duplicate', recordDigest: attachment.attachment_digest };
  return accepted
    ? { outcome: 'applied', recordDigest: attachment.attachment_digest, attachment }
    : {
        outcome: 'applied',
        recordDigest: attachment.attachment_digest,
        detail: 'awaiting_acceptance',
      };
}

// ---------------------------------------------------------------------------
// Buyer: what a placed order has got to (the "Placed orders" list)
// ---------------------------------------------------------------------------

/**
 * A placed order's progress, read from the evidence the supplier's
 * integration attached and from the buyer's own khata. A READ: it raises no
 * card and authors nothing — the cards are the questions, this is the
 * summary an owner scrolls past.
 *
 * Each field is the NEWEST word on its subject and claims no more than the
 * evidence does: `payment` is what the processor reported, `paymentRecorded`
 * is whether THIS buyer authored a PaymentNote for the order, and the two are
 * reported separately because "the processor says captured" is not "you
 * recorded it as paid".
 */
export interface PlacedOrderProgress {
  /** The latest checkout link; https only (the wire already refuses anything else). */
  checkoutLink: {
    url: string;
    amount: Money;
    provider: string;
    expiresAt: string | null;
    /** True when `expiresAt` has passed — shown as history, never offered. */
    expired: boolean;
  } | null;
  /** The newest revision of the most recently reported processor payment. */
  payment: {
    state: 'authorized' | 'captured' | 'refunded' | 'failed';
    amount: Money;
    provider: string;
  } | null;
  /** Whether this buyer authored a PaymentNote naming the order (or its processor payment). */
  paymentRecorded: boolean;
  /** The newest fulfilment step the supplier's integration reported. */
  fulfilment: {
    state: 'production_started' | 'ready' | 'handed_to_carrier';
    provider: string;
    reportedAt: string;
  } | null;
}

/** Newest per `provider_ref` by `version`, then the one whose newest row arrived last. */
function newestByRef<T extends { payload: { provider_ref: string; version: string } }>(
  entries: { createdAt: number; attachment: T }[],
): T | null {
  const byRef = new Map<string, { createdAt: number; attachment: T }>();
  for (const entry of entries) {
    const held = byRef.get(entry.attachment.payload.provider_ref);
    if (
      held === undefined ||
      BigInt(entry.attachment.payload.version) > BigInt(held.attachment.payload.version)
    ) {
      byRef.set(entry.attachment.payload.provider_ref, entry);
    }
  }
  let latest: { createdAt: number; attachment: T } | null = null;
  for (const entry of byRef.values()) {
    if (latest === null || entry.createdAt >= latest.createdAt) latest = entry;
  }
  return latest?.attachment ?? null;
}

export function summarizePlacedOrderProgress(
  stores: Pick<CommerceMoneyStores, 'orderAttachments' | 'tradeDocuments'>,
  order: { orderDigest: string; supplierDid: string; purchaseOrderId: string },
  nowMs: number,
): PlacedOrderProgress {
  const checkouts: (OrderAttachment & { kind: 'checkout_handoff' })[] = [];
  const payments: {
    createdAt: number;
    attachment: OrderAttachment & { kind: 'payment_evidence' };
  }[] = [];
  const steps: {
    createdAt: number;
    attachment: OrderAttachment & { kind: 'fulfilment_evidence' };
  }[] = [];
  // An order this node cannot restate (a pre-digest record) has no evidence
  // it can bind, so it reads as "nothing attached" rather than as a lookup on ''.
  if (order.orderDigest !== '') {
    for (const { row, attachment } of listOrderAttachments(stores, order.orderDigest)) {
      // INBOUND, from this order's supplier, about this order. On a node that
      // also supplies, the same store holds what its own connector authored.
      if (row.direction !== 'inbound') continue;
      if (attachment.supplier_did !== order.supplierDid) continue;
      if (attachment.purchase_order_id !== order.purchaseOrderId) continue;
      if (attachment.kind === 'checkout_handoff') checkouts.push(attachment);
      else if (attachment.kind === 'payment_evidence')
        payments.push({ createdAt: row.createdAt, attachment });
      else steps.push({ createdAt: row.createdAt, attachment });
    }
  }

  // The newest link wins (rows are oldest first); a later one supersedes it,
  // as it supersedes the pending card. Belt and braces on https: the validator
  // already refuses anything else, and the phone opens what this returns.
  const link = checkouts[checkouts.length - 1] ?? null;
  const checkoutLink =
    link === null || !link.payload.url.startsWith('https://')
      ? null
      : {
          url: link.payload.url,
          amount: link.payload.amount,
          provider: link.source.provider,
          expiresAt: link.expires_at ?? null,
          expired: link.expires_at !== undefined && Date.parse(link.expires_at) <= nowMs,
        };

  const payment = newestByRef(payments);
  const step = newestByRef(steps);

  const refs = new Set(payments.map((p) => p.attachment.payload.provider_ref));
  const paymentRecorded = stores.tradeDocuments
    .listByCounterparty(order.supplierDid, 'payment_note')
    .some((row) => {
      if (row.direction !== 'outbound') return false;
      const note = rehydratePaymentNote(row.recordJson, hash);
      if (!note.ok) return false;
      return (
        (note.value.order_refs ?? []).includes(order.purchaseOrderId) ||
        (note.value.external_ref !== undefined && refs.has(note.value.external_ref))
      );
    });

  return {
    checkoutLink,
    payment:
      payment === null
        ? null
        : {
            state: payment.payload.state,
            amount: payment.payload.amount,
            provider: payment.source.provider,
          },
    paymentRecorded,
    fulfilment:
      step === null
        ? null
        : { state: step.payload.state, provider: step.source.provider, reportedAt: step.issued_at },
  };
}

// ---------------------------------------------------------------------------
// The owner's two questions
// ---------------------------------------------------------------------------

// The two card types are declared on the money-free surface
// (`integration.ts`) so the workflow routes can fence them; the cards
// themselves — "open this payment link?" and "record this as paid?" — are
// minted here, on the money line, where a yes to the second authors a
// PaymentNote.

export interface CheckoutLinkCardPayload {
  type: typeof ORDER_CHECKOUT_LINK_TYPE;
  attachment_digest: string;
  purchase_order_id: string;
  supplier_did: string;
  provider: string;
  session_ref: string;
  url: string;
  amount: Money;
  expires_at?: string;
}

export interface PaymentEvidenceCardPayload {
  type: typeof PAYMENT_EVIDENCE_RECORD_TYPE;
  attachment_digest: string;
  purchase_order_id: string;
  supplier_did: string;
  provider: string;
  provider_ref: string;
  amount: Money;
  method?: PaymentMethod;
}

export type RaisedCard =
  | { raised: true; taskId: string }
  | {
      raised: false;
      reason:
        | 'not_a_card'
        | 'already_recorded'
        | 'expired'
        | 'superseded'
        | 'already_decided'
        | 'no_workflow'
        | 'refused';
      detail?: string;
    };

/** The owner's name for a supplier on a card line: their contact name, else "the supplier". */
function supplierLabel(supplierDid: string): string {
  try {
    const name = getContact(supplierDid)?.displayName.trim() ?? '';
    return name === '' ? 'the supplier' : name;
  } catch {
    return 'the supplier';
  }
}

function shortMoney(amount: Money): string {
  const units = amount.minor_units;
  const whole = units.length > 2 ? units.slice(0, -2) : '0';
  const frac = units.padStart(3, '0').slice(-2);
  return `${amount.currency} ${whole}.${frac}`;
}

function paymentAlreadyRecorded(
  stores: Pick<CommerceMoneyStores, 'tradeDocuments'>,
  supplierDid: string,
  providerRef: string,
): boolean {
  return stores.tradeDocuments.listByCounterparty(supplierDid, 'payment_note').some((row) => {
    if (row.direction !== 'outbound') return false;
    const note = rehydratePaymentNote(row.recordJson, hash);
    return note.ok && note.value.external_ref === providerRef;
  });
}

/**
 * The newest retained revision of ONE processor payment on an order — the
 * inbound `payment_evidence` rows sharing the attachment's supplier and
 * `provider_ref`, compared by `version` as integers.
 */
function newestPaymentEvidence(
  stores: Pick<CommerceMoneyStores, 'orderAttachments'>,
  like: { order_digest: string; supplier_did: string; payload: { provider_ref: string } },
): (OrderAttachment & { kind: 'payment_evidence' }) | null {
  let newest: (OrderAttachment & { kind: 'payment_evidence' }) | null = null;
  for (const { row, attachment } of listOrderAttachments(stores, like.order_digest)) {
    if (row.direction !== 'inbound' || attachment.kind !== 'payment_evidence') continue;
    if (attachment.supplier_did !== like.supplier_did) continue;
    if (attachment.payload.provider_ref !== like.payload.provider_ref) continue;
    if (newest === null || BigInt(attachment.payload.version) > BigInt(newest.payload.version)) {
      newest = attachment;
    }
  }
  return newest;
}

function sameMoney(a: Money, b: Money): boolean {
  return a.currency === b.currency && BigInt(a.minor_units) === BigInt(b.minor_units);
}

function paymentCardId(supplierDid: string, providerRef: string): string {
  return `payment-evidence-${hexDigest(`${supplierDid}\n${providerRef}`).slice(0, 32)}`;
}

function cardFor(
  stores: Pick<CommerceMoneyStores, 'tradeDocuments' | 'orderAttachments'>,
  attachment: OrderAttachment,
  nowMs: number,
):
  | {
      id: string;
      idempotencyKey: string;
      description: string;
      payload: CheckoutLinkCardPayload | PaymentEvidenceCardPayload;
      expiresAtSec?: number;
    }
  | RaisedCard {
  const shared = {
    attachment_digest: attachment.attachment_digest,
    purchase_order_id: attachment.purchase_order_id,
    supplier_did: attachment.supplier_did,
    provider: attachment.source.provider,
  };
  if (attachment.kind === 'checkout_handoff') {
    // A link that has already lapsed is evidence, not a question (Silence First).
    if (attachment.expires_at !== undefined && Date.parse(attachment.expires_at) <= nowMs) {
      return { raised: false, reason: 'expired' };
    }
    const payload: CheckoutLinkCardPayload = {
      type: ORDER_CHECKOUT_LINK_TYPE,
      ...shared,
      session_ref: attachment.payload.session_ref,
      url: attachment.payload.url,
      amount: attachment.payload.amount,
      ...(attachment.expires_at !== undefined ? { expires_at: attachment.expires_at } : {}),
    };
    return {
      id: `order-checkout-${attachment.attachment_digest.slice(0, 32)}`,
      idempotencyKey: `order_attachment:${attachment.attachment_digest}`,
      // Named by the supplier (the owner's contact name), never `po_…`: this
      // line is the card's and the Activity title. The order id stays in the payload.
      description: `Pay ${shortMoney(attachment.payload.amount)} to ${supplierLabel(attachment.supplier_did)} through ${attachment.source.provider}?`,
      payload,
      ...(attachment.expires_at !== undefined
        ? { expiresAtSec: Math.floor(Date.parse(attachment.expires_at) / 1000) }
        : {}),
    };
  }
  if (attachment.kind === 'payment_evidence') {
    // Only the NEWEST revision of a processor payment speaks: a `captured`
    // carried by an older-numbered message after a `refunded` raises nothing,
    // and a non-captured newest revision is the processor's own answer.
    const newest = newestPaymentEvidence(stores, attachment);
    if (
      newest !== null &&
      newest.attachment_digest !== attachment.attachment_digest &&
      BigInt(newest.payload.version) >= BigInt(attachment.payload.version)
    ) {
      return { raised: false, reason: 'superseded' };
    }
    if (attachment.payload.state !== 'captured') return { raised: false, reason: 'not_a_card' };
    if (BigInt(attachment.payload.amount.minor_units) === 0n) {
      return { raised: false, reason: 'not_a_card' };
    }
    if (paymentAlreadyRecorded(stores, attachment.supplier_did, attachment.payload.provider_ref)) {
      return { raised: false, reason: 'already_recorded' };
    }
    const payload: PaymentEvidenceCardPayload = {
      type: PAYMENT_EVIDENCE_RECORD_TYPE,
      ...shared,
      provider_ref: attachment.payload.provider_ref,
      amount: attachment.payload.amount,
      ...(attachment.payload.method !== undefined ? { method: attachment.payload.method } : {}),
    };
    // One question per processor payment, whatever revision reported it.
    return {
      id: paymentCardId(attachment.supplier_did, attachment.payload.provider_ref),
      idempotencyKey: `payment_evidence_record:${attachment.supplier_did}:${attachment.payload.provider_ref}`,
      description: `Record ${shortMoney(attachment.payload.amount)} as paid to ${supplierLabel(attachment.supplier_did)}? ${attachment.source.provider} reports it captured.`,
      payload,
    };
  }
  return { raised: false, reason: 'not_a_card' };
}

/**
 * Put the owner's question on the inbox for an attachment that just landed.
 * Never throws into the ingress path — the attachment is already retained,
 * and a fault here must not turn an accepted document into a failed receive.
 */
export function raiseOrderAttachmentCard(
  stores: Pick<CommerceMoneyStores, 'tradeDocuments' | 'orderAttachments'>,
  attachment: OrderAttachment,
  nowMs: number,
  workflow: WorkflowService | null = getWorkflowService(),
): RaisedCard {
  try {
    if (workflow === null) return { raised: false, reason: 'no_workflow' };
    const store = workflow.store();
    const pendingOn = (type: string): WorkflowTask[] =>
      store
        .getByCorrelationId(attachment.purchase_order_id)
        .filter(
          (t) =>
            t.kind === WorkflowTaskKind.Approval &&
            t.status === WorkflowTaskState.PendingApproval &&
            readCardPayload(t)?.type === type,
        );
    // A processor's later word withdraws the question it answers: a refunded or
    // failed revision that is now the newest closes a pending "record as paid?".
    if (attachment.kind === 'payment_evidence' && attachment.payload.state !== 'captured') {
      const newest = newestPaymentEvidence(stores, attachment);
      if (newest === null || newest.attachment_digest === attachment.attachment_digest) {
        for (const stale of pendingOn(PAYMENT_EVIDENCE_RECORD_TYPE)) {
          const p = readCardPayload(stale);
          if (
            p !== null &&
            p.type === PAYMENT_EVIDENCE_RECORD_TYPE &&
            p.provider_ref === attachment.payload.provider_ref
          ) {
            workflow.cancel(stale.id, 'superseded_by_processor');
            appendAudit(
              'integration',
              'order_attachment_card_withdrawn',
              stale.id,
              `kind=${attachment.kind} state=${attachment.payload.state}`,
            );
          }
        }
      }
    }
    const card = cardFor(stores, attachment, nowMs);
    if ('raised' in card) return card;
    // One payment link per order: a newer checkout supersedes the pending one.
    if (attachment.kind === 'checkout_handoff') {
      for (const stale of pendingOn(ORDER_CHECKOUT_LINK_TYPE)) {
        if (stale.id === card.id) continue;
        workflow.cancel(stale.id, 'superseded');
        appendAudit(
          'integration',
          'order_attachment_card_withdrawn',
          stale.id,
          'kind=checkout_handoff superseded',
        );
      }
    }
    const create = (id: string, idempotencyKey: string): void => {
      workflow.create({
        id,
        kind: WorkflowTaskKind.Approval,
        description: card.description,
        payload: JSON.stringify(card.payload),
        idempotencyKey,
        correlationId: attachment.purchase_order_id,
        origin: 'system',
        initialState: WorkflowTaskState.PendingApproval,
        ...(card.expiresAtSec !== undefined ? { expiresAtSec: card.expiresAtSec } : {}),
      });
    };
    let taskId = card.id;
    try {
      create(card.id, card.idempotencyKey);
    } catch (error) {
      if (!(error instanceof WorkflowConflictError)) throw error;
      const existing = store.getById(card.id);
      if (existing === null) throw error;
      if (existing.status === WorkflowTaskState.PendingApproval) {
        return { raised: true, taskId: card.id };
      }
      // The owner already answered this question (or the store closed it): ask nothing.
      if (existing.status !== WorkflowTaskState.Failed) {
        return { raised: false, reason: 'already_decided' };
      }
      // A card that FAILED (the money line was closed at the yes) is a question
      // never answered: ask again under a revision-qualified id.
      taskId = `${card.id}-r${attachment.attachment_digest.slice(0, 8)}`;
      try {
        create(taskId, `${card.idempotencyKey}:${attachment.attachment_digest.slice(0, 16)}`);
      } catch (again) {
        if (!(again instanceof WorkflowConflictError)) throw again;
        const retry = store.getById(taskId);
        if (retry?.status === WorkflowTaskState.PendingApproval) return { raised: true, taskId };
        return { raised: false, reason: 'already_decided' };
      }
    }
    appendAudit('integration', 'order_attachment_carded', taskId, `kind=${attachment.kind}`);
    return { raised: true, taskId };
  } catch (error) {
    return {
      raised: false,
      reason: 'refused',
      detail: error instanceof Error ? error.constructor.name : typeof error,
    };
  }
}

/**
 * The acceptance arrived after an attachment did: raise the cards for every
 * inbound attachment on the order that never had one. Idempotent — a card
 * that exists is a conflict `raiseOrderAttachmentCard` already answers.
 */
export function raiseCardsForRetainedAttachments(
  stores: Pick<CommerceMoneyStores, 'tradeDocuments' | 'orderAttachments'>,
  orderDigest: string,
  nowMs: number,
  workflow: WorkflowService | null = getWorkflowService(),
): RaisedCard[] {
  return listOrderAttachments(stores, orderDigest)
    .filter(({ row }) => row.direction === 'inbound')
    .map(({ attachment }) => raiseOrderAttachmentCard(stores, attachment, nowMs, workflow));
}

function readCardPayload(
  task: WorkflowTask,
): CheckoutLinkCardPayload | PaymentEvidenceCardPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(task.payload);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (
    typeof p.supplier_did !== 'string' ||
    typeof p.purchase_order_id !== 'string' ||
    typeof p.attachment_digest !== 'string'
  )
    return null;
  if (p.amount === null || typeof p.amount !== 'object') return null;
  if (p.type === ORDER_CHECKOUT_LINK_TYPE && typeof p.url === 'string')
    return p as unknown as CheckoutLinkCardPayload;
  if (p.type === PAYMENT_EVIDENCE_RECORD_TYPE && typeof p.provider_ref === 'string')
    return p as unknown as PaymentEvidenceCardPayload;
  return null;
}

/**
 * The owner decided. A yes to a payment-evidence card authors the buyer's
 * `PaymentNote` — under the buyer's key, through the same service the
 * owner's route uses — and pushes it to the supplier best-effort; the card
 * completes with the note digest or fails with the reason. A yes to a
 * checkout card records that the link was opened; the client opened it. A
 * no or a lapse changes nothing.
 */
export function makeOrderAttachmentDecisionHandler(deps: {
  runtime: () => CommerceRuntime | null;
  workflow: () => WorkflowService | null;
  nowMs: () => number;
}): ApprovalDecisionHandler {
  return ({ task, decision }) => {
    const payload = readCardPayload(task);
    if (payload === null) return;
    appendAudit(
      'integration',
      `${payload.type}_${decision}`,
      task.id,
      `order=${payload.purchase_order_id}`,
    );
    if (decision !== 'approved') return;
    const workflow = deps.workflow();
    if (workflow === null) return;
    const settle = (
      result: { ok: true; body: Record<string, unknown> } | { ok: false; reason: string },
    ): void => {
      try {
        workflow
          .store()
          .transition(task.id, WorkflowTaskState.Queued, WorkflowTaskState.Running, deps.nowMs());
        if (result.ok) workflow.complete(task.id, JSON.stringify(result.body), payload.type);
        else workflow.fail(task.id, result.reason);
      } catch {
        /* a raced transition changes nothing the owner decided */
      }
    };
    if (payload.type === ORDER_CHECKOUT_LINK_TYPE)
      return settle({ ok: true, body: { opened: true } });
    const runtime = deps.runtime();
    if (runtime === null) return settle({ ok: false, reason: 'commerce_unavailable' });
    const money = runtime.money();
    if (!money.available)
      return settle({ ok: false, reason: `money_unavailable: ${money.reason}` });
    // The yes is checked against the record NOW, not the card's moment: the
    // khata may already hold this payment, or the processor may have spoken
    // again (a refund, a re-priced capture) since the card was raised.
    if (paymentAlreadyRecorded(money.stores, payload.supplier_did, payload.provider_ref)) {
      return settle({ ok: true, body: { already_recorded: true } });
    }
    const orderDigest = runtime.receipts
      .listByOrder(runtime.nodeDid(), payload.purchase_order_id)
      .find((r) => r.domain === 'order')?.recordDigest;
    if (orderDigest !== undefined) {
      const newest = newestPaymentEvidence(money.stores, {
        order_digest: orderDigest,
        supplier_did: payload.supplier_did,
        payload: { provider_ref: payload.provider_ref },
      });
      if (
        newest !== null &&
        (newest.payload.state !== 'captured' || !sameMoney(newest.payload.amount, payload.amount))
      ) {
        return settle({
          ok: false,
          reason: `evidence_superseded: newest revision is ${newest.payload.state}`,
        });
      }
    }
    const service = new TradeLedgerService({
      documents: money.stores.tradeDocuments,
      nodeDid: runtime.nodeDid,
      now: runtime.now,
      ...tradeRelationshipReaders(runtime),
    });
    const authored = service.issuePaymentNote({
      supplierDid: payload.supplier_did,
      amount: payload.amount,
      method: payload.method ?? 'other',
      externalRef: payload.provider_ref,
      orderRefs: [payload.purchase_order_id],
    });
    if (!authored.ok) return settle({ ok: false, reason: authored.refusal });
    // Retained first, pushed second, best-effort: the card records what the
    // push REPORTED, and the khata's unanswered-payment resend covers a miss.
    const dispatch = getTradeDocumentDispatcher();
    const noteDigest = authored.document.note_digest;
    if (dispatch === null) {
      return settle({ ok: true, body: { note_digest: noteDigest, dispatched: false } });
    }
    void dispatch(payload.supplier_did, 'payment_note', authored.document).then(
      (sent) => settle({ ok: true, body: { note_digest: noteDigest, dispatched: sent } }),
      () => settle({ ok: true, body: { note_digest: noteDigest, dispatched: false } }),
    );
  };
}

export function orderAttachmentWorkflowHooks(over: { nowMs?: () => number } = {}): WorkflowHooks {
  return {
    responseEgressGate: () => ({ kind: 'passthrough' }),
    approvalDecisionHandler: makeOrderAttachmentDecisionHandler({
      runtime: getCommerceRuntime,
      workflow: getWorkflowService,
      nowMs: over.nowMs ?? Date.now,
    }),
  };
}
