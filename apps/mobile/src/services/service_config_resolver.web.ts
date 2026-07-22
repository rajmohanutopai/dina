/**
 * Service-config Core-client resolver — WEB.
 *
 * The web thin-client's in-process Core store is empty (Core runs server-side),
 * so the My-Services publish form's `ServiceConfigCoreClient` is backed by an
 * HTTP client to the brain's `/api/v1/service/config` proxy (which forwards to
 * Core, signed as brain — `/v1/service/*` is a brain-allowed route). Without
 * this, publishing a service on web silently no-ops against the empty in-browser
 * store. Native returns the in-process client unchanged.
 */

import type { ServiceConfigCoreClient } from '../hooks/useServiceConfigForm';
import type { ServiceConfig, ServiceListing } from '@dina/core';


const BASE = '/api/v1/service';

function configPath(rkey?: string): string {
  return rkey === undefined ? `${BASE}/config` : `${BASE}/config/${encodeURIComponent(rkey)}`;
}

async function throwOnError(res: Response, label: string): Promise<void> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${label}: ${res.status} ${detail.slice(0, 300)}`);
  }
}

const httpServiceConfig: ServiceConfigCoreClient = {
  async serviceConfig(rkey?: string): Promise<ServiceConfig | null> {
    const res = await fetch(configPath(rkey));
    if (res.status === 404) return null; // not published yet
    await throwOnError(res, 'service_config');
    return (await res.json()) as ServiceConfig;
  },
  async putServiceConfig(config: ServiceConfig, rkey?: string): Promise<void> {
    const res = await fetch(configPath(rkey), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    });
    // A 400 carries Core's validation message — surface it so the form shows why.
    await throwOnError(res, 'service_config publish');
  },
  async listServiceConfigs(): Promise<ServiceListing[]> {
    const res = await fetch(`${BASE}/configs`);
    await throwOnError(res, 'service_config list');
    const body = (await res.json()) as { listings?: ServiceListing[] };
    return body.listings ?? [];
  },
  async deleteServiceConfig(rkey: string): Promise<void> {
    const res = await fetch(configPath(rkey), { method: 'DELETE' });
    await throwOnError(res, 'service_config delete');
  },
};

export function resolveServiceConfigCoreClient(
  _inProcess: ServiceConfigCoreClient,
): ServiceConfigCoreClient {
  return httpServiceConfig;
}
