/**
 * Round-A A-07 — the lite server's owner run/watch channel (§12.5).
 *
 * The HTTP adapter stamps `callerType:'owner'` ONLY on a timing-safe
 * `x-dina-owner-capability` match, scoped to the `/v1/run*` + `/v1/watch*`
 * surface; the in-handler owner guard re-validates. Everything else stays
 * fail-closed: no header, wrong header, or a matching header on a non-owner
 * path grants nothing.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { resolveOwnerCapability } from '../src/server/owner_capability';

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
    expect(readFileSync(path.join(dir, 'owner_capability'), 'utf8').trim()).toBe(first.capability);
    const second = resolveOwnerCapability({}, dir);
    expect(second).toEqual({ ...first, source: 'file' });
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
});
