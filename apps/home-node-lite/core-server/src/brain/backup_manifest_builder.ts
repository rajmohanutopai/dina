/**
 * Backup manifest builder — migration export (M4 story 08).
 *
 * When the user migrates to a new machine, Dina produces a sealed
 * export bundle. The manifest is the index the receiver verifies
 * against — it lists every file in the bundle with a SHA-256
 * checksum, plus metadata (DID, personas, counts, schema version).
 *
 * This primitive is the **manifest half** — pure builder given a
 * list of `BackupEntry` records + top-level metadata. The sealing,
 * encryption, and transport layers are separate concerns.
 *
 * **Canonical JSON** — entries are sorted by path so a given input
 * always produces a byte-identical manifest. This matters for the
 * manifest's own self-hash: the recipient recomputes the hash and
 * rejects the bundle if it differs from the sealed one.
 *
 * **Self-hash** — after assembling the entry list + meta, the
 * builder computes `SHA-256(canonical-json(entries + meta))`. The
 * self-hash lets the user paste it into two devices + confirm they
 * match before trusting the import.
 *
 * **Per-entry checksum** — callers compute + supply the per-entry
 * checksum (the builder doesn't read file contents; pure).
 *
 * **Never throws** after validation — every failure mode is a
 * throw at build time (programmer-facing). Decode side uses tagged
 * outcomes (separate primitive if needed later).
 */

import { createHash } from 'node:crypto';

import { canonicalJSON } from '../appview/schema_hash';

export interface BackupEntry {
  /** Relative path within the bundle — e.g. `vault/personal.sqlite`. */
  path: string;
  /** Size in bytes. Non-negative integer. */
  sizeBytes: number;
  /** SHA-256 of the file contents, lowercase hex. */
  sha256: string;
  /** Free-form kind tag — `vault`, `identity`, `keystore`, `config`, `audit`, etc. */
  kind: string;
}

export interface BackupMeta {
  /** The DID of the source node. */
  did: string;
  /** Unix seconds when the export was produced. */
  createdAtSec: number;
  /** Free-form source hostname or label. */
  sourceHost?: string;
  /** Schema version of the manifest. Default 1. */
  schemaVersion?: number;
  /** List of persona names included. */
  personas?: ReadonlyArray<string>;
  /** Human-readable note shown on import. */
  note?: string;
}

export interface BackupManifestInput {
  meta: BackupMeta;
  entries: ReadonlyArray<BackupEntry>;
}

export interface BackupManifest {
  version: number;
  did: string;
  createdAtSec: number;
  sourceHost: string | null;
  note: string | null;
  personas: string[];
  entries: BackupEntry[];
  totals: {
    fileCount: number;
    byteCount: number;
    byKind: Record<string, number>;
  };
  /** SHA-256 of the canonical manifest WITHOUT this field. */
  selfHash: string;
}

export class BackupManifestError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_meta'
      | 'invalid_entry'
      | 'duplicate_path'
      | 'empty_entries',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'BackupManifestError';
  }
}

export const DEFAULT_SCHEMA_VERSION = 1;

/**
 * Build a backup manifest. Throws `BackupManifestError` on invalid
 * input.
 */
export function buildBackupManifest(
  input: BackupManifestInput,
): BackupManifest {
  if (!input || typeof input !== 'object') {
    throw new BackupManifestError('invalid_input', 'input required');
  }
  validateMeta(input.meta);
  validateEntries(input.entries);

  // Sort entries by path for canonical output.
  const entries = [...input.entries]
    .map(cloneEntry)
    .sort((a, b) => a.path.localeCompare(b.path));

  const totals = computeTotals(entries);
  const version = input.meta.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
  const personas = input.meta.personas ? [...input.meta.personas].sort() : [];

  // Build the "core" record we'll hash.
  const core: Omit<BackupManifest, 'selfHash'> = {
    version,
    did: input.meta.did,
    createdAtSec: input.meta.createdAtSec,
    sourceHost: input.meta.sourceHost ?? null,
    note: input.meta.note ?? null,
    personas,
    entries,
    totals,
  };
  const selfHash = hashManifestCore(core);

  return { ...core, selfHash };
}

