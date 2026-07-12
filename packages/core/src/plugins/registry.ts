/**
 * Plugin install registry — the per-node dynamic registry
 * (PLUGIN_ARCHITECTURE.md §6, migration v18).
 *
 * `install_id` is the stable local anchor: lane (`plugin:<install_id>`),
 * vault, grants, config, and the decision log all hang off it.
 * `(publisherDid, pluginId)` is IDENTITY — what updates, advisories,
 * and trust attach to — and deliberately NOT unique (multi-install is
 * legitimate). `currentCid` is version state ON the row, never the key:
 * an update must not orphan grants, config, or the vault, and under
 * this keying it structurally cannot.
 *
 * Lifecycle (§14): `pending` (install started, awaiting pairing +
 * consent) → `active` (the single atomic commit point) → `paused` /
 * back → gone (uninstall deletes the row; grants cascade). Restore
 * brings installs back `paused` pending re-pair + re-consent. The
 * abandoned-install sweeper expires stale pendings AND surfaces their
 * device DIDs so the caller can `revokeDeviceDurable` them — a
 * paired-but-never-activated device must not outlive its install.
 *
 * **Sync-by-design** — same rationale as ServiceGrantRepository.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';
import type { PluginManifest, PluginTrustAnchor } from '@dina/protocol';

export type PluginInstallStatus = 'pending' | 'active' | 'paused' | 'revoked';
export type PluginPendingDecision = 'awaiting_consent' | 'awaiting_behavior_approval';

export interface PluginInstall {
  installId: string;
  publisherDid: string;
  pluginId: string;
  /** Owner label — required by UI when identity count > 1 (§15). */
  label: string;
  status: PluginInstallStatus;
  executionMode: 'interpreted' | 'runner';
  currentCid: string;
  currentVersion: string;
  /** The pinned NORMALIZED manifest — the stored form (§8.1). */
  manifest: PluginManifest;
  installScopeHash: string;
  /** capability id → approved_scope_hash. */
  capabilityHashes: Record<string, string>;
  behaviorHash: string;
  presentationHash: string;
  trustAnchor: PluginTrustAnchor;
  /** Runner instance device DID; undefined until pairing attaches it. */
  deviceDid?: string;
  /** Bumped on every config save; claim check six pins it (§9.1/§14). */
  configRevision: number;
  pendingCid?: string;
  pendingBehaviorHash?: string;
  pendingDecision?: PluginPendingDecision;
  /** Pending-install expiry (unix seconds) for the abandoned sweeper. */
  pendingExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PluginInstallRepository {
  /** Mint a `pending` install row. Returns the new install_id. */
  createPending(args: {
    publisherDid: string;
    pluginId: string;
    label: string;
    executionMode: 'interpreted' | 'runner';
    currentCid: string;
    currentVersion: string;
    manifest: PluginManifest;
    installScopeHash: string;
    capabilityHashes: Record<string, string>;
    behaviorHash: string;
    presentationHash: string;
    trustAnchor: PluginTrustAnchor;
    pendingExpiresAtSec: number;
    nowMs: number;
  }): string;

  getById(installId: string): PluginInstall | null;
  getByDeviceDid(deviceDid: string): PluginInstall | null;
  /**
   * P1-3: EVERY install bound to a device DID — active, paused, AND pending.
   * `getByDeviceDid` returns only the single active/oldest row, so device
   * revocation that walked one row left the OTHER installs co-bound to the
   * same DID still authorized (the v19 partial unique index constrains only
   * `active`, so paused/pending duplicates are legal). Revocation must disable
   * them all. Ordered active-first for deterministic handling.
   */
  listByDeviceDid(deviceDid: string): PluginInstall[];
  listByIdentity(publisherDid: string, pluginId: string): PluginInstall[];
  list(): PluginInstall[];

  /**
   * Attach the instance device to a PENDING install during the pairing
   * leg, BEFORE consent (§14). Without this, a device paired but whose
   * consent is later declined or expires has no `device_did` on its
   * pending row, so decline/sweep cannot revoke it (orphan plugin
   * device). Returns false unless the row is still `pending`.
   */
  bindPendingDevice(installId: string, deviceDid: string, nowMs: number): boolean;

  /**
   * The single atomic commit point (§14): attach the instance device
   * (runner mode; interpreted passes undefined) and flip
   * pending → active. Returns false unless the row was `pending`.
   */
  activate(installId: string, deviceDid: string | undefined, nowMs: number): boolean;

  /** active → paused. Lane stops accepting at the claim guard. */
  pause(installId: string, nowMs: number): boolean;
  /** paused → active. */
  resume(installId: string, nowMs: number): boolean;

  /**
   * Uninstall/revoke: delete the row plus its grants, uses, and stats
   * in one transaction (explicit cascade — the adapter does not enable
   * PRAGMA foreign_keys). Returns the deleted row so the caller can
   * revoke the device + purge the plugin vault. Decision-log rows
   * survive: records of the past, not authority.
   */
  remove(installId: string): PluginInstall | null;

  /** Bump config_revision (every config save, §14). Returns new revision or 0. */
  bumpConfigRevision(installId: string, nowMs: number): number;

  /** Record a pending update (§14 dual boundary). */
  setPendingUpdate(
    installId: string,
    args: { cid: string; behaviorHash: string; decision: PluginPendingDecision },
    nowMs: number,
  ): boolean;

  /**
   * Apply an update: new CID/version/manifest/hashes ON THE SAME ROW —
   * grants/config/vault stay anchored to install_id (§6). Clears the
   * pending fields.
   */
  applyUpdate(
    installId: string,
    args: {
      cid: string;
      version: string;
      manifest: PluginManifest;
      installScopeHash: string;
      capabilityHashes: Record<string, string>;
      behaviorHash: string;
      presentationHash: string;
    },
    nowMs: number,
  ): boolean;

  /**
   * Abandoned-install sweep (§14): delete `pending` rows past their
   * expiry and return them — the caller MUST revokeDeviceDurable any
   * attached device, or a paired-but-not-activated device outlives the
   * abandoned install.
   */
  expireStalePending(nowSec: number): PluginInstall[];

  /**
   * P2-11: SELECT (do NOT delete) `pending` rows past their expiry. The
   * sweeper revokes each attached device FIRST and deletes only on success,
   * so a device-revoke failure leaves the row as a retry anchor instead of
   * orphaning the device with nothing left to sweep.
   */
  listStalePending(nowSec: number): PluginInstall[];

  /**
   * Prior invocation count for a capability — the first-N counter (§8).
   * Read BEFORE `evaluatePluginIntent` so the gatekeeper knows whether
   * the first N cards still apply. 0 when never invoked.
   */
  getInvocationCount(installId: string, capability: string): number;

  /**
   * Record one dispatched invocation — increments the first-N counter.
   * Called AFTER a card is approved or a silent dispatch fires, so the
   * count reflects actual invocations, not attempts. Returns the new
   * count.
   */
  recordInvocation(installId: string, capability: string): number;
}

