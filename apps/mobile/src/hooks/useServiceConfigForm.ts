/**
 * Service config form — data layer for MOBILE-010.
 *
 * Backs the settings screen that lets the operator toggle isDiscoverable and
 * pick the response policy (auto / review) for each capability. Calls
 * Core's `/v1/service/config` endpoint via `CoreClient`.
 *
 * Validation is shared with Core's `validateServiceConfig`, so the UI
 * surfaces the same error strings the server would.
 *
 * Source: SERVICE_DISCOVERY_DESIGN.md MOBILE-010.
 */

import type { CoreClient } from '@dina/core';
import {
  validateServiceConfig,
  type ServiceConfig,
} from '@dina/core';

/**
 * Subset of `CoreClient` the config form uses. `serviceConfig` returns
 * `ServiceConfig | null` (null on 404 = "not published yet"), same
 * semantic as the legacy `getServiceConfig`. `putServiceConfig` is the
 * upsert.
 */
export type ServiceConfigCoreClient = Pick<
  CoreClient,
  'serviceConfig' | 'putServiceConfig'
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
  return requireClient().serviceConfig();
}

/**
 * Load the service config, tolerating the brief boot window where the Core
 * client isn't wired yet.
 *
 * The client is set during node boot (`installChatGlobals`); a screen can
 * mount while it's momentarily `null` — at first boot, or during a re-boot
 * (auto-lock → re-unlock, dev Fast-Refresh). Without this, that transient
 * surfaces as a sticky "couldn't load" error even though the client appears a
 * beat later. So we retry ONLY on `ServiceConfigNotConfiguredError` (the
 * not-wired-yet signal), up to `maxAttempts`, sleeping `delayMs` between tries.
 * Any other error (or a genuine persistent null) propagates immediately /
 * after the window. `sleep` is injectable so tests don't wait real time.
 */
export async function loadServiceConfigWithRetry(opts?: {
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ServiceConfig | null> {
  const maxAttempts = opts?.maxAttempts ?? 6;
  const delayMs = opts?.delayMs ?? 500;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 1; ; attempt++) {
    try {
      return await loadServiceConfig();
    } catch (err) {
      if (err instanceof ServiceConfigNotConfiguredError && attempt < maxAttempts) {
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
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
