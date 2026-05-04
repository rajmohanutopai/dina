/**
 * Production database provider — manages identity + persona databases.
 *
 * Uses OpSQLiteAdapter for SQLCipher-encrypted persistence.
 * Called at app startup after identity unlock.
 *
 * Source: ARCHITECTURE.md — op-sqlite persistence layer
 */

import type { DatabaseAdapter, DBProvider } from '@dina/core/storage';
import { OpSQLiteAdapter } from './op_sqlite_adapter';
import { bytesToHex } from '@noble/hashes/utils.js';
import { derivePersonaDEK, deriveDEKHash } from '@dina/core';

interface ProviderConfig {
  dbDir: string;
  masterSeed: Uint8Array;
  userSalt: Uint8Array;
  openFn: (options: { name: string; location?: string }) => any;
}

export class ProductionDBProvider implements DBProvider {
  private identityDB: OpSQLiteAdapter | null = null;
  private personaDBs = new Map<string, OpSQLiteAdapter>();
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async openIdentityDB(): Promise<DatabaseAdapter> {
    if (this.identityDB?.isOpen) return this.identityDB;

    const dek = derivePersonaDEK(this.config.masterSeed, 'identity', this.config.userSalt);
    const dekHex = bytesToHex(dek);

    const adapter = new OpSQLiteAdapter();
    adapter.open('identity.sqlite', this.config.dbDir, dekHex, this.config.openFn);
    this.identityDB = adapter;
    return adapter;
  }

  async openPersonaDB(persona: string): Promise<DatabaseAdapter> {
    const existing = this.personaDBs.get(persona);
    if (existing?.isOpen) return existing;

    const dek = derivePersonaDEK(this.config.masterSeed, persona, this.config.userSalt);
    const dekHex = bytesToHex(dek);

    const adapter = new OpSQLiteAdapter();
    adapter.open(`${persona}.sqlite`, this.config.dbDir, dekHex, this.config.openFn);
    this.personaDBs.set(persona, adapter);
    return adapter;
  }

  async closePersonaDB(persona: string): Promise<void> {
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
