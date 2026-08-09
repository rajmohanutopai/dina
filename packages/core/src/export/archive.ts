/**
 * Encrypted export archive (.dina format) — REAL backup (issues.txt §3).
 *
 * Wire format (unchanged, cross-compatible server↔mobile):
 *   DINA magic (4 bytes) + version (1 byte) + salt_len (1 byte)
 *   + salt + wrapped_len (4 bytes LE) + AES-256-GCM(payload_json)
 *   Key derivation: Argon2id(passphrase, salt) → archive_key.
 *
 * The payload is now `ArchivePayloadV1`: the actual identity + per-persona
 * table rows, plus a manifest (schema versions, app version, per-table
 * checksums, persona list). Secrets are excluded by table allowlist +
 * a kv key denylist (issues.txt §3): BYOK API keys, PDS password, raw
 * tokens, master seed, active agent grants, and volatile/transient state
 * (audit, devices, workflow, staging, outbox) never enter an archive.
 *
 * Export reads rows through a registered `ArchiveDataSource` (the storage
 * layer's identity adapter + open persona adapters). Import is
 * clean-install-only for V1: it refuses a target that already holds user
 * data unless `force` is set, validates the manifest + checksums before
 * writing, and restores each table inside a transaction. A payload that
 * carries data but finds no data source throws — import never silently
 * succeeds in production.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import {
  canonicalJson,
  computePluginDigests,
  hasUnsafeText,
  isValidTrustAnchor,
  normalizePluginManifest,
  validatePluginManifest,
} from '@dina/protocol';

import {
  describePreflightRefusal,
  preflightCommerceArchive,
} from '../commerce/archive_preflight';
import {
  COMMERCE_RESTORE_PENDING_KEY,
  markCommerceRestorePending,
} from '../commerce/restore_marker';
import { ARGON2ID_PARAMS, DINA_FILE_MAGIC, DINA_FILE_VERSION } from '../constants';
import { wrapSeed, unwrapSeed } from '../crypto/aesgcm';
import { validatePersonaName } from '../persona/service';
import { VALID_PLUGIN_DECISION_KINDS } from '../plugins/decisions';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';
import type { PluginManifest } from '@dina/protocol';

const ARCHIVE_MAGIC = DINA_FILE_MAGIC;
const ARCHIVE_VERSION = DINA_FILE_VERSION;
const ARCHIVE_FORMAT = 'dina-archive-v1' as const;

/**
 * JSON cannot represent SQLite BLOB values. In particular, op-sqlite returns
 * BLOBs as `ArrayBuffer`, which plain JSON.stringify silently turns into `{}`.
 * Encode every binary scalar explicitly so export/import preserves embeddings
 * and any future BLOB columns across storage adapters.
 */
const ARCHIVE_BLOB_TAG = '__dina_blob_hex_v1' as const;

function binaryBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function archiveJsonReplacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  // Read from the holder so Node Buffer's toJSON() cannot erase its binary
  // identity before the replacer sees it.
  const original = key === '' ? value : this[key];
  const bytes = binaryBytes(original);
  return bytes === null ? value : { [ARCHIVE_BLOB_TAG]: bytesToHex(bytes) };
}

function archiveJsonReviver(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== ARCHIVE_BLOB_TAG) return value;

  const hex = record[ARCHIVE_BLOB_TAG];
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new Error('archive: invalid encoded BLOB');
  }
  return hexToBytes(hex);
}

// ---------------------------------------------------------------
// Table policy — what travels in an archive, and what never does.
// ---------------------------------------------------------------

/**
 * Identity-DB tables exported as user data. EXCLUDED (deliberately):
 *   - `audit_log` — local security log, not portable user content.
 *   - `paired_devices` — device tokens (secrets) + machine-local trust.
 *   - `workflow_tasks` / `workflow_events` — volatile in-flight work.
 *   - `staging_inbox` — transient ingest queue.
 *   - `d2d_outbox` — transient outbound queue (issues.txt §1).
 *   - `agent_persona_grants` — active grants must NOT be exported (§2/§3).
 *   - `service_grants` — active provider-issued service authority; same posture
 *      as agent grants (re-issue offers after migration, don't restore live
 *      authorization onto a new device).
 *   - `person_extraction_log` — derived idempotency bookkeeping.
 *   - `schema_version` — managed by the migration runner on restore.
 *
 * `service_configs` (per-rkey multi-listing catalog, v8) IS exported — these are
 * the user's published service listings, real portable content. The old single-
 * row `service_config` table (v2) was dropped by v8 and no longer exists.
 * `contact_service_offers` (v9) is exported too — the user's received-offer
 * catalog is contact metadata, like `contacts`/`contact_aliases`.
 */
