/**
 * What every Lane 2 ingress operation shares (design §4.3, §5.1, §7.2): the
 * envelope the gateway forwards, the answer it relays, and admission —
 * steps 1–4 of §7.2 for any method, plus the principal's own task lookup.
 */

import {
  A2A_BEARER_CHALLENGE,
  A2A_LIMITS,
  A2A_REST_PATH,
  A2A_RPC_PATH,
  DINA_ERROR_DOMAIN,
  a2aError,
  isPlainObject,
  jsonRpcError,
  restError,
  speaksA2AVersion,
  type JsonRpcErrorObject,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcSuccess,
} from '@dina/a2a';

import { getNodeDID } from '../pairing/ceremony';

import { authenticateA2ABearer, authenticateA2ADidRequest } from './clients';
import { bindRestDispatch, bindSignedDispatch } from './dispatch_binding';

import type { InboundCore } from './inbound_view';
import type { PrincipalBudgets } from './receipts';
import type { A2ATaskRow } from './store';

/** What the ingress operations need besides: the per-principal budgets. */
export interface InboundRuntime extends InboundCore {
  budgets: PrincipalBudgets;
}

/** A DID-signed request's four values, as the client sent them (§5.1). */
export interface DidRequestSignature {
  did: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

/** What the gateway forwards for one client call (design §4.3, §5.1): one credential, never both. */
export interface GatewayEnvelope {
  request: { method: string; path: string; query: string; body: string; version?: string };
  client_auth: { authorization?: string; did_signature?: DidRequestSignature };
}

/** What the gateway sends back to the client. */
export interface GatewayAnswer {
  status: number;
  body?: JsonRpcSuccess | JsonRpcFailure | Record<string, unknown>;
  headers?: Record<string, string>;
}

/** The gateway's public JSON-RPC path; the client's request must have come to it. */
export { A2A_RPC_PATH };

/** Whether the client sent its request by the REST binding: to a path under `A2A_REST_PATH`. */
export function isRestRequest(envelope: GatewayEnvelope): boolean {
  return envelope.request.path.startsWith(`${A2A_REST_PATH}/`);
}

/** The `google.rpc.Code` name of an answer that was never JSON-RPC (Core's own refusals). */
const GRPC_STATUS_OF_HTTP: Readonly<Record<number, string>> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'ABORTED',
  413: 'INVALID_ARGUMENT',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  503: 'UNAVAILABLE',
};

/**
 * An answer in JSON-RPC form, as every operation gives it, rendered for the
 * REST binding (spec §11): a result is the bare body; a JSON-RPC error is
 * A2A's mapped HTTP status and `google.rpc.Status` (`restError`); an answer
 * that was never JSON-RPC (a 401 challenge, 413, 429) is a
 * `google.rpc.Status` of its own status, Dina's reason in its details. The
 * headers (the challenge, `retry-after`, a stream's event cursor) stay.
 */
export function renderRestAnswer(answer: GatewayAnswer): GatewayAnswer {
  const body = answer.body;
  const headers = answer.headers === undefined ? {} : { headers: answer.headers };
  if (isPlainObject(body) && body.jsonrpc === '2.0') {
    if ('result' in body) return { status: answer.status, ...headers, body: (body.result ?? {}) as Record<string, unknown> };
    if (isPlainObject(body.error)) {
      const rendered = restError(body.error as unknown as JsonRpcErrorObject);
      return { status: rendered.status, ...headers, body: rendered.body };
    }
  }
  const reason = isPlainObject(body) && typeof body.error === 'string' ? body.error : 'error';
  return {
    status: answer.status,
    ...headers,
    body: {
      error: {
        code: answer.status,
        status: GRPC_STATUS_OF_HTTP[answer.status] ?? 'UNKNOWN',
        message: reason,
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: DINA_ERROR_DOMAIN }],
      },
    },
  };
}

export function parseGatewayEnvelope(value: unknown): GatewayEnvelope | null {
  if (!isPlainObject(value) || !isPlainObject(value.request) || !isPlainObject(value.client_auth)) return null;
  const r = value.request;
  if (typeof r.method !== 'string' || typeof r.path !== 'string' || typeof r.query !== 'string' || typeof r.body !== 'string') {
    return null;
  }
  if (r.version !== undefined && typeof r.version !== 'string') return null;
  const auth = value.client_auth.authorization;
  if (auth !== undefined && typeof auth !== 'string') return null;
  const sig = value.client_auth.did_signature;
  let didSignature: DidRequestSignature | undefined;
  if (sig !== undefined) {
    if (!isPlainObject(sig)) return null;
    const { did, timestamp, nonce, signature } = sig;
    if (typeof did !== 'string' || typeof timestamp !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string') {
      return null;
    }
    didSignature = { did, timestamp, nonce, signature };
  }
  return {
    request: {
      method: r.method,
      path: r.path,
      query: r.query,
      body: r.body,
      ...(typeof r.version === 'string' ? { version: r.version } : {}),
    },
    client_auth: {
      ...(typeof auth === 'string' ? { authorization: auth } : {}),
      ...(didSignature === undefined ? {} : { did_signature: didSignature }),
    },
  };
}

