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

import { isValidTrustAnchor } from '@dina/protocol';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';
import type { PluginManifest, PluginTrustAnchor } from '@dina/protocol';

export type PluginInstallStatus = 'pending' | 'active' | 'paused' | 'revoked';
export type PluginPendingDecision = 'awaiting_consent' | 'awaiting_behavior_approval';

/**
 * Round-9 #16: WHY an install is paused. `manual` (owner-initiated) is plainly
 * resumable; `device_revoked` / `restore` / `advisory` are holds that require a
 * specific recovery flow (re-pair / re-consent / advisory resolution), so a
 * plain `resume` must refuse them. `null` reason (legacy / unset) is treated as
 * owner-resumable.
 */
export type PluginPauseReason = 'manual' | 'device_revoked' | 'restore' | 'advisory';

/** Pause reasons a plain `resume` may reactivate. Others need a recovery flow. */
const RESUMABLE_PAUSE_REASONS = new Set<PluginPauseReason>(['manual']);

/**
 * Round-10 #14: minimal identity of an install for AUTHORITY CLEANUP — only the
 * scalar columns needed to pause/remove + grant-revoke, none of which need
 * `JSON.parse`. Lets revocation act on a row even if its manifest JSON is
 * corrupt (which quarantines it out of the full `PluginInstall` mapper).
 */
export interface PluginInstallRef {
  installId: string;
  status: PluginInstallStatus;
  /** Present on raw enumerations that also carry the device binding (the
   *  stale-pending sweep needs it to revoke the orphan device). */
  deviceDid?: string;
}

/**
 * Round-9 #17: optimistic-concurrency expectations for a write. Any field set
 * is ANDed into the UPDATE's WHERE so the write only lands if the row still
 * matches what the caller last read; a stale caller gets `false`, not a
 * silent clobber. All fields optional — pass what you can pin.
 */
