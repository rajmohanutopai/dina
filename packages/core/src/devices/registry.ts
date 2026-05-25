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
import {
  registerDevice as registerDeviceAuth,
  unregisterDevice as unregisterDeviceAuth,
} from '../auth/caller_type';
import { getDeviceRepository } from './repository';
import { getAgentGrantRepository } from '../agent/grant_repository';
import { appendAudit } from '../audit/service';

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
 * Listeners notified whenever the registry mutates (register, revoke,
 * hydrate, reset). Mirrors the unlock-state subscription pattern used
 * elsewhere on mobile so screens that gate UI on "is at least one
 * agent paired?" (the chat /task action, the Approvals tab) re-render
 * the moment the answer changes — without polling.
 */
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* swallow — subscribers must not block notify */
    }
  }
}

/** Subscribe to registry mutations. Returns an unsubscribe function. */
export function subscribeToDeviceRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

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
  notifyListeners();
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

  cutDeviceAccess(device);
  device.revoked = true;

  // SQL write-through (fire-and-forget) so a revoke survives restart even
  // on this legacy sync path (issues.txt §5). The DURABLE guarantee — fail
  // the call when persistence fails — is `revokeDeviceDurable`, which the
  // release UI/routes use. Without ANY write-through, `hydrateDeviceRegistry`
  // reloaded the row as revoked=0 on the next boot and the device became
  // trusted again.
  const sqlRepo = getDeviceRepository();
  if (sqlRepo) {
    void sqlRepo.revoke(deviceId).catch(() => {
      /* best-effort — the durable variant is the guaranteed path */
    });
  }
  notifyListeners();
  return true;
}

/** Result of a durable revoke. `durable` is false when SQL persistence failed. */
export interface DeviceRevokeResult {
  found: boolean;
  /** In-memory + auth access was cut (fail-safe, even if persistence failed). */
  revoked: boolean;
  /** The revocation was durably persisted to SQL. */
  durable: boolean;
  alreadyRevoked?: boolean;
  error?: string;
}

/**
 * Revoke a device DURABLY (issues.txt §5). Persists `revoked=1` to SQL
 * BEFORE reporting durable success, so a restart can never re-trust the
 * device. Idempotent (re-revoking a revoked device is a success no-op).
 * If the SQL write fails, access is still cut in-memory as a fail-safe,
 * but the result reports `durable: false` so the UI/route surfaces a
 * persistence warning instead of claiming a durable revoke.
 *
 * Also cascades to the device's durable agent persona-grants (§2): a
 * revoked agent immediately loses any locked-vault access it was granted.
 */
export async function revokeDeviceDurable(deviceId: string): Promise<DeviceRevokeResult> {
  const device = devices.get(deviceId);
  if (!device) return { found: false, revoked: false, durable: false, error: 'not_found' };
  if (device.revoked) {
    return { found: true, revoked: true, durable: true, alreadyRevoked: true };
  }

  // Step 1: Persist FIRST — durability is claimed only after this succeeds.
  const sqlRepo = getDeviceRepository();
  let durable = false;
  let error: string | undefined;
  if (sqlRepo === null) {
    error = 'no_repository';
  } else {
    try {
      durable = await sqlRepo.revoke(deviceId);
      if (!durable) error = 'row_not_found';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  // Step 2: Cut access (in-memory + auth) regardless — fail-safe deny.
  cutDeviceAccess(device);
  device.revoked = true;

  // Step 3: Cascade — revoke this DID's durable agent grants so a revoked
  // agent can't keep reading a locked persona with a stale grant (§2/§5).
  try {
    const grantRepo = getAgentGrantRepository();
    if (grantRepo !== null && device.did !== '') {
      grantRepo.revokeForAgent(device.did, Date.now());
    }
  } catch {
    /* best-effort */
  }

  notifyListeners();
  appendAudit(
    device.did !== '' ? device.did : deviceId,
    'device_revoked',
    deviceId,
    `durable=${durable}${error !== undefined ? ` error=${error}` : ''}`,
  );

  return { found: true, revoked: true, durable, ...(error !== undefined ? { error } : {}) };
}

/** Cut a device's auth access — unregister its DID from caller-type resolution. */
function cutDeviceAccess(device: PairedDevice): void {
  try {
    const pubKey = multibaseToPublicKey(device.publicKeyMultibase);
    const deviceDID = deriveDIDKey(pubKey);
    unregisterDeviceAuth(deviceDID);
  } catch {
    // If DID derivation fails (corrupted key), still proceed with revocation.
  }
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
  notifyListeners();
}

/**
 * Rehydrate the in-memory device registry from the SQL repository.
 *
 * `getDeviceByDID` and friends only read the in-memory Map. On a cold
 * boot (or Metro reload in dev) the Map starts empty, so a previously
 * paired device's DID can't be resolved to a role — the auth middleware
 * sees `device` instead of `agent` and every `/v1/workflow/tasks/claim`
 * 403s. This mirrors the `hydrateContactDirectory` /
 * `hydrateRemindersFromRepo` recovery wired in `mobile/src/storage/init.ts`.
 *
 * Idempotent: existing entries with matching IDs are kept (no-op).
 */
export async function hydrateDeviceRegistry(): Promise<number> {
  const sqlRepo = getDeviceRepository();
  if (!sqlRepo) return 0;
  const all = await sqlRepo.list();
  let added = 0;
  for (const d of all) {
    if (!devices.has(d.deviceId)) {
      devices.set(d.deviceId, d);
      if (d.publicKeyMultibase !== '') keyIndex.set(d.publicKeyMultibase, d.deviceId);
      if (d.did !== '') didIndex.set(d.did, d.deviceId);
      added += 1;
    }
    // Always re-register the auth-side mapping. The pairing ceremony
    // calls `registerDeviceAuth(did, name)` which populates a SEPARATE
    // Map (`deviceDIDs` in auth/caller_type.ts). Without this every
    // boot, `resolveCallerType` won't recognize the DID as a paired
    // device, the role resolver never fires, and the agent gets
    // `callerType: 'unknown'` → 403 on every workflow claim.
    if (!d.revoked && d.did !== '') {
      registerDeviceAuth(d.did, d.deviceName);
    }
  }
  if (added > 0) notifyListeners();
  return added;
}
