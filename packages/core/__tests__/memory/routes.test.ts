/**
 * Working-memory HTTP route tests (WM-CORE-07).
 *
 * Exercises the pure handlers returned by `makeMemoryHandlers` so
 * these tests cover request parsing, validation, resolver threading,
 * and response shapes without running the router's signed-auth
 * pipeline. Auth / wire integration is covered separately by
 * `server/core_router_integration.test.ts` once WM-CORE-10 lands.
 */

import type { CoreRequest, CoreResponse } from '../../src/server/router';
import { makeMemoryHandlers } from '../../src/server/routes/memory';
import { InMemoryTopicRepository, type TopicRepository } from '../../src/memory/repository';
import { MemoryService } from '../../src/memory/service';

const T0 = 1_700_000_000;

function req(partial: Partial<CoreRequest>): CoreRequest {
  return {
    method: 'GET',
    path: '/',
    query: {},
    headers: {},
    body: undefined,
    rawBody: new Uint8Array(),
    params: {},
    ...partial,
  };
}

function jsonBody(value: unknown): { body: unknown; rawBody: Uint8Array } {
  const s = JSON.stringify(value);
  return { body: value, rawBody: new TextEncoder().encode(s) };
}

// ---------------------------------------------------------------------------
// POST /v1/memory/topic/touch
// ---------------------------------------------------------------------------

