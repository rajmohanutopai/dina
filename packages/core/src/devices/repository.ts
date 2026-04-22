/**
 * Device SQL repository — backs device registry with SQLite.
 *
 * **Phase 2.3 (task 2.3).** Port methods return `Promise<T>`. SQLite is
 * sync under go-sqlcipher so each implementation returns
 * `Promise.resolve(result)` without microtask overhead beyond one promise
 * per call. Service-layer `registerDevice()` in `devices/registry.ts`
 * stays sync by firing `register()` fire-and-forget — same fail-safe
 * write-through pattern used by `audit/service.ts`.
 *
 * Source: ARCHITECTURE.md — op-sqlite persistence layer
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';
import type { PairedDevice, DeviceRole, AuthType } from './registry';

export interface DeviceRepository {
  register(device: PairedDevice): Promise<void>;
  get(deviceId: string): Promise<PairedDevice | null>;
  getByPublicKey(publicKeyMultibase: string): Promise<PairedDevice | null>;
  getByDID(did: string): Promise<PairedDevice | null>;
  list(): Promise<PairedDevice[]>;
  revoke(deviceId: string): Promise<boolean>;
  touch(deviceId: string, lastSeen: number): Promise<void>;
}

let repo: DeviceRepository | null = null;
export function setDeviceRepository(r: DeviceRepository | null): void {
  repo = r;
}
export function getDeviceRepository(): DeviceRepository | null {
  return repo;
}

export class SQLiteDeviceRepository implements DeviceRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async register(d: PairedDevice): Promise<void> {
    this.db.execute(
      `INSERT INTO paired_devices (device_id, did, public_key_multibase, device_name, role, auth_type, last_seen, created_at, revoked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        d.deviceId,
        d.did,
        d.publicKeyMultibase,
        d.deviceName,
        d.role,
        d.authType,
        d.lastSeen,
        d.createdAt,
        d.revoked ? 1 : 0,
      ],
    );
  }

  async get(deviceId: string): Promise<PairedDevice | null> {
    const rows = this.db.query('SELECT * FROM paired_devices WHERE device_id = ?', [deviceId]);
    return rows.length > 0 ? rowToDevice(rows[0]) : null;
  }

  async getByPublicKey(publicKeyMultibase: string): Promise<PairedDevice | null> {
    const rows = this.db.query('SELECT * FROM paired_devices WHERE public_key_multibase = ?', [
      publicKeyMultibase,
    ]);
    return rows.length > 0 ? rowToDevice(rows[0]) : null;
  }

  async getByDID(did: string): Promise<PairedDevice | null> {
    const rows = this.db.query('SELECT * FROM paired_devices WHERE did = ?', [did]);
    return rows.length > 0 ? rowToDevice(rows[0]) : null;
  }

  async list(): Promise<PairedDevice[]> {
    return this.db.query('SELECT * FROM paired_devices').map(rowToDevice);
  }

  async revoke(deviceId: string): Promise<boolean> {
    const existing = this.db.query('SELECT 1 FROM paired_devices WHERE device_id = ?', [deviceId]);
    if (existing.length === 0) return false;
    this.db.execute('UPDATE paired_devices SET revoked = 1 WHERE device_id = ?', [deviceId]);
    return true;
  }

  async touch(deviceId: string, lastSeen: number): Promise<void> {
    this.db.execute('UPDATE paired_devices SET last_seen = ? WHERE device_id = ?', [
      lastSeen,
      deviceId,
    ]);
  }
}

function rowToDevice(row: DBRow): PairedDevice {
  return {
    deviceId: String(row.device_id ?? ''),
    did: String(row.did ?? ''),
    publicKeyMultibase: String(row.public_key_multibase ?? ''),
    deviceName: String(row.device_name ?? ''),
    role: String(row.role ?? 'rich') as DeviceRole,
    authType: String(row.auth_type ?? 'ed25519') as AuthType,
    lastSeen: Number(row.last_seen ?? 0),
    createdAt: Number(row.created_at ?? 0),
    revoked: Number(row.revoked ?? 0) === 1,
  };
}
