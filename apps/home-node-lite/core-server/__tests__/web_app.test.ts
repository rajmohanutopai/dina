/**
 * WEB_OWNER_SURFACE_PLAN §3.2 — Core serves the web app at /app/.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import {
  RUNTIME_CONFIG_PATH,
  parseBrainOrigin,
  registerWebAppRoutes,
  webAppContentSecurityPolicy,
} from '../src/server/web_app';

const BRAIN = 'http://127.0.0.1:8200';

describe('Core-served web app', () => {
  let dir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'webapp-'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Dina</title>');
    mkdirSync(path.join(dir, '_expo', 'static', 'js'), { recursive: true });
    writeFileSync(path.join(dir, '_expo', 'static', 'js', 'entry-abc.js'), 'console.log(1)');
    writeFileSync(path.join(tmpdir(), 'outside-secret.txt'), 'not for the web');
    app = Fastify({ logger: false });
    await registerWebAppRoutes(app, { bundleDir: dir, brainOrigin: BRAIN });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(path.join(tmpdir(), 'outside-secret.txt'), { force: true });
  });

  function expectSecure(headers: Record<string, unknown>): void {
    expect(headers['content-security-policy']).toBe(webAppContentSecurityPolicy(BRAIN));
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
  }

  it('serves the shell at /app/ and for a deep link, revalidated on every load', async () => {
    for (const url of ['/app/', '/app/index.html', '/app/settings', '/app/tender?tender_id=t1']) {
      const res = await app.inject({ method: 'GET', url });
      expect([url, res.statusCode]).toEqual([url, 200]);
      expect(res.body).toContain('<title>Dina</title>');
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['cache-control']).toBe('no-cache, must-revalidate');
      expectSecure(res.headers);
    }
  });

  it('serves a real asset as itself', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/_expo/static/js/entry-abc.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log(1)');
    expect(res.headers['content-type']).toContain('javascript');
    expectSecure(res.headers);
  });

  it('never serves a file outside the bundle: a traversal gets the shell', async () => {
    for (const url of [
      '/app/../outside-secret.txt',
      '/app/..%2F..%2Foutside-secret.txt',
      '/app/%2e%2e/outside-secret.txt',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body).not.toContain('not for the web');
    }
  });

  it('runtime config says Core served the page and where Brain is; never cached', async () => {
    const res = await app.inject({ method: 'GET', url: RUNTIME_CONFIG_PATH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ served_by: 'core', brain_url: BRAIN });
    expect(res.headers['cache-control']).toBe('no-store');
    expectSecure(res.headers);
  });

  it('the policy runs only the app’s own scripts; plain http reaches only Core and Brain', () => {
    const policy = webAppContentSecurityPolicy(BRAIN);
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval';");
    // WebAssembly may compile (Argon2id); JavaScript may never be eval'd or inlined.
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-(eval|inline)'/);
    expect(policy).toContain(`connect-src 'self' ${BRAIN} https: wss:`);
    // Plain http goes nowhere but Core and Brain.
    expect(policy).not.toMatch(/connect-src[^;]*\shttp:(\s|;|$)/);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
  });

  it('refuses to start without a built bundle', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'webapp-empty-'));
    const other = Fastify({ logger: false });
    try {
      await expect(
        registerWebAppRoutes(other, { bundleDir: empty, brainOrigin: BRAIN }),
      ).rejects.toThrow(/index\.html not found/);
    } finally {
      await other.close();
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('parseBrainOrigin', () => {
  it('keeps scheme, host and port only', () => {
    expect(parseBrainOrigin('http://127.0.0.1:8200/')).toBe('http://127.0.0.1:8200');
    expect(parseBrainOrigin('https://brain.example:8443/some/path?q=1')).toBe(
      'https://brain.example:8443',
    );
  });
  it('refuses anything that is not http(s)', () => {
    expect(() => parseBrainOrigin('javascript:alert(1)')).toThrow();
    expect(() => parseBrainOrigin('ftp://x')).toThrow(/http\(s\)/);
    expect(() => parseBrainOrigin('not a url')).toThrow();
  });
});