let repo: PluginInstallRepository | null = null;
export function setPluginInstallRepository(r: PluginInstallRepository | null): void {
  repo = r;
}
export function getPluginInstallRepository(): PluginInstallRepository | null {
  return repo;
}

function newInstallId(): string {
  return `pli_${bytesToHex(randomBytes(12))}`;
}

function rowToInstall(r: DBRow): PluginInstall {
  return {
    installId: String(r.install_id),
    publisherDid: String(r.publisher_did),
    pluginId: String(r.plugin_id),
    label: typeof r.label === 'string' ? r.label : '',
    status: String(r.status) as PluginInstallStatus,
    executionMode: String(r.execution_mode) as 'interpreted' | 'runner',
    currentCid: String(r.current_cid),
    currentVersion: String(r.current_version),
    manifest: JSON.parse(String(r.manifest_json)) as PluginManifest,
    installScopeHash: String(r.install_scope_hash),
    capabilityHashes: JSON.parse(String(r.capability_hashes_json)) as Record<string, string>,
    behaviorHash: String(r.behavior_hash),
    presentationHash: String(r.presentation_hash),
    trustAnchor: JSON.parse(String(r.trust_anchor_json)) as PluginTrustAnchor,
    ...(typeof r.device_did === 'string' && r.device_did !== '' ? { deviceDid: r.device_did } : {}),
    configRevision: Number(r.config_revision),
    ...(typeof r.pending_cid === 'string' ? { pendingCid: r.pending_cid } : {}),
    ...(typeof r.pending_behavior_hash === 'string'
      ? { pendingBehaviorHash: r.pending_behavior_hash }
      : {}),
    ...(typeof r.pending_decision === 'string'
      ? { pendingDecision: r.pending_decision as PluginPendingDecision }
      : {}),
    ...(typeof r.pending_expires_at === 'number' ? { pendingExpiresAt: r.pending_expires_at } : {}),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export class SQLitePluginInstallRepository implements PluginInstallRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  createPending(args: Parameters<PluginInstallRepository['createPending']>[0]): string {
    const installId = newInstallId();
    this.db.execute(
      `INSERT INTO plugin_installs (
        install_id, publisher_did, plugin_id, label, status, execution_mode,
        current_cid, current_version, manifest_json, install_scope_hash,
        capability_hashes_json, behavior_hash, presentation_hash,
        trust_anchor_json, device_did, config_revision,
        pending_expires_at, created_at, updated_at
      ) VALUES (?,?,?,?,'pending',?,?,?,?,?,?,?,?,?,NULL,1,?,?,?)`,
      [
        installId,
        args.publisherDid,
        args.pluginId,
        args.label,
        args.executionMode,
        args.currentCid,
        args.currentVersion,
        JSON.stringify(args.manifest),
        args.installScopeHash,
        JSON.stringify(args.capabilityHashes),
        args.behaviorHash,
        args.presentationHash,
        JSON.stringify(args.trustAnchor),
        args.pendingExpiresAtSec,
        args.nowMs,
        args.nowMs,
      ],
    );
    return installId;
  }

  getById(installId: string): PluginInstall | null {
    const rows = this.db.query('SELECT * FROM plugin_installs WHERE install_id = ?', [installId]);
    return rows.length === 0 ? null : rowToInstall(rows[0]);
  }

  getByDeviceDid(deviceDid: string): PluginInstall | null {
    if (deviceDid === '') return null;
    // Deterministic: prefer the ACTIVE install (the one that can serve the
    // lane), then the oldest. The v19 partial unique index guarantees at
    // most one active install per device, so the active-preference is
    // unambiguous; the ORDER BY only disambiguates the impossible-by-
    // constraint case instead of an arbitrary LIMIT 1.
    const rows = this.db.query(
      `SELECT * FROM plugin_installs WHERE device_did = ?
       ORDER BY (status = 'active') DESC, created_at ASC LIMIT 1`,
      [deviceDid],
    );
    return rows.length === 0 ? null : rowToInstall(rows[0]);
  }

  listByDeviceDid(deviceDid: string): PluginInstall[] {
    if (deviceDid === '') return [];
    const rows = this.db.query(
      `SELECT * FROM plugin_installs WHERE device_did = ?
       ORDER BY (status = 'active') DESC, created_at ASC`,
      [deviceDid],
    );
    return rows.map(rowToInstall);
  }

  /**
   * P2-7: does a DIFFERENT install already hold this device DID in the
   * `active` state? The v19 partial unique index enforces one active install
   * per device; a paused/pending → active flip that would violate it THROWS
   * SQLITE_CONSTRAINT_UNIQUE. `activate`/`resume` declare a boolean contract,
   * so they pre-check here and return false rather than letting the write
   * throw. Single-threaded SQLite means no interleaving between this read and
   * the subsequent UPDATE.
   */
  private hasOtherActiveOnDevice(deviceDid: string, exceptInstallId: string): boolean {
    if (deviceDid === '') return false;
    const rows = this.db.query(
      `SELECT install_id FROM plugin_installs
       WHERE device_did = ? AND status = 'active' AND install_id != ? LIMIT 1`,
      [deviceDid, exceptInstallId],
    );
    return rows.length > 0;
  }

  listByIdentity(publisherDid: string, pluginId: string): PluginInstall[] {
    const rows = this.db.query(
      'SELECT * FROM plugin_installs WHERE publisher_did = ? AND plugin_id = ? ORDER BY created_at ASC',
      [publisherDid, pluginId],
    );
    return rows.map(rowToInstall);
  }

  list(): PluginInstall[] {
    const rows = this.db.query('SELECT * FROM plugin_installs ORDER BY created_at ASC');
    return rows.map(rowToInstall);
  }

  bindPendingDevice(installId: string, deviceDid: string, nowMs: number): boolean {
    if (deviceDid === '') return false;
    const affected = this.db.run(
      `UPDATE plugin_installs SET device_did = ?, updated_at = ?
       WHERE install_id = ? AND status = 'pending'`,
      [deviceDid, nowMs, installId],
    );
    return affected > 0;
  }

  activate(installId: string, deviceDid: string | undefined, nowMs: number): boolean {
    // P2-7: refuse (don't throw) if another active install already owns this
    // device — the v19 partial unique index would otherwise raise
    // SQLITE_CONSTRAINT_UNIQUE, breaking the declared boolean contract.
    if (deviceDid !== undefined && this.hasOtherActiveOnDevice(deviceDid, installId)) {
      return false;
    }
    const affected = this.db.run(
      `UPDATE plugin_installs
       SET status = 'active', device_did = ?, pending_expires_at = NULL, updated_at = ?
       WHERE install_id = ? AND status = 'pending'`,
      [deviceDid ?? null, nowMs, installId],
    );
    return affected > 0;
  }

  pause(installId: string, nowMs: number): boolean {
    const affected = this.db.run(
      `UPDATE plugin_installs SET status = 'paused', updated_at = ?
       WHERE install_id = ? AND status = 'active'`,
      [nowMs, installId],
    );
    return affected > 0;
  }

  resume(installId: string, nowMs: number): boolean {
    // P2-7: a paused → active flip whose device DID is already held by another
    // active install would violate the v19 partial unique index and THROW
    // rather than return this method's declared boolean. Pre-check and return
    // false — the owner must resolve the conflicting install first.
    const current = this.getById(installId);
    if (current === null || current.status !== 'paused') return false;
    if (
      current.deviceDid !== undefined &&
      this.hasOtherActiveOnDevice(current.deviceDid, installId)
    ) {
      return false;
    }
    const affected = this.db.run(
      `UPDATE plugin_installs SET status = 'active', updated_at = ?
       WHERE install_id = ? AND status = 'paused'`,
      [nowMs, installId],
    );
    return affected > 0;
  }

  remove(installId: string): PluginInstall | null {
    const existing = this.getById(installId);
    if (existing === null) return null;
    // Explicit cascade: the adapter does not enable PRAGMA foreign_keys,
    // so the schema's ON DELETE CASCADE never fires — deleting only the
    // install row would leave orphaned grants still authorizing an
    // uninstalled plugin. One transaction, grants + uses + stats + row.
    this.db.transaction(() => {
      this.db.execute(
        `DELETE FROM plugin_grant_uses WHERE grant_id IN
           (SELECT grant_id FROM plugin_grants WHERE install_id = ?)`,
        [installId],
      );
      this.db.execute('DELETE FROM plugin_grants WHERE install_id = ?', [installId]);
      this.db.execute('DELETE FROM plugin_capability_stats WHERE install_id = ?', [installId]);
      this.db.execute('DELETE FROM plugin_installs WHERE install_id = ?', [installId]);
    });
    return existing;
  }

  bumpConfigRevision(installId: string, nowMs: number): number {
    const affected = this.db.run(
      `UPDATE plugin_installs SET config_revision = config_revision + 1, updated_at = ?
       WHERE install_id = ?`,
      [nowMs, installId],
    );
    if (affected === 0) return 0;
    return this.getById(installId)?.configRevision ?? 0;
  }

  setPendingUpdate(
    installId: string,
    args: { cid: string; behaviorHash: string; decision: PluginPendingDecision },
    nowMs: number,
  ): boolean {
    const affected = this.db.run(
      `UPDATE plugin_installs
       SET pending_cid = ?, pending_behavior_hash = ?, pending_decision = ?, updated_at = ?
       WHERE install_id = ?`,
      [args.cid, args.behaviorHash, args.decision, nowMs, installId],
    );
    return affected > 0;
  }

  applyUpdate(
    installId: string,
    args: Parameters<PluginInstallRepository['applyUpdate']>[1],
    nowMs: number,
  ): boolean {
    const affected = this.db.run(
      `UPDATE plugin_installs
       SET current_cid = ?, current_version = ?, manifest_json = ?,
           install_scope_hash = ?, capability_hashes_json = ?,
           behavior_hash = ?, presentation_hash = ?,
           pending_cid = NULL, pending_behavior_hash = NULL, pending_decision = NULL,
           updated_at = ?
       WHERE install_id = ?`,
      [
        args.cid,
        args.version,
        JSON.stringify(args.manifest),
        args.installScopeHash,
        JSON.stringify(args.capabilityHashes),
        args.behaviorHash,
        args.presentationHash,
        nowMs,
        installId,
      ],
    );
    return affected > 0;
  }

  expireStalePending(nowSec: number): PluginInstall[] {
    const expired = this.listStalePending(nowSec);
    for (const install of expired) {
      // Same explicit cascade as remove() — pendings shouldn't have
      // grants yet, but a consent flow that minted one before
      // abandoning must not leave it behind.
      this.remove(install.installId);
    }
    return expired;
  }

  listStalePending(nowSec: number): PluginInstall[] {
    const rows = this.db.query(
      `SELECT * FROM plugin_installs
       WHERE status = 'pending' AND pending_expires_at IS NOT NULL AND pending_expires_at <= ?`,
      [nowSec],
    );
    return rows.map(rowToInstall);
  }

  getInvocationCount(installId: string, capability: string): number {
    const rows = this.db.query<{ invocations: number }>(
      'SELECT invocations FROM plugin_capability_stats WHERE install_id = ? AND capability = ?',
      [installId, capability],
    );
    return rows.length > 0 ? Number(rows[0].invocations) : 0;
  }

  recordInvocation(installId: string, capability: string): number {
    // UPSERT: first invocation inserts 1, subsequent bump by 1.
    this.db.execute(
      `INSERT INTO plugin_capability_stats (install_id, capability, invocations)
       VALUES (?, ?, 1)
       ON CONFLICT(install_id, capability)
       DO UPDATE SET invocations = invocations + 1`,
      [installId, capability],
    );
    return this.getInvocationCount(installId, capability);
  }
}
