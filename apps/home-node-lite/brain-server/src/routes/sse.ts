/**
 * Open a Server-Sent Events response.
 *
 * An event stream writes its headers straight to the socket so they land
 * before any body bytes, which bypasses Fastify's own header handling. Headers
 * a hook already set on the reply (CORS for the Core-served page, see
 * web_origin.ts) would be lost that way, so they are carried into the head.
 */

import type { FastifyReply } from 'fastify';
import type { OutgoingHttpHeaders } from 'node:http';

export function openEventStream(reply: FastifyReply): void {
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
}
