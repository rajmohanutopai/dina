/**
 * Persona vault schema — DDL from persona_001.sql.
 *
 * Each persona has its own SQLCipher database with this schema.
 * Tables: vault_items (with FTS5), staging, relationships, embedding_meta, schema_version.
 * vault_items.type CHECK has 23 values matching VAULT_ITEM_TYPES.
 *
 * Source: core/internal/adapter/sqlite/schema/persona_001.sql
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------
// Table metadata
// ---------------------------------------------------------------

/** Vault items column names (matches persona_001.sql CREATE TABLE). */
const VAULT_ITEMS_COLUMNS = [
  'id',
  'type',
  'source',
  'source_id',
  'contact_did',
  'summary',
  'body',
  'metadata',
  'embedding',
  'tags',
  'timestamp',
  'created_at',
  'updated_at',
  'deleted',
  'sender',
  'sender_trust',
  'source_type',
  'confidence',
  'retrieval_policy',
  'contradicts',
  'content_l0',
  'content_l1',
  'enrichment_status',
  'enrichment_version',
];

/** The 23 vault_items.type CHECK constraint values. */
const VAULT_ITEM_TYPE_VALUES = [
  'email',
  'message',
  'event',
  'note',
  'photo',
  'email_draft',
  'cart_handover',
  'contact_card',
  'document',
  'bookmark',
  'voice_memo',
  'kv',
  'contact',
  'health_context',
  'work_context',
  'finance_context',
  'family_context',
  'trust_review',
  'purchase_decision',
  'relationship_note',
  'medical_record',
  'medical_note',
  'trust_attestation',
];

/** All tables in a persona vault database. */
const PERSONA_TABLE_NAMES = [
  'vault_items',
  'vault_items_fts',
  'staging',
  'relationships',
  'embedding_meta',
  'schema_version',
];

// ---------------------------------------------------------------
// DDL loading
// ---------------------------------------------------------------

let persona001DDL: string | null = null;

/** Get the persona_001 schema DDL. */
export function getPersona001DDL(): string {
  if (!persona001DDL) {
    const fixturePath = path.resolve(__dirname, '../../../fixtures/schema/persona_001.sql');
    persona001DDL = fs.readFileSync(fixturePath, 'utf-8');
  }
  return persona001DDL;
}

/** Get a list of all table names in a persona vault database. */
export function getPersonaTableNames(): string[] {
  return [...PERSONA_TABLE_NAMES];
}

/** Get column names for vault_items table. */
export function getVaultItemsColumns(): string[] {
  return [...VAULT_ITEMS_COLUMNS];
}

/** Get the vault_items.type CHECK constraint values (23 types). */
export function getVaultItemTypeValues(): string[] {
  return [...VAULT_ITEM_TYPE_VALUES];
}
