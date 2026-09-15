/**
 * Device pairing ceremony — 8-character Crockford-Base32 code exchange.
 *
 * 1. GeneratePairingCode() → 8-char alphanumeric code (32^8 ≈ 1.1T
 *    space, derived from a 32-byte secret via SHA-256), 5-min TTL
 * 2. CompletePairing() → validate code, register Ed25519 public key
 * 3. Returns device_id, node_did
 *
 * Security (matching Go pairing.go):
 * - Single-use codes (consumed on completion)
 * - 5-minute expiry
 * - Max 100 pending codes (DoS protection)
 * - Collision retry (5 attempts on code generation)
 * - Brute-force protection (3 failed attempts burns a code)
 * - Constant-time code comparison
 *
 * Source: core/test/pairing_test.go
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { registerDevice as registerDeviceAuth } from '../auth/caller_type';
import {
  PAIRING_CODE_TTL_S,
  PAIRING_MAX_PENDING,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_ALPHABET,
  PAIRING_SECRET_BYTES,
} from '../constants';
import { registerDevice as persistDevice, revokeDevice } from '../devices/registry';
import { multibaseToPublicKey , deriveDIDKey } from '../identity/did';
import { getPluginInstallRepository } from '../plugins/registry';

export interface PairingCode {
  code: string; // 8-char Crockford-Base32 string
  expiresAt: number; // Unix seconds
}

export interface PairingResult {
  deviceId: string;
  nodeDID: string;
}

const CODE_TTL_SECONDS = PAIRING_CODE_TTL_S;
const MAX_PENDING_CODES = PAIRING_MAX_PENDING;

/** Max code generation retries on collision (matching Go's 5 attempts). */
const MAX_COLLISION_RETRIES = 5;

/** Max failed completion attempts before burning a code (matching Go's 3 attempts). */
const MAX_FAILED_ATTEMPTS = 3;

/** In-memory store of pending codes. */
interface PendingCode {
  code: string;
  expiresAt: number;
  used: boolean;
  failedAttempts: number;
  /**
   * Pair-intent metadata supplied at initiate time. The admin UI
   * records WHAT the upcoming device should be registered as (name +
   * role) before the device knows the code. `completePairing`
   * honours these when the caller omits them, so the agent side can
   * present a minimal `{code, publicKey}` request (matches the
   * `dina configure --pairing-code` CLI shape).
   */
  deviceName?: string;
  role?: import('../devices/registry').DeviceRole;
  /** Item C — agent_scope the enrolling authority stamps at INITIATE. */
  scope?: import('../auth/agent_scope').AgentScope;
  /**
   * PLUGIN_ARCHITECTURE §15.3 — a code issued for ONE pending runner install.
   * `completePairing` binds the device that uses it to exactly that install,
   * in Core, before the code is consumed; the install's row is then the only
   * place the bound device lives, and a device DID typed at the final button
   * is never accepted in its place. A code whose install is gone, expired, or
   * already bound to a different device refuses to pair at all, so no plugin
   * device can exist that no install references.
   */
  pluginInstallId?: string;
}

const pendingCodes = new Map<string, PendingCode>();

/** Node DID — MUST be set at startup via setNodeDID() before any pairing. */
let nodeDID: string | null = null;

/** Set the node DID (called at startup after identity unlock). */
export function setNodeDID(did: string): void {
  if (!did || !did.startsWith('did:')) throw new Error('pairing: invalid node DID');
  nodeDID = did;
}

/** This node's DID (set at startup), or null before identity is loaded. */
/**
 * The node's Ed25519 SIGNING public key, for surfaces that mint
 * connection metadata (the §6 staff setup code carries it so a joining
 * phone can seal its first request). Public information — the same key
 * the DID doc publishes as `#dina_signing`.
 */
let nodeSigningPub: Uint8Array | null = null;

export function setNodeSigningPublicKey(pub: Uint8Array | null): void {
  nodeSigningPub = pub;
}

export function getNodeSigningPublicKey(): Uint8Array | null {
  return nodeSigningPub;
}

export function getNodeDID(): string | null {
  return nodeDID;
}

/**
 * Generate an 8-character Crockford-Base32 pairing code.
 *
 * Retries up to 5 times on collision (matching Go's collision retry).
 *
 * Optional `intent` records the pair's target metadata (device name +
 * role) so the eventual `completePairing` call can apply those
 * defaults — matches `dina-admin device pair` which accepts the
 * device_name + role at INITIATE, not COMPLETE.
 *
 * @returns { code, expiresAt }
 * @throws if max pending codes exceeded or collision retry exhausted
 */
