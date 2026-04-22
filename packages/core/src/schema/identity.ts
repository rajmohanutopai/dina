/**
 * Identity database schema — DDL from identity_001.sql + identity_002_trust_cache.sql.
 *
 * Provides the schema DDL as strings and table metadata for contract tests.
 * The DDL matches the server's schema exactly.
 *
 * Mobile adaptation: server's `device_tokens` table is replaced with
 * `paired_devices` using `public_key_multibase` instead of `token_hash`
 * (Ed25519 device keys, not CLIENT_TOKEN hashes).
 *
 * Source: core/internal/adapter/sqlite/schema/identity_001.sql, identity_002_trust_cache.sql
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------
// Table column metadata
// ---------------------------------------------------------------

/** Column definitions for each table in the identity database. */
const TABLE_COLUMNS: Record<string, string[]> = {
  contacts: [
    'did',
    'display_name',
    'trust_level',
    'sharing_tier',
    'notes',
    'created_at',
    'updated_at',
  ],
  audit_log: ['seq', 'ts', 'actor', 'action', 'resource', 'detail', 'prev_hash', 'entry_hash'],
  paired_devices: [
    'device_id',
    'public_key_multibase',
    'device_name',
    'last_seen',
    'created_at',
    'revoked',
  ],
  crash_log: ['id', 'ts', 'component', 'message', 'stack_hash', 'reported'],
  kv_store: ['key', 'value', 'updated_at'],
  scratchpad: ['task_id', 'step', 'context', 'created_at', 'updated_at'],
  dina_tasks: [
    'id',
    'type',
    'payload',
    'status',
    'attempts',
    'max_attempts',
    'scheduled_at',
    'started_at',
    'completed_at',
    'error',
    'created_at',
  ],
  reminders: [
    'id',
    'message',
    'due_at',
    'recurring',
    'completed',
    'created_at',
    'source_item_id',
    'source',
    'persona',
    'timezone',
    'kind',
    'status',
  ],
  staging_inbox: [
    'id',
    'connector_id',
    'source',
    'source_id',
    'source_hash',
    'type',
    'summary',
    'body',
    'sender',
    'metadata',
    'status',
    'target_persona',
    'classified_item',
    'error',
    'retry_count',
    'claimed_at',
    'lease_until',
    'expires_at',
    'created_at',
    'updated_at',
    'ingress_channel',
    'origin_did',
    'origin_kind',
    'producer_id',
  ],
  schema_version: ['version', 'applied_at', 'description'],
  trust_cache: [
    'did',
    'display_name',
    'trust_score',
    'trust_ring',
    'relationship',
    'source',
    'last_verified_at',
    'updated_at',
  ],
};

/** All table names in the identity database (identity_001 + identity_002). */
const IDENTITY_TABLE_NAMES = Object.keys(TABLE_COLUMNS);

// ---------------------------------------------------------------
// DDL loading
// ---------------------------------------------------------------

/** Cached DDL strings. */
let identity001DDL: string | null = null;
let identity002DDL: string | null = null;

/**
 * Get the identity_001 schema DDL (all tables).
 * Adapts device_tokens → paired_devices for mobile.
 */
export function getIdentity001DDL(): string {
  if (!identity001DDL) {
    const fixturePath = path.resolve(__dirname, '../../../fixtures/schema/identity_001.sql');
    let ddl = fs.readFileSync(fixturePath, 'utf-8');

    // Mobile adaptation: rename device_tokens → paired_devices, token_hash → public_key_multibase
    ddl = ddl.replace(/device_tokens/g, 'paired_devices');
    ddl = ddl.replace(/token_hash/g, 'public_key_multibase');

    identity001DDL = ddl;
  }
  return identity001DDL;
}

/**
 * Get the identity_002 trust cache DDL (applied alongside identity_001 on first boot).
 */
export function getIdentity002DDL(): string {
  if (!identity002DDL) {
    const fixturePath = path.resolve(
      __dirname,
      '../../../fixtures/schema/identity_002_trust_cache.sql',
    );
    identity002DDL = fs.readFileSync(fixturePath, 'utf-8');
  }
  return identity002DDL;
}

/**
 * Get a list of all table names in the identity database.
 */
export function getIdentityTableNames(): string[] {
  return [...IDENTITY_TABLE_NAMES];
}

/**
 * Get column names for a specific table.
 * @throws if table name is unknown
 */
export function getTableColumns(tableName: string): string[] {
  const columns = TABLE_COLUMNS[tableName];
  if (!columns) {
    throw new Error(`schema: unknown table "${tableName}"`);
  }
  return [...columns];
}
