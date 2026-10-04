/**
 * The HTTP+JSON/REST binding (A2A v1.0 §11; design §4.3, M4): the same
 * eleven operations as JSON-RPC, each at its own method and path under
 * `A2A_REST_PATH` (the v1.0 paths, no `/v1` prefix: `/message:send`,
 * `/tasks/{id}`, `/tasks/{id}:cancel`, …, as the reference SDK serves
 * them), its params read from the path, the query and the body. An answer
 * is the bare result, typed `application/a2a+json`; an error is a
 * `google.rpc.Status` with the HTTP status of A2A's mapping.
 *
 * The gateway routes by this table. Core re-derives the operation and its
 * params from what the client sent (method, path, query, raw body), checks
 * them against the route the gateway called, and runs the same operation a
 * JSON-RPC call reaches: one table and one set of operations, two ways in.
 *
 * Strict where the binding leaves room: the query may hold only the
 * operation's own parameters and `A2A-Version`, each once; a body is
 * parsed strictly, and refused where the operation takes none; an id in a
 * body must be the one in the path.
 */

import { a2aErrorInfo, isA2AErrorInfo, type JsonRpcErrorObject } from './errors';
import { A2A_DISPATCH_TABLE, isDotSegmentId } from './ingress_routes';
import { hasOwn, isPlainObject, type JsonObject, type JsonValue } from './json';
import { parseStrictJson } from './strict_json';

import type { A2AMethod } from './jsonrpc';

/** Where the REST binding lives on the gateway: the base of every path below. */
export const A2A_REST_PATH = '/a2a/rest';

/** The content type of every REST request body and answer (spec §11). */
export const A2A_REST_CONTENT_TYPE = 'application/a2a+json';

type RestMethod = 'GET' | 'POST' | 'DELETE';
type QueryKind = 'string' | 'int' | 'bool';
type BodyRule = 'required' | 'optional' | 'none';

interface RestRoute {
  method: RestMethod;
  /** Matched against the path after `A2A_REST_PATH`; groups are the ids, percent-encoded. */
  pattern: RegExp;
  operation: A2AMethod;
  /** Where each captured id goes in the params, in capture order. */
  ids: readonly ('id' | 'taskId')[];
  body: BodyRule;
  /** The query parameters the operation reads (spec §11.5: camelCase field names). */
  query: Readonly<Record<string, QueryKind>>;
}

const SEG = '([^/:]+)';
const LIST_TASKS_QUERY = {
  contextId: 'string',
  status: 'string',
  pageSize: 'int',
  pageToken: 'string',
  historyLength: 'int',
  statusTimestampAfter: 'string',
  includeArtifacts: 'bool',
} as const;

const ROUTES: readonly RestRoute[] = [
  { method: 'POST', pattern: /^\/message:send$/, operation: 'SendMessage', ids: [], body: 'required', query: {} },
  { method: 'POST', pattern: /^\/message:stream$/, operation: 'SendStreamingMessage', ids: [], body: 'required', query: {} },
  { method: 'GET', pattern: /^\/tasks$/, operation: 'ListTasks', ids: [], body: 'none', query: LIST_TASKS_QUERY },
  {
    method: 'GET',
    pattern: new RegExp(`^/tasks/${SEG}$`),
    operation: 'GetTask',
    ids: ['id'],
    body: 'none',
    query: { historyLength: 'int' },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/tasks/${SEG}:cancel$`),
    operation: 'CancelTask',
    ids: ['id'],
    body: 'optional',
    query: {},
  },
  // The proto says GET, the prose POST (unresolved upstream): the reference SDK serves both.
  { method: 'GET', pattern: new RegExp(`^/tasks/${SEG}:subscribe$`), operation: 'SubscribeToTask', ids: ['id'], body: 'none', query: {} },
  { method: 'POST', pattern: new RegExp(`^/tasks/${SEG}:subscribe$`), operation: 'SubscribeToTask', ids: ['id'], body: 'optional', query: {} },
  {
    method: 'POST',
    pattern: new RegExp(`^/tasks/${SEG}/pushNotificationConfigs$`),
    operation: 'CreateTaskPushNotificationConfig',
    ids: ['taskId'],
    body: 'required',
    query: {},
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/tasks/${SEG}/pushNotificationConfigs$`),
    operation: 'ListTaskPushNotificationConfigs',
    ids: ['taskId'],
    body: 'none',
    query: { pageSize: 'int', pageToken: 'string' },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/tasks/${SEG}/pushNotificationConfigs/${SEG}$`),
    operation: 'GetTaskPushNotificationConfig',
    ids: ['taskId', 'id'],
    body: 'none',
    query: {},
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/tasks/${SEG}/pushNotificationConfigs/${SEG}$`),
    operation: 'DeleteTaskPushNotificationConfig',
    ids: ['taskId', 'id'],
    body: 'none',
    query: {},
  },
  { method: 'GET', pattern: /^\/extendedAgentCard$/, operation: 'GetExtendedAgentCard', ids: [], body: 'none', query: {} },
];