export interface PluginInstallCas {
  configRevision?: number;
  status?: PluginInstallStatus;
  currentCid?: string;
  /**
   * Round-10 #17: `undefined` = don't check; a string = `pending_cid = ?`;
   * explicit `null` = `pending_cid IS NULL` (so a first-pending-update creation
   * can assert nothing is pending yet, guarding against a concurrent second
   * discovery). The `undefined` vs `null` distinction is the whole point.
   */
  pendingCid?: string | null;
}

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
  /** Round-9 #16: why the install is paused (undefined unless status=paused). */
  pauseReason?: PluginPauseReason;
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
  /**
   * Round-10 #14: authority cleanup (device revoke / sweep) must see EVERY row
   * bound to a device — including one whose JSON columns are corrupt, which
   * `listByDeviceDid` quarantines OUT (round-9 #19). Reads only stable scalar
   * columns (no JSON.parse), so a semantically-broken row can still be
   * paused/removed and its grants revoked instead of escaping revocation.
   */
  listRawByDeviceDid(deviceDid: string): PluginInstallRef[];
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

  /**
   * active → paused. Lane stops accepting at the claim guard. Round-9 #16:
   * records WHY (default `manual`) so `resume` can distinguish an owner pause
   * from a device-revoke / restore / advisory hold.
   */
  pause(installId: string, nowMs: number, reason?: PluginPauseReason): boolean;
  /**
   * Round-10 #5: escalate an ALREADY-paused install's hold reason (`pause` only
   * touches active rows, so a device revoke over a manually-paused install would
   * otherwise leave it `manual`+resumable). Only upgrades a `null`/`manual` hold
   * — never downgrades a stronger one. Returns true if it changed.
   */
  escalatePauseReason(installId: string, reason: PluginPauseReason, nowMs: number): boolean;
  /**
   * PLG-27 #4: pending → revoked tombstone. `pause` (active-only) and
   * `escalatePauseReason` (paused-only) both no-op on a PENDING install, so a
   * pending install bound to a device that fails/lacks durable revocation during
   * uninstall stays `pending` — and `activate`'s `status='pending'` CAS
   * (confirmConsent) can still bring it live AFTER the owner uninstalled it.
   * Flipping it to `revoked` makes `activate` and `resume` refuse it while the
   * teardown's raw-status probe + `remove` still fire. No-op for non-pending
   * rows. Returns true if it changed a row.
   */
  markRevoked(installId: string, nowMs: number): boolean;
  /**
   * paused → active. Round-9 #16: a plain resume only reactivates an
   * owner-initiated (`manual`) or legacy (null) pause. A `device_revoked` /
   * `restore` / `advisory` hold needs its specific recovery flow (re-pair /
   * re-consent / advisory resolution), so resume returns false for those.
   */
  resume(installId: string, nowMs: number): boolean;

  /**
   * Uninstall/revoke: delete the row plus its grants, uses, and stats
   * in one transaction (explicit cascade — the adapter does not enable
   * PRAGMA foreign_keys). Returns the deleted row so the caller can
   * revoke the device + purge the plugin vault. Decision-log rows
   * survive: records of the past, not authority.
   */
  remove(installId: string): PluginInstall | null;

  /**
   * PLG-29 #10: a status-gated `remove`. Deletes the row + its grants/uses/stats
   * ONLY if the install is still in one of `statuses`, all inside one
   * transaction. The status re-check and the cascade delete are therefore
   * atomic, so a concurrent `activate`/`resume` that made the row live between a
   * caller's earlier status read and this call CANNOT be destroyed — the delete
   * simply no-ops (returns false). Like `remove`, the delete is keyed on
   * install_id (a semantically-corrupt row is still deletable when its raw status
   * matches). Returns true iff the row was deleted.
   */
  removeIfStatus(installId: string, statuses: readonly PluginInstallStatus[]): boolean;

  /** Bump config_revision (every config save, §14). Returns new revision or 0. */
  bumpConfigRevision(installId: string, nowMs: number): number;

  /**
   * Record a pending update (§14 dual boundary). Round-9 #17: an optional
   * `expected` compare-and-swap — when provided, the write only lands if the
   * row still matches (status / config_revision / current_cid), so a stale
   * worker cannot clobber a row whose state moved on. Returns false on a stale
   * mismatch (0 rows).
   */
  setPendingUpdate(
    installId: string,
    args: { cid: string; behaviorHash: string; decision: PluginPendingDecision },
    nowMs: number,
    expected?: PluginInstallCas,
  ): boolean;

  /**
   * Apply an update: new CID/version/manifest/hashes ON THE SAME ROW —
   * grants/config/vault stay anchored to install_id (§6). Clears the
   * pending fields. Round-9 #17: optional `expected` CAS (see setPendingUpdate)
   * so a stale UI/worker cannot overwrite a newer pending release.
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
    expected?: PluginInstallCas,
  ): boolean;

  /**
   * P2-11: SELECT (do NOT delete) `pending` rows past their expiry. The
   * sweeper revokes each attached device FIRST and deletes only on success,
   * so a device-revoke failure leaves the row as a retry anchor instead of
   * orphaning the device with nothing left to sweep.
   *
   * Round-11 #16: the delete-and-return convenience (`expireStalePending`)
   * was REMOVED — it deleted the pending row WITHOUT the device-revoke-first
   * ordering or the pending-only re-check that `sweepAbandonedInstalls`
   * (install_service) enforces, so any caller of it would orphan the attached
   * device. The only correct abandoned-install path is
   * `listStalePending` → revoke device durably → `remove`.
   */
  listStalePending(nowSec: number): PluginInstall[];

  /**
   * Round-12 #11: the RAW (scalar-only, no `JSON.parse`) counterpart of
   * `listStalePending`. `listStalePending` maps through `rowToInstall`, which
   * QUARANTINES a corrupt row to null — so a corrupt abandoned pending (whose
   * device the sweeper must still revoke) is silently dropped and never swept.
   * This returns `install_id` + `status` + `device_did` for every stale pending,
   * corrupt or not, so the sweep can revoke the device and `remove()` the row
   * (which is itself raw-keyed, Round-11 #10).
   */
  listRawStalePending(nowSec: number): PluginInstallRef[];

  /**
   * Round-12 #11/#12: the RAW status of a row (scalar column, no projection),
   * or null when no such row exists. The abandoned-pending sweep and
   * `declineConsent` use it to distinguish, after a durable device revoke,
   * three states a projecting `getById` cannot: row GONE (the revoke cascade
   * already removed the pending row → teardown SUCCEEDED), row ACTIVE (a racing
   * `confirmConsent` → refuse), row still PENDING (remove it ourselves).
   * `getById` returns null for BOTH "gone" and "corrupt-still-present", so it
   * cannot make this distinction.
   */
  rawStatus(installId: string): string | null;

  /**
   * Round-14 #6: the RAW device_did of a row (scalar column, no projection),
   * or null when no such row exists or the column is NULL/empty. Pairs with
   * `rawStatus`: `declineConsent` / `uninstall` fall back to this when a
   * projecting `getById` returns null for a CORRUPT-but-present row (rowToInstall
   * quarantines → null). Without it a quarantined install row with a bound
   * device could never be torn down — stuck forever, orphaning the device.
   */
  rawDeviceDid(installId: string): string | null;

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

