/**
 * T2A.22 — Persona vault schema validation.
 *
 * Category B: contract test. Verifies DDL matches server persona_001.sql.
 *
 * Source: core/internal/adapter/sqlite/schema/persona_001.sql
 */

import {
  getPersona001DDL,
  getPersonaTableNames,
  getVaultItemsColumns,
  getVaultItemTypeValues,
} from '../../src/schema/persona';
import { VAULT_ITEM_TYPES } from '@dina/test-harness';

describe('Persona Vault Schema', () => {
  describe('persona_001', () => {
    it('returns DDL string', () => {
      const ddl = getPersona001DDL();
      expect(typeof ddl).toBe('string');
      expect(ddl.length).toBeGreaterThan(100);
    });

    it('DDL contains CREATE TABLE vault_items', () => {
      expect(getPersona001DDL()).toContain('CREATE TABLE');
      expect(getPersona001DDL()).toContain('vault_items');
    });

    it('includes all required tables', () => {
      const names = getPersonaTableNames();
      expect(names).toContain('vault_items');
      expect(names).toContain('vault_items_fts');
      expect(names).toContain('relationships');
      expect(names).toContain('embedding_meta');
      expect(names).toContain('staging');
      expect(names).toContain('schema_version');
    });
  });

  describe('vault_items table', () => {
    it('has body column (not body_text)', () => {
      const cols = getVaultItemsColumns();
      expect(cols).toContain('body');
      expect(cols).not.toContain('body_text');
    });

    it('has tags column', () => {
      expect(getVaultItemsColumns()).toContain('tags');
    });

    it('has enrichment_status and enrichment_version', () => {
      const cols = getVaultItemsColumns();
      expect(cols).toContain('enrichment_status');
      expect(cols).toContain('enrichment_version');
    });

    it('has content_l0 and content_l1', () => {
      const cols = getVaultItemsColumns();
      expect(cols).toContain('content_l0');
      expect(cols).toContain('content_l1');
    });

    it('has deleted column (soft delete)', () => {
      expect(getVaultItemsColumns()).toContain('deleted');
    });

    it('has contradicts column', () => {
      expect(getVaultItemsColumns()).toContain('contradicts');
    });

    it('has sender_trust and retrieval_policy', () => {
      const cols = getVaultItemsColumns();
      expect(cols).toContain('sender_trust');
      expect(cols).toContain('retrieval_policy');
    });
  });

  describe('vault_items.type CHECK constraint', () => {
    it('returns 23 type values', () => {
      expect(getVaultItemTypeValues()).toHaveLength(23);
    });

    it('matches VAULT_ITEM_TYPES from test harness', () => {
      const types = getVaultItemTypeValues();
      for (const t of VAULT_ITEM_TYPES) {
        expect(types).toContain(t);
      }
    });

    it('includes relationship_note', () => {
      expect(getVaultItemTypeValues()).toContain('relationship_note');
    });

    it('includes trust_attestation', () => {
      expect(getVaultItemTypeValues()).toContain('trust_attestation');
    });

    it('includes medical_record and medical_note', () => {
      const types = getVaultItemTypeValues();
      expect(types).toContain('medical_record');
      expect(types).toContain('medical_note');
    });
  });

  describe('relationships table', () => {
    it('uses from_id/to_id (in DDL)', () => {
      const ddl = getPersona001DDL();
      expect(ddl).toContain('from_id');
      expect(ddl).toContain('to_id');
    });

    it('has rel_type CHECK constraint', () => {
      const ddl = getPersona001DDL();
      expect(ddl).toContain('rel_type');
      expect(ddl).toContain("'related'");
    });
  });

  describe('embedding_meta table', () => {
    it('exists in table list', () => {
      expect(getPersonaTableNames()).toContain('embedding_meta');
    });

    it('DDL includes model_name and dimensions', () => {
      const ddl = getPersona001DDL();
      expect(ddl).toContain('model_name');
      expect(ddl).toContain('dimensions');
    });
  });
});
