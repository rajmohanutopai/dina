/**
 * Node-only DDL fixture loaders for the identity database. Portable
 * column metadata lives in `./identity.ts`. This adapter is reachable
 * only through `@dina/core/node`.
 */

import * as fs from 'fs';
import * as path from 'path';

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
