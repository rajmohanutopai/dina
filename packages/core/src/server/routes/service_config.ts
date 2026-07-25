/**
 * Service-config routes (multi-listing per DID).
 *
 * Invariant: ONE local listing row == ONE published
 * `com.dinakernel.service.profile/<rkey>` record; `rkey` is the join key.
 *
 *   GET    /v1/service/configs        — list every listing (rkey + config)
 *   GET    /v1/service/config/:rkey   — one listing or 404
 *   PUT    /v1/service/config/:rkey   — upsert one listing (device-signed auth)
 *   DELETE /v1/service/config/:rkey   — remove one listing (idempotent)
 *
 *   GET    /v1/service/config         — compat alias for the `self` listing
 *   PUT    /v1/service/config         — compat alias: upsert the `self` listing
 *
 * The bare `/v1/service/config` endpoints preserve the original single-listing
 * behaviour so existing clients keep working; new clients use the `:rkey` form.
 */

import { isValidServiceListingRkey } from '@dina/protocol';

import {
  DEFAULT_LISTING_RKEY,
  getServiceConfig,
  listServiceConfigs,
  setServiceConfigDurable,
  clearServiceConfigDurable,
  validateServiceConfigForSave,
} from '../../service/service_config';

import { requireAgentSession } from '../agent_session_guard';
import type { CoreRouter } from '../router';

/**
 * Validate and durably persist one listing.
 *
 * Exported so narrow, owner-approved agent facades can execute through the
 * exact same save path as the owner/Brain HTTP routes. Authorization and
 * approval happen before this function; this is the shared mutation boundary.
 */
export async function upsertServiceListing(
  rkey: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  if (body === undefined) {
    return { status: 400, body: { error: 'empty body' } };
  }
  const validated = validateServiceConfigForSave(body);
  if (!validated.ok) {
    return {
      status: 400,
      body: {
        error: validated.error,
        ...(validated.details !== undefined ? { details: validated.details } : {}),
      },
    };
  }
  // Durable-first (P1.4): persist before reporting success so a provider's
  // published listing can't appear saved here yet vanish on restart. A
  // persistence failure returns 503 rather than a false 200.
  try {
    await setServiceConfigDurable(validated.config, rkey);
  } catch (err) {
    return {
      status: 503,
      body: { error: `service_config: persistence failed — ${(err as Error).message}` },
    };
  }
  return { status: 200, body: { ok: true } };
}

export function registerServiceConfigRoutes(router: CoreRouter): void {
  // ── Multi-listing catalog ────────────────────────────────────────────────

  // List every configured listing. Always 200 (empty array when none).
  router.get('/v1/service/configs', async () => {
    return { status: 200, body: { listings: listServiceConfigs() } };
  });

  // Get one listing by rkey.
  router.get('/v1/service/config/:rkey', async (req) => {
    const rkey = req.params.rkey ?? '';
    if (!isValidServiceListingRkey(rkey)) {
      return { status: 400, body: { error: `service_config: invalid rkey ${JSON.stringify(rkey)}` } };
    }
    const cfg = getServiceConfig(rkey);
    if (cfg === null) {
      return { status: 404, body: { error: 'service_config: not set' } };
    }
    return { status: 200, body: cfg };
  });

  // Upsert one listing by rkey.
  router.put('/v1/service/config/:rkey', async (req) => {
    const session = requireAgentSession(req);
    if (!session.ok) return session.response;
    const rkey = req.params.rkey ?? '';
    if (!isValidServiceListingRkey(rkey)) {
      return { status: 400, body: { error: `service_config: invalid rkey ${JSON.stringify(rkey)}` } };
    }
    return upsertServiceListing(rkey, req.body);
  });

  // Delete one listing by rkey (idempotent — 200 even if absent).
  router.delete('/v1/service/config/:rkey', async (req) => {
    const rkey = req.params.rkey ?? '';
    if (!isValidServiceListingRkey(rkey)) {
      return { status: 400, body: { error: `service_config: invalid rkey ${JSON.stringify(rkey)}` } };
    }
    // Durable-first: persist the deletion before reporting 200, so the row
    // can't resurrect on restart (and republish stale data) after a failed
    // SQLite delete. A persistence failure returns 503.
    try {
      await clearServiceConfigDurable(rkey);
    } catch (err) {
      return {
        status: 503,
        body: { error: `service_config: persistence failed — ${(err as Error).message}` },
      };
    }
    return { status: 200, body: { ok: true } };
  });

  // ── `self` compatibility endpoints (original single-listing surface) ──────

  router.get('/v1/service/config', async () => {
    const cfg = getServiceConfig(DEFAULT_LISTING_RKEY);
    if (cfg === null) {
      return { status: 404, body: { error: 'service_config: not set' } };
    }
    return { status: 200, body: cfg };
  });

  router.put('/v1/service/config', async (req) => {
    const session = requireAgentSession(req);
    if (!session.ok) return session.response;
    return upsertServiceListing(DEFAULT_LISTING_RKEY, req.body);
  });
}
