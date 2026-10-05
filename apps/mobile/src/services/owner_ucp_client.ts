/**
 * The owner's UCP client (UCP plan §4.2 U1): the allowed shops and context
 * fields, and a search as the owner sees it. Derived from the platform's
 * owner dispatcher (`owner_dispatcher.ts`); null while none is installed.
 */

import { OwnerUcpClient, type OwnerDispatcher } from '@dina/core';

import { getOwnerDispatcher } from './owner_dispatcher';

let built: { dispatcher: OwnerDispatcher; client: OwnerUcpClient } | null = null;

export function getOwnerUcpClient(): OwnerUcpClient | null {
  const dispatcher = getOwnerDispatcher();
  if (dispatcher === null) return null;
  if (built === null || built.dispatcher !== dispatcher) {
    built = { dispatcher, client: new OwnerUcpClient(dispatcher) };
  }
  return built.client;
}
