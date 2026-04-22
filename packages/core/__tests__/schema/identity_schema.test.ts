/**
 * T1.33 — Identity DB schema validation (identity_001.sql).
 *
 * Validates the schema SQL defines all required tables, columns,
 * constraints, indexes, and pragmas.
 *
 * Source: ARCHITECTURE.md Task 1.33
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseSchema, validateIdentitySchema } from '../../src/schema/validator';

const SCHEMA_PATH = path.resolve(__dirname, '../../../fixtures/schema/identity_001.sql');
const sql = fs.readFileSync(SCHEMA_PATH, 'utf-8');

describe('Identity DB Schema — identity_001.sql (1.33)', () => {
  describe('validation', () => {
    it('passes validation with no errors', () => {
      const errors = validateIdentitySchema(sql);
      if (errors.length > 0) {
        console.log('Validation errors:', errors);
      }
      expect(errors).toHaveLength(0);
    });
  });

  describe('tables', () => {
    const schema = parseSchema(sql);

    it('defines contacts table', () => {
      const t = schema.tables.find((t) => t.name === 'contacts');
      expect(t).toBeDefined();
      expect(t!.columns).toContain('did');
      expect(t!.columns).toContain('display_name');
      expect(t!.columns).toContain('trust_level');
      expect(t!.columns).toContain('sharing_tier');
      expect(t!.withoutRowid).toBe(true);
    });

    it('defines audit_log table with hash chain columns', () => {
      const t = schema.tables.find((t) => t.name === 'audit_log');
      expect(t).toBeDefined();
      expect(t!.columns).toContain('prev_hash');
      expect(t!.columns).toContain('entry_hash');
      expect(t!.columns).toContain('actor');
      expect(t!.columns).toContain('action');
    });

    it('defines device_tokens table', () => {
      const t = schema.tables.find((t) => t.name === 'device_tokens');
      expect(t).toBeDefined();
      expect(t!.columns).toContain('device_id');
      expect(t!.columns).toContain('token_hash');
      expect(t!.columns).toContain('revoked');
    });

    it('defines kv_store table', () => {
      const t = schema.tables.find((t) => t.name === 'kv_store');
      expect(t).toBeDefined();
      expect(t!.columns).toContain('key');
      expect(t!.columns).toContain('value');
      expect(t!.withoutRowid).toBe(true);
    });

    it('defines scratchpad table', () => {
      const t = schema.tables.find((t) => t.name === 'scratchpad');
      expect(t).toBeDefined();
      expect(t!.columns).toContain('task_id');
      expect(t!.columns).toContain('step');
      expect(t!.columns).toContain('context');
    });

    it('defines dina_tasks table', () => {
      const t = schema.tables.find((t) => t.name === 'dina_tasks');
      expect(t).toBeDefined();
      expect(t!.columns).toContain('status');
      expect(t!.columns).toContain('attempts');
    });

    it('defines reminders table with dedup columns', () => {
      const t = schema.tables.find((t) => t.name === 'reminders');
      expect(t).toBeDefined();
      expect(t!.columns).toContain('message');
      expect(t!.columns).toContain('due_at');
      expect(t!.columns).toContain('recurring');
      expect(t!.columns).toContain('persona');
      expect(t!.columns).toContain('source_item_id');
    });

    it('defines staging_inbox table', () => {
      const t = schema.tables.find((t) => t.name === 'staging_inbox');
      expect(t).toBeDefined();
      expect(t!.columns).toContain('source');
      expect(t!.columns).toContain('source_id');
      expect(t!.columns).toContain('status');
      expect(t!.columns).toContain('producer_id');
      expect(t!.columns).toContain('lease_until');
    });

    it('defines schema_version table', () => {
      const t = schema.tables.find((t) => t.name === 'schema_version');
      expect(t).toBeDefined();
      expect(t!.columns).toContain('version');
    });

    it('defines exactly 10 tables', () => {
      expect(schema.tables).toHaveLength(10);
    });
  });

  describe('indexes', () => {
    const schema = parseSchema(sql);

    it('has index on contacts.trust_level', () => {
      expect(schema.indexes.find((i) => i.name === 'idx_contacts_trust')).toBeDefined();
    });

    it('has indexes on audit_log', () => {
      expect(schema.indexes.find((i) => i.name === 'idx_audit_log_ts')).toBeDefined();
      expect(schema.indexes.find((i) => i.name === 'idx_audit_log_actor')).toBeDefined();
    });

    it('has unique dedup index on staging_inbox', () => {
      const idx = schema.indexes.find((i) => i.name === 'idx_staging_inbox_dedup');
      expect(idx).toBeDefined();
      expect(idx!.isUnique).toBe(true);
    });

    it('has unique dedup index on reminders', () => {
      const idx = schema.indexes.find((i) => i.name === 'idx_reminders_dedup');
      expect(idx).toBeDefined();
      expect(idx!.isUnique).toBe(true);
    });
  });

  describe('CHECK constraints', () => {
    it('contacts.trust_level has blocked/unknown/verified/trusted', () => {
      expect(sql).toContain("'blocked'");
      expect(sql).toContain("'unknown'");
      expect(sql).toContain("'verified'");
      expect(sql).toContain("'trusted'");
    });

    it('staging_inbox.status has all pipeline states', () => {
      expect(sql).toContain("'received'");
      expect(sql).toContain("'classifying'");
      expect(sql).toContain("'stored'");
      expect(sql).toContain("'pending_unlock'");
      expect(sql).toContain("'failed'");
    });

    it('reminders.recurring has daily/weekly/monthly', () => {
      expect(sql).toContain("'daily'");
      expect(sql).toContain("'weekly'");
      expect(sql).toContain("'monthly'");
    });
  });

  describe('pragmas', () => {
    const schema = parseSchema(sql);

    it('sets journal_mode=WAL', () => {
      expect(schema.pragmas).toContain('journal_mode=WAL');
    });

    it('sets foreign_keys=ON', () => {
      expect(schema.pragmas).toContain('foreign_keys=ON');
    });
  });
});