export function generatePairingCode(
  intent: {
    deviceName?: string;
    role?: import('../devices/registry').DeviceRole;
    scope?: import('../auth/agent_scope').AgentScope;
    /** §15.3 — bind whoever uses this code to this pending runner install. */
    pluginInstallId?: string;
  } = {},
): PairingCode {
  if (!nodeDID) throw new Error('pairing: node DID not set — call setNodeDID() at startup');

  // Purge expired before counting
  purgeExpiredCodes();

  if (activePairingCount() >= MAX_PENDING_CODES) {
    throw new Error('pairing: max pending codes exceeded (100)');
  }

  // Generate code with collision retry (matching Go's 5-attempt limit).
  // Algorithm — bug-for-bug parity with `core/internal/adapter/pairing/pairing.go`:
  //   1. Sample 32 cryptographically random bytes (PAIRING_SECRET_BYTES).
  //   2. SHA-256 the secret.
  //   3. Take the first 8 hash bytes; map each via `byte % 32` into the
  //      Crockford Base32 alphabet to produce the displayed code.
  //   4. The 32-byte secret is the cryptographic material; the
  //      displayed 8-char code is a stable index. (Lite uses the code
  //      directly as the lookup key into `pendingCodes`; a future
  //      revision could persist the secret separately if any
  //      downstream key-derivation needs it.)
  let code: string;
  let retries = 0;

  do {
    const secret = randomBytes(PAIRING_SECRET_BYTES);
    code = deriveAlphanumericCode(secret, PAIRING_CODE_LENGTH);
    retries++;
  } while (pendingCodes.has(code) && retries <= MAX_COLLISION_RETRIES);

  if (pendingCodes.has(code)) {
    throw new Error('pairing: code generation collision (retry exhausted)');
  }

  const expiresAt = Math.floor(Date.now() / 1000) + CODE_TTL_SECONDS;

  pendingCodes.set(code, {
    code,
    expiresAt,
    used: false,
    failedAttempts: 0,
    deviceName: intent.deviceName,
    role: intent.role,
    scope: intent.scope,
    ...(intent.pluginInstallId !== undefined ? { pluginInstallId: intent.pluginInstallId } : {}),
  });

  return { code, expiresAt };
}

/**
 * Read the device-name / role intent a pending code was created
 * with. Used by the `/v1/pair/complete` route so the caller can omit
 * fields it didn't supply (matches the `dina configure` CLI shape
 * where the agent only presents `{code, publicKey}`). Returns null
 * when the code isn't a known pending entry.
 */
export function getPairingIntent(code: string): {
  deviceName?: string;
  role?: import('../devices/registry').DeviceRole;
  scope?: import('../auth/agent_scope').AgentScope;
  pluginInstallId?: string;
} | null {
  const pending = pendingCodes.get(code);
  if (!pending) return null;
  return {
    deviceName: pending.deviceName,
    role: pending.role,
    scope: pending.scope,
    ...(pending.pluginInstallId !== undefined ? { pluginInstallId: pending.pluginInstallId } : {}),
  };
}

/**
 * Complete pairing with a device's Ed25519 public key.
 *
 * Brute-force protection: tracks failed attempts per code.
 * After 3 failed attempts, the code is burned (matching Go).
 *
 * @param code - The 8-character Crockford-Base32 pairing code
 * @param deviceName - Human-readable device name
 * @param publicKeyMultibase - z-prefixed Ed25519 public key
 * @returns { deviceId, nodeDID }
 * @throws if code is invalid, expired, burned, or already used
 */
