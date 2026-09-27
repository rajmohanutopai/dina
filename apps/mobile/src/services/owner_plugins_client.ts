/**
 * The owner's plugins client, derived from the platform's owner dispatcher
 * (`owner_dispatcher.ts`): the phone's in-process Core, or the Home Node's
 * for a browser connected as the owner. Null while no dispatcher is installed.
 */

import { OwnerPluginsClient, type OwnerDispatcher } from '@dina/core';

import { getOwnerDispatcher } from './owner_dispatcher';

let built: { dispatcher: OwnerDispatcher; client: OwnerPluginsClient } | null = null;

export function getOwnerPluginsClient(): OwnerPluginsClient | null {
  const dispatcher = getOwnerDispatcher();
  if (dispatcher === null) return null;
  if (built === null || built.dispatcher !== dispatcher) {
    built = { dispatcher, client: new OwnerPluginsClient(dispatcher) };
  }
  return built.client;
}