const IDENTITY_TABLES = [
  'contacts',
  'contact_aliases',
  'people',
  'person_identities',
  'person_surfaces',
  'reminders',
  'service_configs',
  'contact_service_offers',
  'chat_messages',
  // P2-12: the installed-plugin CATALOG (what plugin, version, capabilities,
  // pinned hashes) is portable content worth preserving. It is TRANSFORMED on
  // export to restore PAUSED with no device binding (see buildArchivePayload).
  // plugin_grants / plugin_grant_uses / plugin_capability_stats are NOT
  // exported — durable authority and runner pairings do not travel (§14).
  'plugin_installs',
  // Round-5 #8: the owner-private plugin DECISION LOG is history, not authority
  // ("records of the past, not authority" — it survives install removal, and has
  // no FK to plugin_installs). It travels with the catalog so the audit trail is
  // continuous across a migration. Being an IDENTITY_TABLE also means overwrite
  // clears the target's stale decisions first (they'd otherwise linger against a
  // restored install_id).
  'plugin_decisions',
  // Commerce (docs/COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md §16.2): the
  // receipt store is durable commercial memory (like plugin_decisions), and —
  // unlike the usual live-authority posture — the spec REQUIRES the
  // operational tables (order refs with effect phases, quote heads/uses,
  // status heads) in the archive: restoring receipts without them would
  // re-serve quotes with reset counters or re-sign forked heads. Watermarks
  // travel too, so a restored BUYER keeps its rollback protection. The
  // stale-backup residual is fenced by the commerce epoch (§16.2), not by
  // excluding these tables.
  'commerce_receipts',
  'commerce_order_refs',
  'commerce_quote_heads',
  'commerce_quote_uses',
  'commerce_status_heads',
  'commerce_epoch_watermarks',
] as const;

/** kv_store is exported, but sensitive keys are filtered out (below). */
const KV_TABLE = 'kv_store';

/** Persona-DB tables. `vault_items_fts` is a derived FTS index — rebuilt on insert, never exported. */
const PERSONA_TABLES = [
  'vault_items',
  'vault_item_subjects',
  'topic_salience',
  'topic_aliases',
] as const;

/** kv keys whose values are secrets — never exported. */
const SENSITIVE_KV_PATTERNS: RegExp[] = [
  /api[_-]?key/i,
  /password/i,
  /\btoken\b/i,
  /secret/i,
  /\bseed\b/i,
  /mnemonic/i,
  /^pds[_-]/i,
  /passphrase/i,
];

function isSensitiveKvKey(key: unknown): boolean {
  if (typeof key !== 'string') return false;
  return SENSITIVE_KV_PATTERNS.some((re) => re.test(key));
}

/**
 * kv keys that are EPHEMERAL device-session state, not portable user content —
 * never exported. The guided-demo keys (`guided_demo.active`,
 * `guided_demo.entry_seen`) matter most: a backup taken DURING a demo would
 * otherwise carry the active-demo record, and restoring it resurrects a recovery
 * record with no corresponding demo data — the next boot would offer to recover
 * into an orphan guided-demo scope. The actual demo rows are already excluded
 * (they're scope-tagged, and the archive only exports user-scope rows).
 */
const EPHEMERAL_KV_PATTERNS: RegExp[] = [
  /^guided_demo\./,
  // §16.2 — the commerce restore-fence marker describes THIS node's pending
  // obligation, not the backup's content. Exporting it would make a backup
  // taken while a fence was owed demand a second fence, on a different node,
  // for an event that already happened here.
  new RegExp(`^${COMMERCE_RESTORE_PENDING_KEY}$`),
];

function isEphemeralKvKey(key: unknown): boolean {
  if (typeof key !== 'string') return false;
  return EPHEMERAL_KV_PATTERNS.some((re) => re.test(key));
}

/** kv keys excluded from the archive: secrets + ephemeral device-session state. */
function isExcludedKvKey(key: unknown): boolean {
  return isSensitiveKvKey(key) || isEphemeralKvKey(key);
}

// ---------------------------------------------------------------
// Payload shape
// ---------------------------------------------------------------

export interface ArchiveHeaderV1 {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  created_at: number;
  app_version: string;
  schema_versions: Record<string, number>;
  persona_count: number;
  /** SHA-256 (hex) of each table's serialized rows, keyed `scope:table`. */
  checksums: Record<string, string>;
}

export interface ArchivePersonaV1 {
  name: string;
  tier: string;
  tables: Record<string, DBRow[]>;
}

export interface ArchivePayloadV1 {
  header: ArchiveHeaderV1;
  identity: { tables: Record<string, DBRow[]> };
  personas: ArchivePersonaV1[];
}

/** Back-compat alias — `readManifest` returns the payload. */
export type ArchiveManifest = ArchivePayloadV1;

// ---------------------------------------------------------------
// Data source — supplies adapters for export + import.
// ---------------------------------------------------------------

