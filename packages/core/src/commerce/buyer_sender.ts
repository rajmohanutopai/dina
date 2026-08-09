import type { BuyerOrderSender, BuyerSendOutcome } from './buyer_executor';

/**
 * The buyer order sender, expressed over the service-query lane (§11.2a, §12.7).
 *
 * The executor deliberately does not own transport. This is the adapter that
 * gives it one: it turns a purchase order into the `service.query` a supplier's
 * provider ingress already understands, and turns the transport's answer into
 * the three outcomes the executor reasons about.
 *
 * THE INTERESTING PART IS THE MAPPING, NOT THE PLUMBING, which is why it lives
 * here in tested code rather than as a lambda in two composition roots. Getting
 * it wrong in the safe direction costs a needless reconcile; getting it wrong
 * in the other direction authorizes a duplicate order for real goods.
 *
 * AN ACKNOWLEDGEMENT NEVER COMES BACK FROM THE SEND. The supplier's answer
 * arrives later, through the response bridge, as its own inbound message. So a
 * successful dispatch is `ambiguous` — sent, no answer yet — and that is not a
 * defect: it is the honest description of an asynchronous lane, and it is
 * exactly the state §12.7 was written for.
 */

/** What a transport reports back. Structured, so a refusal stays legible. */
export interface ServiceQueryDispatchResult {
  /**
   * The gate that refused, when one did, BEFORE anything crossed the boundary.
   * Present only when the transport can prove nothing was sent.
   */
  deniedAt?: string;
  /** Whether the message left, was buffered, or was queued for retry. */
  sent: boolean;
  error?: string;
}

export type ServiceQueryDispatch = (args: {
  toDid: string;
  body: {
    query_id: string;
    capability: string;
    params: unknown;
    ttl_seconds: number;
    service_uri?: string;
  };
}) => Promise<ServiceQueryDispatchResult>;

/** The capability a supplier pack publishes for order submission (§11.1). */
export const SUBMIT_ORDER_CAPABILITY = 'submit_order';

/** How long a supplier has to answer before the query expires. */
export const DEFAULT_ORDER_TTL_SECONDS = 900;

export function makeServiceQueryBuyerSender(deps: {
  dispatch: ServiceQueryDispatch;
  ttlSeconds?: number;
}): BuyerOrderSender {
  return async ({ supplierDid, serviceRkey, order }): Promise<BuyerSendOutcome> => {
    let result: ServiceQueryDispatchResult;
    try {
      result = await deps.dispatch({
        toDid: supplierDid,
        body: {
          // The purchase order id IS the correlation id. A separate random one
          // would let two dispatches of the same order look like two different
          // questions, which is how a duplicate becomes invisible.
          query_id: order.purchase_order_id,
          capability: SUBMIT_ORDER_CAPABILITY,
          params: order,
          ttl_seconds: deps.ttlSeconds ?? DEFAULT_ORDER_TTL_SECONDS,
          service_uri: `at://${supplierDid}/com.dinakernel.service.profile/${serviceRkey}`,
        },
      });
    } catch (error) {
      // A THROW IS AMBIGUOUS, not `not_sent`. A transport that throws has not
      // told us whether anything left — the outbox may already hold the
      // message, or the socket may have closed after the write. Claiming
      // `not_sent` here would authorize a resend on a maybe, and the whole of
      // §12.7 exists to stop exactly that.
      return {
        kind: 'ambiguous',
        reason: `dispatch threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (result.deniedAt !== undefined) {
      // The ONLY path to `not_sent`: a gate refused before egress, so the
      // transport can prove nothing crossed the boundary.
      return { kind: 'not_sent', reason: `refused at ${result.deniedAt}` };
    }
    if (!result.sent && result.error !== undefined) {
      // Failed without naming a gate. We cannot prove nothing left — a queued
      // outbox row will try again later — so we do not claim it.
      return { kind: 'ambiguous', reason: result.error };
    }
    // Sent, buffered or queued, and no answer yet. The acknowledgement arrives
    // later through the response bridge; until it does, the order is parked.
    return { kind: 'ambiguous', reason: 'sent; awaiting the supplier acknowledgement' };
  };
}

let dispatch: ServiceQueryDispatch | null = null;

/**
 * Install HOW THIS NODE REACHES A SUPPLIER over the service-query lane.
 *
 * One registry rather than one per caller. There are already two things that
 * need it — the buyer's order send and §12.7's re-poll — and they must reach a
 * supplier the same way: a second dispatch built at a second call site is a
 * second place for a gate, a signature or an outbox to go missing, and the one
 * that fell behind would be the one nobody looked at.
 *
 * Null on shutdown, and null on a node with no outbound transport. A caller
 * that finds null must do nothing rather than invent a path.
 */
export function installCommerceServiceQueryDispatch(value: ServiceQueryDispatch | null): void {
  dispatch = value;
}

export function getCommerceServiceQueryDispatch(): ServiceQueryDispatch | null {
  return dispatch;
}
