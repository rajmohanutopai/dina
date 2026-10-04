/**
 * The gateway's doors into Core (A2A design §4.3, §7.2): one POST per A2A
 * operation Dina serves, at the paths the dispatch-binding table names, so
 * the route and the binding Core checks the body against are one table.
 * Only the gateway may call them (the authorization matrix opens nothing
 * else to it, and nothing here to anyone else); the handler checks again.
 *
 * `GET /v1/a2a/card` hands the gateway the signed public card and the JWK
 * Set its `jku` names (§7.1); the gateway serves both as they come.
 *
 * `POST /v1/a2a/ingress/events/claim` and `/ack` are the gateway's delivery
 * doors (§7.5): it claims the task events due for its streams and webhooks,
 * then reports each one. `POST /v1/a2a/ingress/did/complete` binds a client
 * to a DID (§5.1, M4).
 *
 * Each request carries the client's raw request and its credential evidence
 * (`GatewayEnvelope`); each answer is what the gateway relays to the client:
 * an HTTP status, headers, and a JSON-RPC body.
 */

import {
  A2A_CORE_ANSWER_HEADER,
  A2A_DID_COMPLETE_ROUTE,
  A2A_EVENTS_ACK_ROUTE,
  A2A_EVENTS_CLAIM_ROUTE,
  DELIVERY_LIMITS,
  ingressRouteOf,
  isPlainObject,
  parseDeliveryAcks,
  A2A_METHODS,
  type A2AMethod,
} from '@dina/a2a';

import { ackDeliveries, claimDeliveries } from '../../a2a/delivery';
import { ingressCompleteDidBinding } from '../../a2a/did_binding';
import {
  awaitSendMessage,
  ingressCancelTask,
  ingressGetTask,
  ingressListTasks,
  ingressSendMessage,
  ingressSubscribeToTask,
  inboundCore,
} from '../../a2a/inbound';
import { buildInboundCard, getA2ACardConfig, ingressGetExtendedAgentCard } from '../../a2a/inbound_card';
import {
  isRestRequest,
  parseGatewayEnvelope,
  renderRestAnswer,
  type GatewayAnswer,
  type GatewayEnvelope,
  type InboundRuntime,
} from '../../a2a/ingress_common';
import {
  ingressCreatePushConfig,
  ingressDeletePushConfig,
  ingressGetPushConfig,
  ingressListPushConfigs,
} from '../../a2a/push_configs';
import { PrincipalBudgets } from '../../a2a/receipts';
import { getA2ARuntime, getA2AStore } from '../../a2a/runtime';
import { getNodeDID } from '../../pairing/ceremony';

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

/** One budget book per process: the gateway's calls all land here. */
let budgets = new PrincipalBudgets();

/** Tests start each case with fresh budgets. */
export function resetA2AIngressState(): void {
  budgets = new PrincipalBudgets();
}

const json = (status: number, body: unknown, headers?: Record<string, string>): CoreResponse => ({
  status,
  body,
  ...(headers === undefined ? {} : { headers }),
});

type Handler = (
  rt: InboundRuntime,
  envelope: GatewayEnvelope,
  req: CoreRequest,
) => GatewayAnswer | Promise<GatewayAnswer>;

function currentRuntime() {
  try {
    return getA2ARuntime();
  } catch {
    return null;
  }
}

function serve(handle: Handler): (req: CoreRequest) => Promise<CoreResponse> {
  return async (req) => {
    if (req.callerType !== 'gateway') return json(403, { error: 'gateway_only' });
    const envelope = parseGatewayEnvelope(req.body);
    if (envelope === null) return json(400, { error: 'envelope_malformed' });
    const a2a = currentRuntime();
    if (a2a === null) return json(503, { error: 'a2a_unavailable' });
    const given = await handle({ ...inboundCore(a2a), budgets }, envelope, req);
    // Every operation answers in JSON-RPC form; a REST call gets it rendered for REST.
    const answer = isRestRequest(envelope) ? renderRestAnswer(given) : given;
    return json(answer.status, answer.body, { ...answer.headers, [A2A_CORE_ANSWER_HEADER]: '1' });
  };
}

/** The card config and node DID the cards are built from, or null where Lane 2 is not configured. */
function cardInputs() {
  const config = getA2ACardConfig();
  const nodeDid = getNodeDID();
  return config === null || nodeDid === null ? null : { config, nodeDid };
}

/**
 * The gateway claims due task events (§7.5); body `{limit?, webhook_limit?}`:
 * at most `DELIVERY_LIMITS.maxClaim` events, of which at most
 * `webhook_limit` webhook POSTs (none when absent).
 */