export interface ArchivePersonaSource {
  name: string;
  tier: string;
  adapter: DatabaseAdapter;
}

export interface ArchiveDataSource {
  /** Open identity DB adapter, or null when persistence isn't ready. */
  identityAdapter(): DatabaseAdapter | null;
  /** Every currently-open persona (name + tier + adapter). */
  personaSources(): Promise<ArchivePersonaSource[]>;
  /** Open/create a persona adapter to restore INTO (clean-install import). */
  openPersonaForRestore(name: string, tier: string): Promise<DatabaseAdapter>;
  /** True if the target already holds user data (clean-install guard). */
  hasExistingUserData(): Promise<boolean>;
  /** App version string stamped into the manifest. */
  appVersion?: string;
  /** Schema versions stamped into the manifest. */
  schemaVersions?: Record<string, number>;
}

let dataSource: ArchiveDataSource | null = null;
export function setArchiveDataSource(ds: ArchiveDataSource | null): void {
  dataSource = ds;
}
export function getArchiveDataSource(): ArchiveDataSource | null {
  return dataSource;
}

// Legacy injectable import handler — retained so callers/tests that wired
// a manifest-only handler still run. The real path uses the data source.
let importHandler: ((manifest: ArchivePayloadV1) => Promise<void>) | null = null;
export function setImportHandler(handler: (manifest: ArchivePayloadV1) => Promise<void>): void {
  importHandler = handler;
}
export function resetImportHandler(): void {
  importHandler = null;
}

// ---------------------------------------------------------------
// Table dump / restore + checksums
// ---------------------------------------------------------------

/**
 * Tables carrying a `data_scope` column. Export must include ONLY the `user`
 * scope — guided-demo data must never end up in a backup (design doc
 * Functional Invariant #3). Keep in lockstep with the data_scope migrations.
 */
const SCOPED_EXPORT_TABLES = new Set<string>([
  'vault_items',
  'vault_item_subjects',
  'reminders',
  'people',
  'person_surfaces',
  'chat_messages',
]);

function dumpTable(adapter: DatabaseAdapter, table: string): DBRow[] {
  try {
    // `'user'` is a constant (USER_SCOPE), not user input — safe to inline.
    const sql = SCOPED_EXPORT_TABLES.has(table)
      ? `SELECT * FROM ${table} WHERE data_scope = 'user'`
      : `SELECT * FROM ${table}`;
    return adapter.query(sql);
  } catch {
    // Table absent in this DB (e.g. an older persona) — treat as empty.
    return [];
  }
}

function tableChecksum(rows: DBRow[]): string {
  return bytesToHex(sha256(new TextEncoder().encode(stableStringify(rows))));
}

/** Deterministic JSON (sorted keys) so a checksum is stable across row order quirks. */
function stableStringify(rows: DBRow[]): string {
  return JSON.stringify(
    rows.map((r) => {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(r).sort()) sorted[k] = (r as Record<string, unknown>)[k];
      return sorted;
    }),
    archiveJsonReplacer,
  );
}

