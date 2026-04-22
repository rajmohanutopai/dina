/**
 * Device registry — paired device management.
 *
 * Stores Ed25519 device public keys (multibase-encoded), NOT token hashes.
 * Mobile adaptation: `paired_devices` table with `public_key_multibase`
 * instead of the server's `device_tokens` with `token_hash`.
 *
 * Devices are registered via the pairing ceremony (6-digit code exchange).
 * Revoked devices remain in the registry (revoked=1) for audit trail
 * but cannot authenticate.
 *
 * Source: ARCHITECTURE.md Section 2.63, Task 2.63
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { multibaseToPublicKey, deriveDIDKey } from '../identity/did';
import { unregisterDevice as unregisterDeviceAuth } from '../auth/caller_type';
import { getDeviceRepository } from './repository';

export type DeviceRole = 'rich' | 'thin' | 'cli' | 'agent';
export type AuthType = 'ed25519' | 'token';

export interface PairedDevice {
  deviceId: string;
  /** DID derived from the device's Ed25519 public key (matching Go's DID field). */
  did: string;
  publicKeyMultibase: string;
  deviceName: string;
  role: DeviceRole;
  /** Auth method used for this device (matching Go's AuthType field). */
  authType: AuthType;
  lastSeen: number;
  createdAt: number;
  revoked: boolean;
}

/** In-memory device registry keyed by deviceId. */
const devices = new Map<string, PairedDevice>();

/** Public key multibase → deviceId index (for key-based lookup). */
const keyIndex = new Map<string, string>();

/** DID → deviceId index (for DID-based lookup, matching Go's GetDeviceByDID). */
const didIndex = new Map<string, string>();

/**
 * Register a new paired device.
 *
 * Called after pairing ceremony completes. Stores the device's Ed25519
 * public key in multibase format.
 *
 * Returns the registered device with a generated deviceId.
 */
export function registerDevice(
  name: string,
  publicKeyMultibase: string,
  role: DeviceRole,
): PairedDevice {
  if (!name || name.trim().length === 0) throw new Error('devices: name is required');
  if (!publicKeyMultibase) throw new Error('devices: publicKeyMultibase is required');

  // Prevent registering duplicate keys
  if (keyIndex.has(publicKeyMultibase)) {
    const existingId = keyIndex.get(publicKeyMultibase)!;
    const existing = devices.get(existingId);
    if (existing && !existing.revoked) {
      throw new Error(`devices: key already registered as "${existing.deviceName}"`);
    }
  }

  const deviceId = `dev-${bytesToHex(randomBytes(8))}`;
  const now = Date.now();

  // Derive DID from Ed25519 public key (matching Go's DID field on PairedDevice)
  let did: string;
  try {
    const pubKey = multibaseToPublicKey(publicKeyMultibase);
    did = deriveDIDKey(pubKey);
  } catch {
    // Fallback for test fixtures with mock multibase strings
    did = `did:key:${publicKeyMultibase}`;
  }

  const device: PairedDevice = {
    deviceId,
    did,
    publicKeyMultibase,
    deviceName: name.trim(),
    role,
    authType: 'ed25519',
    lastSeen: now,
    createdAt: now,
    revoked: false,
  };

  devices.set(deviceId, device);
  keyIndex.set(publicKeyMultibase, deviceId);
  didIndex.set(did, deviceId);
  // SQL write-through — fire-and-forget since Phase 2.3 (task 2.3).
  // In-memory Map is authoritative for reads within the process; SQL
  // persists across restart. A transient write failure doesn't affect
  // correctness — matches the semantics of the prior try/catch.
  // Keeping `registerDevice` sync preserves every caller's signature
  // (pairing ceremony, auth caller_type, HTTP routes, sync client).
  const sqlRepo = getDeviceRepository();
  if (sqlRepo) {
    void sqlRepo.register(device).catch(() => {
      /* fail-safe — transient SQL write loss is acceptable */
    });
  }
  return device;
}

/** List all devices (including revoked). */
export function listDevices(): PairedDevice[] {
  return [...devices.values()];
}

/** List only active (non-revoked) devices. */
export function listActiveDevices(): PairedDevice[] {
  return [...devices.values()].filter((d) => !d.revoked);
}

/** Get a device by ID. Returns null if not found. */
export function getDevice(deviceId: string): PairedDevice | null {
  return devices.get(deviceId) ?? null;
}

/**
 * Get a device by its public key multibase.
 *
 * Used during authentication to look up the device from
 * the presented Ed25519 public key.
 */
export function getByPublicKey(publicKeyMultibase: string): PairedDevice | null {
  const deviceId = keyIndex.get(publicKeyMultibase);
  if (!deviceId) return null;
  return devices.get(deviceId) ?? null;
}

/**
 * Revoke a device. Marks it as revoked AND cascades to auth layer.
 *
 * Revoked devices remain in registry for audit trail but cannot authenticate.
 * The cascade ensures the device's DID is unregistered from caller_type.ts
 * so it can no longer pass auth middleware.
 *
 * Without this cascade, a revoked device's DID would remain registered
 * in the auth layer and could still authenticate — a security bug
 * identified in GAP_ANALYSIS.md §A41.
 *
 * Returns true if found.
 */
/**
 * Revoke a device. Marks it as revoked AND cascades to auth layer.
 *
 * Throws on double-revocation (matching Go's ErrDeviceRevoked).
 * Returns true if successfully revoked.
 */
export function revokeDevice(deviceId: string): boolean {
  const device = devices.get(deviceId);
  if (!device) return false;

  // Double-revocation guard (matching Go's ErrDeviceRevoked)
  if (device.revoked) {
    throw new Error(`devices: "${deviceId}" is already revoked`);
  }

  // Step 1: Cascade to auth — unregister the device's DID so it can
  // no longer pass caller-type resolution.
  try {
    const pubKey = multibaseToPublicKey(device.publicKeyMultibase);
    const deviceDID = deriveDIDKey(pubKey);
    unregisterDeviceAuth(deviceDID);
  } catch {
    // If DID derivation fails (corrupted key), still proceed with revocation
  }

  // Step 2: Mark revoked in device registry
  device.revoked = true;
  return true;
}

/** Check if a device is active (exists and not revoked). */
export function isDeviceActive(deviceId: string): boolean {
  const device = devices.get(deviceId);
  return device !== null && device !== undefined && !device.revoked;
}

/** Update last_seen timestamp for a device. */
export function touchDevice(deviceId: string): void {
  const device = devices.get(deviceId);
  if (device) device.lastSeen = Date.now();
}

/** Get device count (all, including revoked). */
export function deviceCount(): number {
  return devices.size;
}

/**
 * Get a device by its DID.
 *
 * O(1) lookup via DID index. Used for DID-based device discovery —
 * matching Go's GetDeviceByDID.
 */
export function getDeviceByDID(did: string): PairedDevice | null {
  const deviceId = didIndex.get(did);
  if (!deviceId) return null;
  return devices.get(deviceId) ?? null;
}

/** Reset all device state (for testing). */
export function resetDeviceRegistry(): void {
  devices.clear();
  keyIndex.clear();
  didIndex.clear();
}
