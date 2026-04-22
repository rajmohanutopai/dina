/**
 * Task 4.46 — dispatch MsgBox-tunnelled RPCs through the full Fastify
 * chain (auth + rate limit + body limit + route handlers).
 *
 * When Core receives a sealed `CoreRPCRequest` via the MsgBox relay
 * (task 4.45 decrypts it), we must route it through the SAME Fastify
 * pipeline that an HTTP-native request would go through. If we
 * bypassed the chain and invoked a handler function directly, we'd
 * lose:
 *
 *   - Signed-header auth (tasks 4.19-4.26) — signature verification,
 *     nonce replay guard, timestamp window check
 *   - Per-DID rate limiting (task 4.30)
 *   - Body size limit (task 4.32)
 *   - Content-type enforcement (task 4.33)
 *   - Metrics recording (task 4.88/4.89)
 *   - Request-id correlation (task 4.86)
 *   - Agent-context decorator (task 4.28)
 *
 * The classic Go bug `NewRPCBridge(mux)` passed the raw router
 * instead of the middleware chain — signed requests landed without
 * `AgentDIDKey` in context and the auth-aware handlers returned 401.
 * This module exists specifically to prevent that regression: the
 * only way to dispatch a tunnelled request is through
 * `dispatchTunneledRequest(app, rpcRequest)`, which uses Fastify's
 * `inject()` to run the FULL chain.
 *
 * **Response shape**: the MsgBox handler needs a `CoreRPCResponse`
 * to re-seal + send back. We convert Fastify's inject-result
 * (`statusCode` + `headers` + `body`) into the `status/headers/body`
 * fields of `CoreRPCResponse` at the boundary. The response's
 * `request_id` is echoed from the input so the sender can correlate.
 * `from` is the server's DID (passed in via `coreDid`).
 *
 * **Header forwarding**: every CoreRPCRequest header becomes an HTTP
 * header on the injected request. The sender's signed-request
 * headers (`X-DID`, `X-Timestamp`, `X-Nonce`, `X-Signature`) arrive
 * verbatim — that's what makes the auth middleware verify the same
 * signature it would on an HTTP-native request.
 *
 * **Body handling**: `rpcRequest.body` may be `unknown` (structured
 * object the sender JSON-encoded) or a string (raw payload). We
 * serialise structured bodies as JSON; string bodies pass through.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4f task 4.46.
 */

import type { CoreRPCRequest, CoreRPCResponse } from '@dina/protocol';
import { RPC_RESPONSE_TYPE } from '@dina/protocol';

/**
 * Fastify inject result — the structural subset we consume. Matches
 * `LightMyRequest.Response` but avoids a direct import so consumers
 * of this module don't re-type-resolve LightMyRequest.
 */
export interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
}

/**
 * Minimum shape of the Fastify app. We use only `inject()` — same
 * pattern as `bind_core_router.ts` + `src/pair/routes.ts` for
 * pino-generic-free typing.
 */
export interface DispatchAppShape {
  inject(opts: {
    method: string;
    url: string;
    headers?: Record<string, string | string[]>;
    payload?: string | Buffer;
  }): Promise<InjectResponse>;
}

export interface DispatchOptions {
  /** The Fastify instance whose chain we dispatch through. Required. */
  app: DispatchAppShape;
  /** The decrypted tunnelled request. Required. */
  request: CoreRPCRequest;
  /** This server's DID — emitted as `from` on the response envelope. */
  coreDid: string;
}

/**
 * Dispatch one tunnelled RPC through the full Fastify pipeline.
 * Returns a `CoreRPCResponse` that the caller re-seals + ships.
 *
 * Does NOT seal the response — that's the caller's job (uses
 * `sealOutboundRpc` from task 4.47 with the sender's pubkey).
 * Separation keeps each layer's responsibility clean.
 */
export async function dispatchTunneledRequest(
  opts: DispatchOptions,
): Promise<CoreRPCResponse> {
  const { app, request, coreDid } = opts;
  if (!coreDid) {
    throw new Error('dispatchTunneledRequest: coreDid is required');
  }

  // ── Build the injected URL ────────────────────────────────────────────
  // `query` is a pre-serialised string (no leading `?`) per the
  // CoreRPCRequest contract in `@dina/protocol`. Append verbatim;
  // Fastify's router re-parses.
  const queryString =
    typeof request.query === 'string' ? request.query.trim() : '';
  const url = queryString ? `${request.path}?${queryString}` : request.path;

  // ── Build headers ──────────────────────────────────────────────────────
  // CoreRPCRequest.headers is `Record<string, string>`; Fastify's
  // inject accepts the same shape.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers ?? {})) {
    if (typeof v === 'string') headers[k] = v;
  }

  // ── Serialise body ────────────────────────────────────────────────────
  // CoreRPCRequest.body is a string (the sender already JSON-encoded
  // structured payloads before sealing). Pass through as-is; the
  // sender is responsible for setting `content-type` in headers.
  // Empty string → no payload (same as HTTP's "no body" semantics).
  const payload: string | undefined =
    request.body && request.body.length > 0 ? request.body : undefined;

  const fastifyRes = await app.inject(
    payload !== undefined
      ? { method: request.method, url, headers, payload }
      : { method: request.method, url, headers },
  );

  // ── Convert to CoreRPCResponse ────────────────────────────────────────
  const outHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(fastifyRes.headers)) {
    if (v === undefined) continue;
    outHeaders[k] = Array.isArray(v) ? v.join(',') : String(v);
  }

  return {
    type: RPC_RESPONSE_TYPE,
    request_id: request.request_id,
    from: coreDid,
    status: fastifyRes.statusCode,
    headers: outHeaders,
    body: fastifyRes.body,
    // `signature` is populated by `sealOutboundRpc` (task 4.47)
    // after this function returns — dispatch just produces the
    // canonical response bytes; signing is the caller's concern.
    signature: '',
  };
}
