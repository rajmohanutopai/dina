/**
 * The owner-only group-plan client (GROUP_COORDINATION §9), derived from the
 * platform's owner dispatcher (`owner_dispatcher.ts`). Brain opens and reads
 * plans through `CoreClient`; the organizer's decisions go through this. Null
 * while no dispatcher is installed.
 */

import { OwnerCoordinationClient, type OwnerDispatcher } from '@dina/core';

import { getOwnerDispatcher } from './owner_dispatcher';

let built: { dispatcher: OwnerDispatcher; client: OwnerCoordinationClient } | null = null;

/** The plan card resolves it lazily; one client per dispatcher. */
export function getOwnerCoordinationClient(): OwnerCoordinationClient | null {
  const dispatcher = getOwnerDispatcher();
  if (dispatcher === null) return null;
  if (built === null || built.dispatcher !== dispatcher) {
    built = { dispatcher, client: new OwnerCoordinationClient(dispatcher) };
  }
  return built.client;
}
