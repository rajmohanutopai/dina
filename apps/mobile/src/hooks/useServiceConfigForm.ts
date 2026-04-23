/**
 * Service config form — data layer for MOBILE-010.
 *
 * Backs the settings screen that lets the operator toggle isDiscoverable and
 * pick the response policy (auto / review) for each capability. Calls
 * Core's `/v1/service/config` endpoint via `BrainCoreClient`.
 *
 * Validation is shared with Core's `validateServiceConfig`, so the UI
 * surfaces the same error strings the server would.
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md MOBILE-010.
 */

import type { BrainCoreClient } from '@dina/brain/src/core_client/http';
import {
  validateServiceConfig,
  type ServiceConfig,
} from '@dina/core/src/service/service_config';

export type ServiceConfigCoreClient = Pick<
  BrainCoreClient,
  'getServiceConfig' | 'putServiceConfig'
>;

let client: ServiceConfigCoreClient | null = null;

export function setServiceConfigCoreClient(next: ServiceConfigCoreClient | null): void {
  client = next;
}

export function resetServiceConfigCoreClient(): void {
  client = null;
}

export class ServiceConfigNotConfiguredError extends Error {
  constructor() {
    super('Service config Core client not configured — call setServiceConfigCoreClient');
    this.name = 'ServiceConfigNotConfiguredError';
  }
}

export class ServiceConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceConfigValidationError';
  }
}

/**
 * Load the current service config. Returns `null` when none is set.
 */
export async function loadServiceConfig(): Promise<ServiceConfig | null> {
  return requireClient().getServiceConfig();
}

/**
 * Save a new service config. Runs client-side validation before the
 * network call so typos surface immediately (surfacing the same error
 * Core would have returned after a round-trip).
 */
export async function saveServiceConfig(next: ServiceConfig): Promise<void> {
  try {
    validateServiceConfig(next);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ServiceConfigValidationError(msg);
  }
  await requireClient().putServiceConfig(next);
}

function requireClient(): ServiceConfigCoreClient {
  if (client === null) throw new ServiceConfigNotConfiguredError();
  return client;
}
