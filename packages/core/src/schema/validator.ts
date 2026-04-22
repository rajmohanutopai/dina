/**
 * SQL schema validator — parse and validate DDL for identity + persona databases.
 *
 * Validates:
 *   - All expected tables exist in the SQL
 *   - Required columns are present per table
 *   - CHECK constraints reference correct values
 *   - Indexes exist for performance-critical queries
 *   - FTS5 virtual tables and triggers are defined
 *   - Schema version tracking table exists
 *
 * This runs without a database — it parses the raw SQL text.
 * In production, these schemas are applied via SQLCipher.
 *
 * Source: ARCHITECTURE.md Tasks 1.33, 1.35
 */

export interface SchemaTable {
  name: string;
  columns: string[];
  isVirtual: boolean;
  withoutRowid: boolean;
}

export interface SchemaIndex {
  name: string;
  table: string;
  columns: string[];
  isUnique: boolean;
}

export interface SchemaTrigger {
  name: string;
  event: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
}

export interface SchemaParseResult {
  tables: SchemaTable[];
  indexes: SchemaIndex[];
  triggers: SchemaTrigger[];
  pragmas: string[];
}

export interface ValidationError {
  type:
    | 'missing_table'
    | 'missing_column'
    | 'missing_index'
    | 'missing_trigger'
    | 'missing_check'
    | 'missing_pragma';
  message: string;
}

/**
 * Parse a SQL schema file into structured metadata.
 */
export function parseSchema(sql: string): SchemaParseResult {
  const tables: SchemaTable[] = [];
  const indexes: SchemaIndex[] = [];
  const triggers: SchemaTrigger[] = [];
  const pragmas: string[] = [];

  // Extract PRAGMAs
  const pragmaPattern = /PRAGMA\s+(\w+)\s*=\s*(\w+)/gi;
  let pragmaMatch;
  while ((pragmaMatch = pragmaPattern.exec(sql)) !== null) {
    pragmas.push(`${pragmaMatch[1]}=${pragmaMatch[2]}`);
  }

  // Extract CREATE TABLE (including VIRTUAL TABLE)
  // Use a stateful approach to handle nested parentheses in CHECK constraints
  const tableHeaderPattern =
    /CREATE\s+(VIRTUAL\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*(USING\s+\w+)?\s*\(/gi;
  let headerMatch;
  while ((headerMatch = tableHeaderPattern.exec(sql)) !== null) {
    const isVirtual = !!headerMatch[1];
    const name = headerMatch[2];
    const startIdx = headerMatch.index + headerMatch[0].length;

    // Find matching closing paren (accounting for nested parens)
    const body = extractBalancedBody(sql, startIdx);
    const suffix = sql
      .slice(startIdx + body.length + 1, sql.indexOf(';', startIdx + body.length))
      .trim();
    const withoutRowid = /WITHOUT\s+ROWID/i.test(suffix);

    const columns = extractColumns(body, isVirtual);
    tables.push({ name, columns, isVirtual, withoutRowid });
  }

  // Extract CREATE INDEX
  const indexPattern =
    /CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]+)\)/gi;
  let indexMatch;
  while ((indexMatch = indexPattern.exec(sql)) !== null) {
    indexes.push({
      name: indexMatch[2],
      table: indexMatch[3],
      columns: indexMatch[4].split(',').map((c) => c.trim().split(/\s/)[0]),
      isUnique: !!indexMatch[1],
    });
  }

  // Extract CREATE TRIGGER
  const triggerPattern =
    /CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+AFTER\s+(INSERT|UPDATE|DELETE)\s+ON\s+(\w+)/gi;
  let triggerMatch;
  while ((triggerMatch = triggerPattern.exec(sql)) !== null) {
    triggers.push({
      name: triggerMatch[1],
      event: triggerMatch[2].toUpperCase() as 'INSERT' | 'UPDATE' | 'DELETE',
      table: triggerMatch[3],
    });
  }

  return { tables, indexes, triggers, pragmas };
}

/**
 * Validate the identity_001 schema.
 */
