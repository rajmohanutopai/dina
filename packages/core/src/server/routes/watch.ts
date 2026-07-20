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

import { classifyWatchFilter, parseWatchFilter } from '../../watch/filter';
import { watchTaskToListItem, type WatchListItem } from '../../watch/list';
import { getWatchService, type WatchService } from '../../watch/service';

import type { CoreRouter, CoreRequest, CoreResponse } from '../router';

export type { WatchListItem } from '../../watch/list';

function j(status: number, body: unknown): CoreResponse {
  return { status, body };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Owner guard bound to the boot-minted capability (§12.5, F15) — closure-held,
 *  fail-closed when unconfigured. See run.ts `makeOwnerGuard`. */
type OwnerGuard = (req: CoreRequest) => CoreResponse | null;
function makeOwnerGuard(expectedCapability: string | undefined): OwnerGuard {
  return (req) => {
    if (expectedCapability === undefined || expectedCapability === '') {
      return j(403, { error: 'access_denied', reason: 'owner control plane not configured' });
    }
    if (req.callerType !== 'owner' || req.ownerCapability !== expectedCapability) {
      return j(403, { error: 'access_denied', reason: 'only the owner may list or steer a watch' });
    }
    return null;
  };
}

function requireService(): WatchService | CoreResponse {
  const svc = getWatchService();
  if (svc === null) return j(503, { error: 'unavailable', reason: 'watch service not wired' });
  return svc;
}

export function registerWatchRoutes(router: CoreRouter, ownerCapability?: string): void {
  const ownerOnlyGuard = makeOwnerGuard(ownerCapability);

  // POST /v1/watch/create — the owner creates a poll-mode standing watch (#7).
  // Owner-only, same boundary as list/steer. Idempotent on `subscription_id`
  // (createPollWatch dedups via the active idempotency key), so a replayed create
  // returns the existing watch instead of a duplicate.
  router.post('/v1/watch/create', async (req) => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const svc = requireService();
    if ('status' in svc) return svc;

    const body = isRecord(req.body) ? req.body : {};
    const subscriptionId = String(body.subscription_id ?? '');
    const persona = String(body.persona ?? '');
    const serviceUri = String(body.service_uri ?? '');
    const providerDid = String(body.provider_did ?? '');
    const capability = String(body.capability ?? '');
    const pollInterval = typeof body.poll_interval_sec === 'number' ? body.poll_interval_sec : 0;
    if (
      subscriptionId === '' ||
      persona === '' ||
      serviceUri === '' ||
      providerDid === '' ||
      capability === '' ||
      pollInterval <= 0
    ) {
      return j(400, {
        error: 'invalid',
        reason:
          'subscription_id, persona, service_uri, provider_did, capability, and a positive poll_interval_sec are required',
      });
    }
    const query = isRecord(body.query) ? body.query : {};
    const condition = typeof body.condition === 'string' ? body.condition : undefined;
    // R2-04 / R5-07 — the optional executable wake filter (untrusted). A PRESENT
    // but malformed filter is REJECTED (400), never silently dropped to
    // "unfiltered = fire always" — a corrupt condition must fail closed, not
    // become cry-wolf noise (Silence First).
    if (classifyWatchFilter(body.filter) === 'invalid') {
      return j(400, {
        error: 'invalid',
        reason: 'filter, when present, must be { contains: <non-empty string> }',
      });
    }
    const filter = parseWatchFilter(body.filter);
    const task = svc.createPollWatch({
      subscription_id: subscriptionId,
      persona,
      service_uri: serviceUri,
      provider_did: providerDid,
      capability,
      query,
      poll_interval_sec: pollInterval,
      ...(condition !== undefined ? { condition } : {}),
      ...(filter !== undefined ? { filter } : {}),
    });
    const item = watchTaskToListItem(task);
    return j(201, {
      watch_id: task.id,
      subscription_id: subscriptionId,
      ...(item !== null ? { watch: item } : {}),
    });
  });

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

  router.post('/v1/watch/:id/pause', async (req) => steer(req, 'pause', ownerOnlyGuard));
  router.post('/v1/watch/:id/resume', async (req) => steer(req, 'resume', ownerOnlyGuard));
  router.post('/v1/watch/:id/cancel', async (req) => steer(req, 'cancel', ownerOnlyGuard));
}

/** Shared pause/resume/cancel handler (owner-only, state-gated in the service). */
function steer(
  req: CoreRequest,
  command: 'pause' | 'resume' | 'cancel',
  ownerOnlyGuard: OwnerGuard,
): CoreResponse {
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
