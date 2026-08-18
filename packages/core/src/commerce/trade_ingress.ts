/**
 * The khata documents' inbound seam (TRADE_FIRST_STRATEGY §4.2/§4.3) —
 * ONE entry for both transport legs:
 *
 *   - supplier → buyer: DeliveryNote, PaymentAcknowledgement;
 *   - buyer → supplier: DeliveryReceipt, PaymentNote.
 *
 * BOTH directions ride the `commerce.trade` message under KNOWN-CONTACT
 * trust, and that symmetry is a recorded design decision: a khata
 * document is SELF-AUTHORIZING BY BINDING — every verifier ties it to an
 * order/note this node already retained and to the transport-
 * authenticated sender — so the capability/grant lane (probing budget,
 * listing semantics, runner dispatch) would add machinery and no
 * authority. A stranger's document binds to nothing and refuses; a
 * misdirected one fails its side checks. No runner ever sees a khata
 * document.
 *
 * The SENDER IS THE TRANSPORT-AUTHENTICATED DID on both legs; the
 * document's own party fields are checked AGAINST it by the verifiers,
 * never believed. Inert without a commerce runtime.
 */

import {
  verifyInboundAgreementDecision,
  verifyInboundAgreementProposal,
  verifyInboundAgreementTermination,
  verifyInboundSettlementAck,
  verifyInboundSettlementNote,
} from './revshare_ledger';
import { getCommerceRuntime } from './runtime';
import {
  verifyInboundDeliveryNote,
  verifyInboundDeliveryReceipt,
  verifyInboundPaymentAck,
  verifyInboundPaymentNote,
  type TradeIngest,
} from './trade_ledger';
import { tradeRelationshipReaders } from './trade_readers';


/** The §4.2 document kinds a trade push may carry, by direction. */
export const INBOUND_AT_BUYER = ['delivery_note', 'payment_ack'] as const;
export const INBOUND_AT_SUPPLIER = ['delivery_receipt', 'payment_note'] as const;
/** The §5 revenue-share chain rides the same lane — the §4 discipline. */
export const REVSHARE_KINDS = [
  'agreement_proposal',
  'agreement_decision',
  'agreement_termination',
  'settlement_note',
  'settlement_ack',
] as const;

export type TradePushKind =
  | (typeof INBOUND_AT_BUYER)[number]
  | (typeof INBOUND_AT_SUPPLIER)[number]
  | (typeof REVSHARE_KINDS)[number];

export interface TradePushBody {
  kind: TradePushKind;
  document: unknown;
}

/** Parse an untrusted body into a trade push, or say why not. */
export function readTradePushBody(value: unknown): TradePushBody | string {
  if (value === null || typeof value !== 'object') return 'trade push: body must be an object';
  const b = value as Partial<TradePushBody>;
  const kinds: readonly string[] = [...INBOUND_AT_BUYER, ...INBOUND_AT_SUPPLIER, ...REVSHARE_KINDS];
  if (typeof b.kind !== 'string' || !kinds.includes(b.kind)) {
    return 'trade push: kind must name a khata document';
  }
  if (b.document === null || typeof b.document !== 'object') {
    return 'trade push: document must be an object';
  }
  return { kind: b.kind as TradePushKind, document: b.document };
}

export type TradeIngressOutcome = TradeIngest | { outcome: 'unavailable' | 'unreadable'; detail?: string };

/**
 * Verify and retain one inbound khata document. The verifiers own every
 * rule — replay, binding, cumulative over-delivery, one-answer — and
 * this function only routes to them with the runtime's readers.
 */
export function applyInboundTradeDocument(args: {
  /** Transport-authenticated counterparty DID. */
  senderDid: string;
  body: unknown;
  /** The retained-envelope evidence JSON (§4.3 stored-verified rule). */
  evidenceJson: string;
  nowMs: number;
}): TradeIngressOutcome & { kind?: TradePushKind } {
  const runtime = getCommerceRuntime();
  if (runtime === null) return { outcome: 'unavailable' };
  const read = readTradePushBody(args.body);
  if (typeof read === 'string') return { outcome: 'unreadable', detail: read };

  const readers = tradeRelationshipReaders(runtime);
  const shared = {
    senderDid: args.senderDid,
    selfDid: runtime.nodeDid(),
    repository: runtime.tradeDocuments,
    evidenceJson: args.evidenceJson,
    nowMs: args.nowMs,
  };
  const readOrder = (purchaseOrderId: string): ReturnType<typeof readers.readOrder> =>
    readers.readOrder(args.senderDid, purchaseOrderId);
  const revshared = {
    senderDid: args.senderDid,
    selfDid: runtime.nodeDid(),
    repository: runtime.revshareDocuments,
    evidenceJson: args.evidenceJson,
    nowMs: args.nowMs,
  };

  switch (read.kind) {
    case 'delivery_note':
      return { ...verifyInboundDeliveryNote({ ...shared, note: read.document, readOrder }), kind: read.kind };
    case 'payment_ack':
      return { ...verifyInboundPaymentAck({ ...shared, ack: read.document }), kind: read.kind };
    case 'delivery_receipt':
      return {
        ...verifyInboundDeliveryReceipt({ ...shared, receipt: read.document, readOrder }),
        kind: read.kind,
      };
    case 'payment_note':
      return { ...verifyInboundPaymentNote({ ...shared, note: read.document }), kind: read.kind };
    case 'agreement_proposal':
      return {
        ...verifyInboundAgreementProposal({ ...revshared, proposal: read.document }),
        kind: read.kind,
      };
    case 'agreement_decision':
      return {
        ...verifyInboundAgreementDecision({ ...revshared, decision: read.document }),
        kind: read.kind,
      };
    case 'agreement_termination':
      return {
        ...verifyInboundAgreementTermination({ ...revshared, termination: read.document }),
        kind: read.kind,
      };
    case 'settlement_note':
      return {
        ...verifyInboundSettlementNote({ ...revshared, note: read.document }),
        kind: read.kind,
      };
    case 'settlement_ack':
      return {
        ...verifyInboundSettlementAck({ ...revshared, ack: read.document }),
        kind: read.kind,
      };
  }
}
