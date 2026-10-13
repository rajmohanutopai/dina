/**
 * Owner settings routes (REAL_LIFE_FIXES_2 §0). Brain reads; only the owner
 * writes.
 *
 *   GET /v1/settings/guard-modes      → { action_claims, regulated }
 *   PUT /v1/settings/guard-modes      → owner only
 *   GET /v1/settings/owner-timezone   → { timezone, source }
 *   PUT /v1/settings/owner-timezone   → owner only, { timezone }
 */

import {
  getGuardModes,
  getOwnerTimeZone,
  setGuardModes,
  setOwnerTimeZone,
} from '../../settings/owner_settings';

import { ownerDidForRequest } from './owner_guard';

import type { CoreRouter } from '../router';

export function registerSettingsRoutes(router: CoreRouter, ownerCapability?: string): void {
  router.get('/v1/settings/guard-modes', async () => ({ status: 200, body: await getGuardModes() }));

  router.put('/v1/settings/guard-modes', async (req) => {
    const owner = ownerDidForRequest(req, ownerCapability);
    if (typeof owner !== 'string') return owner;
    const body = req.body as Record<string, unknown> | null;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 400, body: { error: 'body must be an object' } };
    }
    const out = await setGuardModes(body);
    if (typeof out === 'string') return { status: 400, body: { error: out } };
    return { status: 200, body: out };
  });

  router.get('/v1/settings/owner-timezone', async () => ({ status: 200, body: await getOwnerTimeZone() }));

  router.put('/v1/settings/owner-timezone', async (req) => {
    const owner = ownerDidForRequest(req, ownerCapability);
    if (typeof owner !== 'string') return owner;
    const zone = (req.body as { timezone?: unknown } | null)?.timezone;
    if (typeof zone !== 'string' || !(await setOwnerTimeZone(zone))) {
      return { status: 400, body: { error: 'timezone must be an IANA time zone name' } };
    }
    return { status: 200, body: await getOwnerTimeZone() };
  });
}
