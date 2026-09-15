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

import { askPaymentStatusRail } from './country_rails';
import { rehydrateSpooledTradeBody } from './money_rehydrate';
import {
  verifyInboundAgreementDecision,
  verifyInboundAgreementProposal,
  verifyInboundAgreementTermination,
  verifyInboundSettlementAck,
  verifyInboundSettlementNote,
} from './revshare_ledger';
import { getCommerceRuntime, type CommerceMoneyStores, type CommerceRuntime } from './runtime';
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

export type TradeIngressOutcome =
  | TradeIngest
  | { outcome: 'unavailable' | 'unreadable'; detail?: string }
  /** Held in the spool for a closed money line; replayed when it opens. */
  | { outcome: 'spooled' };

/** How many spooled documents one drain replays at most. */
const TRADE_SPOOL_DRAIN_BATCH = 200;

/**
 * Verify and retain one inbound khata document. The verifiers own every
 * rule — replay, binding, cumulative over-delivery, one-answer — and
 * this function only routes to them with the runtime's readers.
 *
 * THE MONEY LINE (§5.B1 Cut 3): with no active Commerce Pack the document is
 * not verified and not retained — it is SPOOLED, exactly as it arrived, and
 * replayed here once the pack is active (before any newer document, so arrival
 * order holds). Dropping it would lose the counterparty's answer for good: the
 * relay already accepted it, and nothing re-sends a receipt or an ack. A full
 * spool refuses the newest document (`unavailable`) and keeps the oldest.
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
  const money = runtime.money();
  if (!money.available) {
    const held = runtime.tradeSpool.put({
      senderDid: args.senderDid,
      bodyJson: JSON.stringify(args.body ?? null),
      evidenceJson: args.evidenceJson,
      receivedAt: args.nowMs,
    });
    return held ? { outcome: 'spooled' } : { outcome: 'unavailable', detail: `${money.detail}; spool full` };
  }
  // Older mail first: whatever waited while the line was closed lands before
  // this document, so a receipt never applies ahead of the note it answers.
  drainTradeSpool(runtime, money.stores);
  return applyOne(runtime, money.stores, { ...args, askAtMs: args.nowMs });
}

/**
 * Replay everything the spool holds through the verifiers, each document AS OF
 * ITS ARRIVAL (`receivedAt`): the ledger row it leaves carries the moment it
 * reached this node, not the moment the pack reopened, so the khata's order and
 * the inbox's order stay what they would have been with the pack open. Each row
 * is deleted whatever its verdict — a document the verifiers refuse on replay is
 * one they would have refused on arrival, and a document that makes a verifier
 * THROW (a ledger row it binds to is corrupt) is dropped the same way: kept, it
 * would jam every later drain on the same row and stop new mail landing.
 * Returns the tallies, for the caller's audit. A no-op with an empty spool, so
 * the inbox and the money routes may call it whenever they find the line open.
 */
export function drainTradeSpool(
  runtime: CommerceRuntime,
  stores: CommerceMoneyStores,
): { replayed: number; applied: number; faulted: number } {
  let replayed = 0;
  let applied = 0;
  let faulted = 0;
  for (;;) {
    const batch = runtime.tradeSpool.oldest(TRADE_SPOOL_DRAIN_BATCH);
    if (batch.length === 0) break;
    for (const row of batch) {
      let verdict: { outcome: string } | null = null;
      try {
        verdict = applyOne(runtime, stores, {
          senderDid: row.senderDid,
          body: rehydrateSpooledTradeBody(row.bodyJson),
          evidenceJson: row.evidenceJson,
          // The ledger row keeps the ARRIVAL time; anything the document asks
          // of the owner now (a rail card) lives from the moment of replay.
          nowMs: row.receivedAt,
          askAtMs: runtime.now(),
        });
      } catch {
        faulted++;
      }
      // Removed before anything else can observe it, so a batch that is
      // interrupted never replays the same row twice.
      runtime.tradeSpool.remove(row.spoolId);
      replayed++;
      if (verdict !== null && (verdict.outcome === 'applied' || verdict.outcome === 'duplicate')) applied++;
    }
  }
  return { replayed, applied, faulted };
}

function applyOne(
  runtime: CommerceRuntime,
  stores: CommerceMoneyStores,
  args: {
    senderDid: string;
    body: unknown;
    evidenceJson: string;
    /** The document's arrival — what the ledger row records. */
    nowMs: number;
    /** The wall clock of this apply — what a card raised for the owner lives from. */
    askAtMs: number;
  },
): (TradeIngest | { outcome: 'unreadable'; detail?: string }) & { kind?: TradePushKind } {
  const read = readTradePushBody(args.body);
  if (typeof read === 'string') return { outcome: 'unreadable', detail: read };

  const readers = tradeRelationshipReaders(runtime);
  const shared = {
    senderDid: args.senderDid,
    selfDid: runtime.nodeDid(),
    repository: stores.tradeDocuments,
    evidenceJson: args.evidenceJson,
    nowMs: args.nowMs,
  };
  const readOrder = (purchaseOrderId: string): ReturnType<typeof readers.readOrder> =>
    readers.readOrder(args.senderDid, purchaseOrderId);
  const revshared = {
    senderDid: args.senderDid,
    selfDid: runtime.nodeDid(),
    repository: stores.revshareDocuments,
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
    case 'payment_note': {
      const verdict = verifyInboundPaymentNote({ ...shared, note: read.document });
      // §5.D — a note that landed asks the active country pack's status rail
      // (through the gate; the owner still acks). Only a note that was
      // ACCEPTED asks: a refused or duplicate one already has its answer.
      if (verdict.outcome === 'applied') askPaymentStatusRail(read.document, args.askAtMs);
      return { ...verdict, kind: read.kind };
    }
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
