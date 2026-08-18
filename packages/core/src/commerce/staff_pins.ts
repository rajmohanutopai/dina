/**
 * The staff PIN registry (TRADE_FIRST_STRATEGY §6.4) — the per-device
 * Argon2id record the grant ceremony mints. The PIN unlocks NOTHING in
 * the vault; it proves a person is at that device now, which is exactly
 * what attributed presence needs and nothing more.
 *
 * SAME KDF, LIGHTER PARAMS. Verification runs on a clerk's tap fifty
 * times a day, so the parameters are the interactive tier rather than
 * the seed-wrapping tier — and they are STORED PER RECORD (the
 * wrapped-seed discipline), so tuning the defaults later never breaks a
 * PIN minted under the old ones.
 *
 * The verifier itself is INSTALLED BY THE COMMERCE RUNTIME (see
 * `runtime.ts`): one composition, both boots, no root left to forget it
 * — the exact failure the probing-ledger install there already guards
 * against.
 */

import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import { deriveKEK } from '../crypto/argon2id';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

/** Interactive-tier Argon2id: ~19 MiB, 2 passes — a tap, not a vault. */
export const STAFF_PIN_PARAMS = { memory: 19456, iterations: 2, parallelism: 1 } as const;

/** A PIN is short by nature; refuse the degenerate ones. */
export const MIN_STAFF_PIN_LENGTH = 4;

/**
 * §6.4 brute-force posture: a 4-character PIN behind Argon2id alone
 * falls in hours to a patient attacker holding the device key. Five
 * failures lock the device's PIN for five minutes — durable (v41), so
 * a reboot never resets the clock. Success clears the counter.
 */
export const STAFF_PIN_MAX_FAILURES = 5;
export const STAFF_PIN_LOCKOUT_MS = 5 * 60 * 1000;

export interface StaffPinAttempts {
  failedCount: number;
  lockedUntil: number;
}

export interface StaffPinRecord {
  deviceDid: string;
  saltHex: string;
  hashHex: string;
  memory: number;
  iterations: number;
  parallelism: number;
  createdAt: number;
}

export interface StaffPinRepository {
  /** Set or rotate — a fresh salt every time. */
  put(record: StaffPinRecord): void;
  get(deviceDid: string): StaffPinRecord | null;
  /** Device revocation calls this beside the grant/presence teardown. */
  remove(deviceDid: string): void;
  getAttempts(deviceDid: string): StaffPinAttempts;
  putAttempts(deviceDid: string, attempts: StaffPinAttempts): void;
}

