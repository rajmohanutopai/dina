/**
 * WHERE A KHATA DOCUMENT ENTERS THE NODE (RESEARCHER_KERNEL_ARCHITECTURE
 * §5.B1) — the seam between Core's transport and the money engine.
 *
 * The receive pipeline is Core's own: it unseals, verifies a signature, binds
 * the sender, checks the replay cache, and decides what a message is. What it
 * must not do is KNOW what a khata document is. Until this module existed it
 * did — `receive_pipeline.ts` imported `commerce/trade_ingress` directly, so
 * Core's transport layer held a static edge into the money engine, and the
 * money engine could not move to the Commerce Pack without dragging the
 * transport with it.
 *
 * So the pipeline asks a registered handler. The money engine registers one
 * at boot; a node with no money engine registers none, and an inbound khata
 * document is dropped with a named outcome rather than silently mishandled.
 * The direction is the point: the pack knows about Core, Core does not know
 * about the pack.
 *
 * WHY A SEAM AND NOT A PARAMETER. The pipeline is reached from four places
 * (the relay handler, the HTTP receive route, the msgbox bridge, the phone's
 * in-process transport) and none of them is a composition root. Threading a
 * handler through all four would put a money-shaped argument in four
 * signatures that have no other reason to mention money — the registry keeps
 * the knowledge in one place, which is also where it can be cleared when the
 * runtime goes.
 */

/**
 * What the pipeline needs back, and nothing more: an outcome, a kind to log,
 * and a detail line for the audit.
 *
 * `outcome` is a bounded string rather than the money engine's own union.
 * The pipeline branches on three of these — applied, duplicate and spooled
 * are the ones it reports as "bypassed" — and treats everything else as a
 * drop, so widening the engine's vocabulary (a new refusal reason, say) must
 * not mean editing Core's transport. A value this seam does not recognise is
 * still a drop, which is the safe direction.
 */
export interface TradeIngressResult {
  outcome: string;
  /** The document kind, for the audit line. Metadata only, never content. */
  kind?: string;
  detail?: string;
}

export type TradeIngressHandler = (args: {
  /** Transport-authenticated counterparty DID. */
  senderDid: string;
  body: unknown;
  /** The retained-envelope evidence JSON (§4.3 stored-verified rule). */
  evidenceJson: string;
  nowMs: number;
}) => TradeIngressResult;

let handler: TradeIngressHandler | null = null;

/** Register the money engine's ingress, or clear it with null at shutdown. */
export function setTradeDocumentIngress(next: TradeIngressHandler | null): void {
  handler = next;
}

/**
 * Hand one inbound khata document to the registered ingress.
 *
 * With none registered the answer is `unavailable`, which is exactly what the
 * pipeline already does with a document the money line refuses: audit the
 * outcome by name, drop the message, keep no content. A node that holds no
 * money engine is not a node with a bug — it is the kernel running as the
 * kernel, which is the whole point of the money line.
 */
export function applyInboundTradeDocumentVia(
  args: Parameters<TradeIngressHandler>[0],
): TradeIngressResult {
  if (handler === null) {
    return { outcome: 'unavailable', detail: 'no trade ingress is registered on this node' };
  }
  return handler(args);
}
