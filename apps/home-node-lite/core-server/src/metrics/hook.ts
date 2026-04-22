/**
 * Tasks 4.88 + 4.89 — Fastify hook that feeds the metrics registry.
 *
 * Records duration + status on `onResponse` using Fastify's own
 * `reply.elapsedTime` (milliseconds), which is ALWAYS set regardless
 * of whether the response was produced by a handler, a
 * short-circuiting hook (e.g. content-type 415), or an error
 * renderer. That's the critical correctness win over capturing
 * `hrtime` in `onRequest`: Fastify skips remaining onRequest hooks
 * once any of them sends a reply, so a symbol-stashed start-time
 * would be missing for short-circuited requests and we'd silently
 * drop those observations — exactly the requests ops most need to
 * see.
 *
 * **Why `onResponse` not `onSend`**: `onResponse` fires AFTER the
 * body has been flushed. Duration measured here reflects
 * client-observable latency. `onSend` fires before network send
 * completes.
 *
 * **Route normalization**: use Fastify's matched `routeOptions.url`
 * (the pattern, e.g. `/v1/vault/items/:id`) rather than the filled
 * URL, so parameterised routes don't explode the key space. When no
 * route matched (404), fall back to `'unknown'`.
 *
 * **No onError wiring**: Fastify's setErrorHandler converts a thrown
 * handler error into a normal response, so `onResponse` fires with
 * the final status code. 5xx paths already reach us cleanly.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4l tasks 4.88 + 4.89.
 */

import type { MetricsRegistry } from './registry';

/**
 * Minimal Fastify shape we need — matches the structural typing
 * pattern used by `src/pair/routes.ts` so we don't couple to the
 * pino-specialised `FastifyInstance` generics.
 */
export interface FastifyAppShape {
  addHook(
    event: 'onResponse',
    fn: (
      req: {
        method?: string;
        routeOptions?: { url?: string };
        url?: string;
      },
      reply: { statusCode: number; elapsedTime: number },
    ) => Promise<void> | void,
  ): unknown;
}

export interface MetricsHookOptions {
  /** Metrics registry to feed. Required. */
  registry: MetricsRegistry;
}

export function installMetricsHook(app: FastifyAppShape, opts: MetricsHookOptions): void {
  const { registry } = opts;
  if (!registry) {
    throw new Error('installMetricsHook: registry is required');
  }

  app.addHook('onResponse', async (req, reply) => {
    // `reply.elapsedTime` is milliseconds per Fastify docs.
    // Fastify always sets it; a negative / NaN value would indicate
    // a runtime bug elsewhere — we guard defensively so one bad
    // request doesn't poison the histogram.
    const ms = typeof reply.elapsedTime === 'number' ? reply.elapsedTime : NaN;
    if (!Number.isFinite(ms) || ms < 0) return;

    const route =
      (typeof req.routeOptions?.url === 'string' && req.routeOptions.url) ||
      'unknown';
    const method = (req.method ?? 'UNKNOWN').toUpperCase();
    registry.record(route, method, reply.statusCode, ms / 1000);
  });
}
