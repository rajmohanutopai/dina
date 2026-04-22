/**
 * Dep-hygiene gate — @dina/protocol is a leaf package.
 *
 * It must never import from `@dina/core`, `@dina/brain`, or any of the
 * other `@dina/*-node` / `@dina/*-expo` adapter packages. The whole
 * point of extracting the protocol is that it's independently
 * consumable; a reverse edge here would fold the rest of the workspace
 * back in.
 *
 * Additionally, it must have **zero runtime npm deps** — the only
 * imports should resolve to TypeScript/Node builtins or relative
 * paths within this package.
 *
 * Enforced as a jest test so CI fails on violation. Mirrors the
 * requirement called out in docs/HOME_NODE_LITE_TASKS.md task 1.26.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PROTOCOL_SRC = resolve(__dirname, '..', 'src');

/** Forbidden specifier prefixes — any import starting with one of these fails the gate. */
const FORBIDDEN_PREFIXES = [
  '@dina/core',
  '@dina/brain',
  '@dina/test-harness',
  '@dina/fixtures',
  '@dina/storage-node',
  '@dina/crypto-node',
  '@dina/fs-node',
  '@dina/net-node',
  '@dina/keystore-node',
  '@dina/adapters-node',
  '@dina/storage-expo',
  '@dina/crypto-expo',
  '@dina/fs-expo',
  '@dina/net-expo',
  '@dina/keystore-expo',
  '@dina/adapters-expo',
  '@dina/app',
];

/** Third-party runtime deps protocol must never pull — it's a zero-dep package. */
const FORBIDDEN_RUNTIME_DEPS = [
  '@noble/',
  '@scure/',
  'hash-wasm',
  'tweetnacl',
  'libsodium',
  'argon2',
  'undici',
  'ws',
  'fetch',
];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (full.endsWith('.ts')) {
      yield full;
    }
  }
}

function collectImportSpecifiers(src: string): string[] {
  // Match both `import … from 'x'` and `import 'x'` side-effect imports,
  // plus dynamic `import('x')` and `require('x')`.
  const specs: string[] = [];
  const patterns = [
    /import\s+[^;]*?from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /import\(['"]([^'"]+)['"]\)/g,
    /require\(['"]([^'"]+)['"]\)/g,
  ];
  for (const p of patterns) {
    for (const m of src.matchAll(p)) {
      const spec = m[1];
      if (spec) specs.push(spec);
    }
  }
  return specs;
}

describe('@dina/protocol dependency hygiene (task 1.26)', () => {
  const files = [...walk(PROTOCOL_SRC)];

  it('discovers at least one source file (sanity — guards against an empty src/)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no source file imports from another @dina/* workspace package', () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const spec of collectImportSpecifiers(src)) {
        if (FORBIDDEN_PREFIXES.some((p) => spec === p || spec.startsWith(p + '/'))) {
          offenders.push({ file: f.replace(PROTOCOL_SRC, 'src'), specifier: spec });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no source file pulls a third-party runtime dep', () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const spec of collectImportSpecifiers(src)) {
        // Skip built-ins (`node:*`), relative paths, and TS-type-only imports
        // (`type X from 'y'` already captured by the regex; we allow those
        // only if they match our allowlist — but the simpler invariant is
        // "no runtime imports at all" because the package is types+constants+
        // pure-function only).
        if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/')) continue;
        if (FORBIDDEN_RUNTIME_DEPS.some((p) => spec === p || spec.startsWith(p))) {
          offenders.push({ file: f.replace(PROTOCOL_SRC, 'src'), specifier: spec });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('package.json declares no runtime `dependencies`', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
