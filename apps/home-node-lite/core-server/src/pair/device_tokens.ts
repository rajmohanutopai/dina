/**
 * Task 4.64 — Device token storage (SHA-256 hashed).
 *
 * When a device completes pairing (task 4.63, later) the Home Node
 * issues a `CLIENT_TOKEN` — 32 random bytes hex-encoded. The raw
 * token is handed to the device once; on the server side we only
 * ever persist `SHA-256(rawToken)`. A stolen `device_tokens` table
 * therefore grants nothing — the attacker cannot reverse a 256-bit
 * digest back to the raw token.
 *
 * **Verification path**: on every Bearer-authenticated request the
 * handler computes `SHA-256(candidateToken)` and looks it up in the
 * hashed index. The comparison is constant-time (via
 * `crypto.timingSafeEqual`) so attackers cannot recover a token byte
 * at a time.
 *
 * **Schema parity** with Go (`identity_001.sql device_tokens`):
 *   - `device_id`   TEXT PRIMARY KEY
 *   - `token_hash`  TEXT  (hex SHA-256)
 *   - `device_name` TEXT
 *   - `last_seen`   INTEGER  (unix seconds)
 *   - `created_at`  INTEGER  (unix seconds)
 *   - `revoked`     INTEGER  (0/1)
 *
 * **Storage**: in-memory today, `Map<deviceId, DeviceTokenRecord>`.
 * When `@dina/storage-node` lands, a SQLCipher-backed variant
 * implements the same surface. Pattern matches 4.70 / 4.71 / 4.72 /
 * 4.73 / 4.69.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4h task 4.64.
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** 32 bytes = 64 hex chars. Matches Go `TokenLength = 32`. */
export const DEVICE_TOKEN_BYTES = 32;

/** SHA-256 hex digest length. */
export const DEVICE_TOKEN_HASH_HEX_LENGTH = 64;

export type DeviceRole = 'user' | 'agent';

export interface DeviceTokenRecord {
  /** Stable device id, e.g. `dev-1`. Callers choose the format. */
  readonly deviceId: string;
  /** Hex SHA-256 of the raw client token. */
  readonly tokenHash: string;
  readonly deviceName: string;
  readonly role: DeviceRole;
  /** Unix seconds. */
  readonly createdAt: number;
  /** Unix seconds. Updated via `touch()`. */
  lastSeen: number;
  revoked: boolean;
}

export interface DeviceTokenIssueResult {
  readonly deviceId: string;
  /** RAW hex-encoded client token. Show to the device ONCE — never stored. */
  readonly rawToken: string;
  readonly record: DeviceTokenRecord;
}

export type DeviceTokenErrorReason =
  | 'duplicate_device_id'
  | 'invalid_token_format'
  | 'unknown_device';

export class DeviceTokenError extends Error {
  constructor(
    public readonly reason: DeviceTokenErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'DeviceTokenError';
  }
}

export interface DeviceTokenRegistryOptions {
  /** Injectable clock (ms). Default `Date.now`. */
  nowMsFn?: () => number;
  /** Injectable byte source. Default `node:crypto.randomBytes`. */
  randomBytesFn?: (n: number) => Uint8Array;
  /** Id generator. Default `dev-<counter>`; production can pass UUIDv4 or the pairing secret's derived id. */
  idFn?: () => string;
  /** Diagnostic hook. Fires on state transitions. */
  onEvent?: (event: DeviceTokenEvent) => void;
}

export type DeviceTokenEvent =
  | { kind: 'issued'; deviceId: string; role: DeviceRole }
  | { kind: 'revoked'; deviceId: string }
  | { kind: 'touched'; deviceId: string; lastSeen: number };

/**
 * Hash a raw client token into its persisted form.
 *
 * Pure function. The Bearer-auth handler calls this on every request
 * against the user-supplied token, then looks up the result. Never
 * compare raw tokens — always compare hashes.
 */
