/**
 * Task 4.36 — `/v1/ws/notify` route wiring for the Notify hub.
 *
 * Handles the auth'd upgrade handshake: the client presents a
 * `Authorization: Bearer <clientToken>` header (same Bearer token
 * issued during pairing, task 4.63/4.64), we run it through the
 * supplied `authenticate()` callback (typically the
 * `DeviceTokenBearerValidator` from task 4.65), and on success
 * register the resulting deviceId with the hub (task 4.37).
 *
 * **Why not pin `@fastify/websocket` here**: the concrete
 * Fastify-WebSocket plug-in isn't yet in this package's deps, and
 * adding an npm dep is out of scope for a feature task. This module
 * exposes a transport-agnostic wiring that accepts a `WebSocketLike`
 * (from `notify_hub.ts`) via a `wsFactory` callback. Production
 * wires `wsFactory` to `@fastify/websocket`'s connection; tests
 * pass an in-memory factory. Same surface either way.
 *
 * **Auth-gated upgrade**: the `authenticate(request)` callback
 * returns `{ok: true, deviceId} | {ok: false, reason}`. On
 * rejection we send HTTP 401 with the Dina error envelope — the
 * WebSocket upgrade is abandoned without consuming hub resources.
 * Fastify's middleware chain (rate limit + body limit + metrics)
 * runs BEFORE the upgrade handler, so auth-rejected upgrades still
 * count in the metrics registry.
 *
 * **Lifecycle**: on successful upgrade we register the socket with
 * the hub, then attach a `close` observer that calls
 * `hub.unregister(deviceId)`. If the observer API varies across
 * WS libraries, the caller can pass an explicit
 * `onDisconnect(socket, handler)` wiring hook.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4e task 4.36.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { NotifyHub, WebSocketLike } from './notify_hub';

/** Result of `authenticate()`. */
export type NotifyAuthResult =
  | { ok: true; deviceId: string }
  | { ok: false; reason: 'missing' | 'malformed' | 'unknown_token' };

/**
 * Pluggable Bearer-token validator. Production wires this to the
 * `DeviceTokenBearerValidator.validate` (via
 * `authenticateBearerFromDeviceRegistry` from task 4.65) so the
 * Authorization header is validated against the live token registry.
 */
export type NotifyAuthenticateFn = (
  req: FastifyRequest,
) => NotifyAuthResult | Promise<NotifyAuthResult>;

/**
 * Factory that gets called AFTER auth succeeds. Its job is to produce
 * the `WebSocketLike` for this connection from the underlying
 * transport (Fastify-websocket connection, `ws.Server`, etc.) + wire
 * a `disconnect` observer that invokes the supplied `onDisconnect`.
 *
 * Production implementation (pseudo-code, awaiting the fastify-websocket
 * dep bump):
 *
 * ```ts
 * async wsFactory(req, reply, onDisconnect) {
 *   const wsConn = await reply.raw.accept(); // from @fastify/websocket
 *   wsConn.socket.on('close', () => onDisconnect());
 *   return wsConn.socket;
 * }
 * ```
 */
export type NotifyWsFactory = (
  req: FastifyRequest,
  reply: FastifyReply,
  onDisconnect: () => void,
) => WebSocketLike | null | Promise<WebSocketLike | null>;

/** Structural subset of Fastify we actually use. */
type RouteHandler = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown> | unknown;

export interface FastifyAppShape {
  get(path: string, handler: RouteHandler): unknown;
}

export interface NotifyRouteOptions {
  hub: NotifyHub;
  authenticate: NotifyAuthenticateFn;
  wsFactory: NotifyWsFactory;
  /** Route path. Default `/v1/ws/notify`. */
  path?: string;
}

export const DEFAULT_NOTIFY_WS_PATH = '/v1/ws/notify';

/**
 * Register the Notify WebSocket route on the Fastify app.
 *
 * The route handler:
 *   1. Runs `authenticate(req)` → reject 401 on failure.
 *   2. Invokes `wsFactory(req, reply, onDisconnect)` where
 *      `onDisconnect` is a closure that calls `hub.unregister(deviceId)`.
 *   3. `hub.register(deviceId, socket)` on success.
 *   4. Returns undefined — the reply is owned by the WS upgrade path.
 */
export function registerNotifyRoute(
  app: FastifyAppShape,
  opts: NotifyRouteOptions,
): void {
  const { hub, authenticate, wsFactory } = opts;
  if (!hub) throw new Error('registerNotifyRoute: hub is required');
  if (!authenticate) {
    throw new Error('registerNotifyRoute: authenticate is required');
  }
  if (!wsFactory) throw new Error('registerNotifyRoute: wsFactory is required');
  const path = opts.path ?? DEFAULT_NOTIFY_WS_PATH;

  app.get(path, async (req, reply) => {
    const auth = await authenticate(req);
    if (!auth.ok) {
      const status = auth.reason === 'missing' ? 401 : 401;
      await reply.code(status).send({
        error: mapReasonToMessage(auth.reason),
      });
      return;
    }
    const deviceId = auth.deviceId;

    const socket = await wsFactory(req, reply, () => {
      hub.unregister(deviceId);
    });
    if (socket === null) {
      // Factory refused — it's responsible for having called reply.*
      // to finalise the HTTP response. Defensive: if it hasn't, we
      // emit a generic 500 so the caller isn't left hanging.
      if (!reply.sent) {
        await reply.code(500).send({ error: 'websocket upgrade failed' });
      }
      return;
    }
    hub.register(deviceId, socket);
  });
}

function mapReasonToMessage(
  reason: Exclude<NotifyAuthResult, { ok: true }>['reason'],
): string {
  switch (reason) {
    case 'missing':
      return 'authorization header is required';
    case 'malformed':
      return 'authorization header is malformed';
    case 'unknown_token':
      return 'unknown or revoked token';
  }
}
