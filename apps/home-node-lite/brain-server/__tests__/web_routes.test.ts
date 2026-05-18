/**
 * `GET /web/*` Fastify route — Phase 1 of the home-node-lite web UI.
 *
 * These tests pin the wiring contract: static-file serving, the SPA
 * deep-link fallback (`/web/<unknown path>` → `index.html` with no-cache
 * headers), path-traversal containment, and the "bundle missing"
 * boot-safe behaviour.
 *
 * The HTTP path is exercised via `app.inject(...)` so no socket is
 * opened — these are pure wiring tests, not real network tests.
 * A temporary directory mimicking an Expo web export sits next to
 * `index.html` for each describe block so we don't depend on a real
 * built bundle existing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import { registerWebRoutes } from '../src/routes/web';

interface BundleHandle {
  dir: string;
  cleanup: () => void;
}

function makeBundle(extra: Record<string, string> = {}): BundleHandle {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-web-bundle-'));
  // A minimal Expo web export at rest:
  //   index.html  — the SPA shell
  //   favicon.ico — referenced from <link rel="icon"> in production
  //   _expo/static/js/web/<hash>.js — the bundled JS (one file is enough
  //     to prove the asset-resolution path; tests don't load JS).
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html><html><head><title>Dina</title></head>' +
      '<body><div id="root"></div></body></html>',
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'favicon.ico'), 'iconbytes', 'binary');
  fs.mkdirSync(path.join(dir, '_expo', 'static', 'js', 'web'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '_expo', 'static', 'js', 'web', 'entry-deadbeef.js'),
    '/* fake bundle */',
    'utf8',
  );
  for (const [rel, body] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body, 'utf8');
  }
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

async function makeApp(bundleDir: string, urlPrefix?: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const options: Parameters<typeof registerWebRoutes>[1] = { bundleDir };
  if (urlPrefix !== undefined) {
    options.urlPrefix = urlPrefix;
  }
  await registerWebRoutes(app, options);
  await app.ready();
  return app;
}