export function completePairing(
  code: string,
  deviceName: string,
  publicKeyMultibase: string,
  role: import('../devices/registry').DeviceRole = 'rich',
  scope?: import('../auth/agent_scope').AgentScope,
): PairingResult {
  if (!nodeDID) throw new Error('pairing: node DID not set — call setNodeDID() at startup');

  if (!isCodeValid(code)) {
    // Track failed attempt if the code exists but is being brute-forced
    recordFailedAttempt(code);
    throw new Error('pairing: invalid, expired, or already-used code');
  }

  // Round-15 #6: do the fallible work (decode key, register device) BEFORE
  // consuming the single-use code. A malformed key (`multibaseToPublicKey`
  // throws) or a registration failure is a client/transient error, not a code
  // guess — burning the code first permanently killed a legitimate code and
  // forced a full pairing restart. Consume it only once registration succeeds.
  const pending = pendingCodes.get(code)!;

  // Derive device DID from its public key.
  // PLG-28 #20: a MALFORMED key must count against the 3-attempt burn budget too.
  // The decode threw BEFORE any attempt was recorded, so someone holding a valid
  // (intercepted) code could send malformed keys until expiry without ever
  // triggering the burn. Record the failed attempt on decode failure. This keeps
  // the Round-15 #6 intent intact — a SUCCESSFUL decode followed by a later
  // durable-persistence failure still does NOT burn the code (only genuine
  // malformed input counts) — so a transient server error remains retryable.
  let pubKey: Uint8Array;
  try {
    pubKey = multibaseToPublicKey(publicKeyMultibase);
  } catch {
    recordFailedAttempt(code);
    throw new Error('pairing: malformed public key');
  }
  const deviceDID = deriveDIDKey(pubKey);

  // §15.3 — a runner code pairs ONLY into its pending install. Checked before
  // any registration so a late runner (the owner declined, the install expired
  // or was swept, a second code already bound another device) never becomes a
  // plugin device that nothing references. The code is spent either way: the
  // install it was issued for cannot take a device any more.
  if (pending.pluginInstallId !== undefined) {
    const refusal = runnerInstallRefusal(pending.pluginInstallId, deviceDID);
    if (refusal !== null) {
      pendingCodes.delete(code);
      throw new Error(`pairing: ${refusal}`);
    }
  }

  // Persist device in device registry with caller-specified role + scope
  const device = persistDevice(deviceName, publicKeyMultibase, role, scope);

  // Register device DID for auth resolution (callerType = 'device')
  registerDeviceAuth(deviceDID, deviceName);

  if (pending.pluginInstallId !== undefined) {
    const installs = getPluginInstallRepository();
    const nowMs = Date.now();
    let bound = false;
    try {
      bound = installs !== null && installs.bindPendingDevice(pending.pluginInstallId, deviceDID, nowMs);
    } catch (err) {
      // A storage fault (busy, I/O) is transient and not the runner's doing:
      // undo the registration so no unreferenced plugin device survives, keep
      // the code live so the same runner can retry, and surface the fault.
      revokeDevice(device.deviceId);
      throw new Error(`pairing: runner bind failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // The pre-check above makes a refusal here a race (a rival code bound first
    // between the two calls). Undo the registration so the loser leaves no
    // device behind, and spend the code.
    if (!bound) {
      revokeDevice(device.deviceId);
      pendingCodes.delete(code);
      throw new Error('pairing: runner could not be bound to its install');
    }
  }

  // Mark code as used (single-use) — only after the device is registered.
  pending.used = true;

  return { deviceId: device.deviceId, nodeDID: nodeDID! };
}

/**
 * Why a runner may NOT pair into `installId` right now, or null when it may:
 * the install must exist, still be `pending`, not have expired, and either be
 * unbound or already bound to this same device (an idempotent retry).
 */
function runnerInstallRefusal(installId: string, deviceDid: string): string | null {
  const installs = getPluginInstallRepository();
  if (installs === null) return 'plugin registry not wired';
  const install = installs.getById(installId);
  if (install === null) return 'plugin install no longer pending';
  if (install.status !== 'pending') return `plugin install is ${install.status}, not pending`;
  if (
    install.pendingExpiresAt !== undefined &&
    install.pendingExpiresAt <= Math.floor(Date.now() / 1000)
  ) {
    return 'plugin install request expired';
  }
  if (install.deviceDid !== undefined && install.deviceDid !== '' && install.deviceDid !== deviceDid) {
    return 'plugin install already bound to another runner';
  }
  return null;
}

/**
 * Round-16 #3: un-consume a pairing code after a DURABLE persistence failure.
 * `completePairing` consumes the code once in-memory registration succeeds, but
 * the route awaits `persistDeviceDurable` AFTER that — a transient SQL failure
 * then rolls back the device (via the durable revoker) but the code stays
 * `used` forever, forcing the user to restart pairing. The route calls this in
 * its 503 rollback branch so a retryable server error doesn't burn a legitimate
 * code. No-op if the entry is gone (expired/purged) — a fresh code is required.
 */
export function restorePairingCode(code: string): void {
  const pending = pendingCodes.get(code);
  if (pending === undefined) return;
  // A runner code is only worth restoring while its install can still take a
  // runner. The durable-persist rollback revokes the device, and that revoke's
  // cascade removes the pending install the device was bound to — so a restored
  // runner code would promise a retry that `completePairing` must refuse. Spend
  // it instead; the owner starts the ceremony again with a fresh install.
  if (pending.pluginInstallId !== undefined) {
    const installs = getPluginInstallRepository();
    const install = installs?.getById(pending.pluginInstallId) ?? null;
    if (install === null || install.status !== 'pending') {
      pendingCodes.delete(code);
      return;
    }
  }
  pending.used = false;
}

/**
 * Check if a pairing code is valid (exists, not expired, not used, not burned).
 */
export function isCodeValid(code: string): boolean {
  const pending = pendingCodes.get(code);
  if (!pending) return false;
  if (pending.used) return false;
  if (pending.failedAttempts >= MAX_FAILED_ATTEMPTS) return false;

  const now = Math.floor(Date.now() / 1000);
  if (now > pending.expiresAt) return false;

  return true;
}

/**
 * Record a failed pairing attempt for brute-force tracking.
 *
 * If the code exists and has been attempted MAX_FAILED_ATTEMPTS times,
 * it is burned (marked as used). This prevents attackers from guessing
 * valid codes within the TTL window.
 */
function recordFailedAttempt(code: string): void {
  const pending = pendingCodes.get(code);
  if (!pending || pending.used) return;

  pending.failedAttempts++;

  // Burn the code after max failed attempts
  if (pending.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    pending.used = true;
  }
}

/** Count of active (unexpired, unused, not burned) pairing codes. */
export function activePairingCount(): number {
  const now = Math.floor(Date.now() / 1000);
  let count = 0;
  for (const pending of pendingCodes.values()) {
    if (!pending.used && pending.failedAttempts < MAX_FAILED_ATTEMPTS && now <= pending.expiresAt) {
      count++;
    }
  }
  return count;
}

/** Purge expired and used pairing codes. Returns count of purged codes. */
export function purgeExpiredCodes(): number {
  const now = Math.floor(Date.now() / 1000);
  let purged = 0;
  for (const [key, pending] of pendingCodes.entries()) {
    if (now > pending.expiresAt || pending.used) {
      pendingCodes.delete(key);
      purged++;
    }
  }
  return purged;
}

/**
 * Verify that a device's public_key_multibase actually derives to the
 * expected DID. Prevents identity spoofing during pairing — a device
 * cannot claim a DID that doesn't match its presented public key.
 *
 * Matching Go's VerifyPairingIdentityBinding.
 *
 * @param publicKeyMultibase - The device's presented z-prefixed Ed25519 key
 * @param claimedDID - The DID the device claims to own
 * @returns true if the key derives to the claimed DID
 */
export function verifyPairingIdentityBinding(
  publicKeyMultibase: string,
  claimedDID: string,
): boolean {
  try {
    const pubKey = multibaseToPublicKey(publicKeyMultibase);
    const derivedDID = deriveDIDKey(pubKey);
    return derivedDID === claimedDID;
  } catch {
    return false; // Invalid key format → binding fails
  }
}

/** Clear all pending codes and reset node DID (for testing). */
export function clearPairingState(): void {
  pendingCodes.clear();
  nodeDID = null;
}

/**
 * Derive an `n`-character Crockford-Base32 pairing code from a
 * cryptographic secret. Bit-for-bit parity with Go's
 * `core/internal/adapter/pairing/pairing.go:deriveAlphanumericCode`:
 * SHA-256 the secret, then map the first `n` hash bytes through
 * `byte % alphabet.length` into `PAIRING_CODE_ALPHABET`.
 *
 * Exported so paired-device tooling (CLI / agent) and tests can
 * reproduce a code from a known secret without replicating the
 * algorithm. Not part of the public API for code generation —
 * `generatePairingCode` is the only legitimate caller in production.
 */
export function deriveAlphanumericCode(secret: Uint8Array, n: number): string {
  if (n <= 0 || n > 32) {
    throw new Error(`deriveAlphanumericCode: n must be in [1, 32] (got ${n})`);
  }
  const hash = sha256(secret);
  const alphabet = PAIRING_CODE_ALPHABET;
  const out = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    out[i] = alphabet[hash[i] % alphabet.length]!;
  }
  return out.join('');
}