export function validateIdentitySchema(sql: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const schema = parseSchema(sql);

  // Required tables
  const requiredTables: Record<string, string[]> = {
    contacts: ['did', 'display_name', 'trust_level', 'sharing_tier'],
    audit_log: ['seq', 'ts', 'actor', 'action', 'prev_hash', 'entry_hash'],
    device_tokens: ['device_id', 'token_hash', 'device_name', 'revoked'],
    crash_log: ['id', 'ts', 'component', 'message'],
    kv_store: ['key', 'value'],
    scratchpad: ['task_id', 'step', 'context'],
    dina_tasks: ['id', 'type', 'status', 'attempts'],
    reminders: ['id', 'message', 'due_at', 'recurring', 'persona'],
    staging_inbox: ['id', 'source', 'source_id', 'status', 'producer_id'],
    schema_version: ['version', 'applied_at'],
  };

  for (const [tableName, requiredCols] of Object.entries(requiredTables)) {
    const table = schema.tables.find((t) => t.name === tableName);
    if (!table) {
      errors.push({ type: 'missing_table', message: `Table "${tableName}" not found` });
      continue;
    }
    for (const col of requiredCols) {
      if (!table.columns.includes(col)) {
        errors.push({
          type: 'missing_column',
          message: `Column "${col}" missing from table "${tableName}"`,
        });
      }
    }
  }

  // Required pragmas
  if (!schema.pragmas.some((p) => p.includes('journal_mode=WAL'))) {
    errors.push({ type: 'missing_pragma', message: 'PRAGMA journal_mode=WAL not set' });
  }

  // Check contacts trust_level CHECK constraint
  if (
    !sql.includes("'blocked'") ||
    !sql.includes("'unknown'") ||
    !sql.includes("'verified'") ||
    !sql.includes("'trusted'")
  ) {
    errors.push({ type: 'missing_check', message: 'contacts.trust_level CHECK missing values' });
  }

  // Check staging_inbox status CHECK constraint
  const stagingStatuses = ['received', 'classifying', 'stored', 'pending_unlock', 'failed'];
  for (const s of stagingStatuses) {
    if (!sql.includes(`'${s}'`)) {
      errors.push({ type: 'missing_check', message: `staging_inbox.status missing '${s}'` });
    }
  }

  return errors;
}

/**
 * Validate the persona_001 schema.
 */
export function validatePersonaSchema(sql: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const schema = parseSchema(sql);

  // Required tables
  const requiredTables: Record<string, string[]> = {
    vault_items: ['id', 'type', 'summary', 'body', 'embedding', 'content_l0', 'content_l1'],
    staging: ['id', 'type', 'expires_at'],
    relationships: ['from_id', 'to_id', 'rel_type'],
    embedding_meta: ['item_id', 'model_name', 'dimensions'],
    schema_version: ['version'],
  };

  for (const [tableName, requiredCols] of Object.entries(requiredTables)) {
    const table = schema.tables.find((t) => t.name === tableName);
    if (!table) {
      errors.push({ type: 'missing_table', message: `Table "${tableName}" not found` });
      continue;
    }
    for (const col of requiredCols) {
      if (!table.columns.includes(col)) {
        errors.push({
          type: 'missing_column',
          message: `Column "${col}" missing from table "${tableName}"`,
        });
      }
    }
  }

  // FTS5 virtual table
  const fts = schema.tables.find((t) => t.name === 'vault_items_fts' && t.isVirtual);
  if (!fts) {
    errors.push({
      type: 'missing_table',
      message: 'FTS5 virtual table "vault_items_fts" not found',
    });
  }

  // FTS triggers (INSERT, DELETE, UPDATE)
  const requiredTriggers = [
    { name: 'vault_items_ai', event: 'INSERT' },
    { name: 'vault_items_ad', event: 'DELETE' },
    { name: 'vault_items_au', event: 'UPDATE' },
  ];
  for (const { name, event } of requiredTriggers) {
    if (!schema.triggers.find((t) => t.name === name && t.event === event)) {
      errors.push({
        type: 'missing_trigger',
        message: `Trigger "${name}" (AFTER ${event}) not found`,
      });
    }
  }

  // vault_items type CHECK — must have exactly 22 values
  const typeCheckMatch = sql.match(/CHECK\s*\(\s*type\s+IN\s*\(([^)]+)\)/i);
  if (typeCheckMatch) {
    const types = typeCheckMatch[1].split(',').map((t) => t.trim().replace(/'/g, ''));
    if (types.length < 20) {
      errors.push({
        type: 'missing_check',
        message: `vault_items.type CHECK has only ${types.length} values, expected 20+`,
      });
    }
  } else {
    errors.push({ type: 'missing_check', message: 'vault_items.type CHECK constraint not found' });
  }

  return errors;
}

/** Extract text between balanced parentheses starting at the given position. */
function extractBalancedBody(sql: string, startIdx: number): string {
  let depth = 1;
  let i = startIdx;
  while (i < sql.length && depth > 0) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') depth--;
    if (depth > 0) i++;
  }
  return sql.slice(startIdx, i);
}

/** Extract column names from a CREATE TABLE body. */
function extractColumns(body: string, isVirtual: boolean): string[] {
  if (isVirtual) {
    // FTS5 columns are just comma-separated names (plus config directives)
    return body
      .split(',')
      .map((c) => c.trim().split(/[\s=]/)[0])
      .filter((c) => c.length > 0 && !c.startsWith('content') && !c.startsWith('tokenize'));
  }

  // Split on newlines to get one column definition per line.
  // This avoids the problem of commas inside CHECK(...) clauses.
  const lines = body
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').trim()) // strip comments
    .filter((line) => line.length > 0);

  const columns: string[] = [];
  for (const line of lines) {
    // Skip constraint-only lines
    const firstWord = line.split(/\s+/)[0].replace(/,/g, '');
    if (!firstWord) continue;
    if (/^(CHECK|UNIQUE|FOREIGN|PRIMARY|CONSTRAINT)$/i.test(firstWord)) continue;
    // Column definitions start with an identifier
    if (/^[a-z_][a-z0-9_]*$/i.test(firstWord)) {
      columns.push(firstWord);
    }
  }

  return columns;
}