export function hashDeviceToken(rawToken: string): string {
  if (typeof rawToken !== 'string' || rawToken.length === 0) {
    throw new DeviceTokenError(
      'invalid_token_format',
      'hashDeviceToken: rawToken must be a non-empty string',
    );
  }
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export class DeviceTokenRegistry {
  private readonly devices = new Map<string, DeviceTokenRecord>();
  private readonly nowMsFn: () => number;
  private readonly randomBytesFn: (n: number) => Uint8Array;
  private readonly idFn: () => string;
  private readonly onEvent?: (event: DeviceTokenEvent) => void;
  private idCounter = 0;

  constructor(opts: DeviceTokenRegistryOptions = {}) {
    this.nowMsFn = opts.nowMsFn ?? Date.now;
    this.randomBytesFn = opts.randomBytesFn ?? defaultRandomBytes;
    this.idFn =
      opts.idFn ??
      (() => {
        this.idCounter += 1;
        return `dev-${this.idCounter}`;
      });
    this.onEvent = opts.onEvent;
  }

  /**
   * Issue a new device token. Returns the raw token (show to device
   * once) + the stored record (only the hash is retained).
   *
   * If `deviceId` is supplied the registry uses it verbatim and
   * throws `duplicate_device_id` on conflict; otherwise `idFn()`
   * mints one.
   */
  issue(input: {
    deviceName: string;
    role?: DeviceRole;
    deviceId?: string;
  }): DeviceTokenIssueResult {
    const deviceId = input.deviceId ?? this.idFn();
    if (this.devices.has(deviceId)) {
      throw new DeviceTokenError(
        'duplicate_device_id',
        `DeviceTokenRegistry.issue: deviceId ${JSON.stringify(deviceId)} already exists`,
      );
    }

    const rawBytes = this.randomBytesFn(DEVICE_TOKEN_BYTES);
    if (rawBytes.length !== DEVICE_TOKEN_BYTES) {
      throw new Error(
        `DeviceTokenRegistry.issue: randomBytesFn returned ${rawBytes.length} bytes, expected ${DEVICE_TOKEN_BYTES}`,
      );
    }
    const rawToken = bytesToHex(rawBytes);
    const tokenHash = hashDeviceToken(rawToken);

    const nowSec = Math.floor(this.nowMsFn() / 1000);
    const record: DeviceTokenRecord = {
      deviceId,
      tokenHash,
      deviceName: input.deviceName,
      role: input.role ?? 'user',
      createdAt: nowSec,
      lastSeen: nowSec,
      revoked: false,
    };
    this.devices.set(deviceId, record);
    this.onEvent?.({ kind: 'issued', deviceId, role: record.role });
    return { deviceId, rawToken, record };
  }

  /**
   * Verify a raw token. Returns the matching record when a live,
   * non-revoked device uses it; otherwise `undefined`. Constant-time
   * comparison is delegated to `crypto.timingSafeEqual` over the
   * equal-length hex digests.
   *
   * **Does NOT update `lastSeen`** — that's the caller's decision,
   * because the auth middleware knows whether the request actually
   * produced a real handler response (don't refresh lastSeen on a
   * failed rate-limit check).
   */
  verify(rawToken: string): DeviceTokenRecord | undefined {
    let candidateHash: string;
    try {
      candidateHash = hashDeviceToken(rawToken);
    } catch {
      return undefined;
    }
    const candidateBytes = Buffer.from(candidateHash, 'hex');
    if (candidateBytes.length !== 32) return undefined;
    // Walking the map is O(devices), typically <50. Constant-time
    // per-device compare means we don't short-circuit on a mismatch,
    // so per-device cost is constant. Total cost is still bounded +
    // way cheaper than any of the crypto primitives the handler will
    // run afterwards.
    let match: DeviceTokenRecord | undefined;
    for (const record of this.devices.values()) {
      if (record.revoked) continue;
      const storedBytes = Buffer.from(record.tokenHash, 'hex');
      if (storedBytes.length !== 32) continue;
      if (timingSafeEqual(candidateBytes, storedBytes)) {
        match = record;
        // Intentionally NO break — keep iterating so total work is
        // input-shape-dependent only (count of records), not on
        // which record matched. Matches OWASP's timing-safe lookup.
      }
    }
    return match;
  }

  /**
   * Revoke a device. Returns true if a record was flipped from
   * live→revoked. Idempotent: revoking an already-revoked device
   * returns false. Unknown device throws `unknown_device` so the
   * caller can surface a clean 404 — silently succeeding would hide
   * typos in the deviceId from the operator.
   */
  revoke(deviceId: string): boolean {
    const record = this.devices.get(deviceId);
    if (record === undefined) {
      throw new DeviceTokenError(
        'unknown_device',
        `DeviceTokenRegistry.revoke: device ${JSON.stringify(deviceId)} not found`,
      );
    }
    if (record.revoked) return false;
    record.revoked = true;
    this.onEvent?.({ kind: 'revoked', deviceId });
    return true;
  }

  /** Update `lastSeen` to the current clock. Throws on unknown device. */
  touch(deviceId: string): void {
    const record = this.devices.get(deviceId);
    if (record === undefined) {
      throw new DeviceTokenError(
        'unknown_device',
        `DeviceTokenRegistry.touch: device ${JSON.stringify(deviceId)} not found`,
      );
    }
    record.lastSeen = Math.floor(this.nowMsFn() / 1000);
    this.onEvent?.({ kind: 'touched', deviceId, lastSeen: record.lastSeen });
  }

  /** Fetch a device record by id (no token check). Undefined on unknown. */
  get(deviceId: string): DeviceTokenRecord | undefined {
    return this.devices.get(deviceId);
  }

  /**
   * List live (non-revoked) devices. Useful for `/v1/pair/list` +
   * admin UI. Ordering: createdAt ascending (oldest first).
   */
  listLive(): DeviceTokenRecord[] {
    const out: DeviceTokenRecord[] = [];
    for (const record of this.devices.values()) {
      if (!record.revoked) out.push(record);
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  /** List every device (revoked included). Ordering: createdAt asc. */
  listAll(): DeviceTokenRecord[] {
    return Array.from(this.devices.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Count of records in memory (live + revoked). */
  size(): number {
    return this.devices.size;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultRandomBytes(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}
