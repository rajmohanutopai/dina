/**
 * Open a Server-Sent Events response.
 *
 * An event stream writes its headers straight to the socket so they land
 * before any body bytes, which bypasses Fastify's own header handling. Headers
 * a hook already set on the reply (CORS for the Core-served page, see
 * web_origin.ts) would be lost that way, so they are carried into the head.
 */

import { watchCaller } from '../caller_auth';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OutgoingHttpHeaders } from 'node:http';

/**
 * Returns false, sending nothing, when the client left while its caller was
 * being checked: the route must then start no keepalive and no
 * subscription, since the connection's 'close' has already fired and their
 * cleanup would never run.
 *
 * The stream also ends when its caller leaves Brain's caller set (a revoked
 * owner device): the caller was checked once, when it connected, and must
 * not keep receiving after that (caller_auth.ts).
 */
export function openEventStream(req: FastifyRequest, reply: FastifyReply): boolean {
  const socket = reply.raw.socket;
  if (req.raw.destroyed || socket === null || socket.destroyed) {
    // Taken from Fastify and released at once: nothing will be written.
    reply.hijack();
    reply.raw.destroy();
    return false;
  }
  const set: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) set[name] = value;
  }
  reply.raw.writeHead(200, {
    ...set,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable buffering at reverse proxies (e.g., nginx).
    'X-Accel-Buffering': 'no',
  });
  // If the connection drops, EventSource waits this long before reconnecting.
  reply.raw.write('retry: 2000\n\n');
  const unwatch = watchCaller(req, () => {
    if (!reply.raw.writableEnded) reply.raw.end();
  });
  reply.raw.on('close', unwatch);
  return true;
}
