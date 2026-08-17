/**
 * Round-A A-07 — the lite server's owner run/watch channel (§12.5).
 *
 * The HTTP adapter stamps `callerType:'owner'` ONLY on a timing-safe
 * `x-dina-owner-capability` match, scoped to the `/v1/run*` + `/v1/watch*`
 * surface; the in-handler owner guard re-validates. Everything else stays
 * fail-closed: no header, wrong header, or a matching header on a non-owner
 * path grants nothing.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import {
  InMemoryCommandReceiptRepository,
  InMemoryRunRepository,
  RunService,
  createCoreRouter,
  setCommandReceiptRepository,
  setRunRepository,
  setRunService,
} from '@dina/core';

import { bindCoreRouter } from '../src/server/bind_core_router';
import { resolveOwnerCapability, writeFreshOwnerCapability } from '../src/server/owner_capability';

const CAP = 'test-owner-capability-0123456789abcdef';

describe('owner capability resolution', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ownercap-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('env wins; short env value refuses to boot', () => {
    expect(resolveOwnerCapability({ DINA_OWNER_CAPABILITY: CAP }, dir)).toEqual({
      capability: CAP,
      source: 'env',
    });
    expect(() => resolveOwnerCapability({ DINA_OWNER_CAPABILITY: 'short' }, dir)).toThrow(
      /at least/,
    );
  });

  it('generates once (0600 file) and is stable across restarts', () => {
    const first = resolveOwnerCapability({}, dir);
    expect(first.source).toBe('generated');
    expect(first.capability).toMatch(/^[0-9a-f]{64}$/);
    const fp = path.join(dir, 'owner_capability');
    expect(readFileSync(fp, 'utf8').trim()).toBe(first.capability);
    // C-05 — the generated file really is 0600.
    expect(lstatSync(fp).mode & 0o777).toBe(0o600);
    const second = resolveOwnerCapability({}, dir);
    expect(second).toEqual({ ...first, source: 'file' });
  });

  it('C-05: a loose-permission existing file is tightened to 0600 on load', () => {
    const fp = path.join(dir, 'owner_capability');
    writeFileSync(fp, `${'a'.repeat(40)}\n`, { mode: 0o644 });
    // Ensure the loose bits are actually on disk (umask can strip them).
    chmodSync(fp, 0o644);
    expect(lstatSync(fp).mode & 0o077).not.toBe(0);
    const res = resolveOwnerCapability({}, dir);
    expect(res.source).toBe('file');
    expect(lstatSync(fp).mode & 0o077).toBe(0); // group/other bits cleared
  });

  it('C-05: a symlink at the capability path refuses to boot', () => {
    const real = path.join(dir, 'real_secret');
    writeFileSync(real, `${'b'.repeat(40)}\n`, { mode: 0o600 });
    symlinkSync(real, path.join(dir, 'owner_capability'));
    expect(() => resolveOwnerCapability({}, dir)).toThrow(/not a regular file/);
  });

  it('C-05: a corrupt existing file is replaced with a fresh 0600 inode', () => {
    const fp = path.join(dir, 'owner_capability');
    writeFileSync(fp, 'short\n', { mode: 0o644 }); // below MIN_CAPABILITY_LENGTH
    chmodSync(fp, 0o644);
    const res = resolveOwnerCapability({}, dir);
    expect(res.source).toBe('generated');
    expect(res.capability).toMatch(/^[0-9a-f]{64}$/);
    expect(lstatSync(fp).mode & 0o777).toBe(0o600);
  });

  it('C-05: a DANGLING symlink refuses to boot and is never written through', () => {
    // A dangling symlink is the sharp case: `existsSync` follows it and reports
    // false, so a path-based generate would `writeFileSync` the fresh
    // capability straight into the attacker-chosen target. The O_NOFOLLOW load
    // must reject it instead, and the target must stay non-existent.
    const target = path.join(dir, 'attacker_target');
    symlinkSync(target, path.join(dir, 'owner_capability'));
    expect(existsSync(target)).toBe(false); // dangling
    expect(() => resolveOwnerCapability({}, dir)).toThrow(/not a regular file/);
    // The generated bearer was NOT written through the link.
    expect(existsSync(target)).toBe(false);
  });

  it('C-05: create refuses a LIVE symlink present at create time (O_EXCL|O_NOFOLLOW)', () => {
    // The load path rejects a symlink before the resolver reaches creation, so
    // the create-time guard is exercised DIRECTLY: a symlink occupies the path
    // when the exclusive create runs. It must throw (EEXIST) rather than write
    // the bearer through the redirect, and the target must stay untouched.
    const fp = path.join(dir, 'owner_capability');
    const target = path.join(dir, 'create_target');
    writeFileSync(target, 'not-the-capability\n', { mode: 0o600 });
    symlinkSync(target, fp);
    expect(() => writeFreshOwnerCapability(fp)).toThrow();
    // The pre-existing target file was never overwritten with a capability.
    expect(readFileSync(target, 'utf8')).toBe('not-the-capability\n');
  });

  it('C-05: create refuses a DANGLING symlink at create time (no write-through)', () => {
    const fp = path.join(dir, 'owner_capability');
    const target = path.join(dir, 'create_dangling_target');
    symlinkSync(target, fp); // dangling: target does not exist
    expect(existsSync(target)).toBe(false);
    expect(() => writeFreshOwnerCapability(fp)).toThrow();
    // The generated bearer was NOT written through the dangling link.
    expect(existsSync(target)).toBe(false);
  });

  it('C-05: create writes a fresh 0600 file on a clear path', () => {
    const fp = path.join(dir, 'owner_capability');
    const cap = writeFreshOwnerCapability(fp);
    expect(cap).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(fp, 'utf8').trim()).toBe(cap);
    expect(lstatSync(fp).mode & 0o777).toBe(0o600);
  });
});

describe('owner channel over HTTP (bindCoreRouter + owner guard)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const runs = new InMemoryRunRepository();
    setRunRepository(runs);
    setRunService(new RunService({ repository: runs }));
    setCommandReceiptRepository(new InMemoryCommandReceiptRepository());
    app = Fastify({ logger: false });
    bindCoreRouter({
      coreRouter: createCoreRouter({ ownerCapability: CAP }),
      app: app as never,
      ownerCapability: CAP,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    setRunRepository(null);
    setRunService(null);
    setCommandReceiptRepository(null);
  });

  it('a matching capability header reaches the owner surface', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/run/list',
      headers: { 'x-dina-owner-capability': CAP },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { runs: unknown[] }).runs).toEqual([]);
  });

  it('an owner can START a run over the channel', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/run/start',
      headers: { 'x-dina-owner-capability': CAP, 'content-type': 'application/json' },
      payload: {
        service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
        provider_did: 'did:plc:prov',
        persona: 'general',
        idempotency_key: 'k-1',
        ttl_seconds: 600,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(typeof (res.json() as { run_id: string }).run_id).toBe('string');
  });

  it('no header / wrong header → 401 or 403, never the handler', async () => {
    const noHeader = await app.inject({ method: 'GET', url: '/v1/run/list' });
    expect([401, 403]).toContain(noHeader.statusCode);
    const wrong = await app.inject({
      method: 'GET',
      url: '/v1/run/list',
      headers: { 'x-dina-owner-capability': `${CAP}x` },
    });
    expect([401, 403]).toContain(wrong.statusCode);
  });

  it('a matching header on a NON-owner path grants nothing (scoped stamp)', async () => {
    // /v1/vault/* is a signed route — the capability must not authenticate it.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vault/items',
      headers: { 'x-dina-owner-capability': CAP },
    });
    expect([401, 403, 404]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(200);
  });

  it('the COMMERCE owner surface is reachable over the channel (PC-4/PC-9)', async () => {
    // The first live server run found this missing: the photo lanes were
    // reachable only in-process. With the stamp, the in-handler owner guard
    // passes and the route answers for ITSELF — here 503, because this
    // harness installs no commerce runtime. Without the header the guard
    // refuses before any handler logic runs.
    const stamped = await app.inject({
      method: 'GET',
      url: '/v1/commerce/orders/drafts',
      headers: { 'x-dina-owner-capability': CAP },
    });
    expect(stamped.statusCode).toBe(503);
    expect((stamped.json() as { error: string }).error).toBe('commerce_unavailable');

    const bare = await app.inject({ method: 'GET', url: '/v1/commerce/orders/drafts' });
    expect([401, 403]).toContain(bare.statusCode);
  });
});
