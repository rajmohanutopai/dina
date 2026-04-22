/**
 * UI device key auth — Brain validates Ed25519 signatures from the UI.
 *
 * The UI device key is generated at onboarding and registered with Brain.
 * Each UI request to Brain must be signed with the device key.
 * This prevents unauthorized apps from accessing Brain endpoints.
 *
 * Pipeline:
 *   1. Check if path is public (/healthz, /readyz) → skip auth
 *   2. Extract X-DID, X-Timestamp, X-Nonce, X-Signature headers
 *   3. Validate timestamp (±5 min)
 *   4. Verify registered device DID
 *   5. Verify Ed25519 signature over canonical payload
 *
 * Source: ARCHITECTURE.md Task 3.30
 */

import { isTimestampValid } from '../../../core/src/auth/timestamp';
import { verifyRequest } from '../../../core/src/auth/canonical';

/** Paths that bypass authentication. */
const PUBLIC_PATHS = new Set(['/healthz', '/readyz']);

/** Registered UI device DIDs → public keys. */
const registeredDevices = new Map<string, Uint8Array>();

export interface UIAuthResult {
  authenticated: boolean;
  deviceDID?: string;
  rejectedAt?: 'public' | 'headers' | 'timestamp' | 'device' | 'signature';
  reason?: string;
}

/**
 * Register a UI device key (called during onboarding or pairing).
 */
export function registerUIDeviceKey(did: string, publicKey: Uint8Array): void {
  registeredDevices.set(did, publicKey);
}

/**
 * Revoke a UI device key.
 */
export function revokeUIDeviceKey(did: string): void {
  registeredDevices.delete(did);
}

/**
 * Check if a DID is a registered UI device.
 */
export function isRegisteredUIDevice(did: string): boolean {
  return registeredDevices.has(did);
}

/**
 * Authenticate a UI request to Brain.
 *
 * Returns authenticated=true for public paths and valid signatures.
 * Returns authenticated=false with rejectedAt for failures.
 */
export function authenticateUIRequest(req: {
  method: string;
  path: string;
  body: Uint8Array;
  headers: Record<string, string>;
}): UIAuthResult {
  // 1. Public paths bypass auth
  if (PUBLIC_PATHS.has(req.path)) {
    return { authenticated: true, rejectedAt: 'public' };
  }

  // 2. Extract headers
  const did = req.headers['X-DID'];
  const timestamp = req.headers['X-Timestamp'];
  const nonce = req.headers['X-Nonce'];
  const signature = req.headers['X-Signature'];

  if (!did || !timestamp || !nonce || !signature) {
    return {
      authenticated: false,
      rejectedAt: 'headers',
      reason: 'Missing required auth headers',
    };
  }

  // 3. Validate timestamp
  if (!isTimestampValid(timestamp)) {
    return {
      authenticated: false,
      deviceDID: did,
      rejectedAt: 'timestamp',
      reason: 'Timestamp outside ±5 minute window',
    };
  }

  // 4. Check registered device
  const publicKey = registeredDevices.get(did);
  if (!publicKey) {
    return {
      authenticated: false,
      deviceDID: did,
      rejectedAt: 'device',
      reason: `Device "${did}" not registered`,
    };
  }

  // 5. Verify Ed25519 signature
  const valid = verifyRequest(
    req.method,
    req.path,
    '',
    timestamp,
    nonce,
    req.body,
    signature,
    publicKey,
  );

  if (!valid) {
    return {
      authenticated: false,
      deviceDID: did,
      rejectedAt: 'signature',
      reason: 'Ed25519 signature verification failed',
    };
  }

  return { authenticated: true, deviceDID: did };
}

/** Reset all registered devices (for testing). */
export function resetUIAuth(): void {
  registeredDevices.clear();
}
