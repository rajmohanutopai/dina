/**
 * `@dina/core` dependency-hygiene gate (CA-31).
 *
 * `packages/core/src/**` is portable. Mobile (Expo + RN), Node (server),
 * and any future runtime all consume Core through the same package. The
 * portable surface must not import Node stdlib, server frameworks, or
 * HTTP polyfills — those live in Node-only adapters that are reachable
 * only through the `@dina/core/node` subpath.
 *
 * Convention: any file ending in `_node.ts` is exempt from this gate.
 * Those files are explicitly the Node adapters (`identity/keypair_node.ts`,
 * `storage/seed_file_node.ts`, etc.) and `@dina/core/node` re-exports
 * them. Adding a new Node-only file? Use the `_node.ts` suffix and add
 * its public surface to `node.ts`.
 *
 * Mirrors the pattern in `packages/brain/__tests__/dep_hygiene.test.ts`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CORE_SRC = resolve(__dirname, '..', '..', 'src');

/**
 * Forbidden module specifiers — exact match, or `PREFIX/...` for
 * those listed in FORBIDDEN_PREFIXES.
 *
 * Two-tier reasoning:
 *   - Node stdlib (`fs`, `path`, `node:fs`, etc.) — portable Core must
 *     work on Expo/RN where these don't exist. File-backed adapters
 *     belong in `*_node.ts` siblings reached through `@dina/core/node`.
 *   - HTTP/server libs (`undici`, `ws`, `fastify`, etc.) — Core's
 *     transport boundary is `CoreClient` + `CoreRouter`. Server boot
 *     wires Fastify around `bindCoreRouter`; Core source itself never
 *     pulls those in.
 */
const FORBIDDEN_SPECIFIERS: readonly string[] = [
  'fs',
  'path',
  'os',
  'node:fs',
  'node:path',
  'node:os',
  'node:async_hooks',
  'node:crypto',
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
  'undici',
  'ws',
  'isomorphic-ws',
  'fastify',
  'node-fetch',
];

const FORBIDDEN_PREFIXES: readonly string[] = ['@fastify/', '@whatwg-node/'];

/** Files exempt from the gate — Node-only adapters by convention. */
function isNodeAdapter(filePath: string): boolean {
  return filePath.endsWith('_node.ts');
}

function* walkPortableTs(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* walkPortableTs(full);
    } else if (full.endsWith('.ts') && !full.endsWith('.d.ts') && !isNodeAdapter(full)) {
      yield full;
    }
  }
}

/**
 * Same regex set as the Brain hygiene gate — matches every flavour of
 * import / require / dynamic-import. Type-only imports are still
 * compile-time edges, so they're flagged too.
 */
function collectImportSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /import\s+(?:type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/g,
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

function isForbidden(spec: string): boolean {
  if (FORBIDDEN_SPECIFIERS.includes(spec)) return true;
  if (FORBIDDEN_PREFIXES.some((p) => spec.startsWith(p))) return true;
  return false;
}

describe('@dina/core dependency hygiene (CA-31)', () => {
  const portableFiles = [...walkPortableTs(CORE_SRC)];

  it('discovers portable source files (sanity — empty walk would silently pass)', () => {
    expect(portableFiles.length).toBeGreaterThan(0);
  });

  it('portable Core source imports no Node stdlib, server framework, or HTTP polyfill', () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const f of portableFiles) {
      const src = readFileSync(f, 'utf8');
      for (const spec of collectImportSpecifiers(src)) {
        if (isForbidden(spec)) {
          offenders.push({ file: f.replace(CORE_SRC + '/', 'src/'), specifier: spec });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('Node adapter files exist and are excluded from the walk', () => {
    // Sanity: prove the *_node.ts convention is being applied. If
    // someone deletes the keypair_node sibling without re-adding the
    // file I/O, the writeServiceKey/loadServiceKey contract breaks
    // silently — this asserts the adapter set is non-empty.
    const nodeAdapters: string[] = [];
    function* walkAll(dir: string): Generator<string> {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) yield* walkAll(full);
        else if (full.endsWith('_node.ts')) yield full;
      }
    }
    for (const f of walkAll(CORE_SRC)) nodeAdapters.push(f);
    expect(nodeAdapters.length).toBeGreaterThan(0);
    // Ensure none of them sneaks into the portable walk.
    const portableSet = new Set(portableFiles);
    for (const adapter of nodeAdapters) {
      expect(portableSet.has(adapter)).toBe(false);
    }
  });

  describe('self-check — the gate actually detects violations', () => {
    const cases: { spec: string; snippet: string }[] = [
      { spec: 'fs', snippet: `import * as fs from 'fs';` },
      { spec: 'path', snippet: `import * as path from 'path';` },
      { spec: 'node:fs', snippet: `import { readFileSync } from 'node:fs';` },
      { spec: 'node:path', snippet: `import { join } from 'node:path';` },
      { spec: 'node:async_hooks', snippet: `import { AsyncLocalStorage } from 'node:async_hooks';` },
      { spec: 'node:crypto', snippet: `import { randomBytes } from 'node:crypto';` },
      { spec: 'fastify', snippet: `import Fastify from 'fastify';` },
      { spec: '@fastify/cors', snippet: `import cors from '@fastify/cors';` },
      { spec: 'undici', snippet: `import { fetch } from 'undici';` },
      { spec: 'ws', snippet: `import WebSocket from 'ws';` },
      { spec: 'fs (type-only)', snippet: `import type { Stats } from 'fs';` },
      { spec: 'fs (dynamic)', snippet: `const m = await import('fs');` },
      { spec: 'fs (require)', snippet: `const fs = require('fs');` },
    ];

    it.each(cases)('flags `$spec`', ({ snippet }) => {
      const specs = collectImportSpecifiers(snippet);
      expect(specs.some(isForbidden)).toBe(true);
    });

    it('does NOT flag patterns portable Core is allowed to use', () => {
      const allowed = [
        `import { sign } from '@noble/curves/ed25519';`,
        `import type { D2DEnvelope } from '@dina/protocol';`,
        `import { sign } from '../crypto/ed25519';`,
        `const f = globalThis.fetch;`,
        `import type { Buffer } from 'buffer';`, // RN polyfills 'buffer'; only node:buffer is Node-only
      ];
      const specs = allowed.flatMap(collectImportSpecifiers);
      const flagged = specs.filter(isForbidden);
      expect(flagged).toEqual([]);
    });
  });
});
