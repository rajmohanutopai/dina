/**
 * The owner-only run/watch control client (§12.5), derived from the
 * platform's owner dispatcher (`owner_dispatcher.ts`): the run UI reaches every
 * list and steer through owner-marked dispatch → route guards → durable
 * command receipts, never the raw run/watch globals Brain shares on this JS VM
 * ("trusted-in-process" is not the owner boundary, §20). Null while no
 * dispatcher is installed.
 */

import {
  OwnerRunControlClient,
  type OwnerDispatcher,
  type OwnerReasoningClient,
  type OwnerRunClient,
} from '@dina/core';

import { getOwnerDispatcher } from './owner_dispatcher';

export type OwnerControlClient = OwnerRunClient & Partial<OwnerReasoningClient>;

let built: { dispatcher: OwnerDispatcher; client: OwnerRunControlClient } | null = null;

/** The owner UI hooks resolve it lazily; one client per dispatcher. */
export function getOwnerRunClient(): OwnerControlClient | null {
  const dispatcher = getOwnerDispatcher();
  if (dispatcher === null) return null;
  if (built === null || built.dispatcher !== dispatcher) {
    built = { dispatcher, client: new OwnerRunControlClient(dispatcher) };
  }
  return built.client;
}
