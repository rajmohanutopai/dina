/**
 * Task 4.77 — GET /v1/memory/toc Fastify integration tests.
 *
 * Drives the route against a fake `MemoryService` that records the
 * (personas, limit) it was called with + returns a scripted result.
 * Query parsing, limit defaulting, bounds checking, and the empty-
 * personas → undefined contract are all exercised.
 */

import { pino } from 'pino';
import {
  InMemoryTopicRepository,
  MemoryService,
  type TocEntry,
  type TopicRepository,
} from '@dina/core';
import { createServer } from '../src/server';
import type { CoreServerConfig } from '../src/config';
import {
  DEFAULT_MEMORY_TOC_LIMIT,
  MAX_MEMORY_TOC_LIMIT,
  registerMemoryRoutes,
} from '../src/memory/routes';

function baseConfig(): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'silent', rateLimitPerMinute: 10_000, prettyLogs: false },
    msgbox: {},
    cors: {},
  };
}

function silentLogger() {
  return pino({ level: 'silent' });
}

/**
 * Build a MemoryService whose `.toc(personas, limit)` records its args
 * and returns a scripted entry list. The base class needs an
 * `onWarning` etc. noise-suppressor so we just subclass and override
 * `toc`.
 */
class FakeMemoryService extends MemoryService {
  public calls: Array<{ personas: string[] | undefined; limit: number }> = [];
  public result: TocEntry[] = [];
  override async toc(
    personas: string[] | undefined,
    limit: number,
  ): Promise<TocEntry[]> {
    this.calls.push({ personas, limit });
    return this.result.slice(0, limit);
  }
}

function entry(
  persona: string,
  topic: string,
  salience: number,
  last_update = 1_700_000_000,
): TocEntry {
  return {
    persona,
    topic,
    kind: 'theme',
    salience,
    last_update,
  };
}

async function buildApp(result: TocEntry[] = []) {
  const memoryService = new FakeMemoryService();
  memoryService.result = result;
  const app = await createServer({ config: baseConfig(), logger: silentLogger() });
  registerMemoryRoutes(app, { memoryService });
  return { app, memoryService };
}

