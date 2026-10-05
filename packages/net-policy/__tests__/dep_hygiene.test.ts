/**
 * Dep-hygiene gate — @dina/net-policy is pure policy (UCP plan §3.3): Core,
 * the phone (Hermes), the Node socket package and AppView all import it, so it
 * imports nothing but its own files. Not even `node:` builtins.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

describe('dep hygiene', () => {
  const files = readdirSync(join(ROOT, 'src')).filter((n) => n.endsWith('.ts'));

  it('finds source files (sanity)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('src/ imports only relative paths', () => {
    const violations: string[] = [];
    for (const name of files) {
      const source = readFileSync(join(ROOT, 'src', name), 'utf8');
      for (const m of source.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1] as string;
        if (!spec.startsWith('./')) violations.push(`${name}: "${spec}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('package.json has no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
  });
});