function claimEvents(req: CoreRequest): CoreResponse {
  if (req.callerType !== 'gateway' || req.callerDID === undefined) return json(403, { error: 'gateway_only' });
  const body = req.body === undefined || req.body === null ? {} : req.body;
  if (!isPlainObject(body)) return json(400, { error: 'body_malformed' });
  const count = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, DELIVERY_LIMITS.maxClaim) : fallback;
  const limit = count(body.limit, DELIVERY_LIMITS.maxClaim);
  const webhookLimit = count(body.webhook_limit, 0);
  const a2a = currentRuntime();
  if (a2a === null) return json(503, { error: 'a2a_unavailable' });
  return json(200, claimDeliveries(inboundCore(a2a), { claimant: req.callerDID, limit, webhookLimit }));
}

/** The gateway reports what became of each claimed event. */
function ackEvents(req: CoreRequest): CoreResponse {
  if (req.callerType !== 'gateway' || req.callerDID === undefined) return json(403, { error: 'gateway_only' });
  const acks = parseDeliveryAcks(req.body);
  if (acks === null) return json(400, { error: 'acks_malformed' });
  const a2a = currentRuntime();
  if (a2a === null) return json(503, { error: 'a2a_unavailable' });
  return json(200, { applied: ackDeliveries(inboundCore(a2a), { claimant: req.callerDID, acks }) });
}

/** The gateway reads the public card here, and serves it and its JWK Set as they come. */
export const A2A_CARD_ROUTE = '/v1/a2a/card';

async function serveCard(req: CoreRequest): Promise<CoreResponse> {
  if (req.callerType !== 'gateway') return json(403, { error: 'gateway_only' });
  const inputs = cardInputs();
  const store = getA2AStore();
  if (inputs === null || store === null) return json(503, { error: 'a2a_card_unconfigured' });
  const built = await buildInboundCard(store, inputs);
  if (!built.ok) return json(404, { error: built.reason });
  return json(200, { card: built.card, jwks: built.jwks });
}

/**
 * Whether `method` + `path` (no query) is one of the gateway's routes: the
 * card read, a method's ingress route, or a delivery door. Hosts use it to scope
 * limiter exemptions to exactly these routes (design §4.1).
 */
export function isA2AGatewayRoute(method: string, path: string): boolean {
  if (method === 'GET') return path === A2A_CARD_ROUTE;
  if (method !== 'POST') return false;
  if (path === A2A_EVENTS_CLAIM_ROUTE || path === A2A_EVENTS_ACK_ROUTE || path === A2A_DID_COMPLETE_ROUTE) return true;
  const given = path.split('/');
  return A2A_METHODS.some((m) => {
    const template = ingressRouteOf(m).split('/');
    return (
      template.length === given.length &&
      template.every((part, i) => (part.startsWith(':') ? (given[i] ?? '') !== '' : part === given[i]))
    );
  });
}

export function registerA2AIngressRoutes(router: CoreRouter): void {
  router.get(A2A_CARD_ROUTE, serveCard);
  router.post(A2A_EVENTS_CLAIM_ROUTE, claimEvents);
  router.post(A2A_EVENTS_ACK_ROUTE, ackEvents);
  router.post(
    A2A_DID_COMPLETE_ROUTE,
    serve((rt, envelope) => ingressCompleteDidBinding(rt, envelope, getNodeDID())),
  );
  // One handler per A2A method, and a route for each and no other.
  const ext = (req: CoreRequest): string => req.params.extId ?? '';
  const cfg = (req: CoreRequest): string => req.params.configId ?? '';
  const handlers: Readonly<Record<A2AMethod, Handler>> = {
    SendMessage: (rt, envelope) => awaitSendMessage(rt, envelope),
    SendStreamingMessage: (rt, envelope) => ingressSendMessage(rt, envelope, 'SendStreamingMessage'),
    ListTasks: (rt, envelope) => ingressListTasks(rt, envelope),
    GetTask: (rt, envelope, req) => ingressGetTask(rt, envelope, ext(req)),
    CancelTask: (rt, envelope, req) => ingressCancelTask(rt, envelope, ext(req)),
    SubscribeToTask: (rt, envelope, req) => ingressSubscribeToTask(rt, envelope, ext(req)),
    CreateTaskPushNotificationConfig: (rt, envelope, req) => ingressCreatePushConfig(rt, envelope, ext(req)),
    GetTaskPushNotificationConfig: (rt, envelope, req) => ingressGetPushConfig(rt, envelope, ext(req), cfg(req)),
    ListTaskPushNotificationConfigs: (rt, envelope, req) => ingressListPushConfigs(rt, envelope, ext(req)),
    DeleteTaskPushNotificationConfig: (rt, envelope, req) => ingressDeletePushConfig(rt, envelope, ext(req), cfg(req)),
    GetExtendedAgentCard: (rt, envelope) => ingressGetExtendedAgentCard(rt, envelope, cardInputs()),
  };
  for (const method of A2A_METHODS) router.post(ingressRouteOf(method), serve(handlers[method]));
}