describe('GET /v1/memory/toc (task 4.77)', () => {
  describe('happy path', () => {
    it('returns 200 with entries from the service', async () => {
      const { app, memoryService } = await buildApp([
        entry('work', 'taxes', 1.3),
        entry('health', 'cholesterol', 0.9),
      ]);
      const res = await app.inject({ method: 'GET', url: '/v1/memory/toc' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { entries: TocEntry[] };
      expect(body.entries).toHaveLength(2);
      expect(body.entries[0]!.topic).toBe('taxes');
      expect(memoryService.calls).toEqual([
        { personas: undefined, limit: DEFAULT_MEMORY_TOC_LIMIT },
      ]);
      await app.close();
    });

    it('returns empty entries list when the service returns nothing', async () => {
      const { app } = await buildApp([]);
      const res = await app.inject({ method: 'GET', url: '/v1/memory/toc' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ entries: [] });
      await app.close();
    });
  });

  describe('personas query param', () => {
    it('parses a comma-separated list and forwards to toc()', async () => {
      const { app, memoryService } = await buildApp();
      await app.inject({
        method: 'GET',
        url: '/v1/memory/toc?personas=work,health',
      });
      expect(memoryService.calls[0]!.personas).toEqual(['work', 'health']);
      await app.close();
    });

    it('trims whitespace + skips empties', async () => {
      const { app, memoryService } = await buildApp();
      await app.inject({
        method: 'GET',
        url: '/v1/memory/toc?personas=%20work%20,,health%20,',
      });
      expect(memoryService.calls[0]!.personas).toEqual(['work', 'health']);
      await app.close();
    });

    it('empty personas= query resolves to undefined (all unlocked)', async () => {
      const { app, memoryService } = await buildApp();
      await app.inject({ method: 'GET', url: '/v1/memory/toc?personas=' });
      expect(memoryService.calls[0]!.personas).toBeUndefined();
      await app.close();
    });

    it('personas=,,, resolves to undefined (no non-empty entries)', async () => {
      const { app, memoryService } = await buildApp();
      await app.inject({ method: 'GET', url: '/v1/memory/toc?personas=,,,' });
      expect(memoryService.calls[0]!.personas).toBeUndefined();
      await app.close();
    });
  });

  describe('limit query param', () => {
    it('honours a valid integer limit', async () => {
      const { app, memoryService } = await buildApp();
      await app.inject({ method: 'GET', url: '/v1/memory/toc?limit=5' });
      expect(memoryService.calls[0]!.limit).toBe(5);
      await app.close();
    });

    it('rejects non-integer limit with 400', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/memory/toc?limit=5.5',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'limit must be a positive integer' });
      await app.close();
    });

    it('rejects negative / zero limit with 400', async () => {
      const { app } = await buildApp();
      const negRes = await app.inject({
        method: 'GET',
        url: '/v1/memory/toc?limit=-3',
      });
      expect(negRes.statusCode).toBe(400);
      const zeroRes = await app.inject({
        method: 'GET',
        url: '/v1/memory/toc?limit=0',
      });
      expect(zeroRes.statusCode).toBe(400);
      await app.close();
    });

    it('rejects non-numeric limit with 400', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/memory/toc?limit=abc',
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('rejects limit over the cap with 400', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: `/v1/memory/toc?limit=${MAX_MEMORY_TOC_LIMIT + 1}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: `limit exceeds ${MAX_MEMORY_TOC_LIMIT} cap`,
      });
      await app.close();
    });

    it('accepts limit exactly at the cap', async () => {
      const { app, memoryService } = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: `/v1/memory/toc?limit=${MAX_MEMORY_TOC_LIMIT}`,
      });
      expect(res.statusCode).toBe(200);
      expect(memoryService.calls[0]!.limit).toBe(MAX_MEMORY_TOC_LIMIT);
      await app.close();
    });

    it('default limit is applied when omitted', async () => {
      const { app, memoryService } = await buildApp();
      await app.inject({ method: 'GET', url: '/v1/memory/toc' });
      expect(memoryService.calls[0]!.limit).toBe(DEFAULT_MEMORY_TOC_LIMIT);
      await app.close();
    });
  });

  describe('constants', () => {
    it('DEFAULT_MEMORY_TOC_LIMIT is 20', () => {
      expect(DEFAULT_MEMORY_TOC_LIMIT).toBe(20);
    });
    it('MAX_MEMORY_TOC_LIMIT is 200', () => {
      expect(MAX_MEMORY_TOC_LIMIT).toBe(200);
    });
  });

  describe('POST /v1/memory/touch (task 4.76 — reload on ingestion)', () => {
    /**
     * Build an app where `MemoryService` reads from real in-memory
     * topic repositories so a touch → toc round-trip is end-to-end.
     */
    async function buildIngestingApp(opts: {
      personas: string[];
      nowSec?: number;
    }) {
      const repoByPersona = new Map<string, TopicRepository>();
      for (const p of opts.personas) {
        repoByPersona.set(p, new InMemoryTopicRepository());
      }
      const resolver = (persona: string) => repoByPersona.get(persona) ?? null;
      const lister = () => Array.from(repoByPersona.keys());
      const nowSec = opts.nowSec ?? 1_700_000_000;
      const memoryService = new MemoryService({
        resolve: resolver,
        listPersonas: lister,
        nowSecFn: () => nowSec,
      });
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      registerMemoryRoutes(app, {
        memoryService,
        topicRepositoryResolver: resolver,
        nowSecFn: () => nowSec,
      });
      return { app, repoByPersona };
    }

    it('touch → toc round-trip surfaces the new topic', async () => {
      const { app } = await buildIngestingApp({ personas: ['work'] });
      const touchRes = await app.inject({
        method: 'POST',
        url: '/v1/memory/touch',
        headers: { 'content-type': 'application/json' },
        payload: {
          persona: 'work',
          topic: 'quarterly-taxes',
          kind: 'theme',
        },
      });
      expect(touchRes.statusCode).toBe(200);
      expect(touchRes.json()).toMatchObject({
        persona: 'work',
        topic: 'quarterly-taxes',
        canonical_topic: 'quarterly-taxes',
        kind: 'theme',
      });

      const tocRes = await app.inject({ method: 'GET', url: '/v1/memory/toc' });
      const body = tocRes.json() as { entries: TocEntry[] };
      expect(body.entries.map((e) => e.topic)).toContain('quarterly-taxes');
      expect(body.entries[0]!.persona).toBe('work');
      await app.close();
    });

    it('alias resolution collapses variants to a single canonical row', async () => {
      const { app, repoByPersona } = await buildIngestingApp({
        personas: ['work'],
      });
      // Register an explicit variant → canonical alias BEFORE the touches.
      await repoByPersona.get('work')!.putAlias('tax plans', 'tax');

      // Touch the variant — server should resolve to canonical.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/memory/touch',
        headers: { 'content-type': 'application/json' },
        payload: { persona: 'work', topic: 'tax plans', kind: 'theme' },
      });
      expect(res.json()).toMatchObject({
        topic: 'tax plans',
        canonical_topic: 'tax',
      });

      // Then touch the canonical form — should hit the SAME row.
      await app.inject({
        method: 'POST',
        url: '/v1/memory/touch',
        headers: { 'content-type': 'application/json' },
        payload: { persona: 'work', topic: 'tax', kind: 'theme' },
      });

      const tocRes = await app.inject({ method: 'GET', url: '/v1/memory/toc' });
      const entries = (tocRes.json() as { entries: TocEntry[] }).entries;
      // Both touches collapsed into one canonical row.
      const taxEntries = entries.filter((e) => e.topic === 'tax');
      expect(taxEntries).toHaveLength(1);
      await app.close();
    });

    it('accepts sample_item_id when provided', async () => {
      const { app, repoByPersona } = await buildIngestingApp({ personas: ['work'] });
      await app.inject({
        method: 'POST',
        url: '/v1/memory/touch',
        headers: { 'content-type': 'application/json' },
        payload: {
          persona: 'work',
          topic: 'sancho',
          kind: 'entity',
          sample_item_id: 'item-42',
        },
      });
      const topic = await repoByPersona.get('work')!.get('sancho');
      expect(topic?.sample_item_id).toBe('item-42');
      await app.close();
    });

    it('kind=entity stored as entity', async () => {
      const { app } = await buildIngestingApp({ personas: ['work'] });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/memory/touch',
        headers: { 'content-type': 'application/json' },
        payload: { persona: 'work', topic: 'sancho', kind: 'entity' },
      });
      expect(res.json()).toMatchObject({ kind: 'entity' });
      await app.close();
    });

    it.each([
      ['missing persona', { topic: 'x', kind: 'theme' }, 'persona is required'],
      ['empty persona', { persona: '', topic: 'x', kind: 'theme' }, 'persona is required'],
      ['missing topic', { persona: 'work', kind: 'theme' }, 'topic is required'],
      ['whitespace topic', { persona: 'work', topic: '  ', kind: 'theme' }, 'topic is required'],
      [
        'missing kind',
        { persona: 'work', topic: 'x' },
        'kind must be "entity" or "theme"',
      ],
      [
        'invalid kind',
        { persona: 'work', topic: 'x', kind: 'namespace' },
        'kind must be "entity" or "theme"',
      ],
      [
        'non-string sample_item_id',
        { persona: 'work', topic: 'x', kind: 'theme', sample_item_id: 42 },
        'sample_item_id must be a string when provided',
      ],
    ])('rejects %s with 400', async (_label, payload, errorMsg) => {
      const { app } = await buildIngestingApp({ personas: ['work'] });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/memory/touch',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: errorMsg });
      await app.close();
    });

    it('returns 503 when persona has no topic repository (locked)', async () => {
      const { app } = await buildIngestingApp({ personas: ['work'] });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/memory/touch',
        headers: { 'content-type': 'application/json' },
        payload: { persona: 'health', topic: 'x', kind: 'theme' },
      });
      expect(res.statusCode).toBe(503);
      await app.close();
    });

    it('is NOT registered when topicRepositoryResolver is absent (404)', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      const memoryService = new FakeMemoryService();
      registerMemoryRoutes(app, { memoryService });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/memory/touch',
        headers: { 'content-type': 'application/json' },
        payload: { persona: 'work', topic: 'x', kind: 'theme' },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('server-derived nowUnix is used (ignores client-supplied timestamps)', async () => {
      const serverNow = 1_700_000_000;
      const { app, repoByPersona } = await buildIngestingApp({
        personas: ['work'],
        nowSec: serverNow,
      });
      await app.inject({
        method: 'POST',
        url: '/v1/memory/touch',
        headers: { 'content-type': 'application/json' },
        // If the server trusted a client timestamp, it would use this far-future one.
        payload: {
          persona: 'work',
          topic: 'taxes',
          kind: 'theme',
          nowUnix: 9_999_999_999,
        },
      });
      const topic = await repoByPersona.get('work')!.get('taxes');
      // last_update must reflect server clock, not the spoof.
      expect(topic?.last_update).toBe(serverNow);
      await app.close();
    });
  });

  describe('registerMemoryRoutes construction', () => {
    it('throws when memoryService is missing', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      expect(() =>
        registerMemoryRoutes(app, {
          memoryService: undefined as unknown as MemoryService,
        }),
      ).toThrow(/memoryService is required/);
      await app.close();
    });

    it('rejects non-positive defaultLimit', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      const svc = new FakeMemoryService();
      expect(() =>
        registerMemoryRoutes(app, { memoryService: svc, defaultLimit: 0 }),
      ).toThrow(/defaultLimit/);
      expect(() =>
        registerMemoryRoutes(app, { memoryService: svc, defaultLimit: 1.5 }),
      ).toThrow(/defaultLimit/);
      await app.close();
    });

    it('rejects maxLimit below defaultLimit', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      const svc = new FakeMemoryService();
      expect(() =>
        registerMemoryRoutes(app, {
          memoryService: svc,
          defaultLimit: 50,
          maxLimit: 10,
        }),
      ).toThrow(/maxLimit/);
      await app.close();
    });
  });
});