/**
 * Round-9 #19: returns `null` for a row whose JSON columns (manifest /
 * capability hashes / trust anchor) are corrupt, instead of throwing. A single
 * damaged row — e.g. from a restore of a divergent node — otherwise throws
 * mid-`.map` and blanks EVERY listing: Settings enumeration, `listByDeviceDid`
 * revoke reconciliation, and the stale-pending sweep would all fail to load any
 * install. Quarantining the bad row lets the healthy ones through; callers
 * filter nulls via `mapInstalls`.
 */
function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Round-11 #9: the enum columns cast in rowToInstall must be MEMBERS of their
// type, not just any string — a restore from a divergent node could carry a
// `status`/`execution_mode`/`pause_reason`/`pending_decision` this node's
// state machine never emits, and casting it into the trusted union misleads
// every downstream `=== 'active'` / `=== 'runner'` comparison.
const VALID_INSTALL_STATUS = new Set<PluginInstallStatus>([
  'pending',
  'active',
  'paused',
  'revoked',
]);
const VALID_EXECUTION_MODE = new Set(['interpreted', 'runner']);
const VALID_PAUSE_REASON = new Set<PluginPauseReason>([
  'manual',
  'device_revoked',
  'restore',
  'advisory',
]);
const VALID_PENDING_DECISION = new Set<PluginPendingDecision>([
  'awaiting_consent',
  'awaiting_behavior_approval',
]);

