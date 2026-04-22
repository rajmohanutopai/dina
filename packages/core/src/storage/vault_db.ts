/**
 * Vault database abstraction — interface for SQLCipher-encrypted storage.
 *
 * The VaultDB interface defines the contract for persona vault databases.
 * Two backends:
 *   - InMemoryVaultDB: for testing and early development (this file)
 *   - NativeVaultDB: op-sqlite + SQLCipher (plugged in after native build)
 *
 * Each persona gets its own VaultDB, opened with its DEK (derived via HKDF).
 * The interface enforces:
 *   - Open with DEK (wrong DEK must throw)
 *   - WAL journal mode + synchronous=NORMAL pragmas
 *   - SQL execution (for schema application)
 *   - Prepared statement support (for queries)
 *   - Close with WAL checkpoint
 *
 * Source: ARCHITECTURE.md Tasks 1.30, 1.31, 1.32
 */

export interface VaultDBRow {
  [key: string]: string | number | null | Uint8Array;
}

export interface VaultDB {
  /** Whether the database is currently open. */
  readonly isOpen: boolean;

  /** The persona this vault belongs to. */
  readonly persona: string;

  /** Whether WAL mode is active. */
  readonly walEnabled: boolean;

  /**
   * Open the vault database with the given DEK.
   * Applies WAL + synchronous pragmas after opening.
   * @throws if DEK is wrong or database is corrupted
   */
  open(path: string, dek: Uint8Array): void;

  /**
   * Close the vault database.
   * Performs WAL checkpoint before closing.
   */
  close(): void;

  /**
   * Execute a SQL statement (DDL or DML without results).
   * @throws if database is not open
   */
  exec(sql: string): void;

  /**
   * Execute a SQL query and return rows.
   * @throws if database is not open
   */
  query(sql: string, params?: unknown[]): VaultDBRow[];

  /**
   * Execute a SQL statement with parameters (INSERT/UPDATE/DELETE).
   * Returns the number of affected rows.
   */
  run(sql: string, params?: unknown[]): number;

  /**
   * Run multiple statements in a transaction.
   * Rolls back on any error.
   */
  transaction(fn: () => void): void;
}

/**
 * In-memory VaultDB backend — for testing and early development.
 *
 * Simulates SQLCipher behavior:
 * - Validates DEK length (must be 32 bytes)
 * - Tracks WAL mode state
 * - Stores data in Maps (tables → rows)
 * - Supports basic SQL parsing for INSERT/SELECT/CREATE
 */
export class InMemoryVaultDB implements VaultDB {
  private _isOpen = false;
  private _walEnabled = false;
  private _persona: string;
  private _dekHash: string = '';
  private tables = new Map<string, VaultDBRow[]>();
  private pragmas = new Map<string, string>();

  constructor(persona: string) {
    this._persona = persona;
  }

  get isOpen(): boolean {
    return this._isOpen;
  }
  get persona(): string {
    return this._persona;
  }
  get walEnabled(): boolean {
    return this._walEnabled;
  }

  open(path: string, dek: Uint8Array): void {
    if (this._isOpen) throw new Error('vault_db: already open');
    if (!dek || dek.length !== 32) throw new Error('vault_db: DEK must be exactly 32 bytes');

    // Store DEK hash for validation (never store the DEK itself)
    this._dekHash = simpleHash(dek);
    this._isOpen = true;

    // Apply default pragmas (WAL + synchronous)
    this.applyPragmas();
  }

  close(): void {
    if (!this._isOpen) return;

    // WAL checkpoint (simulated)
    this._isOpen = false;
    this._walEnabled = false;
    this.tables.clear();
    this.pragmas.clear();
  }

