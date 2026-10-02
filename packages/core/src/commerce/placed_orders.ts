/**
 * The buyer's PLACED ORDERS (§12.7, §18) — every order this node sent,
 * settled or not, newest first, as the owner reads them.
 *
 * WHY THIS EXISTS. The phone's buyer surfaces each forget an order the moment
 * it leaves: the drafts list holds only photographed drafts, and the trade
 * inbox drops a tender once its held order is sent. `/orders/unsettled` lists
 * only the two waiting states, so an ACCEPTED order — the one with a payment
 * link, a capture, a van on the way — vanished from the phone entirely.
 *
 * MONEY-FREE, on purpose. This module reads the buyer's order record, the
 * retained proposal (for the total) and nothing else; the progress a
 * supplier's integration attached (checkout link, payment, fulfilment) lives
 * on the money line (`order_attachments.ts`) and is joined by the route only
 * while the Commerce Pack is active. A consumer with the money plugin
 * uninstalled still sees every order it placed and what the supplier said.
 *
 * ONE PROJECTION for the headline: `describeOrderForOwner`, the same function
 * `/orders/unsettled` and `/orders/command` answer with, so this list can never
 * call an order something the other two surfaces do not.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { describeOrderForOwner, type OwnerOrderView } from './buyer_reconciliation';
import { rehydratePurchaseOrder } from './rehydrate';
import { offeredName } from './tender_story';

import type { CommerceRuntime } from './runtime';
import type {
  Money,
  ProductRef,
  PurchaseOrderLine,
  Quantity,
  Sha256Fn,
} from '@dina/commerce-protocol';

const hash: Sha256Fn = (data) => sha256(data);

/** Default and ceiling for one page of the list. */
export const PLACED_ORDERS_DEFAULT_LIMIT = 20;
export const PLACED_ORDERS_MAX_LIMIT = 100;

/** One line of a placed order, named the way the supplier named it. */
export interface PlacedOrderLine {
  lineId: string;
  product: ProductRef;
  quantity: Quantity;
  /** The supplier's name for the item from its signed quote; null when it gave none. */
  name: string | null;
}

export interface PlacedOrderBase extends OwnerOrderView {
  supplierDid: string;
  /**
   * The supplier's listing the order went to ('' on a record that predates
   * it) — what a surface names the supplier by when the owner has no contact
   * name for them (`at://<did>/com.dinakernel.service.profile/<rkey>`).
   */
  serviceRkey: string;
  /** What the owner calls this supplier, when Core knows; null otherwise. */
  supplierName: string | null;
  /** The approved total from the retained proposal; null when it cannot be read back. */
  total: Money | null;
  /** The proposal's `submitted_at`; null when it cannot be read back. */
  submittedAt: string | null;
  /** The order digest the record is bound to ('' on a record that predates it). */
  orderDigest: string;
  /** The quote the order accepted ('' when the proposal cannot be read back). */
  quoteId: string;
  /** The accepted lines; [] when the proposal cannot be read back. */
  lines: PlacedOrderLine[];
  /** The tender the quote answered, when the order came from one; null otherwise. */
  tenderId: string | null;
}

/**
 * The proposal this node retained for the order, re-validated on the way out.
 *
 * Keyed on THIS node as buyer, which is the only side a buyer record is ever
 * about. The supplier and the id must both match: a node that also supplies
 * could hold a receipt with the same purchase-order id from another party.
 */
function retainedProposal(
  runtime: Pick<CommerceRuntime, 'receipts' | 'nodeDid'>,
  supplierDid: string,
  purchaseOrderId: string,
): { total: Money; submittedAt: string; quoteId: string; lines: PurchaseOrderLine[] } | null {
  for (const receipt of runtime.receipts.listByOrder(runtime.nodeDid(), purchaseOrderId)) {
    if (receipt.domain !== 'order') continue;
    const order = rehydratePurchaseOrder(receipt.recordJson, hash);
    if (!order.ok) continue;
    if (order.value.purchase_order_id !== purchaseOrderId) continue;
    if (order.value.supplier_did !== supplierDid) continue;
    return {
      total: order.value.approved_total,
      submittedAt: order.value.submitted_at,
      quoteId: order.value.quote_id,
      lines: order.value.accepted_lines,
    };
  }
  return null;
}

/**
 * The owner's placed orders, newest placed first, at most `limit`.
 *
 * `nameFor` is injected so this module stays out of the contacts directory:
 * the route decides where a supplier's name comes from, and a lookup that
 * throws answers "no name" rather than failing the list.
 */
/**
 * Each tender member's quote, keyed `supplier|quote`, so an order finds the
 * tender its quote answered. Read once per list; a phone holds few tenders.
 */
function tendersByQuote(tenders: CommerceRuntime['tenders'] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (tenders === undefined) return out;
  for (const tender of tenders.listTenders()) {
    for (const member of tenders.listMembers(tender.tenderId)) {
      if (member.quoteId !== '')
        out.set(`${member.supplierDid}|${member.quoteId}`, tender.tenderId);
    }
  }
  return out;
}

/** The accepted lines, each named by the supplier's own signed quote where it named it. */
function namedLines(
  quotes: CommerceRuntime['buyerQuotes'] | undefined,
  supplierDid: string,
  quoteId: string,
  lines: readonly PurchaseOrderLine[],
): PlacedOrderLine[] {
  const quoted = quotes?.chain(supplierDid, quoteId).at(-1)?.lines ?? [];
  return lines.map((line) => {
    const match = quoted.find(
      (q) =>
        q.offered_product.scheme === line.product.scheme &&
        q.offered_product.value === line.product.value,
    );
    return {
      lineId: line.line_id,
      product: line.product,
      quantity: line.quantity,
      name: match === undefined ? null : offeredName(match),
    };
  });
}

export function listPlacedOrders(
  runtime: Pick<CommerceRuntime, 'buyerOrders' | 'receipts' | 'nodeDid'> &
    Partial<Pick<CommerceRuntime, 'tenders' | 'buyerQuotes'>>,
  args: { limit: number; nameFor?: (did: string) => string | null },
): PlacedOrderBase[] {
  let nodeDid = '';
  try {
    nodeDid = runtime.nodeDid();
  } catch {
    // No Business DID yet: nothing was retained under it, so no totals — but
    // the orders themselves are still the owner's to see.
  }
  const tenderOf = tendersByQuote(runtime.tenders);
  return runtime.buyerOrders.listRecent(args.limit).map(({ supplierDid, record }) => {
    let supplierName: string | null = null;
    if (args.nameFor !== undefined) {
      try {
        const name = args.nameFor(supplierDid);
        supplierName = typeof name === 'string' && name.trim() !== '' ? name : null;
      } catch {
        supplierName = null;
      }
    }
    const proposal =
      nodeDid === ''
        ? null
        : retainedProposal(
            { receipts: runtime.receipts, nodeDid: () => nodeDid },
            supplierDid,
            record.purchaseOrderId,
          );
    return {
      supplierDid,
      serviceRkey: record.serviceRkey,
      supplierName,
      total: proposal?.total ?? null,
      submittedAt: proposal?.submittedAt ?? null,
      orderDigest: record.orderDigest,
      quoteId: proposal?.quoteId ?? '',
      lines:
        proposal === null
          ? []
          : namedLines(runtime.buyerQuotes, supplierDid, proposal.quoteId, proposal.lines),
      tenderId:
        proposal === null ? null : (tenderOf.get(`${supplierDid}|${proposal.quoteId}`) ?? null),
      ...describeOrderForOwner(record),
    };
  });
}
