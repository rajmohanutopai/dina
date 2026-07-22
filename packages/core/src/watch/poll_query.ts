/**
 * `buildWatchPollHandler` (PSVC-0) — the concrete `onPoll` that turns a due
 * poll-mode watch into an ordinary `service.query` through the requester lane.
 *
 * This is the seam the WatchPollSweeper invokes. It goes through
 * `coreClient.sendServiceQuery` (NOT a raw `sendD2D`) so the requester-side
 * correlation task + reservation window are created — that bookkeeping is what
 * lets the provider's `service.response` land and correlate back. Centralised
 * here so the mobile boot and the server `wireWorkflowPlane` share ONE tested
 * mapping instead of hand-rolling it twice.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { MAX_SERVICE_TTL } from '../d2d/families';

import type { WatchPollPayload } from './payload';
import type { WatchPollHandler } from './poll_sweeper';
import type { CoreClient, ServiceQueryClientRequest } from '../client/core-client';


/** A fresh correlation id for one poll fire. */
export function newWatchQueryId(): string {
  return `watchq-${bytesToHex(randomBytes(12))}`;
}

/** Map a watch payload → a requester `service.query`. The wire TTL is the poll
 *  cadence CLAMPED to `MAX_SERVICE_TTL` (the service-query route rejects TTLs
 *  above it), so a stale unanswered poll still expires before the next one fires
 *  without failing validation. A long cadence (e.g. an hourly watch) keeps its
 *  local next-run schedule but sends the capped wire TTL. */
export function watchPollToServiceQuery(
  payload: WatchPollPayload,
  queryId: string,
): ServiceQueryClientRequest {
  return {
    toDID: payload.provider_did,
    capability: payload.capability,
    queryId,
    params: payload.query,
    ttlSeconds: Math.max(1, Math.min(payload.poll_interval_sec, MAX_SERVICE_TTL)),
    serviceUri: payload.service_uri,
    // Forward the pinned schema hash so a provider advertising a versioned
    // schema accepts the poll (else `schema_hash_required`). Omitted when the
    // subscription pinned none (provider publishes no schema).
    ...(payload.schema_hash !== undefined && payload.schema_hash !== ''
      ? { schemaHash: payload.schema_hash }
      : {}),
    originChannel: `watch:${payload.subscription_id}`,
  };
}

export interface BuildWatchPollHandlerOptions {
  /** Correlation-id minter. Default mints a random id (override for tests). */
  queryIdFn?: () => string;
}

/**
 * Build the `onPoll` handler the WatchPollSweeper fires for each due watch.
 * Sends the `service.query` via the CoreClient requester lane; the sweeper
 * isolates any throw and still reschedules, so a transient send failure just
 * retries next interval.
 */
export function buildWatchPollHandler(
  coreClient: Pick<CoreClient, 'sendServiceQuery'>,
  opts: BuildWatchPollHandlerOptions = {},
): WatchPollHandler {
  const mintId = opts.queryIdFn ?? newWatchQueryId;
  return async (_task, payload: WatchPollPayload): Promise<void> => {
    await coreClient.sendServiceQuery(watchPollToServiceQuery(payload, mintId()));
  };
}
