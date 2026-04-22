/**
 * RPCBridge — the dispatch seam between the MsgBox envelope layer and
 * Core's HTTP handler chain.
 *
 * Composes the Phase-0 guards in the correct order:
 *   1. Body-size cap          (CORE-P0-003) — reject before dispatch.
 *   2. Identity binding        (CORE-P0-004) — envelope.from_did MUST
 *                              match inner X-DID.
 *   3. Idempotency cache       (CORE-P0-009) — retries return cached
 *                              response without re-executing.
 *   4. Worker-pool dedup       (CORE-P0-011) — concurrent duplicates
 *                              fold onto one in-flight execution.
 *   5. Panic recovery           (CORE-P0-007) — catches exceptions,
 *                              returns 500 inner response.
 *   6. `handleInnerRequest` is injected so Express / any other HTTP
 *      framework can plug in.
 *
 * The `handler` arg takes an `RPCInnerRequest` and returns an
 * `RPCInnerResponse`. Adapters wrap Express's `app(req, res)` pattern
 * into this shape.
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md CORE-P0-002.
 */

import {
  type RPCInnerRequest,
  type RPCInnerResponse,
  assertInnerBodyWithinSize,
  InnerBodyTooLargeError,
} from './types';
import { assertIdentityBinding, IdentityBindingError } from './identity_binding';
import { IdempotencyCache } from './idempotency_cache';
import { RPCWorkerPool } from './worker_pool';
import { withPanicRecovery } from './panic_recovery';

export interface RPCBridgeOptions {
  /** Downstream HTTP dispatcher — e.g. an Express adapter. */
  handler: (req: RPCInnerRequest) => Promise<RPCInnerResponse>;
  /** Shared caches; supply instances so telemetry/reset hooks work. */
  idempotencyCache?: IdempotencyCache;
  workerPool?: RPCWorkerPool;
  /** Optional panic logger. */
  onPanic?: (err: Error, reason: 'sync-throw' | 'async-rejection') => void;
}

export interface HandleArgs {
  /** DID claimed by the outer envelope (sender). */
  envelopeDid: string;
  /** Opaque request identifier from the envelope (used for idempotency). */
  requestId: string;
  /** The inner HTTP request. */
  request: RPCInnerRequest;
}

export class RPCBridge {
  private readonly handler: (req: RPCInnerRequest) => Promise<RPCInnerResponse>;
  private readonly idempotency: IdempotencyCache;
  private readonly pool: RPCWorkerPool;
  private readonly onPanic?: (err: Error, reason: 'sync-throw' | 'async-rejection') => void;

  constructor(options: RPCBridgeOptions) {
    if (!options.handler) {
      throw new Error('RPCBridge: handler is required');
    }
    this.handler = options.handler;
    this.idempotency = options.idempotencyCache ?? new IdempotencyCache();
    this.pool = options.workerPool ?? new RPCWorkerPool({ maxConcurrent: 8 });
    this.onPanic = options.onPanic;
  }

  /**
   * Dispatch one inner request. Never rejects — every error path produces
   * an `RPCInnerResponse` with the correct status code.
   */
  async handleInnerRequest(args: HandleArgs): Promise<RPCInnerResponse> {
    // 1. Body-size guard. Safe to do before anything else.
    try {
      assertInnerBodyWithinSize(args.request.body);
    } catch (e) {
      if (e instanceof InnerBodyTooLargeError) {
        return errorResponse(e.status, 'body_too_large', e.message);
      }
      throw e;
    }

    // 2. Identity binding.
    try {
      assertIdentityBinding(args.envelopeDid, args.request);
    } catch (e) {
      if (e instanceof IdentityBindingError) {
        return errorResponse(e.status, 'identity_binding_failed', e.message);
      }
      throw e;
    }

    // 3. Idempotency cache hit → short-circuit.
    const cached = this.idempotency.get(args.envelopeDid, args.requestId);
    if (cached !== null) return cached;

    // 4 + 5. Worker-pool dedup + panic-recovered dispatch.
    const jobKey = `${args.envelopeDid}\x00${args.requestId}`;
    const response = await this.pool.submitDuplicate(jobKey, async () =>
      withPanicRecovery(() => this.handler(args.request), {
        onPanic: this.onPanic,
      }),
    );

    // Cache the response for subsequent retries.
    this.idempotency.put(args.envelopeDid, args.requestId, response);
    return response;
  }
}

function errorResponse(status: number, code: string, detail: string): RPCInnerResponse {
  const body = JSON.stringify({ error: code, detail: detail.slice(0, 512) });
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: new TextEncoder().encode(body),
  };
}
