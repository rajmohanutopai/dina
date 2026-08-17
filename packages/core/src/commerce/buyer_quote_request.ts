/**
 * §9.8 / §12.3 — the buyer ASKS for a price.
 *
 * THE HALF THAT WAS NEVER BUILT. A cold audit found the buyer's outbound quote
 * lane missing entirely: `commerceRecordDigest('request', …)` had zero
 * production occurrences, `buyer_sender.ts` only ever sent `submit_order`, and
 * nothing wrote the retained-request store. So the arrival path's §9.8
 * bindings — which check an incoming quote against the question this node
 * asked — had no question to check against, and after the retained-request
 * reader was added every inbound quote was refused as `unsolicited_quote`.
 *
 * That is the shape of the whole defect class in this subsystem: a reader
 * wired to a store nothing writes, passing every test because the tests wrote
 * it themselves.
 *
 * RETAIN BEFORE SEND, and the order is the point. If the request went out
 * first and the retention failed, the supplier could answer a question this
 * node has no record of asking, and the answer would be refused as
 * unsolicited — the buyer would have paid for a round trip it then discarded.
 * Retaining first means the worst case is a retained request that was never
 * asked, which costs a row and refuses nothing.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  commerceRecordDigest,
  validateQuoteRequest,
  type DeliveryProjection,
  type ProductRef,
  type Quantity,
  type QuoteRequest,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import { REQUEST_QUOTE_WIRE_CAPABILITY } from './buyer_response';
import { getCommerceServiceQueryDispatch } from './buyer_sender';
import { getCommerceRuntime } from './runtime';

const hash: Sha256Fn = (data) => sha256(data);

/** How long a quote request stands before a supplier should stop answering. */
const DEFAULT_REQUEST_TTL_SECONDS = 300;
const DEFAULT_REQUEST_VALIDITY_MS = 24 * 60 * 60 * 1000;

export interface QuoteRequestLineInput {
  lineId: string;
  product: ProductRef;
  quantity: Quantity;
  acceptableSubstitutions?: 'none' | 'equivalent' | 'supplier_may_propose';
}

export type QuoteRequestOutcome =
  | { kind: 'sent'; request: QuoteRequest }
  /** Nothing was retained and nothing was sent. */
  | { kind: 'refused'; reason: QuoteRequestRefusal }
  /**
   * §12.7 — retained, and the transport could not prove the request did not
   * leave. The retained row STAYS: a supplier that did receive it may answer,
   * and that answer must be recognised rather than refused as unsolicited.
   */
  | { kind: 'ambiguous'; request: QuoteRequest; reason: string };

export type QuoteRequestRefusal =
  | 'commerce_unavailable'
  | 'no_dispatch'
  | 'request_invalid'
  /** A request with this id is already retained; composing a second would
   *  give one question two documents. */
  | 'duplicate_request'
  /** A gate refused before egress, so nothing crossed the boundary. */
  | 'not_sent';

/**
 * Compose, retain and send a quote request.
 *
 * The digest is computed over the canonical record, so the supplier's answer
 * can bind to it and this node can re-derive it on every read. `request_id` is
 * the caller's, because it is also the correlation id the answer comes back
 * under — the same discipline `submit_order` uses with `purchase_order_id`.
 */
export async function requestQuote(args: {
  supplierDid: string;
  serviceRkey: string;
  requestId: string;
  idempotencyKey: string;
  lines: readonly QuoteRequestLineInput[];
  projection: DeliveryProjection;
  requiredBy?: string;
  currency?: string;
  nowMs: number;
  ttlSeconds?: number;
}): Promise<QuoteRequestOutcome> {
  const runtime = getCommerceRuntime();
  if (runtime === null) return { kind: 'refused', reason: 'commerce_unavailable' };
  const dispatch = getCommerceServiceQueryDispatch();
  if (dispatch === null) return { kind: 'refused', reason: 'no_dispatch' };

  const draft = {
    protocol_version: '1.0',
    request_id: args.requestId,
    buyer_did: runtime.nodeDid(),
    supplier_did: args.supplierDid,
    lines: args.lines.map((line) => ({
      line_id: line.lineId,
      product: line.product,
      requested_quantity: line.quantity,
      ...(line.acceptableSubstitutions === undefined
        ? {}
        : { acceptable_substitutions: line.acceptableSubstitutions }),
    })),
    delivery: {
      projection: args.projection,
      ...(args.requiredBy === undefined ? {} : { required_by: args.requiredBy }),
    },
    ...(args.currency === undefined ? {} : { requested_terms: { currency: args.currency } }),
    issued_at: new Date(args.nowMs).toISOString(),
    expires_at: new Date(args.nowMs + DEFAULT_REQUEST_VALIDITY_MS).toISOString(),
    idempotency_key: args.idempotencyKey,
  };
  const request = {
    ...draft,
    request_digest: commerceRecordDigest('request', draft, hash),
  } as unknown as QuoteRequest;

  // Validate our OWN output before retaining or sending it. A malformed
  // request would be retained as a yardstick this node cannot re-derive, and
  // the arriving answer would then be refused for a fault of our own making.
  if (validateQuoteRequest(request, hash) !== null) {
    return { kind: 'refused', reason: 'request_invalid' };
  }

  // RETAIN FIRST. See the header: the failure that costs something is a sent
  // request with no record, not a record with no request.
  if (!runtime.buyerQuoteRequests.put(request, args.nowMs)) {
    return { kind: 'refused', reason: 'duplicate_request' };
  }

  try {
    const result = await dispatch({
      toDid: args.supplierDid,
      body: {
        // The request id IS the correlation id, so two dispatches of one
        // question cannot look like two questions.
        query_id: request.request_id,
        capability: REQUEST_QUOTE_WIRE_CAPABILITY,
        params: request,
        ttl_seconds: args.ttlSeconds ?? DEFAULT_REQUEST_TTL_SECONDS,
        service_uri: `at://${args.supplierDid}/com.dinakernel.service.profile/${args.serviceRkey}`,
      },
    });
    if (result.deniedAt !== undefined) {
      // A gate refused before egress, so nothing crossed. This is the one
      // outcome that can prove nothing left.
      return { kind: 'refused', reason: 'not_sent' };
    }
    if (!result.sent && result.error !== undefined) {
      return { kind: 'ambiguous', request, reason: result.error };
    }
    return { kind: 'sent', request };
  } catch (error) {
    // A THROW IS AMBIGUOUS, not `not_sent` — the same reasoning as the order
    // sender. The outbox may already hold it.
    return {
      kind: 'ambiguous',
      request,
      reason: `dispatch threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
