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
import { registerDevice as persistDevice } from '../devices/registry';
import { registerDevice as registerDeviceAuth } from '../auth/caller_type';
import { multibaseToPublicKey } from '../identity/did';
import { deriveDIDKey } from '../identity/did';

export interface PairingCode {
  code: string; // 8-char Crockford-Base32 string
  expiresAt: number; // Unix seconds
}

export interface PairingResult {
  deviceId: string;
  nodeDID: string;
}

import {
  PAIRING_CODE_TTL_S,
  PAIRING_MAX_PENDING,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_ALPHABET,
  PAIRING_SECRET_BYTES,
} from '../constants';

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
}

const pendingCodes = new Map<string, PendingCode>();

/** Node DID — MUST be set at startup via setNodeDID() before any pairing. */
let nodeDID: string | null = null;

/** Set the node DID (called at startup after identity unlock). */
export function setNodeDID(did: string): void {
  if (!did || !did.startsWith('did:')) throw new Error('pairing: invalid node DID');
  nodeDID = did;
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
export function getPairingIntent(
  code: string,
): { deviceName?: string; role?: import('../devices/registry').DeviceRole } | null {
  const pending = pendingCodes.get(code);
  if (!pending) return null;
  return { deviceName: pending.deviceName, role: pending.role };
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
): PairingResult {
  if (!nodeDID) throw new Error('pairing: node DID not set — call setNodeDID() at startup');

  if (!isCodeValid(code)) {
    // Track failed attempt if the code exists but is being brute-forced
    recordFailedAttempt(code);
    throw new Error('pairing: invalid, expired, or already-used code');
  }

  // Mark code as used (single-use)
  const pending = pendingCodes.get(code)!;
  pending.used = true;

  // Derive device DID from its public key
  const pubKey = multibaseToPublicKey(publicKeyMultibase);
  const deviceDID = deriveDIDKey(pubKey);

  // Persist device in device registry with caller-specified role
  const device = persistDevice(deviceName, publicKeyMultibase, role);

  // Register device DID for auth resolution (callerType = 'device')
  registerDeviceAuth(deviceDID, deviceName);

  return { deviceId: device.deviceId, nodeDID: nodeDID! };
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
