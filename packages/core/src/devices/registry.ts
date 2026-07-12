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

import { getAgentGrantRepository } from '../agent/grant_repository';
import { appendAudit } from '../audit/service';
import {
  registerDevice as registerDeviceAuth,
  unregisterDevice as unregisterDeviceAuth,
} from '../auth/caller_type';
import { multibaseToPublicKey, deriveDIDKey } from '../identity/did';
import { getPluginDecisionRepository } from '../plugins/decisions';
import { getPluginGrantRepository } from '../plugins/grants';
import { terminateInstallInFlight } from '../plugins/install_service';
import { getPluginInstallRepository } from '../plugins/registry';

import { getDeviceRepository } from './repository';

/**
 * Device roles. `plugin` (PLUGIN_ARCHITECTURE.md §7) is a runner-plugin
 * instance: paired like an agent, but resolved to its OWN caller type —
 * silent fallthrough to 'device' would inherit the much wider device
 * surface (privilege escalation by default-case). Pinned by
 * __tests__/auth/plugin_caller.test.ts.
 */
export type DeviceRole = 'rich' | 'thin' | 'cli' | 'agent' | 'plugin';
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
  const existingId = keyIndex.get(publicKeyMultibase);
  if (existingId !== undefined) {
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

/**
 * Durably persist an already-registered device (P2.10). `registerDevice` does
 * the SQL write fire-and-forget (keeping its callers sync), so a paired device
 * could be lost on restart if that write silently failed. The pairing route
 * calls this AFTER `completePairing` to AWAIT the write before returning 201 —
 * `register` is an idempotent upsert, so re-persisting the same row is safe,
 * and a genuine write failure REJECTS so the route reports it instead of a
 * false success. Throws if the device id isn't in the registry.
 */
export async function persistDeviceDurable(deviceId: string): Promise<void> {
  const device = devices.get(deviceId);
  if (!device) throw new Error(`devices: cannot persist unknown device "${deviceId}"`);
  const sqlRepo = getDeviceRepository();
  if (sqlRepo) await sqlRepo.register(device);
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
  // Round-5 #5: do NOT short-circuit an already-in-memory-revoked device. The
  // in-memory `revoked` flag only proves access was CUT, not that SQL persisted
  // or the cascades completed — a prior call whose SQL write failed, or that
  // crashed before the plugin/grant cascades, would falsely report durable
  // success and never retry. Every call re-runs the idempotent SQL revoke + the
  // idempotent cascades until they stick. `repo.revoke` returns true whenever
  // the row exists, so re-revoking a persisted device still reports durable.
  const wasAlreadyRevoked = device.revoked;

  // Step 1: Persist (idempotent). Retried on EVERY call until it succeeds.
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

  // Round-6 #4: the authority cascades below are BEST-EFFORT for control flow
  // (a failure never aborts the revoke) but their completion is part of what
  // "durable" MUST mean — if grant revocation or install pausing fails, the
  // device SQL row alone being persisted is NOT enough: re-pairing the same key
  // (same derived DID) would revive an active install with old grants. So a
  // cascade failure downgrades `durable`, which — with the idempotent-retry
  // behavior above — makes the caller re-run the whole revoke (cascades
  // included) until everything sticks.
  let cascadesOk = true;

  // Step 3: Cascade — revoke this DID's durable agent grants so a revoked
  // agent can't keep reading a locked persona with a stale grant (§2/§5).
  try {
    const grantRepo = getAgentGrantRepository();
    if (grantRepo !== null && device.did !== '') {
      grantRepo.revokeForAgent(device.did, Date.now());
    }
  } catch (err) {
    cascadesOk = false;
    if (error === undefined) error = `agent-grant cascade failed: ${errMsg(err)}`;
  }

  // Step 4: Cascade to plugin authority — if this device is a plugin
  // runner instance, revoking it MUST stop the install's lane and revoke
  // its grants. Otherwise the install stays active and re-pairing the same
  // key (which derives the same DID) would make the old install and its
  // grants usable again with no re-consent (§14). Pause + grant-revoke =
  // no surviving authority: the claim guard's active-status check stops
  // new claims immediately, the revoked device can no longer authenticate
  // to complete the in-flight one, and a resume requires an explicit owner
  // flow with re-consent (the grants are gone). "Revocation stops future
  // authority, not history" (I12) — the install row and its receipts stay.
  try {
    const installRepo = getPluginInstallRepository();
    if (installRepo !== null && device.did !== '') {
      // P1-3: disable EVERY install bound to this device DID, not just the one
      // getByDeviceDid returns. The v19 partial unique index constrains only
      // `active`, so a device can legitimately be co-bound to one active plus
      // several paused/pending installs. Walking a single row left the others
      // authorized: re-pairing the same key (same derived DID) would revive
      // their grants with no re-consent. Enumerate and disable all of them.
      const nowMs = Date.now();
      const nowSec = Math.floor(nowMs / 1000);
      for (const install of installRepo.listByDeviceDid(device.did)) {
        let changed = false;
        if (install.status === 'pending') {
          // A pending install on a now-revoked device can never legitimately
          // activate (the runner can't authenticate) — unwind it so a later
          // confirmConsent can't commit a lane onto dead authority. remove()
          // cascades its grants.
          installRepo.remove(install.installId);
          changed = true;
        } else {
          getPluginGrantRepository()?.revokeAllForInstall(install.installId, nowSec);
          // pause() returns false if already paused — on an idempotent
          // re-revoke (Round-5 #5) the state didn't change, so don't re-log.
          changed = installRepo.pause(install.installId, nowMs);
          // P1-4: terminate in-flight work immediately — a running effectful
          // task parks as outcome_unknown, queued ones cancel — so no
          // completion can apply through the revoke seam.
          terminateInstallInFlight(install.installId, 'plugin device revoked', nowMs);
        }
        // Only append a decision when the revoke actually changed state, so a
        // retried/duplicate revoke doesn't spam the owner-private log.
        if (changed) {
          getPluginDecisionRepository()?.record({
            installId: install.installId,
            decision: 'paused',
            nowSec,
          });
        }
      }
    }
  } catch (err) {
    cascadesOk = false;
    if (error === undefined) error = `plugin cascade failed: ${errMsg(err)}`;
  }

  notifyListeners();
  // Round-6 #4: durable = device SQL persisted AND authority cascades completed.
  // A cascade failure means old grants/installs may survive, so report NOT
  // durable — the caller's retry re-runs everything (idempotent) until clean.
  const fullyDurable = durable && cascadesOk;
  appendAudit(
    device.did !== '' ? device.did : deviceId,
    'device_revoked',
    deviceId,
    `durable=${fullyDurable}${error !== undefined ? ` error=${error}` : ''}`,
  );

  return {
    found: true,
    revoked: true,
    durable: fullyDurable,
    ...(wasAlreadyRevoked ? { alreadyRevoked: true } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/** Compact error-message extractor for cascade failures. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Round-6 #1: revoke a device identified by its DID — the identifier plugin
 * installs store (`device_did`) — rather than by `deviceId`. Maps DID →
 * deviceId → the durable revoke and returns the full result. This is the typed,
 * ASYNC callback the plugin lifecycle ops (uninstall / declineConsent / the
 * abandoned sweep) pass, so they can confirm `durable === true` BEFORE deleting
 * an install row. Passing the raw `revokeDeviceDurable` there was a latent bug:
 * it is async (its Promise would be dropped) and takes a deviceId, not a DID.
 */
export async function revokeDeviceByDidDurable(deviceDid: string): Promise<DeviceRevokeResult> {
  if (deviceDid === '') return { found: false, revoked: false, durable: false, error: 'empty_did' };
  const device = getDeviceByDID(deviceDid);
  if (device === null) return { found: false, revoked: false, durable: false, error: 'not_found' };
  return revokeDeviceDurable(device.deviceId);
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
