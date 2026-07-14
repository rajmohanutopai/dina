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
import { recordDecisionSafe } from '../plugins/decisions';
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
    if (existing && existing.revoked) {
      // Round-9 #2: reviving a revoked key must REUSE its one row, not mint a
      // second device with a fresh deviceId. Two rows sharing a DID (key →
      // DID is deterministic) make `getByDID`/`getByPublicKey` nondeterministic
      // and let boot reconciliation disable the freshly re-paired device via
      // the stale revoked twin (the reconciler walks every row by DID). Reset
      // in place — same deviceId, same DID — so exactly one row ever exists per
      // key. (Re-pairing is an authorized ceremony; it legitimately revives.)
      const now = Date.now();
      const revived: PairedDevice = {
        ...existing,
        deviceName: name.trim(),
        role,
        lastSeen: now,
        createdAt: now,
        revoked: false,
      };
      devices.set(existing.deviceId, revived);
      keyIndex.set(publicKeyMultibase, existing.deviceId);
      didIndex.set(revived.did, existing.deviceId);
      const sqlRepo = getDeviceRepository();
      if (sqlRepo) {
        void sqlRepo.register(revived).catch(() => {
          /* fail-safe — transient SQL write loss is acceptable */
        });
      }
      notifyListeners();
      return revived;
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
  // Round-15 #4: a NULL repo is not "durably persisted" — it is an in-memory-only
  // device that vanishes on restart. Silently resolving here contradicts the
  // "genuine failure REJECTS" contract above and let both registration routes
  // return 201 for a non-durable device. Fail closed: no repo ⇒ throw, so the
  // route surfaces a 503 (+ rollback) instead of a false success. Production
  // always wires the repo before serving; a null repo means a misconfigured or
  // partial boot.
  if (!sqlRepo) {
    throw new Error('devices: no durable device repository configured — cannot persist');
  }
  await sqlRepo.register(device);
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

  // Step 1: Cut access (in-memory + auth) FIRST — before any await. Round-9 #1:
  // a slow/hung DB must not leave the device authenticatable while persistence
  // is in flight; the SQL revoke below can suspend this function for the whole
  // duration of the stall. cutDeviceAccess is idempotent, and `wasAlreadyRevoked`
  // is already captured above, so cutting first doesn't disturb the durable /
  // retry semantics — the persist + cascades still run and still downgrade
  // `durable` on failure so the caller retries.
  cutDeviceAccess(device);
  device.revoked = true;

  // Step 2: Persist (idempotent). Retried on EVERY call until it succeeds.
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

  // Round-11 #5: a re-pair (revive path) can race THIS revoke during the
  // `await sqlRepo.revoke` yield. Round-10 #4 SKIPPED the authority cascades in
  // that case to avoid "stripping the re-paired device" — that was WRONG. A
  // re-pair mints NO new authority synchronously; the installs/grants bound to
  // `device.did` at this point are the SAME pre-revocation authority the revoke
  // exists to DESTROY. Skipping let a re-pair DEFEAT revocation (and, since the
  // revived row is `revoked=false`, the boot reconciler skipped it too →
  // permanent retention). So ALWAYS run the cascades: they key on `device.did`
  // (stable across re-pair) and are idempotent. Correct end state = an alive,
  // re-paired device with NO plugin/agent authority, requiring re-consent.

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
    if (device.did !== '') {
      const ok = disableAgentGrantsForDevice(device.did, Date.now());
      // Round-9 #13: an AGENT device (the only role that holds persona grants)
      // whose grant repo is absent cannot have its grants verified/cleaned here
      // — SQL rows may survive a teardown-time revoke. Mirror the plugin half:
      // treat the missing repo as a cascade failure so `durable` downgrades and
      // the boot reconciler retries, rather than falsely reporting the
      // agent-grant half of cleanup succeeded. (A non-agent device holds no
      // persona grants, so a `false` there is nothing to clean — durable stays.)
      if (!ok && device.role === 'agent') {
        cascadesOk = false;
        if (error === undefined) error = 'agent-grant cascade failed: repository unavailable';
      }
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
    if (device.did !== '') {
      const ok = disablePluginAuthorityForDevice(device.did, Date.now());
      // Round-12 #13: mirror the agent-grant half above — a PLUGIN device whose
      // install repo is absent cannot have its installs/grants verified/cleaned
      // here, so SQL rows may survive a teardown-time revoke. Downgrade `durable`
      // so the boot reconciler retries, rather than falsely reporting the plugin
      // half of cleanup succeeded. (A non-plugin device binds no plugin installs,
      // so a `false` there is nothing to clean — durable stays.)
      if (!ok && device.role === 'plugin') {
        cascadesOk = false;
        if (error === undefined) error = 'plugin cascade failed: repository unavailable';
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
 * P1-3 + Round-7 #3: disable ALL plugin authority bound to a device DID.
 * Enumerates every install on the DID (the v19 index constrains only `active`,
 * so a device can be co-bound to one active plus several paused/pending
 * installs — re-pairing the same key revives them all otherwise). Pending
 * installs are unwound (they can never legitimately activate on a dead device);
 * active/paused installs have their grants revoked, are paused, and their
 * in-flight work terminated. Fully IDEMPOTENT — re-running it (from a revoke
 * retry OR boot reconciliation) is a no-op once everything is disabled, so a
 * decision is logged only when state actually changed.
 */
function disablePluginAuthorityForDevice(deviceDid: string, nowMs: number): boolean {
  const installRepo = getPluginInstallRepository();
  // Round-12 #13: signal an ABSENT install repo (false) — the plugin half of
  // cleanup could not be verified, so SQL install/grant rows may survive. The
  // caller downgrades `durable` for a plugin-role device (mirroring the
  // agent-grant half). An empty DID is a no-op success (nothing bound).
  if (installRepo === null) return false;
  if (deviceDid === '') return true;
  const nowSec = Math.floor(nowMs / 1000);
  // Round-10 #14: enumerate RAW (scalar columns only) so a JSON-corrupt row
  // bound to this device is still disabled — the full mapper would quarantine
  // it out and let it (and its live grants) escape revocation.
  const installs = installRepo.listRawByDeviceDid(deviceDid);
  // Round-8 #3: if there ARE non-pending installs to disable but the grant repo
  // is absent, we would pause the install while leaving its grants LIVE — a
  // silent half-cleanup. That is a wiring inconsistency (installs exist ⇒ the
  // grant repo should too); THROW so the caller downgrades `durable` / the
  // reconciler retries, rather than reporting a cleanup that didn't happen.
  if (getPluginGrantRepository() === null && installs.some((i) => i.status !== 'pending')) {
    throw new Error(
      'plugin grant repository unavailable — cannot revoke grants for revoked device',
    );
  }
  for (const install of installs) {
    let changed = false;
    if (install.status === 'pending') {
      installRepo.remove(install.installId); // remove() cascades its grants
      changed = true;
    } else {
      getPluginGrantRepository()?.revokeAllForInstall(install.installId, nowSec);
      // Round-9 #16: this is a device-revoke hold — a plain resume must NOT
      // revive it (the runner device is gone; re-pairing is required).
      changed = installRepo.pause(install.installId, nowMs, 'device_revoked'); // false if already paused
      // Round-10 #5: if it was ALREADY paused (e.g. manually), `pause` no-ops
      // (WHERE active) and would leave pause_reason='manual' → still resumable
      // despite grants being revoked. Escalate the hold so resume refuses it.
      if (!changed) {
        changed = installRepo.escalatePauseReason(install.installId, 'device_revoked', nowMs);
      }
      terminateInstallInFlight(install.installId, 'plugin device revoked', nowMs);
    }
    if (changed) {
      // PLG-28 #2: device revocation already committed — a failing audit write
      // must not abort the per-install cascade for the remaining installs.
      recordDecisionSafe({
        installId: install.installId,
        // Round-15 #20: a pending install is DELETED above (never consented), an
        // active/paused one is paused. Record the branch-accurate decision — the
        // owner's audit history said "paused" for an install that was removed.
        decision: install.status === 'pending' ? 'uninstalled' : 'paused',
        nowSec,
      });
    }
  }
  return true;
}

/**
 * Round-6 #4 + Round-8 #2/#3: revoke a device DID's durable AGENT persona grants
 * (§2/§5). Extracted so the revoke cascade AND boot reconciliation share it.
 * Returns false when the repo is absent — the caller cannot then claim the
 * agent-grant half of cleanup succeeded.
 */
function disableAgentGrantsForDevice(deviceDid: string, nowMs: number): boolean {
  const grantRepo = getAgentGrantRepository();
  if (grantRepo === null) return false;
  if (deviceDid !== '') grantRepo.revokeForAgent(deviceDid, nowMs);
  return true;
}

/**
 * Round-7 #3 + Round-8 #2: boot-time reconciliation. A crash BETWEEN the
 * device-SQL revoke and the authority cascades leaves a device revoked in SQL
 * but its installs still active / grants live; nothing re-runs the cascade. On
 * boot, for every REVOKED device, re-disable BOTH halves of its authority —
 * plugin installs/grants AND agent persona grants (Round-8 #2: the earlier
 * reconciler only repeated the plugin half) — idempotently, so a crash can never
 * leave stale authority that re-pairing the same key would revive. Returns the
 * count of revoked devices reconciled. NOTE: for this to reach the agent-grant
 * repo, the caller must wire AgentGrantRepository BEFORE hydrating devices.
 */
export function reconcileRevokedDeviceAuthority(): number {
  const nowMs = Date.now();
  let reconciled = 0;
  for (const device of devices.values()) {
    if (device.revoked && device.did !== '') {
      try {
        const pluginOk = disablePluginAuthorityForDevice(device.did, nowMs);
        const ok = disableAgentGrantsForDevice(device.did, nowMs);
        // Round-9 #13: don't count an AGENT device as reconciled if its
        // persona-grant repo was absent — the agent-grant half didn't run, so
        // leave it for the next boot rather than reporting it as cleaned.
        if (!ok && device.role === 'agent') continue;
        // Round-12 #13: same for a PLUGIN device whose install repo was absent —
        // the plugin half didn't run; leave it for the next boot to retry.
        if (!pluginOk && device.role === 'plugin') continue;
        reconciled += 1;
      } catch {
        /* best-effort per device; the next boot retries */
      }
    }
  }
  return reconciled;
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
  // Round-12 #14: unregister the STORED `did` — the exact value hydration /
  // pairing registered via `registerDeviceAuth(device.did, …)` (and the value
  // `didIndex`/`getDeviceByDID` key on). The old code RE-DERIVED a DID from
  // `public_key_multibase` and unregistered THAT; if the stored `did` and the
  // key ever disagree — a non-`did:key` method (e.g. `did:plc`), the
  // test-fixture `did:key:${multibase}` fallback, or a tampered column — the
  // derived value misses the registered mapping and the identity keeps
  // authenticating after revoke. Cut the registered DID directly.
  if (device.did !== '') {
    unregisterDeviceAuth(device.did);
    return;
  }
  // Legacy row with no stored DID: fall back to deriving from the key.
  try {
    unregisterDeviceAuth(deriveDIDKey(multibaseToPublicKey(device.publicKeyMultibase)));
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
  // Round-7 #3: reconcile any revoked device whose authority cascade may have
  // been interrupted by a crash — re-disable its plugin installs/grants
  // (idempotent) so stale authority can't survive a reboot + re-pair.
  reconcileRevokedDeviceAuthority();
  if (added > 0) notifyListeners();
  return added;
}
