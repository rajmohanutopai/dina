/**
 * Lane 2's internal routes (design §4.3, §5.1): the one table that maps each
 * A2A method to the Core route that serves it (since M3, every method). The gateway routes by it;
 * Core checks every call against it (`bindSignedDispatch`), so a gateway
 * that pairs a valid signature with another route is refused.
 *
 * Every internal route is a POST: the gateway forwards each call as an
 * envelope carrying the client's raw body and its credential evidence, and a
 * GET has no body to carry them.
 */

import { isPlainObject } from './json';

import type { A2AMethod, JsonRpcRequest } from './jsonrpc';

export interface IngressRoute {
  method: 'POST';
  /** Template; `:extId` is the A2A task id, `:configId` a push-config id. */
  path: string;
  /** Where the signed body names each template parameter. */
  ids: { extId?: 'params.id' | 'params.taskId'; configId?: 'params.id' };
}

export const A2A_INGRESS_PREFIX = '/v1/a2a/ingress';

/**
 * Core's ingress handler sets this header (value `1`) on every answer it
 * writes for the client. The gateway relays only answers that carry it, and
 * strips it: a refusal of the gateway itself, a Core-wide limit or a Core
 * error is never passed off as the client's own answer.
 */
export const A2A_CORE_ANSWER_HEADER = 'x-dina-a2a-answer';

/** The `WWW-Authenticate` challenge a client gets when its credential does not admit it (401). */
export const A2A_BEARER_CHALLENGE = 'Bearer realm="dina-a2a"';

/**
 * On Core's answer to a streaming call (`SendStreamingMessage`,
 * `SubscribeToTask`): the sequence number of the last event Core recorded
 * for the task when it built the Task the stream opens with. The gateway
 * sends the stream only events after it (design §7.5), and never relays
 * the header.
 */
export const A2A_EVENT_SEQ_HEADER = 'x-dina-a2a-event-seq';

/**
 * On Core's answer to a streaming call: the client's credential generation
 * when Core authenticated the call. It rises each time one of the client's
 * credentials ends (design §10: rotation answers a stolen bearer), so a
 * stream opened under an earlier one ends instead of getting another event
 * (`DeliveryItem.credential_gen`). Never relayed.
 */
export const A2A_CREDENTIAL_GEN_HEADER = 'x-dina-a2a-credential-gen';

/**
 * On Core's answer to a streaming call: an opaque key for the client the
 * stream belongs to, so a fence (`DeliveryClaim.fenced`) reaches every
 * stream of that client, on any task, including one that registers after
 * the fence came. It names no client to the gateway. Never relayed.
 */
export const A2A_STREAM_CLIENT_HEADER = 'x-dina-a2a-stream-client';

const P = A2A_INGRESS_PREFIX;

export const A2A_DISPATCH_TABLE: Readonly<Record<A2AMethod, IngressRoute>> = Object.freeze({
  SendMessage: { method: 'POST', path: `${P}/message`, ids: {} },
  SendStreamingMessage: { method: 'POST', path: `${P}/message/stream`, ids: {} },
  GetTask: { method: 'POST', path: `${P}/tasks/:extId/get`, ids: { extId: 'params.id' } },
  ListTasks: { method: 'POST', path: `${P}/tasks/list`, ids: {} },
  CancelTask: { method: 'POST', path: `${P}/tasks/:extId/cancel`, ids: { extId: 'params.id' } },
  SubscribeToTask: {
    method: 'POST',
    path: `${P}/tasks/:extId/subscribe`,
    ids: { extId: 'params.id' },
  },
  CreateTaskPushNotificationConfig: {
    method: 'POST',
    path: `${P}/push-configs/:extId/create`,
    ids: { extId: 'params.taskId' },
  },
  GetTaskPushNotificationConfig: {
    method: 'POST',
    path: `${P}/push-configs/:extId/:configId/get`,
    ids: { extId: 'params.taskId', configId: 'params.id' },
  },
  ListTaskPushNotificationConfigs: {
    method: 'POST',
    path: `${P}/push-configs/:extId/list`,
    ids: { extId: 'params.taskId' },
  },
  DeleteTaskPushNotificationConfig: {
    method: 'POST',
    path: `${P}/push-configs/:extId/:configId/delete`,
    ids: { extId: 'params.taskId', configId: 'params.id' },
  },
  GetExtendedAgentCard: { method: 'POST', path: `${P}/extended-card`, ids: {} },
});

/**
 * The methods answered as a Server-Sent Events stream (JSON-RPC binding
 * §9.4.2, §9.4.6): Core answers the Task the stream opens with, and the
 * gateway keeps the stream open for the task's later events.
 */
export const A2A_STREAMING_METHODS: ReadonlySet<A2AMethod> = new Set([
  'SendStreamingMessage',
  'SubscribeToTask',
]);

/**
 * The gateway's delivery doors (design §7.5), not client calls: it claims
 * the task events due for its streams and webhooks, then reports each one.
 */
export const A2A_EVENTS_CLAIM_ROUTE = `${P}/events/claim`;
export const A2A_EVENTS_ACK_ROUTE = `${P}/events/ack`;

/** The internal route of an operation. */
export function ingressRouteOf(method: A2AMethod): string {
  return A2A_DISPATCH_TABLE[method].path;
}

/**
 * The internal path a parsed request asks for, its ids filled in from the
 * body, or why there is none (a route id the body lacks). The gateway calls
 * this to pick a route; Core re-derives and checks it from the signed body.
 */
/**
 * Ids that cannot be a path segment: '.' and '..' are dot segments, which an
 * HTTP client folds away (WHATWG URL also folds their %2e spellings), so the
 * forward would reach another route. No task has either id.
 */
export function isDotSegmentId(id: string): boolean {
  return id === '.' || id === '..';
}

export function ingressPathFor(
  request: JsonRpcRequest,
): { ok: true; path: string } | { ok: false; reason: 'id_missing' | 'id_unroutable' } {
  const route = A2A_DISPATCH_TABLE[request.method];
  let path = route.path;
  for (const [param, where] of Object.entries(route.ids) as [string, 'params.id' | 'params.taskId'][]) {
    const params = request.params;
    const raw = isPlainObject(params) ? (where === 'params.id' ? params.id : params.taskId) : undefined;
    if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'id_missing' };
    if (isDotSegmentId(raw)) return { ok: false, reason: 'id_unroutable' };
    path = path.replace(`:${param}`, encodeURIComponent(raw));
  }
  return { ok: true, path };
}
