/**
 * Service-config routes.
 *
 *   GET /v1/service/config — current config or 404
 *   PUT /v1/service/config — upsert config (device-signed auth)
 */

import {
  type ServiceConfig,
  getServiceConfig,
  setServiceConfigDurable,
  validateServiceConfig,
} from '../../service/service_config';

import type { CoreRouter } from '../router';

export function registerServiceConfigRoutes(router: CoreRouter): void {
  router.get('/v1/service/config', async () => {
    const cfg = getServiceConfig();
    if (cfg === null) {
      return { status: 404, body: { error: 'service_config: not set' } };
    }
    return { status: 200, body: cfg };
  });

  router.put('/v1/service/config', async (req) => {
    if (req.body === undefined) {
      return { status: 400, body: { error: 'empty body' } };
    }
    try {
      validateServiceConfig(req.body);
    } catch (err) {
      return { status: 400, body: { error: (err as Error).message } };
    }
    // Durable-first (P1.4): persist before reporting success so a provider's
    // published config can't appear saved here yet vanish on restart. A
    // persistence failure returns 503 rather than a false 200.
    try {
      await setServiceConfigDurable(req.body as ServiceConfig);
    } catch (err) {
      return {
        status: 503,
        body: { error: `service_config: persistence failed — ${(err as Error).message}` },
      };
    }
    return { status: 200, body: { ok: true } };
  });
}