describe('Brain server — GET /web/* SPA wiring', () => {
  let bundle: BundleHandle;

  beforeEach(() => {
    bundle = makeBundle();
  });

  afterEach(() => {
    bundle.cleanup();
  });

  it('serves the SPA shell at /web/ with no-cache headers', async () => {
    const app = await makeApp(bundle.dir);
    try {
      const resp = await app.inject({ method: 'GET', url: '/web/' });
      expect(resp.statusCode).toBe(200);
      expect(resp.headers['content-type']).toContain('text/html');
      expect(resp.headers['cache-control']).toBe('no-cache, must-revalidate');
      expect(resp.body).toContain('<div id="root">');
    } finally {
      await app.close();
    }
  });

  it('serves an explicit /web/index.html request via the shell path', async () => {
    const app = await makeApp(bundle.dir);
    try {
      const resp = await app.inject({ method: 'GET', url: '/web/index.html' });
      expect(resp.statusCode).toBe(200);
      expect(resp.headers['content-type']).toContain('text/html');
      expect(resp.headers['cache-control']).toBe('no-cache, must-revalidate');
      expect(resp.body).toContain('<div id="root">');
    } finally {
      await app.close();
    }
  });

  it('serves a real static asset under _expo/ via fastify-static', async () => {
    const app = await makeApp(bundle.dir);
    try {
      const resp = await app.inject({
        method: 'GET',
        url: '/web/_expo/static/js/web/entry-deadbeef.js',
      });
      expect(resp.statusCode).toBe(200);
      expect(resp.headers['content-type']).toContain('application/javascript');
      expect(resp.body).toContain('fake bundle');
    } finally {
      await app.close();
    }
  });

  it('serves the favicon as a non-HTML response', async () => {
    const app = await makeApp(bundle.dir);
    try {
      const resp = await app.inject({ method: 'GET', url: '/web/favicon.ico' });
      expect(resp.statusCode).toBe(200);
      // fastify-static maps `.ico` via the mime DB. Exact value
      // varies (some setups: image/vnd.microsoft.icon, others:
      // image/x-icon) — assert just that it's not HTML.
      expect(resp.headers['content-type']).not.toContain('text/html');
    } finally {
      await app.close();
    }
  });

  it('falls back to index.html for client-side routes (deep links)', async () => {
    const app = await makeApp(bundle.dir);
    try {
      // Expo Router emits client-side paths like these — they don't
      // correspond to files on disk. The SPA fallback must serve
      // index.html so the client router can take over.
      for (const url of [
        '/web/onboarding/welcome',
        '/web/(tabs)/chat',
        '/web/peerlens/preferences',
      ]) {
        const resp = await app.inject({ method: 'GET', url });
        expect(resp.statusCode).toBe(200);
        expect(resp.headers['content-type']).toContain('text/html');
        expect(resp.body).toContain('<div id="root">');
      }
    } finally {
      await app.close();
    }
  });

  it('rejects path-traversal attempts by serving the SPA shell instead of escaping the bundle', async () => {
    // Set up a "secret" file OUTSIDE the bundle dir to prove we
    // cannot reach it. Place it as a sibling so `../secret.txt`
    // would resolve there if the guard failed.
    const sibling = path.join(path.dirname(bundle.dir), 'secret.txt');
    fs.writeFileSync(sibling, 'TOP-SECRET-NEVER-LEAK', 'utf8');
    try {
      const app = await makeApp(bundle.dir);
      try {
        // fastify-static normalizes URL paths and rejects `..` in
        // the URL itself with a 400. The handler-side guard (the
        // `candidatePath.startsWith(bundleDir + sep)` check) is the
        // belt for any traversal that slips through URL parsing.
        // To prove our guard runs, use a path-like segment that
        // doesn't get normalized away.
        const resp = await app.inject({
          method: 'GET',
          url: '/web/..%2Fsecret.txt', // url-encoded `..`
        });
        // Either path-traversal blocked outright (400) OR served the
        // SPA shell — both are acceptable secure outcomes. The
        // hostile content MUST NOT appear in the body.
        expect([200, 400, 404]).toContain(resp.statusCode);
        expect(resp.body).not.toContain('TOP-SECRET-NEVER-LEAK');
      } finally {
        await app.close();
      }
    } finally {
      fs.rmSync(sibling, { force: true });
    }
  });

  it('returns the resolved bundleDir + urlPrefix for the caller to log', async () => {
    const app = Fastify({ logger: false });
    try {
      const result = await registerWebRoutes(app, { bundleDir: bundle.dir });
      // urlPrefix defaults to `/web/` (trailing slash normalised).
      expect(result.urlPrefix).toBe('/web/');
      expect(path.resolve(result.bundleDir)).toBe(path.resolve(bundle.dir));
    } finally {
      await app.close();
    }
  });

  it('accepts a custom urlPrefix (e.g. /ui) — used for namespaced mounts', async () => {
    const app = await makeApp(bundle.dir, '/ui');
    try {
      const root = await app.inject({ method: 'GET', url: '/ui/' });
      expect(root.statusCode).toBe(200);
      expect(root.body).toContain('<div id="root">');

      const asset = await app.inject({
        method: 'GET',
        url: '/ui/_expo/static/js/web/entry-deadbeef.js',
      });
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toContain('fake bundle');
    } finally {
      await app.close();
    }
  });

  it('does NOT intercept requests outside its url prefix', async () => {
    const app = Fastify({ logger: false });
    app.get('/api/v1/ping', async () => ({ ok: true }));
    try {
      await registerWebRoutes(app, { bundleDir: bundle.dir });
      await app.ready();
      const resp = await app.inject({ method: 'GET', url: '/api/v1/ping' });
      expect(resp.statusCode).toBe(200);
      expect(resp.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });
});

describe('Brain server — GET /web/* boot-safety when bundle is missing', () => {
  it('throws a descriptive error if index.html is absent from the bundle dir', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-web-empty-'));
    try {
      const app = Fastify({ logger: false });
      await expect(registerWebRoutes(app, { bundleDir: empty })).rejects.toThrow(
        /index\.html not found/,
      );
      await app.close();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
