/**
 * Task 4.91 — GET /v1/admin/sync-status Fastify route.
 *
 * Surfaced by the 4.84 admin-API audit. Returns the Core ↔ Brain
 * connectivity status so admin UI + ops tooling can detect a broken
 * sidecar without guessing from handler failures.
 *
 * **Wire parity with Go** (`core/internal/handler/admin.go`
 * `HandleSyncStatus` / `syncStatusResponse`):
 *
 *   GET /v1/admin/sync-status
 *   → 200 { brain_connected: boolean, status: "ok" | "degraded" }
 *
 * `status = "ok"` iff `brain_connected === true`. Non-200 is only
 * possible on probe failure (probe threw — 500). We explicitly avoid
 * leaking the Brain URL or any internal endpoint — matches Go's
 * CXH6 fix that removed `ProxyTarget` from the response body.
 *
 * **Probe injection**: caller passes `brainProbeFn()` returning
 * `Promise<boolean>`. Production wires a Brain health-check
 * (reachable within 2s = connected); tests pass scripted resolvers.
 * Without a probe, `brain_connected` is always `false` — matches the
 * Go behavior when `ProxyURL` is empty.
 *
 * **Auth note**: this route is admin-gated in production (Bearer
 * token via the `DeviceTokenBearerValidator` from task 4.65 or
 * equivalent). The plugin itself is auth-agnostic; the middleware
 * wraps it at composition time.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4l task 4.91 (surfaced by 4.84).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

export type BrainProbeFn = () => Promise<boolean>;

export interface SyncStatusRoutesOptions {
  /**
   * Probe returning whether Brain is currently reachable. When omitted,
   * `brain_connected` is reported as `false` (parity with Go's empty-
   * ProxyURL behavior). Production wires a bounded-timeout HTTP probe
   * to the Brain's `/healthz`.
   */
  brainProbeFn?: BrainProbeFn;
}

export interface SyncStatusResponse {
  brain_connected: boolean;
  status: 'ok' | 'degraded';
}

type RouteHandler = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown> | unknown;

export interface FastifyAppShape {
  get(path: string, handler: RouteHandler): unknown;
}

export const SYNC_STATUS_PATH = '/v1/admin/sync-status';

export function registerSyncStatusRoute(
  app: FastifyAppShape,
  opts: SyncStatusRoutesOptions = {},
): void {
  const probe = opts.brainProbeFn;

  app.get(SYNC_STATUS_PATH, async (req, reply) => {
    let connected = false;
    if (probe !== undefined) {
      try {
        connected = await probe();
      } catch (err) {
        req.log.warn(
          { err: (err as Error).message },
          '/v1/admin/sync-status: brain probe threw',
        );
        await reply.code(500).send({ error: 'brain probe failed' });
        return;
      }
    }
    const body: SyncStatusResponse = {
      brain_connected: connected,
      status: connected ? 'ok' : 'degraded',
    };
    return body;
  });
}
