/**
 * Deterministically derive a local service identity from an owner's signing
 * seed without reusing the owner's identity key.
 *
 * This is for same-install, non-portable service principals such as mobile's
 * built-in Brain. Installers that possess the master seed should continue to
 * use the purpose-3 SLIP-0010 service hierarchy instead.
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { getPublicKey } from '../crypto/ed25519';

import { deriveDIDKey } from './did';

import type { IdentityKeypair } from './keypair';

const PRIVATE_KEY_BYTES = 32;
const SERVICE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const SALT = new TextEncoder().encode('dina:local-service-identity:salt:v1');

export interface LocalServiceIdentity {
  did: string;
  keypair: IdentityKeypair;
}

export function deriveLocalServiceIdentity(
  ownerSigningSeed: Uint8Array,
  serviceName: string,
): LocalServiceIdentity {
  if (ownerSigningSeed.length !== PRIVATE_KEY_BYTES) {
    throw new Error('local service identity requires a 32-byte owner signing seed');
  }
  if (!SERVICE_NAME_PATTERN.test(serviceName)) {
    throw new Error('local service identity requires a canonical service name');
  }

  const info = new TextEncoder().encode(`dina:local-service-identity:${serviceName}:v1`);
  const privateKey = hkdf(sha256, ownerSigningSeed, SALT, info, PRIVATE_KEY_BYTES);
  const publicKey = getPublicKey(privateKey);
  return {
    did: deriveDIDKey(publicKey),
    keypair: { privateKey, publicKey },
  };
}
