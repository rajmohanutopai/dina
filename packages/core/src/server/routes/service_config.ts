/**
 * Service-config routes.
 *
 *   GET /v1/service/config — current config or 404
 *   PUT /v1/service/config — upsert config (device-signed auth)
 */

import type { CoreRouter } from '../router';
import {
  type ServiceConfig,
  getServiceConfig,
  setServiceConfig,
  validateServiceConfig,
} from '../../service/service_config';

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
    setServiceConfig(req.body as ServiceConfig);
    return { status: 200, body: { ok: true } };
  });
}