/**
 * Step 1 of every call (§5.1): who the client is, from the one credential
 * the gateway forwarded. A bearer is checked by its hash; a DID-signed
 * request by its signature over the client's own request (method, external
 * path, query, time, nonce and the raw body's hash), under the key bound at
 * binding. Both at once, or neither, is a refusal.
 */
export function authenticateIngress(
  rt: InboundRuntime,
  envelope: GatewayEnvelope,
): { ok: true; principal: string; clientId: string; scope: string[] } | { ok: false; answer: GatewayAnswer } {
  const nowMs = rt.a2a.nowMs();
  const { authorization, did_signature: sig } = envelope.client_auth;
  if (sig !== undefined) {
    if (authorization !== undefined) return { ok: false, answer: unauthenticated() };
    // The audience every request signature names: a node with no DID yet can check none.
    const nodeDid = getNodeDID();
    if (nodeDid === null) return { ok: false, answer: unauthenticated() };
    const auth = authenticateA2ADidRequest(
      rt.a2a.store,
      {
        method: envelope.request.method,
        path: envelope.request.path,
        query: envelope.request.query,
        body: new TextEncoder().encode(envelope.request.body),
        did: sig.did,
        timestamp: sig.timestamp,
        nonce: sig.nonce,
        signature: sig.signature,
      },
      nowMs,
      nodeDid,
    );
    if (!auth.ok) return { ok: false, answer: unauthenticated() };
    return { ok: true, principal: auth.principal, clientId: auth.client.client_id, scope: auth.client.scope };
  }
  const auth = authenticateA2ABearer(rt.a2a.store, authorization, nowMs);
  if (!auth.ok) return { ok: false, answer: unauthenticated() };
  return { ok: true, principal: auth.principal, clientId: auth.client.client_id, scope: auth.client.scope };
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export const unauthenticated = (): GatewayAnswer => ({
  status: 401,
  headers: { 'www-authenticate': A2A_BEARER_CHALLENGE },
  body: { error: 'unauthenticated' },
});
export const slowDown = (): GatewayAnswer => ({ status: 429, headers: { 'retry-after': '60' }, body: { error: 'rate_limited' } });
export const rpcError = (id: JsonRpcId | null, kind: Parameters<typeof a2aError>[0], reason?: string): GatewayAnswer => ({
  status: 200,
  body: jsonRpcError(id, a2aError(kind, reason)),
});

export interface Admitted {
  ok: true;
  principal: string;
  scope: string[];
  id: JsonRpcId;
  params: Record<string, unknown>;
}

/**
 * Steps 1–4 for any operation: the principal, the size cap, the binding of
 * the body to the door it came through, and the version. A request with no
 * `params` has empty ones (JSON-RPC 2.0 lets a call leave them out, and
 * `GetExtendedAgentCard` has none). Null fields mean the answer is already
 * decided.
 */
export function admitIngress(
  rt: InboundRuntime,
  envelope: GatewayEnvelope,
  route: { template: string; params: Readonly<Record<string, string>> },
): Admitted | { ok: false; answer: GatewayAnswer } {
  const auth = authenticateIngress(rt, envelope);
  if (!auth.ok) return auth;
  if (utf8Bytes(envelope.request.body) > A2A_LIMITS.maxPayloadBytes) {
    return { ok: false, answer: { status: 413, body: { error: 'payload_too_large' } } };
  }
  const signed = {
    signedMethod: envelope.request.method,
    signedPath: envelope.request.path,
    signedQuery: envelope.request.query,
    rawBody: envelope.request.body,
    internalMethod: 'POST',
    internalRouteTemplate: route.template,
    routeParams: route.params,
  };
  // The binding the client chose, by where it sent its request.
  const bound = isRestRequest(envelope) ? bindRestDispatch(signed) : bindSignedDispatch({ ...signed, rpcPath: A2A_RPC_PATH });
  if (!bound.ok) {
    return { ok: false, answer: rpcError(null, 'invalidRequest', bound.reason) };
  }
  const id = bound.request.id;
  // An absent version means 0.3 (spec §3.6.2), which Dina does not speak.
  const version = envelope.request.version ?? bound.versionParameter ?? '';
  if (!speaksA2AVersion(version)) return { ok: false, answer: rpcError(id, 'versionNotSupported') };
  const params = bound.request.params === undefined ? {} : bound.request.params;
  if (!isPlainObject(params)) return { ok: false, answer: rpcError(id, 'invalidParams', 'params_not_object') };
  // Dina serves no tenants (plan D5): every method refuses one alike, rather than some ignoring it.
  if (params.tenant !== undefined && params.tenant !== '') {
    return { ok: false, answer: rpcError(id, 'invalidParams', 'tenant_unsupported') };
  }
  return { ok: true, principal: auth.principal, scope: auth.scope, id, params };
}

/** An operation the principal owns, by its A2A task id, or null (never another's). */
export function ownedOperation(rt: InboundCore, principal: string, externalId: unknown): A2ATaskRow | null {
  return typeof externalId === 'string' ? rt.a2a.store.getTaskByExternal('inbound', principal, externalId) : null;
}
