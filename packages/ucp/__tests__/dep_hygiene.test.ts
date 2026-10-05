/**
 * Dep-hygiene gate — @dina/ucp is a leaf contract package (UCP plan §3.6,
 * §4.1): runtime-neutral and free of React/Node/Expo/Fastify/database/LLM
 * imports, so Core, the phone (Hermes) and AppView run the same code.
 *
 * src/ may import relative paths and one workspace package, @dina/a2a, which
 * is itself a zero-dependency leaf (its RFC 8785 canonical JSON, base64url,
 * strict JSON and outbound-URL check are shared, not copied). Not even
 * `node:` builtins.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(__dirname, '..', 'src');
const ALLOWED_PACKAGES = new Set(['@dina/a2a']);

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function specifiersIn(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /import\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
    /export\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // Side-effect imports: `import 'node:crypto';`.
    /^\s*import\s*['"]([^'"]+)['"]/gm,
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

  it('src/ imports only relative paths and @dina/a2a', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const spec of specifiersIn(readFileSync(file, 'utf8'))) {
        const relative = spec.startsWith('./') || spec.startsWith('../');
        if (!relative && !ALLOWED_PACKAGES.has(spec)) violations.push(`${file}: "${spec}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('package.json depends at runtime on @dina/a2a only', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@dina/a2a']);
  });

  it('@dina/a2a is itself dependency-free, so the package stays a leaf', () => {
    const a2a = JSON.parse(
      readFileSync(resolve(__dirname, '..', '..', 'a2a', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(a2a.dependencies).toBeUndefined();
  });

  it('src/ uses no Node-only global (it runs on Hermes too)', () => {
    const violations: string[] = [];
    for (const file of files) {
      // Comments may name them; code may not.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const pattern of [
        /\bBuffer\b/,
        /\bprocess\./,
        /\b__dirname\b/,
        /\brequire\s*\(/,
        /\bglobal\./,
      ]) {
        if (pattern.test(code)) violations.push(`${file}: ${pattern.source}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
