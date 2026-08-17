/**
 * The owner-only catalog-draft client, held at the MOBILE APP edge — the
 * same R2-08 rule as `owner_run_client.ts`: a core-level getter would hand
 * Brain (which imports `@dina/core` on this shared VM) a dispatcher that
 * stamps `callerType: 'owner'`. The instance lives here, in app-only code
 * `@dina/brain` cannot import, and construction needs the raw `CoreRouter`
 * Brain never receives.
 */

import type { InProcessOwnerCommerceClient } from '@dina/core';

let client: InProcessOwnerCommerceClient | null = null;

/** Boot installs it after building the router. */
export function setOwnerCommerceClient(c: InProcessOwnerCommerceClient | null): void {
  client = c;
}

/** The seller screens resolve it lazily. */
export function getOwnerCommerceClient(): InProcessOwnerCommerceClient | null {
  return client;
}
