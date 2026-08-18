/**
 * The Tally bridge's Core-side half (TRADE_FIRST_STRATEGY §10).
 *
 * Distributors run Tally or Marg and will not retype. The bridge is a
 * runner-mode plugin ON THE DISTRIBUTOR'S MACHINE (its own key, private
 * lane, out of process — the plugin substrate exactly); what CORE owns
 * is the data contract that plugin pulls: a deterministic export of
 * this node's settled commerce facts as Tally-importable vouchers.
 *
 * THE BOUNDARY, stated because it is the §10 rule: the export FEEDS the
 * firm's internal books; the khata chain between parties remains the
 * shared truth. Every voucher's narration carries the digest it derives
 * from, so the books always point back at the chain — the bridge never
 * becomes an authority the counterparty must trust.
 *
 * WHAT EXPORTS, and only this: ACCEPTED orders (sales on the supplier
 * side, purchases on the buyer side) and SETTLED payments (received
 * acknowledgements, and this node's own payment notes). Nothing
 * proposed, pending or disputed reaches the books.
 */

import { moneyMinorUnits, type Money } from '@dina/commerce-protocol';

import { rehydrateAcknowledgement, rehydratePurchaseOrder } from './rehydrate';
import { rehydrateTradeDocument } from './trade_ledger';

import type { Sha256Fn } from './rehydrate';
import type { CommerceRuntime } from './runtime';

/**
 * Minor-unit exponents for the currencies the trade actually runs in.
 * Two is the ISO-4217 default; zero-exponent currencies are listed so a
 * yen amount never gains phantom decimals. Anything unknown uses 2 and
 * the caller can extend the table when a new market demands it.
 */
const CURRENCY_EXPONENTS: Record<string, number> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  JPY: 0,
  KRW: 0,
};

/** Minor units → the decimal string Tally expects. */
function tallyAmount(money: Money): string {
  const exponent = CURRENCY_EXPONENTS[money.currency] ?? 2;
  const minor = moneyMinorUnits(money);
  if (exponent === 0) return minor.toString();
  const divisor = 10n ** BigInt(exponent);
  const whole = minor / divisor;
  const fraction = (minor % divisor).toString().padStart(exponent, '0');
  return `${whole.toString()}.${fraction}`;
}

/** The five XML entities; Tally XML is plain XML. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface TallyVoucher {
  /** Tally voucher type: Sales / Purchase / Receipt / Payment. */
  vchType: 'Sales' | 'Purchase' | 'Receipt' | 'Payment';
  /** YYYYMMDD, Tally's date shape. */
  date: string;
  /** The counterparty ledger name — the DID, verbatim; the bridge maps
   *  DIDs to the firm's ledger names on its own side. */
  partyLedger: string;
  amount: string;
  currency: string;
  /** The chain reference: which digest these books derive from. */
  narration: string;
}

function tallyDate(iso: string): string {
  return iso.slice(0, 10).replaceAll('-', '');
}

/** Assemble the voucher list from this node's retained, settled facts. */
export function collectTallyVouchers(
  runtime: CommerceRuntime,
  args: { currency: string },
  sha256: Sha256Fn,
): TallyVoucher[] {
  const vouchers: TallyVoucher[] = [];
  const self = runtime.nodeDid();

  // Accepted orders — the acknowledgement store enumerated NODE-WIDE
  // (supplier-side acks live under each BUYER's key, so a self-key walk
  // would see only this node's own purchases). Priced by the order's
  // own approved total; Sales when this node supplied, Purchase when it
  // bought; deduplicated by acknowledgement digest.
  const seenAcks = new Set<string>();
  for (const receipt of runtime.receipts.listByDomain('acknowledgement')) {
    if (seenAcks.has(receipt.recordDigest)) continue;
    seenAcks.add(receipt.recordDigest);
    const ack = rehydrateAcknowledgement(receipt.recordJson, sha256);
    if (!ack.ok || ack.value.kind !== 'accepted') continue;
    const orderRows = runtime.receipts.listByOrder(receipt.buyerDid, ack.value.purchase_order_id);
    const orderRow = orderRows.find((row) => row.domain === 'order');
    if (orderRow === undefined) continue;
    const order = rehydratePurchaseOrder(orderRow.recordJson, sha256);
    if (!order.ok) continue;
    if (order.value.approved_total.currency !== args.currency) continue;
    const supplierSide = order.value.supplier_did === self;
    const buyerSide = order.value.buyer_did === self;
    if (!supplierSide && !buyerSide) continue;
    vouchers.push({
      vchType: supplierSide ? 'Sales' : 'Purchase',
      date: tallyDate(ack.value.accepted_at ?? ack.value.issued_at),
      partyLedger: supplierSide ? order.value.buyer_did : order.value.supplier_did,
      amount: tallyAmount(order.value.approved_total),
      currency: args.currency,
      narration: `dina order ${order.value.purchase_order_id} digest ${order.value.order_digest}`,
    });
  }

  // Settled payments — an OUTBOUND ack is money this node RECEIVED and
  // acknowledged (Receipt); this node's OWN payment notes debit it
  // (Payment). Inbound acks confirm money this node paid, which the
  // payment-note leg already carries — one voucher per rupee.
  for (const row of runtime.tradeDocuments.listByKind('payment_ack', 'outbound')) {
    try {
      const read = rehydrateTradeDocument(row);
      if (read.kind !== 'payment_ack' || read.document.kind !== 'received') continue;
      if (read.document.amount_received.currency !== args.currency) continue;
      vouchers.push({
        vchType: 'Receipt',
        date: tallyDate(read.document.acknowledged_at),
        partyLedger: row.counterpartyDid,
        amount: tallyAmount(read.document.amount_received),
        currency: args.currency,
        narration: `dina payment ack ${read.document.payment_ack_id} digest ${read.document.ack_digest}`,
      });
    } catch {
      // A row this build cannot re-verify never reaches the books.
    }
  }
  for (const row of runtime.tradeDocuments.listByKind('payment_note', 'outbound')) {
    try {
      const read = rehydrateTradeDocument(row);
      if (read.kind !== 'payment_note') continue;
      if (read.document.amount.currency !== args.currency) continue;
      vouchers.push({
        vchType: 'Payment',
        date: tallyDate(read.document.paid_at),
        partyLedger: read.document.supplier_did,
        amount: tallyAmount(read.document.amount),
        currency: args.currency,
        narration: `dina payment note ${read.document.payment_note_id} digest ${read.document.note_digest}`,
      });
    } catch {
      /* unreadable rows never reach the books */
    }
  }

  vouchers.sort((a, b) => a.date.localeCompare(b.date) || a.narration.localeCompare(b.narration));
  return vouchers;
}

/** Render the Tally import envelope. Deterministic byte-for-byte. */
export function renderTallyXml(vouchers: readonly TallyVoucher[]): string {
  const messages = vouchers
    .map(
      (voucher) => `    <TALLYMESSAGE>
      <VOUCHER VCHTYPE="${voucher.vchType}" ACTION="Create">
        <DATE>${voucher.date}</DATE>
        <PARTYLEDGERNAME>${xmlEscape(voucher.partyLedger)}</PARTYLEDGERNAME>
        <AMOUNT>${voucher.amount}</AMOUNT>
        <CURRENCY>${voucher.currency}</CURRENCY>
        <NARRATION>${xmlEscape(voucher.narration)}</NARRATION>
      </VOUCHER>
    </TALLYMESSAGE>`,
    )
    .join('\n');
  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
${messages}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
`;
}
