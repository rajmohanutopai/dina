/**
 * Node-only fixture-file loaders for cross-language test vectors. The
 * portable validation functions live in `./vector_validator.ts`.
 * Reachable only through `@dina/core/node`.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { VectorFile } from './vector_validator';

/**
 * Load all fixture files from the fixtures/crypto directory.
 */
export function loadFixtures(fixturesDir: string): VectorFile[] {
  const files = fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));

  return files.map((f) => {
    const content = fs.readFileSync(path.join(fixturesDir, f), 'utf-8');
    return JSON.parse(content) as VectorFile;
  });
}

/**
 * Load a specific fixture file by name.
 */
export function loadFixture(fixturesDir: string, name: string): VectorFile {
  const filePath = path.join(fixturesDir, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Fixture not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as VectorFile;
}
