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

import { isValidServiceListingRkey, validateServiceListing } from '@dina/protocol';

import {
  type ServiceConfig,
  DEFAULT_LISTING_RKEY,
  getServiceConfig,
  listServiceConfigs,
  setServiceConfigDurable,
  clearServiceConfigDurable,
  validateServiceConfig,
} from '../../service/service_config';

import type { CoreRouter } from '../router';

/** Persist `config` under `rkey`, mapping outcomes to HTTP results. */
async function upsertListing(rkey: string, body: unknown): Promise<{ status: number; body: unknown }> {
  if (body === undefined) {
    return { status: 400, body: { error: 'empty body' } };
  }
  try {
    validateServiceConfig(body);
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
  // Full catalog listing validation — the SAME rules mobile runs at publish, now
  // enforced at the Core boundary so a direct/paired client can't persist a
  // listing mobile would reject (unknown flat capability, disallowed category,
  // write action left on `auto`, public custom capability with no schema). This
  // is STRICT + always-on (greenfield): every listing must carry explicit
  // `discoverability` + a per-capability category. Closes the mobile-only-
  // validation gap (Codex #4) — there is no compatibility bypass.
  const listing = validateServiceListing(body as ServiceConfig, {
    requireExplicitDiscoverability: true,
  });
  if (!listing.ok) {
    return {
      status: 400,
      body: { error: 'invalid service listing', details: listing.errors },
    };
  }
  // Durable-first (P1.4): persist before reporting success so a provider's
  // published listing can't appear saved here yet vanish on restart. A
  // persistence failure returns 503 rather than a false 200.
  try {
    await setServiceConfigDurable(body as ServiceConfig, rkey);
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
    const rkey = req.params.rkey ?? '';
    if (!isValidServiceListingRkey(rkey)) {
      return { status: 400, body: { error: `service_config: invalid rkey ${JSON.stringify(rkey)}` } };
    }
    return upsertListing(rkey, req.body);
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
    return upsertListing(DEFAULT_LISTING_RKEY, req.body);
  });
}
