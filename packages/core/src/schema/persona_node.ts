/**
 * Node-only DDL fixture loader for the persona-vault database. Portable
 * column metadata lives in `./persona.ts`. Reachable only through
 * `@dina/core/node`.
 */

import * as fs from 'fs';
import * as path from 'path';

let persona001DDL: string | null = null;

/** Get the persona_001 schema DDL. */
export function getPersona001DDL(): string {
  if (!persona001DDL) {
    const fixturePath = path.resolve(__dirname, '../../../fixtures/schema/persona_001.sql');
    persona001DDL = fs.readFileSync(fixturePath, 'utf-8');
  }
  return persona001DDL;
}
