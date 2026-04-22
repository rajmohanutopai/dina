/**
 * T2A.21 — Identity database schema validation.
 *
 * Category B: contract test. Verifies DDL matches server schema.
 *
 * Source: core/internal/adapter/sqlite/schema/identity_001.sql, identity_002_trust_cache.sql
 */

import {
  getIdentity001DDL,
  getIdentity002DDL,
  getIdentityTableNames,
  getTableColumns,
} from '../../src/schema/identity';

describe('Identity Database Schema', () => {
  describe('identity_001', () => {
    it('returns DDL string', () => {
      const ddl = getIdentity001DDL();
      expect(typeof ddl).toBe('string');
      expect(ddl.length).toBeGreaterThan(100);
    });

    it('DDL contains CREATE TABLE statements', () => {
      const ddl = getIdentity001DDL();
      expect(ddl).toContain('CREATE TABLE');
    });

    it('includes mobile-adapted paired_devices (not device_tokens)', () => {
      const ddl = getIdentity001DDL();
      expect(ddl).toContain('paired_devices');
      expect(ddl).not.toContain('device_tokens');
    });

    it('uses public_key_multibase (not token_hash)', () => {
      const ddl = getIdentity001DDL();
      expect(ddl).toContain('public_key_multibase');
      expect(ddl).not.toContain('token_hash');
    });
  });

  describe('identity_002 (trust cache)', () => {
    it('returns DDL string', () => {
      const ddl = getIdentity002DDL();
      expect(typeof ddl).toBe('string');
      expect(ddl).toContain('trust_cache');
    });

    it('trust_cache has trust_score CHECK constraint', () => {
      const ddl = getIdentity002DDL();
      expect(ddl).toContain('trust_score');
      expect(ddl).toContain('CHECK');
    });
  });

  describe('table name list', () => {
    it('returns non-empty list', () => {
      const names = getIdentityTableNames();
      expect(names.length).toBeGreaterThan(5);
    });

    it('includes all required tables', () => {
      const names = getIdentityTableNames();
      expect(names).toContain('contacts');
      expect(names).toContain('audit_log');
      expect(names).toContain('paired_devices');
      expect(names).toContain('crash_log');
      expect(names).toContain('kv_store');
      expect(names).toContain('scratchpad');
      expect(names).toContain('dina_tasks');
      expect(names).toContain('reminders');
      expect(names).toContain('staging_inbox');
      expect(names).toContain('schema_version');
      expect(names).toContain('trust_cache');
    });
  });

  describe('table columns', () => {
    it('contacts has display_name (not name)', () => {
      const cols = getTableColumns('contacts');
      expect(cols).toContain('display_name');
      expect(cols).not.toContain('name');
    });

    it('contacts has sharing_tier', () => {
      expect(getTableColumns('contacts')).toContain('sharing_tier');
    });

    it('audit_log has all hash chain fields', () => {
      const cols = getTableColumns('audit_log');
      expect(cols).toContain('seq');
      expect(cols).toContain('ts');
      expect(cols).toContain('actor');
      expect(cols).toContain('action');
      expect(cols).toContain('resource');
      expect(cols).toContain('detail');
      expect(cols).toContain('prev_hash');
      expect(cols).toContain('entry_hash');
    });

    it('dina_tasks has max_attempts and scheduled_at', () => {
      const cols = getTableColumns('dina_tasks');
      expect(cols).toContain('max_attempts');
      expect(cols).toContain('scheduled_at');
    });

    it('reminders has due_at and recurring', () => {
      const cols = getTableColumns('reminders');
      expect(cols).toContain('due_at');
      expect(cols).toContain('recurring');
    });

    it('staging_inbox has source_hash and producer_id', () => {
      const cols = getTableColumns('staging_inbox');
      expect(cols).toContain('source_hash');
      expect(cols).toContain('producer_id');
    });

    it('paired_devices has public_key_multibase (mobile adaptation)', () => {
      const cols = getTableColumns('paired_devices');
      expect(cols).toContain('public_key_multibase');
      expect(cols).toContain('device_id');
      expect(cols).toContain('device_name');
    });

    it('throws for unknown table', () => {
      expect(() => getTableColumns('nonexistent')).toThrow('unknown table');
    });
  });
});
