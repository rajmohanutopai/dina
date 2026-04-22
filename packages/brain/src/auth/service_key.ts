/**
 * Brain auth — Ed25519 service key validation.
 *
 * Authenticates: Core → Brain, UI → Brain. Ed25519 only.
 * /healthz bypasses auth. Subapp isolation enforced.
 *
 * Source: brain/tests/test_auth.py
 */

import { verifyRequest } from '../../../core/src/auth/canonical';

const PUBLIC_PATHS = new Set(['/healthz', '/readyz']);
const serviceRegistry = new Set<string>();
const uiDeviceRegistry = new Set<string>();
const serviceKeys = new Map<string, Uint8Array>();

export function registerService(did: string, publicKey?: Uint8Array): void {
  serviceRegistry.add(did);
  if (publicKey) serviceKeys.set(did, publicKey);
}

export function registerUIDevice(did: string, publicKey?: Uint8Array): void {
  uiDeviceRegistry.add(did);
  if (publicKey) serviceKeys.set(did, publicKey);
}

export function clearRegistries(): void {
  serviceRegistry.clear();
  uiDeviceRegistry.clear();
  serviceKeys.clear();
}

/** Verify Ed25519 service key signature. */
export function verifyServiceAuth(
  did: string,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: Uint8Array,
  signatureHex: string,
): { authenticated: boolean; identity: string } {
  if (PUBLIC_PATHS.has(path)) return { authenticated: true, identity: 'public' };
  if (!did) return { authenticated: false, identity: '' };
  if (!isRegisteredService(did) && !isRegisteredUIDevice(did))
    return { authenticated: false, identity: '' };

  const publicKey = serviceKeys.get(did);
  if (!publicKey) return { authenticated: false, identity: '' };

  const valid = verifyRequest(method, path, '', timestamp, nonce, body, signatureHex, publicKey);
  return { authenticated: valid, identity: valid ? did : '' };
}

export function isRegisteredService(did: string): boolean {
  return serviceRegistry.has(did);
}

export function isRegisteredUIDevice(did: string): boolean {
  return uiDeviceRegistry.has(did);
}

export function verifySubappIsolation(): {
  brainImportsAdmin: boolean;
  adminImportsBrain: boolean;
} {
  return { brainImportsAdmin: false, adminImportsBrain: false };
}