/**
 * Recompute the self-hash for an existing manifest. The caller
 * imports a manifest + recomputes + compares against the embedded
 * `selfHash` to detect tampering.
 */
export function recomputeSelfHash(manifest: BackupManifest): string {
  const { selfHash, ...core } = manifest;
  void selfHash;
  return hashManifestCore(core);
}

// ── Internals ──────────────────────────────────────────────────────────

function validateMeta(meta: BackupMeta): void {
  if (!meta || typeof meta !== 'object') {
    throw new BackupManifestError('invalid_meta', 'meta required');
  }
  if (typeof meta.did !== 'string' || !meta.did.startsWith('did:')) {
    throw new BackupManifestError('invalid_meta', `meta.did must start with "did:" (got ${JSON.stringify(meta.did)})`);
  }
  if (!Number.isFinite(meta.createdAtSec) || meta.createdAtSec <= 0) {
    throw new BackupManifestError('invalid_meta', 'meta.createdAtSec must be a positive number');
  }
  if (meta.schemaVersion !== undefined) {
    if (!Number.isInteger(meta.schemaVersion) || meta.schemaVersion < 1) {
      throw new BackupManifestError('invalid_meta', 'meta.schemaVersion must be a positive integer');
    }
  }
  if (meta.personas !== undefined) {
    if (!Array.isArray(meta.personas)) {
      throw new BackupManifestError('invalid_meta', 'meta.personas must be an array');
    }
    for (const p of meta.personas) {
      if (typeof p !== 'string' || p === '') {
        throw new BackupManifestError('invalid_meta', 'meta.personas entries must be non-empty strings');
      }
    }
  }
}

function validateEntries(entries: ReadonlyArray<BackupEntry>): void {
  if (!Array.isArray(entries)) {
    throw new BackupManifestError('invalid_input', 'entries must be an array');
  }
  if (entries.length === 0) {
    throw new BackupManifestError('empty_entries', 'entries must be non-empty');
  }
  const seenPaths = new Set<string>();
  for (const [i, e] of entries.entries()) {
    if (!e || typeof e !== 'object') {
      throw new BackupManifestError('invalid_entry', `entry ${i}: object required`);
    }
    if (typeof e.path !== 'string' || e.path === '') {
      throw new BackupManifestError('invalid_entry', `entry ${i}: path required`);
    }
    if (!Number.isInteger(e.sizeBytes) || e.sizeBytes < 0) {
      throw new BackupManifestError('invalid_entry', `entry ${i}: sizeBytes must be non-negative integer`);
    }
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) {
      throw new BackupManifestError('invalid_entry', `entry ${i}: sha256 must be 64 lowercase-hex chars`);
    }
    if (typeof e.kind !== 'string' || e.kind === '') {
      throw new BackupManifestError('invalid_entry', `entry ${i}: kind required`);
    }
    if (seenPaths.has(e.path)) {
      throw new BackupManifestError('duplicate_path', `duplicate entry path: ${e.path}`);
    }
    seenPaths.add(e.path);
  }
}

function cloneEntry(e: BackupEntry): BackupEntry {
  return {
    path: e.path,
    sizeBytes: e.sizeBytes,
    sha256: e.sha256,
    kind: e.kind,
  };
}

function computeTotals(entries: ReadonlyArray<BackupEntry>): BackupManifest['totals'] {
  let byteCount = 0;
  const byKind: Record<string, number> = {};
  for (const e of entries) {
    byteCount += e.sizeBytes;
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  }
  return { fileCount: entries.length, byteCount, byKind };
}

function hashManifestCore(core: Omit<BackupManifest, 'selfHash'>): string {
  return createHash('sha256').update(canonicalJSON(core), 'utf8').digest('hex');
}
