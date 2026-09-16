/**
 * The owner-only group-plan client, held at the MOBILE APP edge — the same
 * rule as `owner_commerce_client.ts`: a core-level getter would hand Brain
 * (which imports `@dina/core` on this shared VM) a dispatcher that stamps
 * `callerType: 'owner'`. The instance lives here, in app-only code
 * `@dina/brain` cannot import, and construction needs the raw `CoreRouter`
 * Brain never receives. Brain opens and reads plans through its own
 * `CoreClient`; the plan card decides through THIS.
 */

import type { InProcessOwnerCoordinationClient } from '@dina/core';

let client: InProcessOwnerCoordinationClient | null = null;

/** Boot installs it after building the router. */
export function setOwnerCoordinationClient(c: InProcessOwnerCoordinationClient | null): void {
  client = c;
}

/** The plan card resolves it lazily. */
export function getOwnerCoordinationClient(): InProcessOwnerCoordinationClient | null {
  return client;
}