describe('POST /v1/memory/topic/touch', () => {
  function setup() {
    const repo = new InMemoryTopicRepository();
    const repos = new Map<string, TopicRepository>([['health', repo]]);
    const { touch } = makeMemoryHandlers({
      resolveRepo: (p) => repos.get(p) ?? null,
      nowSecFn: () => T0,
    });
    return { repo, repos, touch };
  }

  it('happy path: stores canonical + returns status=ok', async () => {
    const { repo, touch } = setup();
    const bodyBits = jsonBody({
      persona: 'health',
      topic: 'Dr Carl',
      kind: 'entity',
      sample_item_id: 'item-1',
    });
    const res = await touch(req({ method: 'POST', ...bodyBits }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', canonical: 'Dr Carl' });
    const row = await repo.get('Dr Carl');
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('entity');
    expect(row!.s_short).toBe(1.0);
    expect(row!.sample_item_id).toBe('item-1');
    expect(row!.last_update).toBe(T0);
  });

  it('resolves the canonical BEFORE touching (stem-match path)', async () => {
    const { repo, touch } = setup();
    // Pre-seed a canonical "tax plan".
    await repo.touch({ topic: 'tax plan', kind: 'theme', nowUnix: T0 - 3600 });
    const bodyBits = jsonBody({
      persona: 'health',
      topic: 'tax planning', // stems to "tax plan"
      kind: 'theme',
    });
    const res = await touch(req({ method: 'POST', ...bodyBits }));
    expect(res.status).toBe(200);
    expect((res.body as { canonical: string }).canonical).toBe('tax plan');
    // And crucially — the canonical row was incremented, not a new row created.
    expect(await repo.get('tax planning')).toBeNull();
    const canonical = await repo.get('tax plan');
    expect(canonical).not.toBeNull();
    // s_long after two touches (initial + this one, ~1h apart) is decayed-then-+1.
    expect(canonical!.s_long).toBeGreaterThan(1.5);
  });

  it('locked persona returns 200 status=skipped (soft no-op)', async () => {
    const { touch } = setup();
    const bodyBits = jsonBody({
      persona: 'finance', // not in our map
      topic: 'x',
      kind: 'entity',
    });
    const res = await touch(req({ method: 'POST', ...bodyBits }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'skipped', reason: 'persona not open' });
  });

  it('400 on missing persona', async () => {
    const { touch } = setup();
    const bodyBits = jsonBody({ topic: 'x', kind: 'entity' });
    const res = await touch(req({ method: 'POST', ...bodyBits }));
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/persona is required/);
  });

  it('400 on missing topic', async () => {
    const { touch } = setup();
    const bodyBits = jsonBody({ persona: 'health', kind: 'entity' });
    const res = await touch(req({ method: 'POST', ...bodyBits }));
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/topic is required/);
  });

  it('400 on invalid kind', async () => {
    const { touch } = setup();
    const bodyBits = jsonBody({ persona: 'health', topic: 'x', kind: 'vegetable' });
    const res = await touch(req({ method: 'POST', ...bodyBits }));
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/entity.*theme/);
  });

  it('400 on null / non-object body', async () => {
    const { touch } = setup();
    const res = await touch(req({ method: 'POST', body: null, rawBody: new Uint8Array() }));
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/JSON object/);
  });

  it('413 on oversized body', async () => {
    const { touch } = setup();
    const large = new Uint8Array(16 * 1024 + 1);
    const res = await touch(req({ method: 'POST', body: {}, rawBody: large }));
    expect(res.status).toBe(413);
  });

  it('treats empty optional strings as "not supplied" (sample_item_id preservation)', async () => {
    const { repo, touch } = setup();
    // First, store a row with sample_item_id set.
    await repo.touch({
      topic: 'Dr Carl',
      kind: 'entity',
      nowUnix: T0 - 3600,
      sampleItemId: 'item-1',
    });
    // Touch via HTTP with EMPTY sample_item_id — must not clear it.
    const bodyBits = jsonBody({
      persona: 'health',
      topic: 'Dr Carl',
      kind: 'entity',
      sample_item_id: '',
    });
    const res = await touch(req({ method: 'POST', ...bodyBits }));
    expect(res.status).toBe(200);
    expect((await repo.get('Dr Carl'))!.sample_item_id).toBe('item-1');
  });

  it('trims whitespace from persona + topic', async () => {
    const { repo, touch } = setup();
    const bodyBits = jsonBody({
      persona: '  health  ',
      topic: '  Sancho  ',
      kind: 'entity',
    });
    const res = await touch(req({ method: 'POST', ...bodyBits }));
    expect(res.status).toBe(200);
    expect(await repo.get('Sancho')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /v1/memory/toc
// ---------------------------------------------------------------------------

describe('GET /v1/memory/toc', () => {
  function setupService() {
    const health = new InMemoryTopicRepository();
    const finance = new InMemoryTopicRepository();
    health.touch({ topic: 'Dr Carl', kind: 'entity', nowUnix: T0 });
    finance.touch({ topic: 'HDFC FD', kind: 'entity', nowUnix: T0 });
    const repos: Record<string, TopicRepository> = { health, finance };
    const service = new MemoryService({
      resolve: (p) => repos[p] ?? null,
      listPersonas: () => Object.keys(repos),
      nowSecFn: () => T0,
    });
    const { toc } = makeMemoryHandlers({ memoryService: service });
    return { toc };
  }

  it('503 when no service is wired', async () => {
    const { toc } = makeMemoryHandlers({ memoryService: null });
    const res = await toc(req({ method: 'GET', path: '/v1/memory/toc' }));
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toMatch(/memory service/);
  });

  it('happy path: returns entries + limit', async () => {
    const { toc } = setupService();
    const res = await toc(req({ method: 'GET', path: '/v1/memory/toc' }));
    expect(res.status).toBe(200);
    const body = res.body as { entries: Array<{ topic: string; persona: string }>; limit: number };
    expect(body.limit).toBe(50);
    expect(body.entries.map((e) => e.topic).sort()).toEqual(['Dr Carl', 'HDFC FD']);
  });

  it('parses comma-separated persona filter', async () => {
    const { toc } = setupService();
    const res = await toc(
      req({
        method: 'GET',
        path: '/v1/memory/toc',
        query: { persona: 'health' },
      }),
    );
    const body = res.body as { entries: Array<{ topic: string }> };
    expect(body.entries.map((e) => e.topic)).toEqual(['Dr Carl']);
  });

  it('parses limit query param', async () => {
    const { toc } = setupService();
    const res = await toc(
      req({
        method: 'GET',
        path: '/v1/memory/toc',
        query: { limit: '1' },
      }),
    );
    const body = res.body as { entries: unknown[]; limit: number };
    expect(body.limit).toBe(1);
    expect(body.entries).toHaveLength(1);
  });

  it('clamps limit to MAX_TOC_LIMIT (200)', async () => {
    const { toc } = setupService();
    const res = await toc(
      req({
        method: 'GET',
        path: '/v1/memory/toc',
        query: { limit: '10000' },
      }),
    );
    expect((res.body as { limit: number }).limit).toBe(200);
  });

  it('invalid limit falls back to default', async () => {
    const { toc } = setupService();
    const res = await toc(
      req({
        method: 'GET',
        path: '/v1/memory/toc',
        query: { limit: 'banana' },
      }),
    );
    expect((res.body as { limit: number }).limit).toBe(50);
  });

  it('negative limit falls back to default', async () => {
    const { toc } = setupService();
    const res = await toc(
      req({
        method: 'GET',
        path: '/v1/memory/toc',
        query: { limit: '-5' },
      }),
    );
    expect((res.body as { limit: number }).limit).toBe(50);
  });

  it('empty persona filter is equivalent to "all unlocked"', async () => {
    const { toc } = setupService();
    const res = await toc(
      req({
        method: 'GET',
        path: '/v1/memory/toc',
        query: { persona: '' },
      }),
    );
    const body = res.body as { entries: Array<{ topic: string }> };
    expect(body.entries).toHaveLength(2);
  });

  it('filter with only empty / whitespace segments falls back to "all"', async () => {
    const { toc } = setupService();
    const res = await toc(
      req({
        method: 'GET',
        path: '/v1/memory/toc',
        query: { persona: ',   ,' },
      }),
    );
    const body = res.body as { entries: Array<{ topic: string }> };
    expect(body.entries).toHaveLength(2);
  });
});
