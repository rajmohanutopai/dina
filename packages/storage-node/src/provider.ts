/**
 * `NodeDBProvider` — `DBProvider` implementation coordinating the
 * identity DB + per-persona vault DBs on the Node filesystem.
 *
 * Layout (matches Go Core at `ARCHITECTURE.md § Storage Architecture`):
 *
 *   <vaultDir>/
 *     identity.sqlite          Tier 0: contacts, audit, kv, devices
 *     vault/
 *       <persona>.sqlite       one file per persona (task 3.12)
 *
 * Each file opens with its own DEK; the identity DEK is handed in at
 * construction time, persona DEKs are resolved lazily via the caller-
 * supplied `resolvePersonaDekHex` callback (kept async so future
 * derivation paths that do I/O — e.g. HSM-backed — can land without
 * interface churn).
 *
 * **Idempotent open** — `openIdentityDB` / `openPersonaDB` return the
 * existing adapter if one is already open for that DB. Callers don't
 * need to check before asking.
 *
 * **Path-safe persona names** — validated against a tight allowlist
 * (lower-case alphanumerics plus `-` and `_`, bounded length). Any
 * attempt to smuggle `..` / `/` / `\` / NUL into the filename is
 * rejected with a typed `invalid_persona` error before touching the
 * filesystem.
 *
 * Task roadmap (docs/HOME_NODE_LITE_TASKS.md Phase 3a):
 *   - 3.12 ✅ Per-persona file multiplexing via openPersonaDB
 *   - 3.13 ✅ Identity DB at identity.sqlite
 *   - 3.14 Crash-safety config — `synchronous=NORMAL` for vault,
 *          `FULL` for identity (layered on top of this impl)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { DBProvider, DatabaseAdapter } from '@dina/core';

import { NodeSQLiteAdapter } from './adapter';

const PERSONA_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const IDENTITY_FILENAME = 'identity.sqlite';
const VAULT_SUBDIR = 'vault';

export class NodeDBProviderError extends Error {
  constructor(
    public readonly code:
      | 'invalid_vault_dir'
      | 'invalid_identity_key'
      | 'invalid_persona',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'NodeDBProviderError';
  }
}

export interface NodeDBProviderOptions {
  /** Root directory — identity.sqlite lives here, vault/ is a subdir. */
  vaultDir: string;
  /** Hex-encoded identity DEK (64 hex chars). */
  identityDekHex: string;
  /**
   * Resolves a persona name to its hex-encoded DEK. Kept async so
   * HSM-backed or remote-KMS derivation can land without an interface
   * change.
   */
  resolvePersonaDekHex: (persona: string) => Promise<string>;
}

export class NodeDBProvider implements DBProvider {
  private readonly vaultDir: string;
  private readonly identityDekHex: string;
  private readonly resolvePersonaDekHex: (persona: string) => Promise<string>;
  private identityDB: NodeSQLiteAdapter | null = null;
  private readonly personaDBs = new Map<string, NodeSQLiteAdapter>();

  constructor(opts: NodeDBProviderOptions) {
    if (typeof opts.vaultDir !== 'string' || opts.vaultDir.length === 0) {
      throw new NodeDBProviderError('invalid_vault_dir', 'vaultDir must be a non-empty string');
    }
    if (typeof opts.identityDekHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(opts.identityDekHex)) {
      throw new NodeDBProviderError('invalid_identity_key', 'identityDekHex must be 64 hex chars');
    }
    if (typeof opts.resolvePersonaDekHex !== 'function') {
      throw new NodeDBProviderError('invalid_identity_key', 'resolvePersonaDekHex must be a function');
    }
    this.vaultDir = path.resolve(opts.vaultDir);
    this.identityDekHex = opts.identityDekHex;
    this.resolvePersonaDekHex = opts.resolvePersonaDekHex;
  }

  async openIdentityDB(): Promise<DatabaseAdapter> {
    if (this.identityDB?.isOpen) return this.identityDB;
    fs.mkdirSync(this.vaultDir, { recursive: true });
    // Identity DB carries audit log + contacts + device tokens — every
    // write must be durable before return. DELETE journal + synchronous
    // FULL matches the Go Core tuning (task 3.14).
    const adapter = new NodeSQLiteAdapter({
      path: path.join(this.vaultDir, IDENTITY_FILENAME),
      passphraseHex: this.identityDekHex,
      journalMode: 'DELETE',
      synchronous: 'FULL',
    });
    this.identityDB = adapter;
    return adapter;
  }

  async openPersonaDB(persona: string): Promise<DatabaseAdapter> {
    assertPersonaName(persona);
    const existing = this.personaDBs.get(persona);
    if (existing?.isOpen) return existing;

    const dekHex = await this.resolvePersonaDekHex(persona);
    if (typeof dekHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(dekHex)) {
      throw new NodeDBProviderError(
        'invalid_identity_key',
        `resolvePersonaDekHex("${persona}") must return 64 hex chars`,
      );
    }
    const vaultSubdir = path.join(this.vaultDir, VAULT_SUBDIR);
    fs.mkdirSync(vaultSubdir, { recursive: true });
    // Persona vaults use WAL + synchronous=NORMAL — the WAL-appropriate
    // durability trade-off that's still crash-safe against app crashes
    // (loses only the last few transactions on a power loss, none on
    // an app-level crash). Matches Go Core tuning (task 3.14).
    const adapter = new NodeSQLiteAdapter({
      path: path.join(vaultSubdir, `${persona}.sqlite`),
      passphraseHex: dekHex,
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    this.personaDBs.set(persona, adapter);
    return adapter;
  }

  async closePersonaDB(persona: string): Promise<void> {
    // Accept arbitrary strings here (no validation) — closing something
    // that isn't open is a no-op. Validation only guards filesystem
    // writes.
    const db = this.personaDBs.get(persona);
    if (db) {
      db.close();
      this.personaDBs.delete(persona);
    }
  }

  async getIdentityDB(): Promise<DatabaseAdapter | null> {
    return this.identityDB?.isOpen ? this.identityDB : null;
  }

  async getPersonaDB(persona: string): Promise<DatabaseAdapter | null> {
    const db = this.personaDBs.get(persona);
    return db?.isOpen ? db : null;
  }

  async closeAll(): Promise<void> {
    if (this.identityDB) {
      this.identityDB.close();
      this.identityDB = null;
    }
    for (const db of this.personaDBs.values()) {
      db.close();
    }
    this.personaDBs.clear();
  }
}

// ── Internals ──────────────────────────────────────────────────────────

function assertPersonaName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new NodeDBProviderError('invalid_persona', 'persona name must be a non-empty string');
  }
  if (!PERSONA_NAME_REGEX.test(name)) {
    // Explicit, conservative allowlist — lower-case alphanumerics +
    // `-` + `_`, starting with an alphanumeric, up to 63 chars. Blocks
    // every path-traversal vector without relying on string-search
    // blacklists.
    throw new NodeDBProviderError(
      'invalid_persona',
      `persona name "${name}" invalid — must match /^[a-z0-9][a-z0-9_-]{0,62}$/`,
    );
  }
}
