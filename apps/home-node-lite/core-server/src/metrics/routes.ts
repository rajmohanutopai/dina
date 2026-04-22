/**
 * Task 4.85 — GET /metrics Fastify route (Prometheus text exposition).
 *
 * Opt-in: callers that want the `/metrics` endpoint wire the hook
 * (tasks 4.88 + 4.89) AND this route module. Omitting either gives a
 * server that doesn't expose metrics — zero overhead + zero surface
 * area for installs that don't scrape.
 *
 * Response shape: Prometheus `text/plain; version=0.0.4; charset=utf-8`.
 * Every scraper (Prometheus, Grafana Agent, VictoriaMetrics) accepts
 * this. Status is 200 even when no traffic has been observed —
 * scrapers expect well-formed empty-ish output rather than a 404 on
 * cold boot.
 *
 * **Path override**: some deployments reserve `/metrics` for node-
 * exporter and prefer `/dina/metrics`. Caller supplies `path` to
 * rebind.
 *
 * **No auth guard here** — Prometheus scrape typically lives behind
 * a firewall or separate listener. The admin-auth middleware (task
 * 4.65+) can wrap this route at composition time if exposed publicly.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4l task 4.85.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MetricsRegistry } from './registry';
import {
  PROMETHEUS_CONTENT_TYPE,
  renderPrometheusText,
  type RenderPrometheusTextOptions,
} from './exporter';

export const DEFAULT_METRICS_PATH = '/metrics';

export interface MetricsRoutesOptions {
  /** Metrics registry fed by the hook (task 4.88). Required. */
  registry: MetricsRegistry;
  /** Path to bind. Default `/metrics`. */
  path?: string;
  /** Forwarded to `renderPrometheusText`. */
  namePrefix?: string;
}

type RouteHandler = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown> | unknown;

export interface FastifyAppShape {
  get(path: string, handler: RouteHandler): unknown;
}

export function registerMetricsRoutes(
  app: FastifyAppShape,
  opts: MetricsRoutesOptions,
): void {
  const { registry } = opts;
  if (!registry) {
    throw new Error('registerMetricsRoutes: registry is required');
  }
  const path = opts.path ?? DEFAULT_METRICS_PATH;
  if (!path.startsWith('/')) {
    throw new Error(`registerMetricsRoutes: path must start with '/' (got ${path})`);
  }
  const renderOpts: RenderPrometheusTextOptions = {};
  if (opts.namePrefix !== undefined) renderOpts.namePrefix = opts.namePrefix;

  app.get(path, async (_req, reply) => {
    const body = renderPrometheusText(registry.snapshot(), renderOpts);
    reply
      .code(200)
      .header('content-type', PROMETHEUS_CONTENT_TYPE)
      .send(body);
  });
}