/** A safe SQL identifier (column name). */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function restoreTable(adapter: DatabaseAdapter, table: string, rows: DBRow[]): void {
  for (const row of rows) {
    const cols = Object.keys(row);
    if (cols.length === 0) continue;
    // Defence-in-depth: even though the archive is AES-256-GCM-encrypted
    // (a tamperer needs the passphrase), validate every column identifier
    // before interpolating it into SQL. A crafted archive can't inject DDL
    // or write to a column that isn't a plain identifier.
    for (const c of cols) {
      if (!SAFE_IDENT.test(c)) {
        throw new Error(`archive: refusing to restore unsafe column name "${c}" in ${table}`);
      }
    }
    const placeholders = cols.map(() => '?').join(', ');
    adapter.execute(
      `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
      cols.map((c) => (row as Record<string, unknown>)[c]),
    );
  }
}

/**
 * Empty a table for a force-overwrite restore (P1.1). `table` is ALWAYS a
 * member of the constant IDENTITY_TABLES / PERSONA_TABLES allowlists — never
 * attacker-influenced — so interpolating it is safe. Tolerates a table that's
 * absent in an older-schema target.
 */
function clearTable(adapter: DatabaseAdapter, table: string): void {
  try {
    adapter.execute(`DELETE FROM ${table}`);
  } catch {
    // Table absent in this DB (older schema) — nothing to clear.
  }
}

// ---------------------------------------------------------------
// Build payload (export)
// ---------------------------------------------------------------

export async function buildArchivePayload(ds: ArchiveDataSource): Promise<ArchivePayloadV1> {
  const checksums: Record<string, string> = {};
  const identityTables: Record<string, DBRow[]> = {};

  const idAdapter = ds.identityAdapter();
  if (idAdapter !== null) {
    for (const t of IDENTITY_TABLES) {
      let rows = dumpTable(idAdapter, t);
      if (t === 'plugin_installs') {
        // Round-12 #10: only CONSENTED installs are portable catalog entries.
        // A `pending` row is a ceremony the owner never completed (no consent),
        // and a `revoked` row is dead authority — exporting either would restore
        // it as a `paused` install the owner is prompted to recover, resurrecting
        // something that was never installed. Gate to active/paused before the
        // paused-transform below.
        // P2-12: a restored install has no runner instance and no live grants
        // until the owner re-pairs + re-consents, so bake it PAUSED with the
        // device binding stripped. Restore is then a plain verbatim insert;
        // the v19 unique-active-device index can't conflict (status≠active).
        rows = rows
          .filter((r) => r.status === 'active' || r.status === 'paused')
          .map((r) => ({
            ...r,
            status: 'paused',
            device_did: null,
            pause_reason: 'restore', // round-9 #16: restored installs need re-pair + re-consent
            // Round-15 #16: a restored install must re-pair + re-consent (non-
            // resumable), so any in-flight UPDATE decision from the PRE-BACKUP
            // context is stale. Clear the pending-update columns so a restored
            // catalog can't present or later apply that stale decision.
            pending_cid: null,
            pending_behavior_hash: null,
            pending_decision: null,
            pending_expires_at: null,
          }));
      }
      identityTables[t] = rows;
      checksums[`identity:${t}`] = tableChecksum(rows);
    }
    // kv_store with secrets + ephemeral (guided-demo) keys filtered out.
    const kvRows = dumpTable(idAdapter, KV_TABLE).filter((r) => !isExcludedKvKey(r.key));
    identityTables[KV_TABLE] = kvRows;
    checksums[`identity:${KV_TABLE}`] = tableChecksum(kvRows);
  }

  const personaSources = await ds.personaSources();
  const personas: ArchivePersonaV1[] = personaSources.map((p) => {
    const tables: Record<string, DBRow[]> = {};
    for (const t of PERSONA_TABLES) {
      const rows = dumpTable(p.adapter, t);
      tables[t] = rows;
      checksums[`persona:${p.name}:${t}`] = tableChecksum(rows);
    }
    return { name: p.name, tier: p.tier, tables };
  });

  return {
    header: {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      created_at: Date.now(),
      app_version: ds.appVersion ?? 'unknown',
      schema_versions: ds.schemaVersions ?? {},
      persona_count: personas.length,
      checksums,
    },
    identity: { tables: identityTables },
    personas,
  };
}

function emptyPayload(): ArchivePayloadV1 {
  return {
    header: {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      created_at: Date.now(),
      app_version: 'unknown',
      schema_versions: {},
      persona_count: 0,
      checksums: {},
    },
    identity: { tables: {} },
    personas: [],
  };
}

/** True if a payload carries any rows worth restoring. */
function payloadHasData(p: ArchivePayloadV1): boolean {
  const idHas = Object.values(p.identity.tables).some((rows) => rows.length > 0);
  const pHas = p.personas.some((per) => Object.values(per.tables).some((rows) => rows.length > 0));
  return idHas || pHas;
}

// ---------------------------------------------------------------
// Create / import
// ---------------------------------------------------------------

/**
 * Create an encrypted .dina archive of real user data. Reads through the
 * registered `ArchiveDataSource`; when none is installed (dry-run/tests)
 * it produces a valid but empty archive.
 */
export async function createArchive(passphrase: string): Promise<Uint8Array> {
  const ds = getArchiveDataSource();
  const payload = ds !== null ? await buildArchivePayload(ds) : emptyPayload();
  return encodeArchive(payload, passphrase);
}

export interface ImportArchiveOptions {
  /** Restore even if the target already holds user data (overwrites by PK). */
  force?: boolean;
}

/**
 * Import an archive — decrypt, validate manifest + checksums, then restore
 * into a clean install (or `force`). Throws on: wrong passphrase, corrupt
 * bytes, unsupported version, checksum mismatch, a non-clean target
 * without `force`, or a data-bearing payload with no data source wired.
 */
export async function importArchive(
  archive: Uint8Array,
  passphrase: string,
  opts: ImportArchiveOptions = {},
): Promise<void> {
  const payload = await readManifest(archive, passphrase);
  validateChecksums(payload);

  if (!payloadHasData(payload)) {
    // Empty archive — nothing to restore. Still honour a legacy handler.
    if (importHandler) await importHandler(payload);
    return;
  }

  // §16.2 (WS-4.2) — prove the commerce set BEFORE the target is touched.
  //
  // The restore fence below answers the COUNTER question; it says nothing
  // about structure. An archive whose orders point at quotes it does not carry
  // imports cleanly today and produces a node that cannot answer for its own
  // orders — surfacing later as a counterparty's reconcile that no local
  // record can satisfy. Fail-closed reconstruction means refusing here, whole,
  // rather than importing the coherent part: a dropped order reference does
  // not merely omit information, it makes this node deny an order the
  // counterparty holds signed evidence for.
  const preflight = preflightCommerceArchive(payload.identity.tables);
  if (!preflight.ok) {
    throw new Error(`archive: ${describePreflightRefusal(preflight)}`);
  }

  const ds = getArchiveDataSource();
  if (ds === null) {
    if (importHandler) {
      // Legacy manifest-only handler path.
      await importHandler(payload);
      return;
    }
    throw new Error(
      'archive: import has data to restore but no ArchiveDataSource is installed (import handler missing)',
    );
  }

  if (!opts.force && (await ds.hasExistingUserData())) {
    throw new Error(
      'archive: target is not a clean install — refusing to merge. Pass force to overwrite.',
    );
  }

  // Restore identity tables inside one transaction. Iterate the ALLOWLIST
  // (not the payload's key order) so a crafted archive can't smuggle in a
  // non-exported table (e.g. paired_devices / agent_persona_grants) and so
  // parents are restored before children deterministically.
  const idAdapter = ds.identityAdapter();
  if (idAdapter !== null) {
    idAdapter.transaction(() => {
      for (const table of [...IDENTITY_TABLES, KV_TABLE]) {
        // Force = true overwrite (the UI's "Overwrite"): clear the target
        // table first so rows that exist on the device but NOT in the backup
        // don't survive (P1.1 — `INSERT OR REPLACE` only overwrites matching
        // PKs, it never removes target-only rows). kv_store is the ONE
        // exception: it holds secrets (API keys, PDS password) deliberately
        // kept OUT of the archive, so wiping it would destroy them — kv is
        // merged instead (backup prefs overwrite, target secrets survive).
        //
        // ONLY A TABLE THE ARCHIVE ACTUALLY SUPPLIES. Export writes every
        // allowlisted table, empty arrays included — so a key that is ABSENT
        // means the archive was written by a build whose allowlist did not
        // have this table yet. Clearing it then destroys live data the backup
        // never claimed to describe, which is data loss dressed as a faithful
        // overwrite. A backup that genuinely held no rows still carries the
        // key with `[]`, and that DOES clear.
        //
        // The commerce set is the case that made this concrete: an archive
        // taken before commerce existed carries none of its tables, and the
        // preflight already names that state `predatesCommerce`. Under the old
        // rule a force-restore from such a backup wiped every order reference,
        // quote head, use counter and status head on a live trading node.
        const supplied = Object.prototype.hasOwnProperty.call(
          payload.identity.tables,
          table,
        );
        if (opts.force && supplied && table !== KV_TABLE) clearTable(idAdapter, table);
        const rows = payload.identity.tables[table];
        if (rows !== undefined) {
          // Round-9 #18: plugin authority never travels. Export bakes installs
          // PAUSED with the device binding stripped, but the archive is
          // attacker-influenced (the AES-GCM tag only proves the importer's
          // passphrase, NOT authenticity — a crafted archive supplies its own
          // passphrase + checksums), so a hostile payload can carry a
          // plugin_installs row with status:'active' and an attacker-chosen
          // device_did that bypasses the export transform. RE-force the safe
          // paused/null-device form on IMPORT so a restored install always
          // requires re-pair + re-consent before it is usable.
          const safe =
            table === 'plugin_installs'
              ? rows
                  // Round-10 #15: the archive is attacker-influenced (its tag
                  // only proves the importer's passphrase). Drop any plugin
                  // install whose manifest doesn't VALIDATE, so a crafted /
                  // malformed manifest never persists into the registry (where a
                  // UI reading plugin_installs directly would render it).
                  // Round-11 #11: a VALID manifest can still ship with FORGED
                  // sibling columns — the per-capability scope hashes, install
                  // scope hash, behavior/presentation digests — which the consent
                  // and claim-guard paths read as AUTHORITY (approved_scope_hash).
                  // Recompute all of them from the manifest and drop any row whose
                  // stored columns disagree, so a restored install can only carry
                  // digests that actually derive from its own manifest.
                  .filter((r) => {
                    let manifest: PluginManifest;
                    try {
                      manifest = JSON.parse(String(r.manifest_json)) as PluginManifest;
                    } catch {
                      return false;
                    }
                    if (!validatePluginManifest(manifest).ok) return false;
                    // Round-12 #9: the SCALAR identity columns must also agree
                    // with the validated manifest — the digest checks below bind
                    // scope/behavior/presentation but NOT plugin_id / version /
                    // execution_mode, so a crafted archive could restore a row
                    // whose catalog identity (what the UI + claim guard read)
                    // disagrees with the code/consent snapshot. Mirror of the
                    // rowToInstall cross-check (#8) on the restore path.
                    if (String(r.plugin_id) !== manifest.plugin_id) return false;
                    if (String(r.current_version) !== manifest.version) return false;
                    if (String(r.execution_mode) !== manifest.execution.mode) return false;
                    const digests = computePluginDigests(normalizePluginManifest(manifest), sha256);
                    if (String(r.install_scope_hash) !== digests.installScopeHash) return false;
                    if (String(r.behavior_hash) !== digests.behaviorHash) return false;
                    if (String(r.presentation_hash) !== digests.presentationHash) return false;
                    let storedCaps: unknown;
                    try {
                      storedCaps = JSON.parse(String(r.capability_hashes_json));
                    } catch {
                      return false;
                    }
                    if (canonicalJson(storedCaps) !== canonicalJson(digests.perCapability)) {
                      return false;
                    }
                    // Round-13 #16: the trust anchor is authority too — a crafted
                    // archive could carry an unknown kind or an org_key/
                    // local_publisher_key missing its required field. Reject any
                    // anchor that isn't a valid discriminated-union member.
                    let anchor: unknown;
                    try {
                      anchor = JSON.parse(String(r.trust_anchor_json));
                    } catch {
                      return false;
                    }
                    return isValidTrustAnchor(anchor);
                  })
                  .map((r) => ({
                    ...r,
                    status: 'paused',
                    device_did: null,
                    pause_reason: 'restore', // round-9 #16: restored installs need re-pair + re-consent
                    // Round-15 #16: strip stale pending-update state on restore.
                    pending_cid: null,
                    pending_behavior_hash: null,
                    pending_decision: null,
                    pending_expires_at: null,
                  }))
              : table === 'plugin_decisions'
                ? // Round-15 #17 + Round-16 #19: validate the WHOLE decision row
                  // from the attacker-influenced archive, not just the enum. Drop
                  // rows with an unknown kind, an oversized/spoofing-char
                  // install_id / capability / reason, or a non-integer created_at.
                  // Referential linkage is deliberately NOT enforced (the log
                  // outlives its install — no FK), only well-formedness.
                  rows.filter((r) => {
                    if (!VALID_PLUGIN_DECISION_KINDS.has(String(r.decision))) return false;
                    // PLG-27 #17: the audit `id` was previously unvalidated —
                    // inserted verbatim and read back via a bare `Number(r.id)`.
                    // Require a non-negative integer, matching the created_at
                    // check below. (An unknown extra COLUMN is separately caught
                    // by restoreTable, which fails the restore closed on any
                    // non-schema column name — safe, if strict.)
                    if (typeof r.id !== 'number' || !Number.isInteger(r.id) || r.id < 0) {
                      return false;
                    }
                    if (
                      typeof r.install_id !== 'string' ||
                      r.install_id === '' ||
                      r.install_id.length > 256 ||
                      hasUnsafeText(r.install_id)
                    ) {
                      return false;
                    }
                    const cap = r.capability ?? '';
                    if (typeof cap !== 'string' || cap.length > 256 || hasUnsafeText(cap)) {
                      return false;
                    }
                    const reason = r.reason ?? '';
                    if (
                      typeof reason !== 'string' ||
                      reason.length > 512 ||
                      hasUnsafeText(reason)
                    ) {
                      return false;
                    }
                    return (
                      typeof r.created_at === 'number' &&
                      Number.isInteger(r.created_at) &&
                      r.created_at >= 0
                    );
                  })
                : rows;
          restoreTable(idAdapter, table, safe);
        }
      }
      // P2-12: plugin authority never travels — a restored install is PAUSED
      // and must be re-consented. On overwrite, clear the target's grant / use
      // / stat rows (which are NOT in the archive) so a restored install can't
      // inherit stale grants the target happened to hold for the same id.
      //
      // plugin_drain_authorizations belongs in this list for the same reason
      // and was missing: a drain / lifecycle_continuity row is LIVE authority
      // for a PRIOR manifest CID. Left behind, it re-attaches to a restored
      // install that reuses the install id and admits prior-CID claims the
      // owner never re-consented — the exact posture the PAUSED-on-restore
      // rule exists to prevent (§9.13, §16.2).
      if (opts.force) {
        for (const t of [
          'plugin_grants',
          'plugin_grant_uses',
          'plugin_capability_stats',
          'plugin_drain_authorizations',
        ]) {
          clearTable(idAdapter, t);
        }
      }

      // §16.2 (WS-4.2) — the commerce restore fence, armed HERE.
      //
      // The commerce operational tables are in the archive on purpose: quote
      // heads, status heads, and the USE COUNTERS. Restoring them faithfully
      // means the backup's spent capacity comes back looking exactly like
      // capacity this node spent itself — because that is what a faithful
      // restore is. Nothing in the data can tell the two apart.
      //
      // So the obligation to void it is written down in the SAME transaction
      // that restores it. A marker written afterwards could be lost to a
      // crash in between, leaving resurrected counters with no fence pending
      // — the exact state this prevents, reachable by unlucky timing.
      //
      // Unconditional: no attempt to detect "did this archive actually carry
      // commerce rows?". An empty commerce set costs one wasted epoch
      // increment; a missed one lets capacity be spent twice.
      markCommerceRestorePending(idAdapter, Date.now());
    });
  }

  // Restore each persona into its own DB inside a transaction. PERSONA_TABLES
  // order puts `vault_items` before `vault_item_subjects` so the subject
  // links' parents exist first.
  for (const persona of payload.personas) {
    // Trust boundary: `persona.name` comes from the decrypted manifest, which
    // is attacker-influenced — the AES-256-GCM tag only proves the importer's
    // passphrase, NOT authenticity (a crafted archive supplies its own
    // passphrase + checksums). Reject any non-canonical name before it becomes
    // a vault filename downstream (`${name}.sqlite`), closing the
    // path-traversal class for every storage backend at the boundary.
    const nameError = validatePersonaName(persona.name);
    if (nameError !== null) {
      throw new Error(`archive: refusing to restore persona — ${nameError}`);
    }
    const adapter = await ds.openPersonaForRestore(persona.name, persona.tier);
    adapter.transaction(() => {
      for (const table of PERSONA_TABLES) {
        // Force = true overwrite: clear each persona table first (all persona
        // tables are fully captured in the archive — no secret-exclusion
        // caveat like kv_store) so stale target-only vault rows don't survive.
        // Same rule as the identity side: a table the archive does not mention
        // is one this backup cannot speak for, so it is left alone rather than
        // emptied. Export writes every allowlisted persona table, empty arrays
        // included, so an absent key means an older archive format.
        const rows = persona.tables[table];
        if (opts.force && rows !== undefined) clearTable(adapter, table);
        if (rows !== undefined) restoreTable(adapter, table, rows);
      }
    });
  }
}

/**
 * Recompute per-table checksums and compare to the manifest. Throws on mismatch.
 * Round-13 #24: require COMPLETE coverage — a MISSING checksum for a present
 * table is a failure, not a pass. A crafted archive (the AES-GCM tag proves only
 * the importer's passphrase, not authenticity) could otherwise omit checksums to
 * skip the integrity check on the very tables it tampered.
 */
function validateChecksums(payload: ArchivePayloadV1): void {
  const expected = payload.header.checksums ?? {};
  const check = (key: string, rows: DBRow[]): void => {
    if (expected[key] === undefined) {
      throw new Error(`archive: missing checksum for ${key} (incomplete or tampered)`);
    }
    if (expected[key] !== tableChecksum(rows)) {
      throw new Error(`archive: checksum mismatch for ${key} (corrupt or tampered)`);
    }
  };
  for (const [table, rows] of Object.entries(payload.identity.tables)) {
    check(`identity:${table}`, rows);
  }
  for (const persona of payload.personas) {
    for (const [table, rows] of Object.entries(persona.tables)) {
      check(`persona:${persona.name}:${table}`, rows);
    }
  }
}

/** Read + validate the manifest/payload (wrong passphrase / bad format → throw). */
export async function readManifest(
  archive: Uint8Array,
  passphrase: string,
): Promise<ArchivePayloadV1> {
  const { manifestBytes } = await decryptArchive(archive, passphrase);
  const payload = JSON.parse(
    new TextDecoder().decode(manifestBytes),
    archiveJsonReviver,
  ) as ArchivePayloadV1;
  if (!payload.header || payload.header.format !== ARCHIVE_FORMAT) {
    throw new Error('archive: invalid manifest format');
  }
  if (payload.header.version !== ARCHIVE_VERSION) {
    throw new Error(`archive: unsupported version ${payload.header.version}`);
  }
  return payload;
}

/** Verify an archive is valid (decryptable + well-formed) without importing. */
export async function verifyArchive(archive: Uint8Array, passphrase: string): Promise<boolean> {
  try {
    const payload = await readManifest(archive, passphrase);
    // Round-13 #24: `verifyArchive` must agree with `importArchive` — the import
    // path runs `validateChecksums`, so a checksum mismatch/gap that import
    // rejects must not be reported "valid" here.
    validateChecksums(payload);
    // WS-4.2: and the same for the commerce preflight, for the same reason.
    // This function's whole job is answering "could I restore this?" before an
    // operator commits to it; a `true` that the import then refuses is worse
    // than no check at all, because it is the answer they acted on.
    if (!preflightCommerceArchive(payload.identity.tables).ok) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------
// Encoding (shared with the original wire format)
// ---------------------------------------------------------------

async function encodeArchive(payload: ArchivePayloadV1, passphrase: string): Promise<Uint8Array> {
  const manifestBytes = new TextEncoder().encode(JSON.stringify(payload, archiveJsonReplacer));
  const wrapped = await wrapSeed(passphrase, manifestBytes);

  const saltLen = wrapped.salt.length;
  const wrappedLen = wrapped.wrapped.length;
  const archive = new Uint8Array(4 + 1 + 1 + saltLen + 4 + wrappedLen);
  let offset = 0;
  archive.set(ARCHIVE_MAGIC, offset);
  offset += 4;
  archive[offset++] = ARCHIVE_VERSION;
  archive[offset++] = saltLen;
  archive.set(wrapped.salt, offset);
  offset += saltLen;
  archive[offset++] = wrappedLen & 0xff;
  archive[offset++] = (wrappedLen >> 8) & 0xff;
  archive[offset++] = (wrappedLen >> 16) & 0xff;
  archive[offset++] = (wrappedLen >> 24) & 0xff;
  archive.set(wrapped.wrapped, offset);
  return archive;
}

// ---------------------------------------------------------------
// Path traversal protection (4-layer defense, unchanged)
// ---------------------------------------------------------------

export function validatePath(path: string): string | null {
  if (!path || path.length === 0) return 'path is empty';
  if (path.includes('/') || path.includes('\\')) {
    return `path traversal: directory separator in "${path}"`;
  }
  if (path.includes('..')) return `path traversal: parent directory reference in "${path}"`;
  if (path.startsWith('/') || /^[A-Z]:/i.test(path)) {
    return `path traversal: absolute path "${path}"`;
  }
  if (path.includes('\0')) return `path traversal: null byte in "${path}"`;
  return null;
}

export function isPathSafe(path: string): boolean {
  return validatePath(path) === null;
}

// ---------------------------------------------------------------
// Archive inspection
// ---------------------------------------------------------------

export function checkCompatibility(archive: Uint8Array): {
  compatible: boolean;
  version: number;
  reason?: string;
} {
  if (archive.length < 6) return { compatible: false, version: 0, reason: 'Archive too short' };
  if (archive[0] !== 0x44 || archive[1] !== 0x49 || archive[2] !== 0x4e || archive[3] !== 0x41) {
    return { compatible: false, version: 0, reason: 'Invalid magic header (not a .dina archive)' };
  }
  const version = archive[4];
  if (version !== ARCHIVE_VERSION) {
    return {
      compatible: false,
      version,
      reason: `Unsupported version ${version} (expected ${ARCHIVE_VERSION})`,
    };
  }
  return { compatible: true, version };
}

/**
 * WS-4.2: this deliberately does NOT run the commerce preflight, and the
 * asymmetry with `verifyArchive` is the point. `verifyArchive` makes a claim —
 * "this can be restored" — so it must agree with the import. Listing makes no
 * claim; it shows what is inside. Refusing to list a torn archive would take
 * away the one tool an operator has for working out what went wrong with it.
 */
export async function listArchiveContents(
  archive: Uint8Array,
  passphrase: string,
): Promise<{
  personas: { name: string; tier: string }[];
  total_personas: number;
  created_at: number;
}> {
  const payload = await readManifest(archive, passphrase);
  return {
    personas: payload.personas.map((p) => ({ name: p.name, tier: p.tier })),
    total_personas: payload.header.persona_count,
    created_at: payload.header.created_at,
  };
}

// ---------------------------------------------------------------
// Internal — decrypt
// ---------------------------------------------------------------

async function decryptArchive(
  archive: Uint8Array,
  passphrase: string,
): Promise<{ manifestBytes: Uint8Array }> {
  if (archive.length < 6) throw new Error('archive: too short');
  if (archive[0] !== 0x44 || archive[1] !== 0x49 || archive[2] !== 0x4e || archive[3] !== 0x41) {
    throw new Error('archive: invalid DINA magic');
  }
  let offset = 4;
  const version = archive[offset++];
  if (version !== ARCHIVE_VERSION) throw new Error(`archive: unsupported version ${version}`);
  const saltLen = archive[offset++];
  if (offset + saltLen > archive.length) throw new Error('archive: truncated salt');
  const salt = archive.slice(offset, offset + saltLen);
  offset += saltLen;
  if (offset + 4 > archive.length) throw new Error('archive: truncated length');
  const wrappedLen =
    archive[offset] |
    (archive[offset + 1] << 8) |
    (archive[offset + 2] << 16) |
    (archive[offset + 3] << 24);
  offset += 4;
  if (offset + wrappedLen > archive.length) throw new Error('archive: truncated data');
  const wrapped = archive.slice(offset, offset + wrappedLen);
  const manifestBytes = await unwrapSeed(passphrase, { salt, wrapped, params: ARGON2ID_PARAMS });
  return { manifestBytes };
}
