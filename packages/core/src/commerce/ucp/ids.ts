/**
 * Fresh UCP identifiers: RFC 9562 v4 UUIDs from `crypto.getRandomValues`
 * (through @noble), which Hermes has; `crypto.randomUUID` it does not.
 */

import { randomBytes } from '@noble/hashes/utils.js';

import { uuidV4FromBytes } from '@dina/a2a';

export function newUcpId(): string {
  return uuidV4FromBytes(randomBytes(16));
}
