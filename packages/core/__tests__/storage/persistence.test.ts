/**
 * Persistence foundation tests — DatabaseAdapter, migrations, schemas.
 *
 * Uses InMemoryDatabaseAdapter (no native modules needed).
 */

import { InMemoryDatabaseAdapter } from '../../src/storage/db_adapter';
import {
  applyMigrations,
  getCurrentVersion,
  listAppliedMigrations,
  type Migration,
} from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS, PERSONA_MIGRATIONS } from '../../src/storage/schemas';

describe('DatabaseAdapter', () => {
  it('starts open', () => {
    const db = new InMemoryDatabaseAdapter();
    expect(db.isOpen).toBe(true);
  });

  it('close sets isOpen to false', () => {
    const db = new InMemoryDatabaseAdapter();
    db.close();
    expect(db.isOpen).toBe(false);
  });

  it('execute throws when closed', () => {
    const db = new InMemoryDatabaseAdapter();
    db.close();
    expect(() => db.execute('SELECT 1')).toThrow('not open');
  });

  it('tracks table creation', () => {
    const db = new InMemoryDatabaseAdapter();
    db.execute('CREATE TABLE IF NOT EXISTS test_table (id TEXT PRIMARY KEY)');
    expect(db.hasTable('test_table')).toBe(true);
  });

  it('transaction executes function', () => {
    const db = new InMemoryDatabaseAdapter();
    let executed = false;
    db.transaction(() => {
      executed = true;
    });
    expect(executed).toBe(true);
  });
});

describe('Migration Runner', () => {
  it('starts at version 0', () => {
    const db = new InMemoryDatabaseAdapter();
    expect(getCurrentVersion(db)).toBe(0);
  });

  it('applies migrations in order', () => {
    const db = new InMemoryDatabaseAdapter();
    const migrations: Migration[] = [
      { version: 1, name: 'first', sql: 'CREATE TABLE t1 (id TEXT)' },
      { version: 2, name: 'second', sql: 'CREATE TABLE t2 (id TEXT)' },
    ];

    const applied = applyMigrations(db, migrations);
    expect(applied).toBe(2);
    expect(getCurrentVersion(db)).toBe(2);
  });

  it('skips already-applied migrations', () => {
    const db = new InMemoryDatabaseAdapter();
    const migrations: Migration[] = [
      { version: 1, name: 'first', sql: 'CREATE TABLE t1 (id TEXT)' },
    ];

    applyMigrations(db, migrations);
    const applied = applyMigrations(db, migrations); // re-apply
    expect(applied).toBe(0); // nothing new
  });

  it('applies only new migrations', () => {
    const db = new InMemoryDatabaseAdapter();

    applyMigrations(db, [{ version: 1, name: 'first', sql: 'CREATE TABLE t1 (id TEXT)' }]);

    const applied = applyMigrations(db, [
      { version: 1, name: 'first', sql: 'CREATE TABLE t1 (id TEXT)' },
      { version: 2, name: 'second', sql: 'CREATE TABLE t2 (id TEXT)' },
    ]);

    expect(applied).toBe(1); // only version 2
    expect(getCurrentVersion(db)).toBe(2);
  });

  it('handles out-of-order migration array', () => {
    const db = new InMemoryDatabaseAdapter();
    const applied = applyMigrations(db, [
      { version: 3, name: 'third', sql: 'CREATE TABLE t3 (id TEXT)' },
      { version: 1, name: 'first', sql: 'CREATE TABLE t1 (id TEXT)' },
      { version: 2, name: 'second', sql: 'CREATE TABLE t2 (id TEXT)' },
    ]);
    expect(applied).toBe(3);
    expect(getCurrentVersion(db)).toBe(3);
  });

  it('lists applied migrations', () => {
    const db = new InMemoryDatabaseAdapter();
    applyMigrations(db, [
      { version: 1, name: 'alpha', sql: 'CREATE TABLE t1 (id TEXT)' },
      { version: 2, name: 'beta', sql: 'CREATE TABLE t2 (id TEXT)' },
    ]);

    const list = listAppliedMigrations(db);
    expect(list).toHaveLength(2);
  });
});

describe('Schema definitions', () => {
  it('identity migrations are well-formed', () => {
    expect(IDENTITY_MIGRATIONS.length).toBeGreaterThanOrEqual(1);
    expect(IDENTITY_MIGRATIONS[0].version).toBe(1);
    expect(IDENTITY_MIGRATIONS[0].name).toBeTruthy();
    expect(IDENTITY_MIGRATIONS[0].sql).toContain('contacts');
    expect(IDENTITY_MIGRATIONS[0].sql).toContain('audit_log');
    expect(IDENTITY_MIGRATIONS[0].sql).toContain('paired_devices');
    expect(IDENTITY_MIGRATIONS[0].sql).toContain('reminders');
    expect(IDENTITY_MIGRATIONS[0].sql).toContain('staging_inbox');
    expect(IDENTITY_MIGRATIONS[0].sql).toContain('kv_store');
  });

  it('identity schema can be applied to in-memory adapter', () => {
    const db = new InMemoryDatabaseAdapter();
    const applied = applyMigrations(db, IDENTITY_MIGRATIONS);
    expect(applied).toBe(IDENTITY_MIGRATIONS.length);
    expect(db.hasTable('contacts')).toBe(true);
    expect(db.hasTable('audit_log')).toBe(true);
    expect(db.hasTable('paired_devices')).toBe(true);
    expect(db.hasTable('reminders')).toBe(true);
    expect(db.hasTable('staging_inbox')).toBe(true);
    expect(db.hasTable('kv_store')).toBe(true);
    // v2 added for Bus Driver Scenario (commit f3a1bc7).
    expect(db.hasTable('service_config')).toBe(true);
    // v3 added for WS2 workflow tasks (commit 9c01611).
    expect(db.hasTable('workflow_tasks')).toBe(true);
    expect(db.hasTable('workflow_events')).toBe(true);
  });

  it('persona migrations are well-formed', () => {
    expect(PERSONA_MIGRATIONS.length).toBeGreaterThanOrEqual(1);
    expect(PERSONA_MIGRATIONS[0].version).toBe(1);
    expect(PERSONA_MIGRATIONS[0].sql).toContain('vault_items');
    expect(PERSONA_MIGRATIONS[0].sql).toContain('vault_items_fts');
    expect(PERSONA_MIGRATIONS[0].sql).toContain('fts5');
  });

  it('persona schema can be applied to in-memory adapter', () => {
    const db = new InMemoryDatabaseAdapter();
    const applied = applyMigrations(db, PERSONA_MIGRATIONS);
    expect(applied).toBe(1);
    expect(db.hasTable('vault_items')).toBe(true);
    expect(db.hasTable('vault_items_fts')).toBe(true);
  });

  it('identity schema includes all expected indexes', () => {
    const sql = IDENTITY_MIGRATIONS[0].sql;
    expect(sql).toContain('idx_audit_log_ts');
    expect(sql).toContain('idx_audit_log_actor');
    expect(sql).toContain('idx_devices_pubkey');
    expect(sql).toContain('idx_reminders_due');
    expect(sql).toContain('idx_staging_status');
  });

  it('persona schema includes FTS5 triggers', () => {
    const sql = PERSONA_MIGRATIONS[0].sql;
    expect(sql).toContain('vault_items_ai');
    expect(sql).toContain('vault_items_ad');
    expect(sql).toContain('vault_items_au');
    expect(sql).toContain('content_l0');
    expect(sql).toContain('content_l1');
  });
});
