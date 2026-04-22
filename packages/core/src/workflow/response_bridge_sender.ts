/**
 * Production-wiring helper for the Response Bridge (CORE-P3-I01/I02/I03).
 *
 * Turns a `ServiceQueryBridgeContext` (produced by `WorkflowService.
 * bridgeServiceQueryCompletion` when a delegation task completes) into
 * an outbound `service.response` D2D. The actual network send is
 * injected so this helper stays free of node-identity / keypair /
 * transport coupling — those live in the app-layer bootstrap.
 *
 * Usage (in app bootstrap):
 *
 *   const bridgeSender = makeServiceResponseBridgeSender({
 *     sendResponse: (to, body) => sendD2D({
 *       recipientDID: to,
 *       messageType: 'service.response',
 *       body: JSON.stringify(body),
 *       senderDID, senderPrivateKey, recipientPublicKey: resolve(to),
 *       serviceType: 'DinaDirectHTTPS',
 *       endpoint: coreURL,
 *     }).then(() => {}),
 *   });
 *   setWorkflowService(new WorkflowService({
 *     repository,
 *     responseBridgeSender: bridgeSender,
 *   }));
 *
 * Errors from `sendResponse` are caught and fed to the optional
 * `onSendError` hook — the bridge MUST NOT roll back the completion
 * that already landed. Durable retry is the outbox layer (CORE-P4-I05).
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md CORE-P3-I03.
 */

import type { ResponseBridgeSender, ServiceQueryBridgeContext } from './service';
import type { ServiceResponseBody } from '../d2d/service_bodies';

/**
 * Network-layer callback the bridge uses to deliver a well-formed
 * `service.response` body. The app bootstrap wraps `sendD2D` behind
 * this interface so this module stays pure.
 */
export type ResponseBridgeD2DSender = (
  recipientDID: string,
  body: ServiceResponseBody,
) => Promise<void>;

export interface MakeResponseBridgeSenderOptions {
  /** D2D egress callback. See `ResponseBridgeD2DSender` docstring. */
  sendResponse: ResponseBridgeD2DSender;
  /**
   * Optional hook fired when `sendResponse` rejects or the payload is
   * malformed. Receives the bridge context + the error. Completion
   * state is NOT rolled back — the durable outbox layer (CORE-P4-I05)
   * will retry on future sweeper ticks when wired.
   */
  onSendError?: (ctx: ServiceQueryBridgeContext, err: Error) => void;
  /**
   * Optional hook fired when a result JSON cannot be parsed. Separate
   * from `onSendError` so dashboards can distinguish "runner emitted
   * garbage" from "network is down."
   */
  onMalformedResult?: (ctx: ServiceQueryBridgeContext, err: Error) => void;
  /**
   * GAP-SH-05: optional JSON-Schema-subset validator. When supplied
   * AND the task payload carried a `schema_snapshot`, the bridge
   * validates the runner's result against `snapshot.result` before
   * sending. A violation produces an `error` response rather than a
   * `success` with a drifted payload — main-dina's behaviour.
   *
   * The callback is `(value, schema) => error | null`, compatible
   * with `brain/src/service/capabilities/schema_validator.ts`. The
   * bootstrap wires it in so core stays free of the validator
   * dependency.
   */
  validateResult?: (value: unknown, schema: unknown) => string | null;
  /**
   * Optional hook fired when result-schema validation fails. Lets
   * dashboards distinguish contract drift from transport failures.
   */
  onResultValidationFailure?: (ctx: ServiceQueryBridgeContext, error: string) => void;
}

/**
 * Factory — returns a `ResponseBridgeSender` ready to plug into
 * `WorkflowServiceOptions.responseBridgeSender`.
 *
 * Throws/rejects on transport failure (review #8 / #4848a934
 * durability contract): the caller — `WorkflowService.bridge
 * ServiceQueryCompletion` — needs to distinguish a delivered send
 * (clear the `bridge_pending:` stash) from a failed one (leave it
 * for the retry sweeper). Silently swallowing errors would either
 * leak the stash on a success OR lose the retry on a failure.
 *
 * The `onSendError` / `onMalformedResult` hooks still fire before
 * the re-throw for observability / telemetry; they do NOT suppress
 * the error.
 */
