/**
 * Task 4.16 — response field-name + type parity against wire-format fixtures.
 *
 * Loads each JSON fixture in `fixtures/wire_format/` and drives the
 * server with its declared `{method, path}`, then asserts the response
 * matches the declared `expected`: status, Content-Type prefix, body
 * keys, and (when present) exact body shape or specific field values.
 *
 * **Fixture schema** (intentionally simple so non-TS authors can add
 * new ones):
 * ```json
 * {
 *   "domain": "wire_format/<name>",
 *   "version": 1,
 *   "generated_from": "<Go source reference>",
 *   "route": { "method": "GET|POST|...", "path": "/..." },
 *   "expected": {
 *     "status": <number>,
 *     "content_type_prefix": "application/json",
 *     "body_keys": ["error"],           // required keys
 *     "body_exact": { ... },            // optional: exact object match
 *     "body_shape": { ... }             // optional: per-field declared shape
 *                                        //   e.g. "<string:semver>"
 *   }
 * }
 * ```
 *
 * Exact error **message** strings are NOT pinned (M5 tracks those per
 * test where they string-match). This file pins **field names**,
 * **types**, and **status codes** — the parity vectors that matter
 * for cross-implementation interop.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pino } from 'pino';
import { createServer, type ReadinessCheck } from '../src/server';
import type { Logger } from '../src/logger';
import type { CoreServerConfig } from '../src/config';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/wire_format');

interface WireFixture {
  domain: string;
  version: number;
  route: { method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'; path: string };
  expected: {
    status: number;
    content_type_prefix?: string;
    body_keys?: string[];
    body_exact?: Record<string, unknown>;
    body_shape?: Record<string, string>;
  };
}

function loadFixtures(): Array<[string, WireFixture]> {
  const files = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((f) => {
    const raw = fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf-8');
    return [f, JSON.parse(raw) as WireFixture];
  });
}

function baseConfig(): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'silent', rateLimitPerMinute: 60, prettyLogs: false },
    msgbox: {},
    cors: {},
  };
}
function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

/**
 * Map each fixture to the configuration it needs. /readyz_ok uses a
 * default server; /readyz_not_ready needs a failing check; /error_500
 * needs a throwing route registered inline. Fixtures that describe
 * routes the scaffold doesn't own today (e.g. /v1/vault/store) are
 * covered elsewhere; this audit focuses on what's live.
 */
async function buildAppFor(fx: WireFixture) {
  if (fx.domain === 'wire_format/readyz_not_ready') {
    const checks: ReadinessCheck[] = [{ name: 'db', probe: () => false }];
    return createServer({
      config: baseConfig(),
      logger: silentLogger(),
      readinessChecks: checks,
    });
  }
  const app = await createServer({ config: baseConfig(), logger: silentLogger() });
  if (fx.domain === 'wire_format/error_500') {
    app.get('/__throw__', async () => {
      throw new Error('deliberate for wire-format fixture');
    });
  }
  return app;
}

/**
 * Map fixture → URL to inject against. For most this is just
 * `fx.route.path`; error_500's fixture uses a placeholder path that we
 * substitute here.
 */
function injectUrl(fx: WireFixture): string {
  if (fx.domain === 'wire_format/error_500') return '/__throw__';
  return fx.route.path;
}

describe('wire-format response parity (task 4.16)', () => {
  const fixtures = loadFixtures();

  it('fixture directory has at least one vector', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)('%s matches declared shape', async (_filename, fx) => {
    const app = await buildAppFor(fx);
    try {
      const res = await app.inject({
        method: fx.route.method,
        url: injectUrl(fx),
      });

      expect(res.statusCode).toBe(fx.expected.status);

      if (fx.expected.content_type_prefix) {
        expect(res.headers['content-type']).toMatch(
          new RegExp('^' + escapeRegex(fx.expected.content_type_prefix)),
        );
      }

      const body = res.json() as Record<string, unknown>;

      if (fx.expected.body_keys) {
        for (const k of fx.expected.body_keys) {
          expect(body).toHaveProperty(k);
        }
        // Strict: no additional keys beyond those declared unless
        // `body_shape` is present (some fixtures declare shape without
        // exhaustive keys).
        if (!fx.expected.body_shape) {
          expect(Object.keys(body).sort()).toEqual(
            [...fx.expected.body_keys].sort(),
          );
        }
      }

      if (fx.expected.body_exact) {
        expect(body).toEqual(fx.expected.body_exact);
      }

      if (fx.expected.body_shape) {
        for (const [key, shape] of Object.entries(fx.expected.body_shape)) {
          validateShape(body[key], shape, `${fx.domain}.${key}`);
        }
      }
    } finally {
      await app.close();
    }
  });

  describe('fixture-schema sanity', () => {
    it('every fixture declares domain + version + route + expected', () => {
      for (const [name, fx] of fixtures) {
        expect(fx.domain).toMatch(/^wire_format\//);
        expect(fx.version).toBe(1);
        expect(fx.route).toBeDefined();
        expect(fx.route.method).toMatch(/^(GET|POST|PUT|DELETE|PATCH)$/);
        expect(fx.route.path).toBeTruthy();
        expect(fx.expected.status).toBeGreaterThanOrEqual(100);
        expect(fx.expected.status).toBeLessThan(600);
        expect(name).toBeTruthy();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Shape validator for the limited mini-DSL used in fixtures.
 * Supported:
 *   "ok"                          — exact string match
 *   "<string:semver>"             — string matching semver regex
 *   "<string>"                    — any string
 *   "<object:...>"                — any object
 */
function validateShape(value: unknown, shape: string, fieldPath: string): void {
  if (!shape.startsWith('<')) {
    // Exact literal match.
    expect(value).toBe(shape);
    return;
  }
  const descriptor = shape.slice(1, -1); // strip '<' + '>'
  const [kind, ...rest] = descriptor.split(':');
  switch (kind) {
    case 'string': {
      expect(typeof value).toBe('string');
      if (rest[0] === 'semver') {
        expect(value as string).toMatch(/^\d+\.\d+\.\d+/);
      }
      return;
    }
    case 'object': {
      expect(typeof value).toBe('object');
      expect(value).not.toBeNull();
      return;
    }
    default:
      throw new Error(
        `wire-format fixture: unknown shape descriptor "${shape}" at ${fieldPath}`,
      );
  }
}
