/**
 * Owner-only poll-mode watch-management API (PSVC-0 / PSVC-4). Additive,
 * snake_case:
 *
 *   GET  /v1/watch/list
 *   POST /v1/watch/:id/pause | /resume | /cancel
 *
 * OWNER-ONLY — the same boundary as `/v1/run/*` (§12.5): every request whose
 * resolved caller is not the owner is rejected in-handler (Brain's shared
 * in-process transport carries no `callerType` and is rejected; only the
 * dedicated owner dispatch stamps `callerType='owner'`). A subscription is the
 * subscriber's own standing work — no agent or Brain may list or steer it.
 */

import { watchTaskToListItem, type WatchListItem } from '../../watch/list';
import { getWatchService, type WatchService } from '../../watch/service';

import type { CoreRouter, CoreRequest, CoreResponse } from '../router';

export type { WatchListItem } from '../../watch/list';

function j(status: number, body: unknown): CoreResponse {
  return { status, body };
}

function ownerOnlyGuard(req: CoreRequest): CoreResponse | null {
  if (req.callerType !== 'owner') {
    return j(403, { error: 'access_denied', reason: 'only the owner may list or steer a watch' });
  }
  return null;
}

function requireService(): WatchService | CoreResponse {
  const svc = getWatchService();
  if (svc === null) return j(503, { error: 'unavailable', reason: 'watch service not wired' });
  return svc;
}

export function registerWatchRoutes(router: CoreRouter): void {
  // GET /v1/watch/list — the owner's active (running) watches.
  router.get('/v1/watch/list', async (req) => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const svc = requireService();
    if ('status' in svc) return svc;

    const items: WatchListItem[] = [];
    for (const task of svc.listActive()) {
      const item = watchTaskToListItem(task); // null for a foreign/legacy row
      if (item !== null) items.push(item);
    }
    return j(200, { watches: items });
  });

  router.post('/v1/watch/:id/pause', async (req) => steer(req, 'pause'));
  router.post('/v1/watch/:id/resume', async (req) => steer(req, 'resume'));
  router.post('/v1/watch/:id/cancel', async (req) => steer(req, 'cancel'));
}

/** Shared pause/resume/cancel handler (owner-only, state-gated in the service). */
function steer(req: CoreRequest, command: 'pause' | 'resume' | 'cancel'): CoreResponse {
  const denied = ownerOnlyGuard(req);
  if (denied !== null) return denied;
  const svc = requireService();
  if ('status' in svc) return svc;

  const watchId = String(req.params.id ?? '');
  const ok =
    command === 'pause' ? svc.pause(watchId) : command === 'resume' ? svc.resume(watchId) : svc.cancel(watchId);
  // A running watch was updated → 200; otherwise it was missing / already
  // terminal / not a watch → 404 (idempotent: a re-cancel of a cancelled watch
  // is a no-op the caller can treat as success).
  if (!ok) return j(404, { error: 'not_found', reason: `watch not found or not ${command}-able` });
  return j(200, { watch_id: watchId, command, ok: true });
}