export function makeServiceResponseBridgeSender(
  options: MakeResponseBridgeSenderOptions,
): ResponseBridgeSender {
  if (!options.sendResponse) {
    throw new Error('makeServiceResponseBridgeSender: sendResponse callback is required');
  }
  // Defaults to no-op observers. The returned sender DOES re-throw
  // transport failures — see the factory docstring above for the
  // durability rationale.
  const onSendError =
    options.onSendError ??
    (() => {
      /* no-op */
    });
  const onMalformedResult =
    options.onMalformedResult ??
    (() => {
      /* no-op */
    });
  const onResultValidationFailure =
    options.onResultValidationFailure ??
    (() => {
      /* no-op */
    });
  const validateResult = options.validateResult;

  return async (ctx: ServiceQueryBridgeContext) => {
    let parsed: unknown;
    let parseError: Error | null = null;
    try {
      // `resultJSON` is empty when the runner called `complete` with a
      // summary-only finish (rare but legal). Treat that as a success
      // with an undefined `result` field.
      parsed = ctx.resultJSON === '' ? undefined : JSON.parse(ctx.resultJSON);
    } catch (e) {
      parseError = e instanceof Error ? e : new Error(String(e));
      onMalformedResult(ctx, parseError);
    }

    // Issue #16: when the runner's output is unparseable, still emit an
    // error `service.response` to the requester so they stop waiting
    // for TTL. Previously this path silently dropped the response.
    //
    // Review (main-dina 4848a934): send failures here MUST throw, not
    // just fire `onSendError`. The caller (`WorkflowService.bridge
    // ServiceQueryCompletion`) distinguishes "delivered — clear the
    // durable stash" from "failed — leave for sweeper retry" by
    // whether this promise rejects. Silently swallowing a failure
    // would leave the stash in place on a succeeded send (clobbering
    // future retries) OR clear it on a failed send (losing the retry
    // entirely), depending on the path. The hook fires for
    // observability either way.
    if (parseError !== null) {
      const errorBody: ServiceResponseBody = {
        query_id: ctx.queryId,
        capability: ctx.capability,
        status: 'error',
        error: `malformed_result: ${parseError.message}`,
        ttl_seconds: ctx.ttlSeconds,
      };
      try {
        await options.sendResponse(ctx.fromDID, errorBody);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        onSendError(ctx, err);
        throw err;
      }
      return;
    }
    // Issue #11: derive status + result + error from what the runner
    // actually produced. If the runner returned a recognisable
    // `ServiceResponseBody`-shaped object, forward its status verbatim
    // (so `unavailable` / `error` responses reach the requester
    // faithfully). Otherwise treat the runner's payload as a success
    // result wrapping.
    let body: ServiceResponseBody = deriveResponseBody(ctx, parsed);

    // GAP-SH-05: validate success results against the frozen snapshot.
    // Only applied when the bootstrap wired `validateResult` AND the
    // task payload carried a `schema_snapshot` AND the body still
    // reports `success` (error / unavailable responses pass through —
    // they weren't claiming conformance in the first place).
    if (
      validateResult !== undefined &&
      ctx.schemaSnapshot !== undefined &&
      body.status === 'success'
    ) {
      const err = validateResult(body.result, ctx.schemaSnapshot.result);
      if (err !== null) {
        onResultValidationFailure(ctx, err);
        body = {
          query_id: ctx.queryId,
          capability: ctx.capability,
          status: 'error',
          error: `result_schema_violation: ${err}`,
          ttl_seconds: ctx.ttlSeconds,
        };
      }
    }

    try {
      await options.sendResponse(ctx.fromDID, body);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      onSendError(ctx, err);
      throw err;
    }
  };
}

/**
 * Inspect the runner's result and produce the `ServiceResponseBody` to
 * send back. Three cases:
 *
 *   1. Result is an object carrying an explicit `status` of `unavailable`
 *      or `error`: forward it verbatim (with `error` string + optional
 *      result payload) so the requester sees the real outcome rather
 *      than a fake "success".
 *   2. Result is an object with `status: 'success'`: strip the wrapper
 *      and forward the nested result as the body's `result` field.
 *   3. Anything else (plain result or undefined): wrap as success.
 *
 * This is the single place the bridge classifies runner output — Core
 * cannot schema-validate (ajv would bloat the RN bundle), so the
 * classification stays conservative: only explicitly-tagged outputs
 * opt into a non-success status.
 */
function deriveResponseBody(ctx: ServiceQueryBridgeContext, parsed: unknown): ServiceResponseBody {
  if (parsed !== null && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const status = obj.status;
    if (status === 'unavailable' || status === 'error') {
      const errField = typeof obj.error === 'string' ? obj.error : undefined;
      return {
        query_id: ctx.queryId,
        capability: ctx.capability,
        status,
        // Non-success responses typically omit `result`. Forward it only
        // when the runner explicitly attached one for diagnostics.
        result: obj.result,
        error: errField,
        ttl_seconds: ctx.ttlSeconds,
      };
    }
    if (status === 'success' && 'result' in obj) {
      return {
        query_id: ctx.queryId,
        capability: ctx.capability,
        status: 'success',
        result: obj.result,
        ttl_seconds: ctx.ttlSeconds,
      };
    }
  }
  return {
    query_id: ctx.queryId,
    capability: ctx.capability,
    status: 'success',
    result: parsed,
    ttl_seconds: ctx.ttlSeconds,
  };
}
