/**
 * The owner-only setup client (coding agents, staff phones, owner devices),
 * derived from the platform's owner dispatcher (`owner_dispatcher.ts`). Null
 * while no dispatcher is installed.
 */

import { OwnerSetupClient, type OwnerDispatcher } from '@dina/core';

import { getOwnerDispatcher } from './owner_dispatcher';

let built: { dispatcher: OwnerDispatcher; client: OwnerSetupClient } | null = null;

export function getOwnerSetupClient(): OwnerSetupClient | null {
  const dispatcher = getOwnerDispatcher();
  if (dispatcher === null) return null;
  if (built === null || built.dispatcher !== dispatcher) {
    built = { dispatcher, client: new OwnerSetupClient(dispatcher) };
  }
  return built.client;
}
