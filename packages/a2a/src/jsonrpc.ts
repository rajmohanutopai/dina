/**
 * The JSON-RPC 2.0 envelope of the A2A JSON-RPC binding (spec §9).
 *
 * Parsing answers one question: is this a well-formed request for a method
 * A2A defines? Method-specific params are checked by the caller.
 *
 * Request text goes through the strict I-JSON parser, so a body with
 * duplicate members (two `method`s, say) is refused rather than read
 * last-wins.
 *
 * A request object with no `id` member is a notification. A2A defines no
 * notifications, and JSON-RPC 2.0 §4.1 says a server must not reply to one,
 * so a notification is neither executed nor answered: the parse reports it,
 * and the HTTP layer answers 204 with no body.
 */

import { JSONRPC_ERROR_CODES, a2aError, type JsonRpcErrorObject } from './errors';
import { hasOwn, isPlainObject, type JsonObject, type JsonValue } from './json';
import { parseStrictJson } from './strict_json';

export const A2A_METHODS = [
  'SendMessage',
  'SendStreamingMessage',
  'GetTask',
  'ListTasks',
  'CancelTask',
  'SubscribeToTask',
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
  'GetExtendedAgentCard',
] as const;
export type A2AMethod = (typeof A2A_METHODS)[number];

const METHOD_SET: ReadonlySet<string> = new Set(A2A_METHODS);

export function isA2AMethod(method: string): method is A2AMethod {
  return METHOD_SET.has(method);
}

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: A2AMethod;
  params: JsonObject;
}

export type ParsedJsonRpcRequest =
  | { ok: true; request: JsonRpcRequest }
  /** Answer with this error object. */
  | { ok: false; id: JsonRpcId | null; error: JsonRpcErrorObject }
  /** No `id` member: execute nothing and send no JSON-RPC reply. */
  | { ok: false; notification: true };

const ALLOWED_REQUEST_KEYS: ReadonlySet<string> = new Set(['jsonrpc', 'id', 'method', 'params']);

/** Parse raw request text (the exact bytes the client sent). */
export function parseJsonRpcRequestText(text: string): ParsedJsonRpcRequest {
  const parsed = parseStrictJson(text);
  if (!parsed.ok) {
    return parsed.reason === 'syntax'
      ? { ok: false, id: null, error: a2aError('parseError') }
      : { ok: false, id: null, error: a2aError('invalidRequest', parsed.reason) };
  }
  return parseJsonRpcRequest(parsed.value);
}

/**
 * One request. A notification is a valid Request object without an `id`
 * (JSON-RPC 2.0 §4.1): neither executed nor answered. An object that is not
 * a valid Request is answered Invalid Request with the id it could read, or
 * `null` when it has none (§5; the §7 example answers `{"jsonrpc": "2.0",
 * "method": 1, "params": "bar"}` that way), so a broken request is never
 * mistaken for one that needs no answer.
 */
export function parseJsonRpcRequest(value: unknown): ParsedJsonRpcRequest {
  if (!isPlainObject(value)) {
    return { ok: false, id: null, error: a2aError('invalidRequest') };
  }
  const hasId = hasOwn(value, 'id');
  const read = hasId ? readId(value) : null;
  if (read === undefined) {
    return { ok: false, id: null, error: a2aError('invalidRequest', 'id_invalid') };
  }
  const id = read;
  for (const key of Object.keys(value)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      return { ok: false, id, error: a2aError('invalidRequest', 'unknown_member') };
    }
  }
  if (value.jsonrpc !== '2.0') {
    return { ok: false, id, error: a2aError('invalidRequest', 'jsonrpc_version') };
  }
  if (typeof value.method !== 'string') {
    return { ok: false, id, error: a2aError('invalidRequest', 'method_required') };
  }
  // §4.2: params, when present, is a structured value (an object or an array).
  if (hasOwn(value, 'params') && !isPlainObject(value.params) && !Array.isArray(value.params)) {
    return { ok: false, id, error: a2aError('invalidRequest', 'params_not_structured') };
  }
  if (id === null) return { ok: false, notification: true };
  if (!isA2AMethod(value.method)) {
    return { ok: false, id, error: a2aError('methodNotFound') };
  }
  let params: JsonObject = {};
  if (hasOwn(value, 'params')) {
    if (!isPlainObject(value.params)) {
      return { ok: false, id, error: a2aError('invalidParams', 'params_not_object') };
    }
    params = value.params as JsonObject;
  }
  return { ok: true, request: { id, method: value.method, params } };
}

/** `undefined` when the `id` member is not a non-empty string or a safe integer. */
function readId(value: Record<string, unknown>): JsonRpcId | undefined {
  const id = value.id;
  if (typeof id === 'string' && id.length > 0 && id.length <= 256) return id;
  if (typeof id === 'number' && Number.isSafeInteger(id)) return id;
  return undefined;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: JsonValue;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export function jsonRpcResult(id: JsonRpcId, result: JsonValue): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

export function jsonRpcError(id: JsonRpcId | null, error: JsonRpcErrorObject): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error };
}

export function buildJsonRpcRequest(
  id: JsonRpcId,
  method: A2AMethod,
  params: JsonObject,
): JsonObject {
  return { jsonrpc: '2.0', id, method, params };
}

export type ParsedJsonRpcResponse =
  | { ok: true; result: JsonValue }
  | { ok: false; error: { code: number; message: string } }
  | { ok: false; malformed: string };

/** Parse a peer's response text strictly, then as a response to `expectedId`. */
export function parseJsonRpcResponseText(
  text: string,
  expectedId: JsonRpcId,
): ParsedJsonRpcResponse {
  const parsed = parseStrictJson(text);
  if (!parsed.ok) return { ok: false, malformed: `json_${parsed.reason}` };
  return parseJsonRpcResponse(parsed.value, expectedId);
}

/**
 * Parse a peer's response to a request Dina sent with `expectedId`. A reply
 * whose id differs is malformed: it answers some other call. One exception,
 * JSON-RPC 2.0 §5: a server that could not read the request's id answers a
 * parse error or an invalid request with id null, so those two errors, and
 * only those, may come with a null id. They say the request was refused
 * unread, which is what they are taken to mean.
 */
export function parseJsonRpcResponse(value: unknown, expectedId: JsonRpcId): ParsedJsonRpcResponse {
  if (!isPlainObject(value)) return { ok: false, malformed: 'not_an_object' };
  if (value.jsonrpc !== '2.0') return { ok: false, malformed: 'jsonrpc_version' };
  if (value.id !== expectedId && !(value.id === null && refusedUnread(value))) return { ok: false, malformed: 'id_mismatch' };
  const hasResult = hasOwn(value, 'result');
  const hasError = hasOwn(value, 'error');
  if (hasResult === hasError) return { ok: false, malformed: 'result_xor_error' };
  if (hasResult) return { ok: true, result: value.result as JsonValue };
  const error = value.error;
  if (
    !isPlainObject(error) ||
    typeof error.code !== 'number' ||
    typeof error.message !== 'string'
  ) {
    return { ok: false, malformed: 'error_shape' };
  }
  return { ok: false, error: { code: error.code, message: error.message } };
}

/** An error answer only a server that could not read the request's id may send with id null (§5). */
function refusedUnread(value: Record<string, unknown>): boolean {
  const error = value.error;
  return (
    !hasOwn(value, 'result') &&
    isPlainObject(error) &&
    (error.code === JSONRPC_ERROR_CODES.parseError || error.code === JSONRPC_ERROR_CODES.invalidRequest)
  );
}
