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

import { resolveAgentScope } from '../auth/agent_scope';

import type { PairedDevice, DeviceRole, AuthType } from './registry';
import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

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
    // INSERT OR REPLACE — idempotent on `device_id` (the PK). The pairing
    // route calls this TWICE for the same device by design: once
    // fire-and-forget from `registerDevice()` (so callers stay sync) and
    // once awaited from `persistDeviceDurable()` (so the route blocks on
    // durability before returning 201). On a sync better-sqlite3 host the
    // two INSERTs serialise via micro-task order and the second one would
    // SQLITE_CONSTRAINT-fail; on op-sqlite (async-bridged on mobile) the
    // ordering's the same end-to-end but the failure was surfacing as
    // `UNIQUE constraint failed: paired_devices.device_id` to the agent
    // (MT-2026-05-28-E-BUG1). The row contents are deterministic per
    // device (no auto-updated columns), so REPLACE with identical values
    // is a semantic no-op for the first writer and a clean upsert for
    // any same-row retry.
    this.db.execute(
      `INSERT OR REPLACE INTO paired_devices (device_id, did, public_key_multibase, device_name, role, scope, auth_type, last_seen, created_at, revoked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        d.deviceId,
        d.did,
        d.publicKeyMultibase,
        d.deviceName,
        d.role,
        d.scope ?? null,
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
    // Round-12 #4: drop rows whose role quarantined (rowToDevice → null) so a
    // corrupt-role device never enters the in-memory registry on hydration.
    return this.db
      .query('SELECT * FROM paired_devices')
      .map(rowToDevice)
      .filter((d): d is PairedDevice => d !== null);
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

/** The valid persisted device roles (DeviceRole). A row carrying anything else
 *  is corrupt / from a newer schema / tampered. */
const VALID_DEVICE_ROLES = new Set<DeviceRole>(['rich', 'thin', 'cli', 'agent', 'plugin', 'staff']);

/**
 * Round-12 #4: QUARANTINE a row whose `role` column is not a known DeviceRole
 * (null returned). Caller resolution buckets every role that isn't exactly
 * `agent`/`plugin` into the broad `device` caller type (vault + approvals
 * access); a corrupt/future/tampered role string would silently land there.
 * Dropping the row at hydration means it never enters the in-memory registry,
 * so the role resolver returns null and the caller fails closed to `unknown`
 * (the Round-6 #7 null-role path) — no `caller_type` change needed. This is
 * distinct from that scoped null-role fallback: this is a resolver that
 * SUCCESSFULLY returns a non-null but invalid role.
 */
function rowToDevice(row: DBRow): PairedDevice | null {
  const role = String(row.role ?? 'rich');
  if (!VALID_DEVICE_ROLES.has(role as DeviceRole)) return null;
  // Item C — a corrupt/unknown scope normalises to undefined (fail-safe: no
  // scope means the coding façades stay denied; the auth layer applies the
  // runner default for an agent/plugin caller).
  const scope = resolveAgentScope(row.scope == null ? null : String(row.scope));
  return {
    deviceId: String(row.device_id ?? ''),
    did: String(row.did ?? ''),
    publicKeyMultibase: String(row.public_key_multibase ?? ''),
    deviceName: String(row.device_name ?? ''),
    role: role as DeviceRole,
    ...(scope !== undefined ? { scope } : {}),
    authType: String(row.auth_type ?? 'ed25519') as AuthType,
    lastSeen: Number(row.last_seen ?? 0),
    createdAt: Number(row.created_at ?? 0),
    // Round-15 #8: fail CLOSED on a non-canonical revoked value. `=== 1` treated
    // 2 / -1 / NaN (schema drift, foreign writer, corruption) as revoked:false,
    // and boot hydration then re-registers that device's auth identity. Treat
    // any non-zero/non-numeric value as revoked; only a clean 0/null is active.
    revoked: Number(row.revoked ?? 0) !== 0,
  };
}