/** A REST request matched to its operation, the ids its path names decoded. */
export interface RestMatch {
  operation: A2AMethod;
  route: RestRoute;
  ids: Readonly<Partial<Record<'id' | 'taskId', string>>>;
}

/** The operation a REST request names by its method and path, or null. */
export function matchRestRequest(method: string, path: string): RestMatch | null {
  if (!path.startsWith(`${A2A_REST_PATH}/`)) return null;
  const rest = path.slice(A2A_REST_PATH.length);
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(rest);
    if (m === null) continue;
    const ids: Partial<Record<'id' | 'taskId', string>> = {};
    for (const [i, name] of route.ids.entries()) {
      let value: string;
      try {
        value = decodeURIComponent(m[i + 1] ?? '');
      } catch {
        return null;
      }
      // Empty, or a dot segment no task has and no forward could keep: no route.
      if (value === '' || isDotSegmentId(value)) return null;
      ids[name] = value;
    }
    return { operation: route.operation, route, ids };
  }
  return null;
}

/**
 * The Core route a matched REST request goes to: its operation's route in
 * the shared table, the ids filled in from the path (the gateway forwards
 * to it; Core checks it again from the signed request).
 */
export function restIngressPath(match: RestMatch): string {
  const route = A2A_DISPATCH_TABLE[match.operation];
  let path = route.path;
  for (const [param, where] of Object.entries(route.ids) as [string, 'params.id' | 'params.taskId'][]) {
    const id = where === 'params.id' ? match.ids.id : match.ids.taskId;
    path = path.replace(`:${param}`, encodeURIComponent(id ?? ''));
  }
  return path;
}

/**
 * The methods a REST path is served by, for a 405's `Allow` header; empty
 * when no route has the path. A method counts only when the matcher would
 * take it, ids and all, so a path with an id no route accepts is a 404.
 */
export function restMethodsFor(path: string): RestMethod[] {
  return [...new Set(ROUTES.filter((r) => matchRestRequest(r.method, path) !== null).map((r) => r.method))];
}

export type RestParamsFailure = 'query_not_allowed' | 'body_not_allowed' | 'malformed_body' | 'id_mismatch';

export type RestParams =
  | { ok: true; params: JsonObject; versionParameter?: string }
  | { ok: false; reason: RestParamsFailure };

const VERSION_KEY = 'A2A-Version';
const VERSION_VALUE = /^[0-9.]{1,16}$/;
const INT_VALUE = /^(0|[1-9][0-9]{0,8})$/;

/**
 * The operation's params from what the client sent: the path's ids, the
 * query's parameters (typed), and the body. Total: every failure is a
 * reason.
 */