export class SQLiteStaffPinRepository implements StaffPinRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  put(record: StaffPinRecord): void {
    this.db.run(
      `INSERT OR REPLACE INTO commerce_staff_pins
         (device_did, salt_hex, hash_hex, memory, iterations, parallelism, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.deviceDid,
        record.saltHex,
        record.hashHex,
        record.memory,
        record.iterations,
        record.parallelism,
        record.createdAt,
      ],
    );
  }

  get(deviceDid: string): StaffPinRecord | null {
    const rows = this.db.query<DBRow>(
      `SELECT * FROM commerce_staff_pins WHERE device_did = ?`,
      [deviceDid],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      deviceDid: String(row.device_did),
      saltHex: String(row.salt_hex),
      hashHex: String(row.hash_hex),
      memory: Number(row.memory),
      iterations: Number(row.iterations),
      parallelism: Number(row.parallelism),
      createdAt: Number(row.created_at),
    };
  }

  remove(deviceDid: string): void {
    this.db.run(`DELETE FROM commerce_staff_pins WHERE device_did = ?`, [deviceDid]);
    this.db.run(`DELETE FROM commerce_staff_pin_attempts WHERE device_did = ?`, [deviceDid]);
  }

  getAttempts(deviceDid: string): StaffPinAttempts {
    const rows = this.db.query<DBRow>(
      `SELECT failed_count, locked_until FROM commerce_staff_pin_attempts WHERE device_did = ?`,
      [deviceDid],
    );
    const row = rows[0];
    return row === undefined
      ? { failedCount: 0, lockedUntil: 0 }
      : { failedCount: Number(row.failed_count), lockedUntil: Number(row.locked_until) };
  }

  putAttempts(deviceDid: string, attempts: StaffPinAttempts): void {
    this.db.run(
      `INSERT OR REPLACE INTO commerce_staff_pin_attempts (device_did, failed_count, locked_until)
       VALUES (?, ?, ?)`,
      [deviceDid, attempts.failedCount, attempts.lockedUntil],
    );
  }
}

/** Test double. A production caller would be the bug. */
export class InMemoryStaffPinRepository implements StaffPinRepository {
  private readonly rows = new Map<string, StaffPinRecord>();

  put(record: StaffPinRecord): void {
    this.rows.set(record.deviceDid, { ...record });
  }

  get(deviceDid: string): StaffPinRecord | null {
    const row = this.rows.get(deviceDid);
    return row === undefined ? null : { ...row };
  }

  remove(deviceDid: string): void {
    this.rows.delete(deviceDid);
    this.attempts.delete(deviceDid);
  }

  private readonly attempts = new Map<string, StaffPinAttempts>();

  getAttempts(deviceDid: string): StaffPinAttempts {
    return this.attempts.get(deviceDid) ?? { failedCount: 0, lockedUntil: 0 };
  }

  putAttempts(deviceDid: string, attempts: StaffPinAttempts): void {
    this.attempts.set(deviceDid, { ...attempts });
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Mint (or rotate) a device's PIN record. Fresh salt every time. */
export async function setStaffPin(
  repository: StaffPinRepository,
  deviceDid: string,
  pin: string,
  nowMs: number,
): Promise<{ ok: true } | { ok: false; refusal: string }> {
  if (deviceDid === '') return { ok: false, refusal: 'staff pin: device is required' };
  if (pin.length < MIN_STAFF_PIN_LENGTH) {
    return { ok: false, refusal: `staff pin: at least ${String(MIN_STAFF_PIN_LENGTH)} characters` };
  }
  const salt = randomBytes(16);
  const hash = await deriveKEK(pin, salt, STAFF_PIN_PARAMS);
  repository.put({
    deviceDid,
    saltHex: bytesToHex(salt),
    hashHex: bytesToHex(hash),
    memory: STAFF_PIN_PARAMS.memory,
    iterations: STAFF_PIN_PARAMS.iterations,
    parallelism: STAFF_PIN_PARAMS.parallelism,
    createdAt: nowMs,
  });
  return { ok: true };
}

/**
 * Verify a PIN against the stored record — under the record's OWN
 * params, constant-time on the digest compare. False for a missing
 * record: a caller must not be able to tell "no PIN" from "wrong PIN".
 */
/**
 * The verify the runtime INSTALLS: the lockout wraps the KDF check, so
 * a stolen device key cannot walk the 4-character space. `false` for a
 * locked device — indistinguishable from a wrong PIN by design.
 */
export async function verifyStaffPinGated(
  repository: StaffPinRepository,
  deviceDid: string,
  pin: string,
  nowMs: number,
): Promise<boolean> {
  const attempts = repository.getAttempts(deviceDid);
  if (attempts.lockedUntil > nowMs) return false;
  const ok = await verifyStaffPin(repository, deviceDid, pin);
  if (ok) {
    if (attempts.failedCount > 0 || attempts.lockedUntil > 0) {
      repository.putAttempts(deviceDid, { failedCount: 0, lockedUntil: 0 });
    }
    return true;
  }
  const failedCount = attempts.failedCount + 1;
  repository.putAttempts(
    deviceDid,
    failedCount >= STAFF_PIN_MAX_FAILURES
      ? { failedCount: 0, lockedUntil: nowMs + STAFF_PIN_LOCKOUT_MS }
      : { failedCount, lockedUntil: 0 },
  );
  return false;
}

export async function verifyStaffPin(
  repository: StaffPinRepository,
  deviceDid: string,
  pin: string,
): Promise<boolean> {
  const record = repository.get(deviceDid);
  if (record === null || pin === '') return false;
  const derived = await deriveKEK(pin, hexToBytes(record.saltHex), {
    memory: record.memory,
    iterations: record.iterations,
    parallelism: record.parallelism,
  });
  const expected = hexToBytes(record.hashHex);
  if (derived.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < derived.length; i += 1) diff |= (derived[i] ?? 0) ^ (expected[i] ?? 0);
  return diff === 0;
}
