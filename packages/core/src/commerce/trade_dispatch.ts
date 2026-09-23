/**
 * The khata documents' OUTBOUND seam — the mirror of `trade_ingress_seam.ts`.
 *
 * A trade document is retained first and pushed to the counterparty second,
 * best-effort: both ledgers reconcile through the unanswered sweeps, so a
 * send that fails un-authors nothing. The routes own the D2D sender and
 * install the dispatcher here once; a money module that must push a
 * document it authored OUTSIDE a route (the buyer's PaymentNote authored on
 * the owner's yes to a payment-evidence card, `order_attachments.ts`) reaches
 * the same sender through this seam instead of importing the transport.
 * `null` until a composition root registers routes; a caller then records
 * `dispatched: false` and the resend surface takes it from there.
 */

export type TradeDocumentDispatcher = (
  toDid: string,
  kind: string,
  document: unknown,
) => Promise<boolean>;

let dispatcher: TradeDocumentDispatcher | null = null;

export function installTradeDocumentDispatcher(value: TradeDocumentDispatcher | null): void {
  dispatcher = value;
}

export function getTradeDocumentDispatcher(): TradeDocumentDispatcher | null {
  return dispatcher;
}
