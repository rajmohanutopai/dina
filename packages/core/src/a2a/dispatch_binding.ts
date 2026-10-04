/**
 * Dispatch binding (design §5.1, A2A-I2): Core never trusts the gateway's
 * choice of route. For a request it executes, Core parses the JSON-RPC
 * operation and its identifiers from the SIGNED raw body and checks that the
 * internal route the gateway called is the one that operation maps to, with
 * the same task (and config) ids. A gateway that pairs a valid signature with
 * a different operation or a different task is refused.
 *
 * The table is total over A2A's eleven methods: each maps to exactly one
 * internal route, and no two share one.
 *
 * Every internal route is a POST. The gateway forwards each call as an
 * envelope carrying the client's raw signed body and its `client_auth`, and a
 * GET has no body to carry them (Fastify, like most servers, drops one).
 *
 * The signed body is parsed strictly (`parseStrictJson`), so two members with
 * one name cannot bind one operation and execute another. The signed query
 * may hold only the `A2A-Version` request parameter (spec §3.6); anything
 * else is refused rather than left unbound.
 *
 * The REST binding (M4, `bindRestDispatch`) reaches the same operations: the
 * operation comes from the signed method and path, its params from the
 * path, the signed query and the raw body (`restParams`, as strict), and the
 * same check binds them to the route the gateway called.
 */

import {
  A2A_DISPATCH_TABLE,
  isPlainObject,
  matchRestRequest,
  parseJsonRpcRequestText,
  restParams,
  type A2AMethod,
  type IngressRoute,
  type JsonObject,
  type JsonRpcRequest,
} from '@dina/a2a';

export interface SignedDispatchInput {
  /** The HTTP method and path the client signed (its gateway-facing request). */
  signedMethod: string;
  signedPath: string;
  /** The query string the client signed, without the `?` (often empty). */
  signedQuery: string;
  /** The gateway's JSON-RPC endpoint path, from configuration. */
  rpcPath: string;
  /** The raw request body exactly as the client sent and signed it. */
  rawBody: string;
  /** The internal route the gateway called, and its parameters. */
  internalMethod: string;
  internalRouteTemplate: string;
  routeParams: Readonly<Record<string, string>>;
}

export type DispatchBinding =
  | {
      ok: true;
      request: JsonRpcRequest;
      route: IngressRoute;
      /** The `A2A-Version` request parameter, when the client signed one. */
      versionParameter?: string;
    }
  | {
      ok: false;
      reason:
        | 'external_mismatch'
        | 'query_not_allowed'
        | 'malformed_body'
        | 'body_not_allowed'
        | 'operation_mismatch'
        | 'id_missing'
        | 'id_mismatch';
    };

function readId(
  params: Record<string, unknown>,
  where: 'params.id' | 'params.taskId',
): string | null {
  const v = where === 'params.id' ? params.id : params.taskId;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

const VERSION_PARAM = /^A2A-Version=([0-9.]{1,16})$/;

export function bindSignedDispatch(input: SignedDispatchInput): DispatchBinding {
  if (input.signedMethod !== 'POST' || input.signedPath !== input.rpcPath) {
    return { ok: false, reason: 'external_mismatch' };
  }
  let versionParameter: string | undefined;
  if (input.signedQuery !== '') {
    const match = VERSION_PARAM.exec(input.signedQuery);
    if (match === null) return { ok: false, reason: 'query_not_allowed' };
    versionParameter = match[1];
  }
  const parsed = parseJsonRpcRequestText(input.rawBody);
  if (!parsed.ok) return { ok: false, reason: 'malformed_body' };
  return bindToRoute(parsed.request, input, versionParameter);
}

/** The operation and its params bound to the route the gateway called: the same operation, the same ids. */
function bindToRoute(
  request: JsonRpcRequest,
  input: Pick<SignedDispatchInput, 'internalMethod' | 'internalRouteTemplate' | 'routeParams'>,
  versionParameter: string | undefined,
): DispatchBinding {
  const route = A2A_DISPATCH_TABLE[request.method];
  if (input.internalMethod !== route.method || input.internalRouteTemplate !== route.path) {
    return { ok: false, reason: 'operation_mismatch' };
  }
  const params = request.params;
  const expected: Record<string, string> = {};
  for (const [param, where] of Object.entries(route.ids) as [
    string,
    'params.id' | 'params.taskId',
  ][]) {
    const id = isPlainObject(params) ? readId(params, where) : null;
    if (id === null) return { ok: false, reason: 'id_missing' };
    expected[param] = id;
  }
  const given = Object.keys(input.routeParams);
  const wanted = Object.keys(expected);
  if (given.length !== wanted.length || wanted.some((k) => input.routeParams[k] !== expected[k])) {
    return { ok: false, reason: 'id_mismatch' };
  }
  return {
    ok: true,
    request,
    route,
    ...(versionParameter !== undefined ? { versionParameter } : {}),
  };
}

/**
 * The REST binding has no request id. Core's operations answer in JSON-RPC
 * form whatever the binding; for a REST call they answer under this id, and
 * the ingress route renders the answer as REST, the envelope and its id
 * dropped (`renderRestAnswer`), so it never reaches the client.
 */
export const REST_REQUEST_ID = 'rest';

/** `bindSignedDispatch` for the REST binding (see the module comment). */
export function bindRestDispatch(
  input: Omit<SignedDispatchInput, 'rpcPath'>,
): DispatchBinding {
  const match = matchRestRequest(input.signedMethod, input.signedPath);
  if (match === null) return { ok: false, reason: 'external_mismatch' };
  const params = restParams(match, input.signedQuery, input.rawBody);
  if (!params.ok) return { ok: false, reason: params.reason };
  const request: JsonRpcRequest = { id: REST_REQUEST_ID, method: match.operation as A2AMethod, params: params.params as JsonObject };
  return bindToRoute(request, input, params.versionParameter);
}