function rowToInstall(r: DBRow): PluginInstall | null {
  try {
    const manifest = JSON.parse(String(r.manifest_json)) as PluginManifest;
    const capabilityHashes = JSON.parse(String(r.capability_hashes_json)) as Record<string, string>;
    const trustAnchor = JSON.parse(String(r.trust_anchor_json)) as PluginTrustAnchor;
    const configRevision = Number(r.config_revision);
    // Round-10 #13: reject SEMANTIC corruption too — a row that parses cleanly
    // but is the wrong SHAPE (`manifest_json='null'`, array-shaped hashes, a
    // trust anchor with no `kind`, a non-finite revision) would otherwise be
    // cast into trusted types and crash claim/install consumers later.
    // Quarantine it identically to a syntax error (return null).
    if (
      !isPlainObj(manifest) ||
      !Array.isArray((manifest as { capabilities?: unknown }).capabilities) ||
      !isPlainObj(capabilityHashes) ||
      // Round-13 #16: the trust anchor must be a VALID discriminated union — an
      // unknown kind, or org_key/local_publisher_key missing its required field,
      // is corrupt authority, not just "an object with a string kind".
      !isValidTrustAnchor(trustAnchor) ||
      // Round-13 #23: config_revision feeds CAS compare/increment — it must be a
      // positive integer, not merely finite (Number.isFinite admitted -5 / 0.7).
      !Number.isInteger(configRevision) ||
      configRevision < 1
    ) {
      return null;
    }
    // Round-13 #23: the timestamp columns drive the stale-pending sweep and audit
    // ordering — a NaN/negative/fractional value must not hydrate into a trusted
    // install. created_at/updated_at are non-negative integer epochs; a present
    // pending_expires_at must be a non-negative integer too.
    const createdAtNum = Number(r.created_at);
    const updatedAtNum = Number(r.updated_at);
    if (
      !Number.isInteger(createdAtNum) ||
      createdAtNum < 0 ||
      !Number.isInteger(updatedAtNum) ||
      updatedAtNum < 0 ||
      (r.pending_expires_at !== null &&
        r.pending_expires_at !== undefined &&
        (!Number.isInteger(Number(r.pending_expires_at)) || Number(r.pending_expires_at) < 0))
    ) {
      return null;
    }
    // Round-11 #9: go one level deeper than "is an array/object". A capability
    // element that isn't a `{ id: string }` object, a capability-hash map whose
    // values aren't all strings, or an enum column outside its type would each
    // parse and cast cleanly yet corrupt a later `find(c => c.id === …)`,
    // scope-hash lookup, or status comparison. Quarantine identically (null).
    const caps = (manifest as { capabilities: readonly unknown[] }).capabilities;
    if (caps.some((c) => !isPlainObj(c) || typeof (c as { id?: unknown }).id !== 'string')) {
      return null;
    }
    if (Object.values(capabilityHashes).some((h) => typeof h !== 'string')) {
      return null;
    }
    if (
      !VALID_INSTALL_STATUS.has(String(r.status) as PluginInstallStatus) ||
      !VALID_EXECUTION_MODE.has(String(r.execution_mode)) ||
      (typeof r.pause_reason === 'string' &&
        !VALID_PAUSE_REASON.has(r.pause_reason as PluginPauseReason)) ||
      (typeof r.pending_decision === 'string' &&
        !VALID_PENDING_DECISION.has(r.pending_decision as PluginPendingDecision))
    ) {
      return null;
    }
    // Round-12 #8: the SCALAR identity columns must agree with the pinned
    // manifest. The manifest is the consent/code snapshot; a row whose
    // `plugin_id` / `current_version` / `execution_mode` columns disagree with
    // `manifest.plugin_id` / `.version` / `.execution.mode` is internally
    // inconsistent (a divergent-node restore or a crafted archive), and the
    // claim guard trusts these columns as authority. Quarantine on any mismatch
    // — the same fail-closed posture as the shape/enum checks above. (The
    // archive import filter enforces the mirror of this on restore, #9.)
    const mExecMode = (manifest as { execution?: { mode?: unknown } }).execution?.mode;
    if (
      (manifest as { plugin_id?: unknown }).plugin_id !== String(r.plugin_id) ||
      (manifest as { version?: unknown }).version !== String(r.current_version) ||
      mExecMode !== String(r.execution_mode)
    ) {
      return null;
    }
    return {
      installId: String(r.install_id),
      publisherDid: String(r.publisher_did),
      pluginId: String(r.plugin_id),
      label: typeof r.label === 'string' ? r.label : '',
      status: String(r.status) as PluginInstallStatus,
      executionMode: String(r.execution_mode) as 'interpreted' | 'runner',
      currentCid: String(r.current_cid),
      currentVersion: String(r.current_version),
      manifest,
      installScopeHash: String(r.install_scope_hash),
      capabilityHashes,
      behaviorHash: String(r.behavior_hash),
      presentationHash: String(r.presentation_hash),
      trustAnchor,
      ...(typeof r.device_did === 'string' && r.device_did !== ''
        ? { deviceDid: r.device_did }
        : {}),
      configRevision,
      ...(typeof r.pause_reason === 'string'
        ? { pauseReason: r.pause_reason as PluginPauseReason }
        : {}),
      ...(typeof r.pending_cid === 'string' ? { pendingCid: r.pending_cid } : {}),
      ...(typeof r.pending_behavior_hash === 'string'
        ? { pendingBehaviorHash: r.pending_behavior_hash }
        : {}),
      ...(typeof r.pending_decision === 'string'
        ? { pendingDecision: r.pending_decision as PluginPendingDecision }
        : {}),
      // Round-14 #17: project from the COERCED value, mirroring createdAt /
      // updatedAt. The validation gate above admits a string-typed
      // pending_expires_at (it checks `Number.isInteger(Number(...))`), but a
      // `typeof === 'number'` projection would drop that string — the pending
      // update would then read as having NO expiry and never lapse. Use the
      // same numeric coercion the gate validated against.
      ...(r.pending_expires_at !== null && r.pending_expires_at !== undefined
        ? { pendingExpiresAt: Number(r.pending_expires_at) }
        : {}),
      createdAt: createdAtNum,
      updatedAt: updatedAtNum,
    };
  } catch {
    return null;
  }
}

/** Map DB rows to installs, dropping any that quarantined (round-9 #19). */
function mapInstalls(rows: readonly DBRow[]): PluginInstall[] {
  return rows.map(rowToInstall).filter((x): x is PluginInstall => x !== null);
}

/**
 * PLG-29 #8: a UNIQUE-index violation surfaced by the SQLite adapter. The
 * device-scoped partial indexes (`uq_plugin_installs_active_device` /
 * `_pending_device`) turn a read-then-write bind/activate/resume race into a DB
 * error on the loser; `bindPendingDevice` / `activate` / `resume` declare a
 * boolean contract, so they catch this and return `false` instead of throwing
 * the raw constraint. better-sqlite3 tags `.code = 'SQLITE_CONSTRAINT_UNIQUE'`;
 * op-sqlite (mobile) surfaces the canonical `UNIQUE constraint failed` message —
 * match either so the guard holds on both runtimes.
 */