export function restParams(match: RestMatch, query: string, body: string): RestParams {
  const params: JsonObject = {};
  let versionParameter: string | undefined;
  if (query !== '') {
    const seen = new Set<string>();
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=');
      let key: string;
      let raw: string;
      try {
        key = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
        raw = decodeURIComponent((eq === -1 ? '' : pair.slice(eq + 1)).replace(/\+/g, ' '));
      } catch {
        return { ok: false, reason: 'query_not_allowed' };
      }
      if (seen.has(key)) return { ok: false, reason: 'query_not_allowed' };
      seen.add(key);
      if (key === VERSION_KEY) {
        if (!VERSION_VALUE.test(raw)) return { ok: false, reason: 'query_not_allowed' };
        versionParameter = raw;
        continue;
      }
      // Own members only: a key named after an Object.prototype member
      // (constructor, toString, __proto__) is not a parameter of the route.
      const kind = hasOwn(match.route.query, key) ? match.route.query[key] : undefined;
      if (kind === undefined) return { ok: false, reason: 'query_not_allowed' };
      const value = queryValue(kind, raw);
      if (value === null) return { ok: false, reason: 'query_not_allowed' };
      params[key] = value;
    }
  }
  if (body !== '') {
    if (match.route.body === 'none') return { ok: false, reason: 'body_not_allowed' };
    const parsed = parseStrictJson(body);
    if (!parsed.ok || !isPlainObject(parsed.value)) return { ok: false, reason: 'malformed_body' };
    // No route takes both query parameters and a body, so the two never collide.
    Object.assign(params, parsed.value);
  } else if (match.route.body === 'required') {
    return { ok: false, reason: 'malformed_body' };
  }
  for (const [name, value] of Object.entries(match.ids)) {
    if (params[name] !== undefined && params[name] !== value) return { ok: false, reason: 'id_mismatch' };
    params[name] = value;
  }
  return { ok: true, params, ...(versionParameter === undefined ? {} : { versionParameter }) };
}

function queryValue(kind: QueryKind, raw: string): JsonValue | null {
  switch (kind) {
    case 'string':
      return raw;
    case 'int':
      return INT_VALUE.test(raw) ? Number(raw) : null;
    case 'bool':
      return raw === 'true' ? true : raw === 'false' ? false : null;
  }
}

/**
 * A2A's error mapping for the REST binding: the HTTP status and the
 * `google.rpc.Code` name. The statuses are the reference SDK's (it answers
 * 400 where the spec's §5.4 table says 409, 415 or 502).
 */
const REST_ERRORS: Readonly<Record<number, { http: number; status: string }>> = Object.freeze({
  [-32001]: { http: 404, status: 'NOT_FOUND' },
  [-32002]: { http: 400, status: 'FAILED_PRECONDITION' },
  [-32003]: { http: 400, status: 'FAILED_PRECONDITION' },
  [-32004]: { http: 400, status: 'FAILED_PRECONDITION' },
  [-32005]: { http: 400, status: 'INVALID_ARGUMENT' },
  [-32006]: { http: 500, status: 'INTERNAL' },
  [-32007]: { http: 400, status: 'FAILED_PRECONDITION' },
  [-32008]: { http: 400, status: 'FAILED_PRECONDITION' },
  [-32009]: { http: 400, status: 'FAILED_PRECONDITION' },
  [-32700]: { http: 400, status: 'INVALID_ARGUMENT' },
  [-32600]: { http: 400, status: 'INVALID_ARGUMENT' },
  [-32601]: { http: 404, status: 'NOT_FOUND' },
  [-32602]: { http: 400, status: 'INVALID_ARGUMENT' },
  [-32603]: { http: 500, status: 'INTERNAL' },
});

/**
 * An A2A error as the REST binding answers it: the mapped HTTP status, and
 * `{error: google.rpc.Status}` whose details are the error's own: A2A's
 * `ErrorInfo` first (`a2aError` puts it there; added if a caller built the
 * error without it), then Dina's.
 */
export function restError(error: JsonRpcErrorObject): { status: number; body: JsonObject } {
  const mapped = REST_ERRORS[error.code] ?? { http: 500, status: 'INTERNAL' };
  const data = error.data ?? [];
  const details: JsonObject[] = isA2AErrorInfo(data[0]) ? [...data] : [a2aErrorInfo(error.code), ...data];
  return {
    status: mapped.http,
    body: { error: { code: mapped.http, status: mapped.status, message: error.message, details } },
  };
}
