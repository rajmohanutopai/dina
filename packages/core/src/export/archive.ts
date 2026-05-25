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
import { bytesToHex } from '@noble/hashes/utils.js';

import { wrapSeed, unwrapSeed } from '../crypto/aesgcm';
import { ARGON2ID_PARAMS, DINA_FILE_MAGIC, DINA_FILE_VERSION } from '../constants';
import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

const ARCHIVE_MAGIC = DINA_FILE_MAGIC;
const ARCHIVE_VERSION = DINA_FILE_VERSION;
const ARCHIVE_FORMAT = 'dina-archive-v1' as const;

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
 *   - `person_extraction_log` — derived idempotency bookkeeping.
 *   - `schema_version` — managed by the migration runner on restore.
 */
const IDENTITY_TABLES = [
  'contacts',
  'contact_aliases',
  'people',
  'person_identities',
  'person_surfaces',
  'reminders',
  'service_config',
  'chat_messages',
] as const;

/** kv_store is exported, but sensitive keys are filtered out (below). */
const KV_TABLE = 'kv_store';

/** Persona-DB tables. `vault_items_fts` is a derived FTS index — rebuilt on insert, never exported. */
const PERSONA_TABLES = ['vault_items', 'vault_item_subjects', 'topic_salience', 'topic_aliases'] as const;

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

function dumpTable(adapter: DatabaseAdapter, table: string): DBRow[] {
  try {
    return adapter.query(`SELECT * FROM ${table}`);
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
  );
}

/** Tables an import is allowed to write — mirror of the export allowlists. */
const RESTORE_IDENTITY_TABLES: ReadonlySet<string> = new Set([...IDENTITY_TABLES, KV_TABLE]);
const RESTORE_PERSONA_TABLES: ReadonlySet<string> = new Set(PERSONA_TABLES);
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

// ---------------------------------------------------------------
// Build payload (export)
// ---------------------------------------------------------------

export async function buildArchivePayload(ds: ArchiveDataSource): Promise<ArchivePayloadV1> {
  const checksums: Record<string, string> = {};
  const identityTables: Record<string, DBRow[]> = {};

  const idAdapter = ds.identityAdapter();
  if (idAdapter !== null) {
    for (const t of IDENTITY_TABLES) {
      const rows = dumpTable(idAdapter, t);
      identityTables[t] = rows;
      checksums[`identity:${t}`] = tableChecksum(rows);
    }
    // kv_store with sensitive keys filtered out.
    const kvRows = dumpTable(idAdapter, KV_TABLE).filter((r) => !isSensitiveKvKey(r.key));
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
        const rows = payload.identity.tables[table];
        if (rows !== undefined) restoreTable(idAdapter, table, rows);
      }
    });
  }

  // Restore each persona into its own DB inside a transaction. PERSONA_TABLES
  // order puts `vault_items` before `vault_item_subjects` so the subject
  // links' parents exist first.
  for (const persona of payload.personas) {
    const adapter = await ds.openPersonaForRestore(persona.name, persona.tier);
    adapter.transaction(() => {
      for (const table of PERSONA_TABLES) {
        const rows = persona.tables[table];
        if (rows !== undefined) restoreTable(adapter, table, rows);
      }
    });
  }
}

/** Recompute per-table checksums and compare to the manifest. Throws on mismatch. */
function validateChecksums(payload: ArchivePayloadV1): void {
  const expected = payload.header.checksums ?? {};
  for (const [table, rows] of Object.entries(payload.identity.tables)) {
    const key = `identity:${table}`;
    if (expected[key] !== undefined && expected[key] !== tableChecksum(rows)) {
      throw new Error(`archive: checksum mismatch for ${key} (corrupt or tampered)`);
    }
  }
  for (const persona of payload.personas) {
    for (const [table, rows] of Object.entries(persona.tables)) {
      const key = `persona:${persona.name}:${table}`;
      if (expected[key] !== undefined && expected[key] !== tableChecksum(rows)) {
        throw new Error(`archive: checksum mismatch for ${key} (corrupt or tampered)`);
      }
    }
  }
}

/** Read + validate the manifest/payload (wrong passphrase / bad format → throw). */
export async function readManifest(
  archive: Uint8Array,
  passphrase: string,
): Promise<ArchivePayloadV1> {
  const { manifestBytes } = await decryptArchive(archive, passphrase);
  const payload = JSON.parse(new TextDecoder().decode(manifestBytes)) as ArchivePayloadV1;
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
    await readManifest(archive, passphrase);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------
// Encoding (shared with the original wire format)
// ---------------------------------------------------------------

async function encodeArchive(payload: ArchivePayloadV1, passphrase: string): Promise<Uint8Array> {
  const manifestBytes = new TextEncoder().encode(JSON.stringify(payload));
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
    return { compatible: false, version, reason: `Unsupported version ${version} (expected ${ARCHIVE_VERSION})` };
  }
  return { compatible: true, version };
}

export async function listArchiveContents(
  archive: Uint8Array,
  passphrase: string,
): Promise<{
  personas: Array<{ name: string; tier: string }>;
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