function isUniqueConstraintError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  // PLG-30 #13: match ONLY genuine uniqueness collisions. The old
  // `startsWith('SQLITE_CONSTRAINT')` also swallowed CHECK / NOT NULL / FOREIGN
  // KEY / TRIGGER failures — real corruption or programming errors — silently
  // converting them to the "expected CAS collision" false and masking them. A
  // UNIQUE (or its PRIMARY KEY special case) violation is the only race these
  // guarded writes anticipate; anything else must still throw.
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  // op-sqlite (mobile) surfaces the canonical message rather than a subtype code.
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /UNIQUE constraint failed/i.test(message);
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
    return mapInstalls(rows);
  }

  listRawByDeviceDid(deviceDid: string): PluginInstallRef[] {
    if (deviceDid === '') return [];
    // Round-10 #14: scalar columns only — no JSON.parse, so a corrupt row is
    // still enumerated for authority cleanup (revoke/pause + grant-revoke).
    const rows = this.db.query(
      `SELECT install_id, status FROM plugin_installs WHERE device_did = ?
       ORDER BY (status = 'active') DESC, created_at ASC`,
      [deviceDid],
    );
    return rows.map((r) => ({
      installId: String(r.install_id),
      status: String(r.status) as PluginInstallStatus,
    }));
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

  /**
   * Round-9 #3 + round-10 #8: does a DIFFERENT non-revoked install already hold
   * this device DID? The v19 index constrains only `active`, so nothing at the
   * DB level stops one device from being co-bound to several installs — and
   * device revocation cascades across ALL of them (P1-3), so declining/revoking
   * one takes out the others' runners. `bindPendingDevice` pre-checks here.
   * Round-10 #8: `paused` MUST be included (a paused install keeps its
   * device_did) — round-9 covered active+pending but left the paused hole.
   */
  private hasOtherNonRevokedOnDevice(deviceDid: string, exceptInstallId: string): boolean {
    if (deviceDid === '') return false;
    const rows = this.db.query(
      `SELECT install_id FROM plugin_installs
       WHERE device_did = ? AND status IN ('active','pending','paused') AND install_id != ? LIMIT 1`,
      [deviceDid, exceptInstallId],
    );
    return rows.length > 0;
  }

  listByIdentity(publisherDid: string, pluginId: string): PluginInstall[] {
    const rows = this.db.query(
      'SELECT * FROM plugin_installs WHERE publisher_did = ? AND plugin_id = ? ORDER BY created_at ASC',
      [publisherDid, pluginId],
    );
    return mapInstalls(rows);
  }

  list(): PluginInstall[] {
    const rows = this.db.query('SELECT * FROM plugin_installs ORDER BY created_at ASC');
    return mapInstalls(rows);
  }

  bindPendingDevice(installId: string, deviceDid: string, nowMs: number): boolean {
    if (deviceDid === '') return false;
    // Round-9 #3 + round-10 #8: one device may not straddle multiple installs.
    // If it already holds another active / pending / PAUSED install, refuse —
    // else declining/revoking that other install would durably revoke the shared
    // device and kill THIS install's runner (cross-install collateral revoke).
    if (this.hasOtherNonRevokedOnDevice(deviceDid, installId)) return false;
    // The `(device_did IS NULL OR device_did = ?)` guard prevents silently
    // overwriting a DIFFERENT already-bound device on this pending row; the same
    // DID re-binds idempotently.
    // PLG-29 #8: the read above and this write are not one atomic step. Under a
    // concurrent bind (a second Core worker), both could pass the read and race
    // to bind the same device to different pending rows. The v19
    // `uq_plugin_installs_pending_device` partial index makes the losing write
    // throw SQLITE_CONSTRAINT_UNIQUE; catch it and honor the boolean contract.
    try {
      const affected = this.db.run(
        `UPDATE plugin_installs SET device_did = ?, updated_at = ?
         WHERE install_id = ? AND status = 'pending'
           AND (device_did IS NULL OR device_did = ?)`,
        [deviceDid, nowMs, installId, deviceDid],
      );
      return affected > 0;
    } catch (err) {
      if (isUniqueConstraintError(err)) return false;
      throw err;
    }
  }

  activate(installId: string, deviceDid: string | undefined, nowMs: number): boolean {
    // P2-7: refuse (don't throw) if another active install already owns this
    // device — the v19 partial unique index would otherwise raise
    // SQLITE_CONSTRAINT_UNIQUE, breaking the declared boolean contract.
    if (deviceDid !== undefined && this.hasOtherActiveOnDevice(deviceDid, installId)) {
      return false;
    }
    // PLG-29 #8: the pre-check + this write are not atomic — a concurrent
    // activate on the same device could slip past the read. The v19
    // `uq_plugin_installs_active_device` index makes the loser throw; catch and
    // return false rather than surface the raw constraint.
    try {
      const affected = this.db.run(
        `UPDATE plugin_installs
         SET status = 'active', device_did = ?, pending_expires_at = NULL, updated_at = ?
         WHERE install_id = ? AND status = 'pending'`,
        [deviceDid ?? null, nowMs, installId],
      );
      return affected > 0;
    } catch (err) {
      if (isUniqueConstraintError(err)) return false;
      throw err;
    }
  }

  pause(installId: string, nowMs: number, reason: PluginPauseReason = 'manual'): boolean {
    const affected = this.db.run(
      `UPDATE plugin_installs SET status = 'paused', pause_reason = ?, updated_at = ?
       WHERE install_id = ? AND status = 'active'`,
      [reason, nowMs, installId],
    );
    return affected > 0;
  }

  escalatePauseReason(installId: string, reason: PluginPauseReason, nowMs: number): boolean {
    // Round-10 #5: upgrade an already-paused install's hold, but only from a
    // resumable (null/manual) reason — never downgrade a stronger existing hold.
    const affected = this.db.run(
      `UPDATE plugin_installs SET pause_reason = ?, updated_at = ?
       WHERE install_id = ? AND status = 'paused'
         AND (pause_reason IS NULL OR pause_reason = 'manual')`,
      [reason, nowMs, installId],
    );
    return affected > 0;
  }

  markRevoked(installId: string, nowMs: number): boolean {
    // PLG-27 #4: tombstone a PENDING install to `revoked` during uninstall so
    // confirmConsent→activate (WHERE status='pending') can never bring it live
    // afterwards. Scoped to `status='pending'` so it never clobbers an active
    // (→paused) or already-revoked row; `pause_reason` is set for parity with the
    // device-revoke hold used on active rows.
    // PLG-28 #3: RETAIN `pending_expires_at` (set it to now, in seconds) rather
    // than nulling it — that way the abandoned-install sweep can still reach this
    // tombstone (it selects on `pending_expires_at`) to FINISH the outstanding
    // device revoke if the uninstall's revoke failed / had no callback. Nulling
    // it (the original PLG-27 #4 behavior) evicted the row from the only automatic
    // retry, orphaning the paired plugin device credential.
    const affected = this.db.run(
      `UPDATE plugin_installs
       SET status = 'revoked', pause_reason = 'device_revoked', pending_expires_at = ?, updated_at = ?
       WHERE install_id = ? AND status = 'pending'`,
      [Math.floor(nowMs / 1000), nowMs, installId],
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
    // Round-9 #16: only an owner-initiated (or legacy null) pause is plainly
    // resumable. A device-revoke / restore / advisory hold requires its recovery
    // flow (re-pair / re-consent / advisory resolution), so refuse here.
    if (current.pauseReason !== undefined && !RESUMABLE_PAUSE_REASONS.has(current.pauseReason)) {
      return false;
    }
    if (
      current.deviceDid !== undefined &&
      this.hasOtherActiveOnDevice(current.deviceDid, installId)
    ) {
      return false;
    }
    // Round-10 #18: fold the reason + device-conflict checks INTO the write
    // predicate (not just the read above), so a hold that escalates
    // pause_reason — or an install that activates on the same device — AFTER
    // the read can't be clobbered back to active by this stale resume. Atomic
    // and future-async-safe (today the sync repo already prevents interleaving).
    // PLG-29 #8: the NOT EXISTS predicate already blocks the common conflict, but
    // a concurrent activate committing between the sub-select and the row write
    // could still collide on `uq_plugin_installs_active_device`. Catch the
    // constraint and return false — the owner resolves the conflicting install.
    try {
      const affected = this.db.run(
        `UPDATE plugin_installs SET status = 'active', pause_reason = NULL, updated_at = ?
         WHERE install_id = ? AND status = 'paused'
           AND (pause_reason IS NULL OR pause_reason = 'manual')
           AND NOT EXISTS (
             SELECT 1 FROM plugin_installs other
              WHERE other.device_did = plugin_installs.device_did
                AND other.device_did IS NOT NULL
                AND other.status = 'active'
                AND other.install_id != plugin_installs.install_id
           )`,
        [nowMs, installId],
      );
      return affected > 0;
    } catch (err) {
      if (isUniqueConstraintError(err)) return false;
      throw err;
    }
  }

  remove(installId: string): PluginInstall | null {
    const existing = this.getById(installId);
    // Round-11 #10: gate the cascade on the RAW row existing, not on a
    // successful projection. A semantically-corrupt row makes getById /
    // rowToInstall quarantine → null; gating removal on `existing !== null`
    // would leave that row AND its grants permanently un-deletable — the very
    // rows that most need cleaning. Key the delete on install_id directly; the
    // projected `existing` is only the return value (null for a corrupt row).
    const rawExists = this.db.query('SELECT 1 FROM plugin_installs WHERE install_id = ? LIMIT 1', [
      installId,
    ]);
    if (rawExists.length === 0) return null;
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

  removeIfStatus(installId: string, statuses: readonly PluginInstallStatus[]): boolean {
    if (statuses.length === 0) return false;
    let removed = false;
    // One transaction: the status re-check and the cascade delete cannot be
    // interleaved by another writer, so a row that raced to `active`/`paused`
    // after the caller's own status read is observed HERE and left intact.
    this.db.transaction(() => {
      // Raw status probe (scalar column, no projection) so a semantically-corrupt
      // row is still deletable when its stored status matches — same reachability
      // `remove` guarantees for corrupt rows (Round-11 #10).
      const placeholders = statuses.map(() => '?').join(',');
      const rows = this.db.query(
        `SELECT 1 FROM plugin_installs WHERE install_id = ? AND status IN (${placeholders}) LIMIT 1`,
        [installId, ...statuses],
      );
      if (rows.length === 0) return; // status moved (now live / already gone) — no-op
      this.db.execute(
        `DELETE FROM plugin_grant_uses WHERE grant_id IN
           (SELECT grant_id FROM plugin_grants WHERE install_id = ?)`,
        [installId],
      );
      this.db.execute('DELETE FROM plugin_grants WHERE install_id = ?', [installId]);
      this.db.execute('DELETE FROM plugin_capability_stats WHERE install_id = ?', [installId]);
      this.db.execute('DELETE FROM plugin_installs WHERE install_id = ?', [installId]);
      removed = true;
    });
    return removed;
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

  /**
   * Round-9 #17: build the CAS tail (`AND <col> = ?` clauses + params) for an
   * optional `expected`. Empty when no expectations are pinned, so the write
   * keys by install_id alone (back-compat with callers that pass no CAS).
   */
  private casClause(expected?: PluginInstallCas): { sql: string; params: unknown[] } {
    const parts: string[] = [];
    const params: unknown[] = [];
    if (expected?.configRevision !== undefined) {
      parts.push('config_revision = ?');
      params.push(expected.configRevision);
    }
    if (expected?.status !== undefined) {
      parts.push('status = ?');
      params.push(expected.status);
    }
    if (expected?.currentCid !== undefined) {
      parts.push('current_cid = ?');
      params.push(expected.currentCid);
    }
    if (expected?.pendingCid !== undefined) {
      // Round-10 #17: explicit null → IS NULL (no param); string → equality.
      if (expected.pendingCid === null) {
        parts.push('pending_cid IS NULL');
      } else {
        parts.push('pending_cid = ?');
        params.push(expected.pendingCid);
      }
    }
    return { sql: parts.length > 0 ? ` AND ${parts.join(' AND ')}` : '', params };
  }

  setPendingUpdate(
    installId: string,
    args: { cid: string; behaviorHash: string; decision: PluginPendingDecision },
    nowMs: number,
    expected?: PluginInstallCas,
  ): boolean {
    const cas = this.casClause(expected);
    const affected = this.db.run(
      `UPDATE plugin_installs
       SET pending_cid = ?, pending_behavior_hash = ?, pending_decision = ?, updated_at = ?
       WHERE install_id = ?${cas.sql}`,
      [args.cid, args.behaviorHash, args.decision, nowMs, installId, ...cas.params],
    );
    return affected > 0;
  }

  applyUpdate(
    installId: string,
    args: Parameters<PluginInstallRepository['applyUpdate']>[1],
    nowMs: number,
    expected?: PluginInstallCas,
  ): boolean {
    const cas = this.casClause(expected);
    // Round-11 #12: the execution model (interpreted vs runner) is fixed at
    // install and must NEVER change under an update. The column is authority:
    // an `interpreted` install runs in-process semantics, a `runner` install
    // dispatches to an external device on a lane. Pin the stored execution_mode
    // to the incoming manifest's `execution.mode`; a mismatch (an update that
    // flips the mode) matches zero rows and the update is refused, rather than
    // silently rewriting the manifest while the column — and the whole
    // dispatch/claim routing keyed on it — stays on the old model.
    let affected = 0;
    this.db.transaction(() => {
      affected = this.db.run(
        `UPDATE plugin_installs
         SET current_cid = ?, current_version = ?, manifest_json = ?,
             install_scope_hash = ?, capability_hashes_json = ?,
             behavior_hash = ?, presentation_hash = ?,
             pending_cid = NULL, pending_behavior_hash = NULL, pending_decision = NULL,
             updated_at = ?
         WHERE install_id = ? AND execution_mode = ?${cas.sql}`,
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
          args.manifest.execution.mode,
          ...cas.params,
        ],
      );
      // Round-12 #7: an update is a NEW consent surface (new scope/behavior/
      // release hashes), so the first-N card protection must RESTART. The
      // invocation counter is keyed only by (install_id, capability); without
      // this reset a materially different HIGH capability that keeps the same
      // capability id inherits its predecessor's count (>= FIRST_N) and runs
      // silent immediately, bypassing the first-three cards. Atomic with the
      // manifest swap; only fires when the update actually landed.
      if (affected > 0) {
        this.db.run('DELETE FROM plugin_capability_stats WHERE install_id = ?', [installId]);
      }
    });
    return affected > 0;
  }

  listStalePending(nowSec: number): PluginInstall[] {
    const rows = this.db.query(
      `SELECT * FROM plugin_installs
       WHERE status = 'pending' AND pending_expires_at IS NOT NULL AND pending_expires_at <= ?`,
      [nowSec],
    );
    return mapInstalls(rows);
  }

  listRawStalePending(nowSec: number): PluginInstallRef[] {
    // Round-12 #11: scalar columns only — no JSON.parse — so a corrupt stale
    // pending row is still enumerated and its orphan device can be swept.
    // PLG-28 #3: ALSO enumerate `revoked` tombstones — a failed-uninstall tombstone
    // whose removal didn't land. PLG-31 #19: include revoked tombstones with NO
    // device too — an INTERPRETED (device-less) install crash-tombstoned between
    // markRevoked and remove was stranded forever by the old `device_did != ''`
    // sub-condition. The sweep's device-revoke arm is already conditional on
    // `ref.deviceDid`, and `removeIfStatus` already deletes no-device revoked rows,
    // so widening the enumerator is the only change needed.
    const rows = this.db.query(
      `SELECT install_id, status, device_did FROM plugin_installs
       WHERE pending_expires_at IS NOT NULL AND pending_expires_at <= ?
         AND (status = 'pending' OR status = 'revoked')`,
      [nowSec],
    );
    return rows.map((r) => ({
      installId: String(r.install_id),
      status: String(r.status) as PluginInstallStatus,
      ...(typeof r.device_did === 'string' && r.device_did !== ''
        ? { deviceDid: r.device_did }
        : {}),
    }));
  }

  rawStatus(installId: string): string | null {
    const rows = this.db.query<{ status: string }>(
      'SELECT status FROM plugin_installs WHERE install_id = ? LIMIT 1',
      [installId],
    );
    return rows.length === 0 ? null : String(rows[0].status);
  }

  rawDeviceDid(installId: string): string | null {
    const rows = this.db.query<{ device_did: string | null }>(
      'SELECT device_did FROM plugin_installs WHERE install_id = ? LIMIT 1',
      [installId],
    );
    if (rows.length === 0) return null;
    const did = rows[0].device_did;
    return typeof did === 'string' && did !== '' ? did : null;
  }

  getInvocationCount(installId: string, capability: string): number {
    const rows = this.db.query<{ invocations: number }>(
      'SELECT invocations FROM plugin_capability_stats WHERE install_id = ? AND capability = ?',
      [installId, capability],
    );
    if (rows.length === 0) return 0;
    // Round-15 #9: fail closed toward CARDING. This count gates the mandatory
    // first-N approval cards (gatekeeper: `priorInvocations < FIRST_N`). A NaN
    // from a corrupt/non-integer value makes that comparison false → the HIGH-
    // risk card is skipped. Coerce a non-integer/negative count to 0 so the
    // first-N card always fires. (rowToInstall guards every other numeric column
    // this way; this closes the one that didn't.)
    const n = Number(rows[0].invocations);
    return Number.isInteger(n) && n >= 0 ? n : 0;
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
