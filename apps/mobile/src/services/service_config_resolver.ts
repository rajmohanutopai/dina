/**
 * Service-config Core-client resolver — NATIVE / default.
 *
 * On mobile the app runs Core in-process, so the in-process client already
 * backs the My-Services publish form — return it unchanged. The web variant
 * (`service_config_resolver.web.ts`) overrides this with an HTTP client to the
 * brain's `/api/v1/service/config` proxy, because in the web thin-client the
 * in-process Core store is empty.
 */

import type { ServiceConfigCoreClient } from '../hooks/useServiceConfigForm';

export function resolveServiceConfigCoreClient(
  inProcess: ServiceConfigCoreClient,
): ServiceConfigCoreClient {
  return inProcess;
}
