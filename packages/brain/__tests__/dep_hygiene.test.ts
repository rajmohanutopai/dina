/**
 * Brain dep-hygiene gate — enforces the CoreClient-only discipline.
 *
 * Brain has two build targets (Node server + React Native mobile JS VM).
 * The only portable HTTP primitive across both is `globalThis.fetch`,
 * and the only portable way for Brain to reach Core is through the
 * `CoreClient` interface (dispatched at runtime to `HttpCoreTransport`
 * or `InProcessTransport`). Everything else — `undici`, `ws`, Node's
 * raw http/https/net stdlib, the Fastify server framework — is
 * non-portable and must not appear anywhere under `packages/brain/src/**`.
 *
 * External-service HTTP clients (`AppView`, PDS, OpenRouter, bus-driver
 * tool) still need HTTP; they use `globalThis.fetch` with dependency
 * injection, which is cross-platform-native and **not** an import, so
 * they pass this gate. The gate is about *module specifiers in import
 * statements*, not runtime behavior.
 *
 * Enforced as a jest test so CI fails on violation. Mirrors the
 * requirement in docs/HOME_NODE_LITE_TASKS.md task 1.33 and the
 * hygiene pattern already established in `packages/protocol/__tests__/dep_hygiene.test.ts`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BRAIN_SRC = resolve(__dirname, '..', 'src');

/**
 * Forbidden specifier prefixes — any import whose specifier equals one
 * of these exactly, or starts with it followed by `/`, fails the gate.
 *
 * `node:http` / `node:https` / `node:net` — raw Node network stdlib is
 *   not available in RN; Brain must never depend on it directly.
 * `node:async_hooks` / `node:crypto` — Node-only diagnostics/randomness
 *   belong in Node-specific subpaths or adapters. Portable Brain uses
 *   injected trace storage and `globalThis.crypto.getRandomValues`.
 * `undici` — Node's bundled HTTP client. Not available in RN.
 * `ws` / `isomorphic-ws` — WebSocket client libs. Brain uses CoreClient
 *   which owns the transport, or relies on host/platform WebSocket.
 * `@fastify` / `fastify` — server framework. Wrong direction: Brain is
 *   a *client* to Core; servers live under `apps/*-server/`.
 * `node-fetch` / `@whatwg-node/fetch` — fetch polyfills. `globalThis.fetch`
 *   is available on both Node 22+ and modern RN; no polyfill needed.
 */
const FORBIDDEN_SPECIFIERS: readonly string[] = [
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
  'node:async_hooks',
  'node:crypto',
  'undici',
  'ws',
  'isomorphic-ws',
  'fastify',
  'node-fetch',
];

/** Forbidden prefixes — an import that starts with `PREFIX/` also fails. */
const FORBIDDEN_PREFIXES: readonly string[] = [
  '@fastify/',
  '@whatwg-node/',
];

function* walkTs(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* walkTs(full);
    } else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
      yield full;
    }
  }
}

/**
 * Extract every module specifier mentioned in import / require /
 * dynamic-import syntax. Covers:
 *   - `import X from 'spec'`        (default)
 *   - `import { X } from 'spec'`    (named)
 *   - `import * as X from 'spec'`   (namespace)
 *   - `import 'spec'`               (side-effect)
 *   - `import type X from 'spec'`   (type-only — still a compile-time edge)
 *   - `import('spec')`              (dynamic)
 *   - `require('spec')`             (CJS)
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

describe('@dina/brain dependency hygiene (task 1.33)', () => {
  const files = [...walkTs(BRAIN_SRC)];

  it('discovers source files (sanity — guards against an empty src/)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no source file imports a forbidden HTTP / server / polyfill specifier', () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const spec of collectImportSpecifiers(src)) {
        if (isForbidden(spec)) {
          offenders.push({ file: f.replace(BRAIN_SRC + '/', 'src/'), specifier: spec });
        }
      }
    }
    // Fail loud: show every offender, not just the first.
    expect(offenders).toEqual([]);
  });

  describe('self-check — the gate actually detects violations', () => {
    // These synthetic snippets exist so a future refactor that accidentally
    // neuters the gate (e.g. a regex that no longer matches `from 'undici'`)
    // fails here before silently letting real violations through.
    const cases: { spec: string; snippet: string }[] = [
      { spec: 'undici', snippet: `import { fetch } from 'undici';` },
      { spec: 'ws', snippet: `import WebSocket from 'ws';` },
      { spec: 'node:http', snippet: `import http from 'node:http';` },
      { spec: 'node:https', snippet: `import https from 'node:https';` },
      { spec: 'node:async_hooks', snippet: `import { AsyncLocalStorage } from 'node:async_hooks';` },
      { spec: 'node:crypto', snippet: `import { randomBytes } from 'node:crypto';` },
      { spec: '@fastify/cors', snippet: `import cors from '@fastify/cors';` },
      { spec: 'fastify', snippet: `import Fastify from 'fastify';` },
      { spec: 'node-fetch', snippet: `import fetch from 'node-fetch';` },
      {
        spec: 'undici (dynamic)',
        snippet: `const x = await import('undici');`,
      },
      {
        spec: 'ws (require)',
        snippet: `const WebSocket = require('ws');`,
      },
      {
        spec: 'undici (type-only)',
        snippet: `import type { Dispatcher } from 'undici';`,
      },
    ];

    it.each(cases)('flags `$spec`', ({ snippet }) => {
      const specs = collectImportSpecifiers(snippet);
      expect(specs.some(isForbidden)).toBe(true);
    });

    it('does NOT flag portable patterns Brain is allowed to use', () => {
      const allowed = [
        `const f = globalThis.fetch;`,                         // runtime global, not an import
        `import type { CoreClient } from '@dina/core';`,       // Brain's only Core entry
        `import { TYPE_TOPIC_ENTRY } from '@dina/protocol';`,  // shared wire types
        `import { MockCoreClient } from '@dina/test-harness';`,// test-only mock
        `import { readFileSync } from 'node:fs';`,             // filesystem stdlib is fine
        `import { signRequest } from '../../core/src/auth/canonical';`, // relative
      ];
      const specs = allowed.flatMap(collectImportSpecifiers);
      const flagged = specs.filter(isForbidden);
      expect(flagged).toEqual([]);
    });
  });
});
