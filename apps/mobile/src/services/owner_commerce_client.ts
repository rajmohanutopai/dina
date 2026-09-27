/**
 * The owner-only commerce client for the seller and trade screens, derived
 * from the platform's owner dispatcher (`owner_dispatcher.ts`): the in-process
 * dispatch on the phone, the owner device's signed requests in a browser. Null
 * while no dispatcher is installed. See `owner_dispatcher.ts` for why this
 * lives at the app edge (R2-08).
 */

import { OwnerCommerceClient, type OwnerDispatcher } from '@dina/core';

import { getOwnerDispatcher } from './owner_dispatcher';

let built: { dispatcher: OwnerDispatcher; client: OwnerCommerceClient } | null = null;

/** The screens resolve it lazily; one client per dispatcher. */
export function getOwnerCommerceClient(): OwnerCommerceClient | null {
  const dispatcher = getOwnerDispatcher();
  if (dispatcher === null) return null;
  if (built === null || built.dispatcher !== dispatcher) {
    built = { dispatcher, client: new OwnerCommerceClient(dispatcher) };
  }
  return built.client;
}
