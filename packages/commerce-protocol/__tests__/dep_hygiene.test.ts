/**
 * Dep-hygiene gate — @dina/commerce-protocol is a leaf package (§6.1):
 * dependency-light, runtime-neutral, free of React/Node/Expo/Fastify/
 * database/LLM imports, and independently consumable by plugins, Core
 * validators, AppView, SDKs, and third-party providers.
 *
 * src/ may import ONLY relative paths. Not even `node:` builtins —
 * the package must run identically on Hermes, workers, and browsers.
 * Mirrors @dina/protocol's gate.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(__dirname, '..', 'src');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** import/export-from/require specifiers in a source file. */
function specifiersIn(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /import\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
    /export\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) out.push(match[1] as string);
  }
  return out;
}

describe('dep hygiene', () => {
  const files = tsFilesUnder(SRC);

  it('finds source files (sanity)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('src/ imports only relative paths — no npm deps, no @dina/*, no node builtins', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const spec of specifiersIn(readFileSync(file, 'utf8'))) {
        if (!spec.startsWith('./') && !spec.startsWith('../')) {
          violations.push(`${file}: "${spec}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('package.json declares zero runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).toBeUndefined();
  });
});