  exec(sql: string): void {
    this.assertOpen();
    const trimmed = sql.trim();

    // Handle PRAGMA statements
    if (trimmed.toUpperCase().startsWith('PRAGMA')) {
      this.handlePragma(trimmed);
      return;
    }

    // Handle CREATE TABLE
    if (trimmed.toUpperCase().startsWith('CREATE')) {
      const tableMatch = trimmed.match(
        /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i,
      );
      if (tableMatch) {
        const tableName = tableMatch[1];
        if (!this.tables.has(tableName)) {
          this.tables.set(tableName, []);
        }
      }
      return;
    }

    // Handle CREATE INDEX, CREATE TRIGGER (no-op in memory)
    if (
      trimmed.toUpperCase().startsWith('CREATE INDEX') ||
      trimmed.toUpperCase().startsWith('CREATE UNIQUE INDEX') ||
      trimmed.toUpperCase().startsWith('CREATE TRIGGER')
    ) {
      return;
    }

    // Handle INSERT
    if (trimmed.toUpperCase().startsWith('INSERT')) {
      const tableMatch = trimmed.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)/i);
      if (tableMatch) {
        const table = this.tables.get(tableMatch[1]);
        if (table) {
          table.push({ _raw: trimmed });
        }
      }
      return;
    }
  }

  query(sql: string, params?: unknown[]): VaultDBRow[] {
    this.assertOpen();
    // In-memory: return empty for all queries (real data is in vault/crud.ts)
    return [];
  }

  run(sql: string, params?: unknown[]): number {
    this.assertOpen();
    this.exec(sql);
    return 1;
  }

  transaction(fn: () => void): void {
    this.assertOpen();
    // Simple transaction: just run it (rollback not implemented in memory)
    fn();
  }

  /** Get a pragma value (for testing). */
  getPragma(name: string): string | undefined {
    return this.pragmas.get(name.toLowerCase());
  }

  /** Check if a table exists (for testing). */
  hasTable(name: string): boolean {
    return this.tables.has(name);
  }

  /** Get table count (for testing). */
  tableCount(): number {
    return this.tables.size;
  }

  private assertOpen(): void {
    if (!this._isOpen) throw new Error('vault_db: database is not open');
  }

  private applyPragmas(): void {
    this.pragmas.set('journal_mode', 'wal');
    this.pragmas.set('synchronous', 'normal');
    this.pragmas.set('foreign_keys', 'on');
    this.pragmas.set('busy_timeout', '5000');
    this._walEnabled = true;
  }

  private handlePragma(sql: string): void {
    const setMatch = sql.match(/PRAGMA\s+(\w+)\s*=\s*(\w+)/i);
    if (setMatch) {
      this.pragmas.set(setMatch[1].toLowerCase(), setMatch[2].toLowerCase());
      if (setMatch[1].toLowerCase() === 'journal_mode') {
        this._walEnabled = setMatch[2].toLowerCase() === 'wal';
      }
    }
  }
}

/** Registry of open vault databases. */
const openDBs = new Map<string, VaultDB>();

/** Injectable factory — swap for NativeVaultDB in production. */
let dbFactory: (persona: string) => VaultDB = (persona) => new InMemoryVaultDB(persona);

/**
 * Set the database factory (for production: NativeVaultDB).
 */
export function setVaultDBFactory(factory: (persona: string) => VaultDB): void {
  dbFactory = factory;
}

/**
 * Open a persona vault database.
 */
export function openVaultDB(persona: string, path: string, dek: Uint8Array): VaultDB {
  if (openDBs.has(persona)) {
    throw new Error(`vault_db: "${persona}" is already open`);
  }

  const db = dbFactory(persona);
  db.open(path, dek);
  openDBs.set(persona, db);
  return db;
}

/**
 * Close a persona vault database.
 */
export function closeVaultDB(persona: string): void {
  const db = openDBs.get(persona);
  if (db) {
    db.close();
    openDBs.delete(persona);
  }
}

/**
 * Get an open vault database.
 */
export function getVaultDB(persona: string): VaultDB | null {
  return openDBs.get(persona) ?? null;
}

/**
 * Check if a persona vault is open.
 */
export function isVaultDBOpen(persona: string): boolean {
  return openDBs.has(persona);
}

/**
 * Close all open vault databases.
 */
export function closeAllVaultDBs(): void {
  for (const db of openDBs.values()) {
    db.close();
  }
  openDBs.clear();
}

/**
 * Reset factory + close all (for testing).
 */
export function resetVaultDBs(): void {
  closeAllVaultDBs();
  dbFactory = (persona) => new InMemoryVaultDB(persona);
}

/** Simple hash for DEK validation (not crypto-grade, just for in-memory mock). */
function simpleHash(data: Uint8Array): string {
  let h = 0;
  for (const b of data) h = ((h << 5) - h + b) | 0;
  return h.toString(16);
}
