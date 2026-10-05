/**
 * The UCP merchant index (docs/UCP_IMPLEMENTATION_PLAN.md §3.15, U5), against
 * a real Postgres: which origins come in (only PeerLens organization subjects
 * identified by an origin, D4), how each is read (once a day at most, a
 * conditional request, an earlier read standing through a passing failure),
 * PeerLens trust copied in, and the two xRPC methods (relevance filters,
 * trust orders; the cursor; getMerchant).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { getMerchant, searchMerchants } from '@/api/xrpc/ucp-merchants.js';
import { generateDeterministicId } from '@/db/queries/subjects.js';
import { attestations, subjects, subjectScores } from '@/db/schema/index.js';
import {
  READ_RULES,
  refreshTrust,
  ucpMerchantCrawler,
  type CrawlerDeps,
} from '@/scorer/jobs/ucp-merchant-crawler.js';
import { takeJobLock } from '@/scorer/scheduler.js';
import { dispatchXrpc } from '@/web/xrpc-dispatch.js';
import { XRPC_ROUTES } from '@/web/xrpc-routes.js';
import type { ProfileFetch } from '@/ucp/merchant_fetch.js';

import { cleanAllTables, closeTestDb, getTestDb } from '../test-db.js';

const db = getTestDb();
const V = '2026-08-25';
const DAY = 24 * 3600_000;
const s = (p: string) => `https://ucp.dev/${V}/schemas/shopping/${p}.json`;

function profileBytes(
  origin: string,
  caps: string[],
  over: Record<string, unknown> = {},
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      ucp: {
        version: V,
        services: {
          'dev.ucp.shopping': [
            {
              version: V,
              transport: 'mcp',
              endpoint: `${origin}/ucp/mcp`,
              schema: `https://ucp.dev/${V}/services/shopping/mcp.openrpc.json`,
            },
          ],
        },
        capabilities: Object.fromEntries(
          caps.map((c) => [`dev.ucp.shopping.${c}`, [{ version: V, schema: s(c) }]]),
        ),
        payment_handlers: { 'com.google.pay': [{ id: 'g', version: '2026-01-11' }] },
        ...over,
      },
    }),
  );
}

let attestationN = 0;
/** A live PeerLens attestation about `subjectId` (revoked or taken down when asked). */
async function attest(
  subjectId: string,
  uri: string,
  more: { category?: string; revoked?: boolean; takedown?: boolean } = {},
) {
  await db.insert(attestations).values({
    uri: `at://did:plc:a/com.dinakernel.peerlens.attestation/${++attestationN}`,
    authorDid: 'did:plc:a',
    cid: `c${attestationN}`,
    subjectId,
    subjectRefRaw: { type: 'organization', uri },
    category: more.category ?? 'shopping',
    sentiment: 'positive',
    recordCreatedAt: new Date(),
    indexedAt: new Date(),
    ...(more.revoked === true ? { isRevoked: true } : {}),
    ...(more.takedown === true ? { isTakedownByModerator: true } : {}),
  } as never);
}

async function org(
  uri: string,
  name: string,
  score?: { weighted: number; total: number },
  more: { tombstoned?: boolean; type?: string; attested?: boolean; key?: { did: string } } = {},
) {
  const type = more.type ?? 'organization';
  const id = generateDeterministicId(
    more.key !== undefined
      ? ({ type, did: more.key.did, uri } as never)
      : { type: type as 'organization', uri },
  ).id;
  await db.insert(subjects).values({
    id,
    name,
    subjectType: type,
    identifiersJson: [{ uri }],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...(more.tombstoned === true ? { tombstonedAt: new Date() } : {}),
  });
  if (more.attested !== false) await attest(id, uri);
  if (score !== undefined)
    await db.insert(subjectScores).values({
      subjectId: id,
      weightedScore: score.weighted,
      totalAttestations: score.total,
      computedAt: new Date(),
    });
  return id;
}

let clock: number;
let docs: Map<string, ProfileFetch | (() => ProfileFetch)>;
let asked: { url: string; ifNoneMatch?: string }[];
const deps: CrawlerDeps = {
  now: () => clock,
  fetch: async (url, ifNoneMatch) => {
    asked.push({ url, ...(ifNoneMatch !== undefined ? { ifNoneMatch } : {}) });
    const d = docs.get(url);
    if (d === undefined) return { kind: 'failed', reason: 'not_found' };
    return typeof d === 'function' ? d() : d;
  },
};
const doc = (
  bytes: Uint8Array,
  etag: string | null = null,
  maxAgeMs: number | null = null,
): ProfileFetch => ({
  kind: 'document',
  bytes,
  etag,
  maxAgeMs,
});
const row = async (origin: string) =>
  (
    (await db.execute(sql`SELECT * FROM ucp_merchants WHERE origin = ${origin}`)) as unknown as {
      rows: Record<string, unknown>[];
    }
  ).rows[0];

beforeEach(async () => {
  await cleanAllTables(db);
  clock = Date.parse('2026-10-05T10:00:00Z');
  asked = [];
  docs = new Map([
    [
      'https://tea.example/.well-known/ucp',
      doc(profileBytes('https://tea.example', ['checkout', 'catalog.search']), '"e1"', 3600_000),
    ],
    [
      'https://rice.example/.well-known/ucp',
      doc(profileBytes('https://rice.example', ['checkout'])),
    ],
  ]);
});
afterAll(async () => closeTestDb());

describe('which merchants come in (D4)', () => {
  it('only origins live organization subjects are identified by; a page, another subject type, a removed subject stay out', async () => {
    await org('https://tea.example', 'Tea House');
    await org('https://rice.example/', 'Rice Co');
    await org('https://shop.example/about', 'A page');
    await org('https://gadget.example', 'A product', undefined, { type: 'product' });
    await org('https://gone.example', 'Gone', undefined, { tombstoned: true });
    await org('http://plain.example', 'Plain http');
    // Another port of a host is never reached: the index connects only on 443.
    await org('https://victim.example:22', 'A port');
    await ucpMerchantCrawler(db as never, deps);
    const origins = (
      (await db.execute(sql`SELECT origin FROM ucp_merchants ORDER BY origin`)) as unknown as {
        rows: { origin: string }[];
      }
    ).rows.map((r) => r.origin);
    expect(origins).toEqual(['https://rice.example', 'https://tea.example']);
  });

  it('only what attestations name: a bare subject record, or one whose only attestation is revoked or taken down, stays out', async () => {
    await org('https://bare.example', 'Bare', undefined, { attested: false });
    const revoked = await org('https://revoked.example', 'Revoked', undefined, { attested: false });
    await attest(revoked, 'https://revoked.example', { revoked: true });
    const takedown = await org('https://down.example', 'Down', undefined, { attested: false });
    await attest(takedown, 'https://down.example', { takedown: true });
    await org('https://tea.example', 'Tea House');
    await ucpMerchantCrawler(db as never, deps);
    const origins = (
      (await db.execute(sql`SELECT origin FROM ucp_merchants ORDER BY origin`)) as unknown as {
        rows: { origin: string }[];
      }
    ).rows.map((r) => r.origin);
    expect(origins).toEqual(['https://tea.example']);
  });

  it('an origin spelled another way PeerLens folds (case, :443, tracking parameters) comes in as the origin', async () => {
    await org('https://Shop.Example:443/?utm_source=x', 'Shop');
    await ucpMerchantCrawler(db as never, deps);
    expect(await row('https://shop.example')).toBeDefined();
  });

  it('a subject PeerLens keys by DID is not where its trust would be looked up: it stays out', async () => {
    await org(
      'https://did-keyed.example',
      'DID keyed',
      { weighted: 0.9, total: 4 },
      { key: { did: 'did:plc:keyedorg' } },
    );
    await ucpMerchantCrawler(db as never, deps);
    expect(await row('https://did-keyed.example')).toBeUndefined();
  });

  it('a merchant no longer named leaves the index', async () => {
    const id = await org('https://tea.example', 'Tea House');
    await ucpMerchantCrawler(db as never, deps);
    expect(await row('https://tea.example')).toBeDefined();
    await db.execute(sql`UPDATE subjects SET tombstoned_at = now() WHERE id = ${id}`);
    await ucpMerchantCrawler(db as never, deps);
    expect(await row('https://tea.example')).toBeUndefined();
  });
});

describe('reading each merchant', () => {
  beforeEach(async () => {
    await org('https://tea.example', 'Tea House', { weighted: 0.9, total: 5 });
  });

  it('a new merchant is due by the crawler’s own clock, never the database’s: read in the same run even with the clock years behind', async () => {
    clock = Date.parse('2020-01-01T00:00:00Z');
    await ucpMerchantCrawler(db as never, deps);
    expect(await row('https://tea.example')).toMatchObject({ state: 'usable' });
    expect(new Date((await row('https://tea.example'))?.first_seen_at as string).getTime()).toBe(
      clock,
    );
  });

  it('a usable profile: version, transport, endpoint, capabilities; read again no sooner than a day, then conditionally', async () => {
    await ucpMerchantCrawler(db as never, deps);
    expect(await row('https://tea.example')).toMatchObject({
      state: 'usable',
      version: V,
      transport: 'mcp',
      endpoint: 'https://tea.example/ucp/mcp',
      capabilities: ['dev.ucp.shopping.catalog.search', 'dev.ucp.shopping.checkout'],
      etag: '"e1"',
      failures: 0,
    });
    // max-age an hour: still a day before the next read.
    expect(new Date((await row('https://tea.example'))?.next_check_at as string).getTime()).toBe(
      clock + DAY,
    );
    clock += DAY / 2;
    asked = [];
    await ucpMerchantCrawler(db as never, deps);
    expect(asked).toEqual([]);
    clock += DAY;
    docs.set('https://tea.example/.well-known/ucp', { kind: 'not_modified', maxAgeMs: null });
    await ucpMerchantCrawler(db as never, deps);
    expect(asked).toEqual([{ url: 'https://tea.example/.well-known/ucp', ifNoneMatch: '"e1"' }]);
    expect(await row('https://tea.example')).toMatchObject({ state: 'usable', failures: 0 });
  });

  it('a merchant never reached is tried again no sooner than a day, doubling up to a week', async () => {
    docs.set('https://tea.example/.well-known/ucp', {
      kind: 'failed',
      reason: 'unreachable',
      detail: 'dns_failed',
    });
    const gaps: number[] = [];
    for (let i = 0; i < 5; i++) {
      await ucpMerchantCrawler(db as never, deps);
      const next = new Date((await row('https://tea.example'))?.next_check_at as string).getTime();
      gaps.push(next - clock);
      clock = next;
    }
    expect(gaps).toEqual([DAY, 2 * DAY, 4 * DAY, 7 * DAY, 7 * DAY]);
    expect(await row('https://tea.example')).toMatchObject({
      state: 'unusable',
      reason: 'unreachable',
    });
  });

  it('a 304 is freshened for as long as its own Cache-Control says, up to a week', async () => {
    await ucpMerchantCrawler(db as never, deps);
    clock += DAY;
    docs.set('https://tea.example/.well-known/ucp', { kind: 'not_modified', maxAgeMs: 30 * DAY });
    await ucpMerchantCrawler(db as never, deps);
    expect(new Date((await row('https://tea.example'))?.next_check_at as string).getTime()).toBe(
      clock + 7 * DAY,
    );
    expect(await row('https://tea.example')).toMatchObject({ etag: '"e1"', state: 'usable' });
  });

  it('a read made under other rules is made again in full: no If-None-Match', async () => {
    await ucpMerchantCrawler(db as never, deps);
    await db.execute(sql`UPDATE ucp_merchants SET rules = 'older-rules'`);
    clock += DAY;
    asked = [];
    await ucpMerchantCrawler(db as never, deps);
    expect(asked).toEqual([{ url: 'https://tea.example/.well-known/ucp' }]);
    expect(await row('https://tea.example')).toMatchObject({ rules: READ_RULES });
  });

  it('the earlier usable read stands six days out of reach, and goes just past seven', async () => {
    await ucpMerchantCrawler(db as never, deps);
    const usableAt = clock;
    docs.set('https://tea.example/.well-known/ucp', { kind: 'failed', reason: 'unreachable' });
    clock = usableAt + 6 * DAY;
    await db.execute(sql`UPDATE ucp_merchants SET next_check_at = ${new Date(clock)}`);
    await ucpMerchantCrawler(db as never, deps);
    expect(await row('https://tea.example')).toMatchObject({ state: 'usable' });
    clock = usableAt + 7 * DAY + 1;
    await db.execute(sql`UPDATE ucp_merchants SET next_check_at = ${new Date(clock)}`);
    await ucpMerchantCrawler(db as never, deps);
    expect(await row('https://tea.example')).toMatchObject({
      state: 'unusable',
      reason: 'unreachable',
    });
  });

  it('a long max-age is honoured, up to a week', async () => {
    docs.set(
      'https://tea.example/.well-known/ucp',
      doc(profileBytes('https://tea.example', ['checkout']), null, 30 * DAY),
    );
    await ucpMerchantCrawler(db as never, deps);
    expect(new Date((await row('https://tea.example'))?.next_check_at as string).getTime()).toBe(
      clock + 7 * DAY,
    );
  });

  it('out of reach: the earlier usable read stands a week, retried no sooner than a day, doubling; after that, unusable', async () => {
    await ucpMerchantCrawler(db as never, deps);
    docs.set('https://tea.example/.well-known/ucp', {
      kind: 'failed',
      reason: 'unreachable',
      detail: 'timeout',
    });
    clock += DAY;
    await ucpMerchantCrawler(db as never, deps);
    expect(await row('https://tea.example')).toMatchObject({ state: 'usable', failures: 1 });
    expect(new Date((await row('https://tea.example'))?.next_check_at as string).getTime()).toBe(
      clock + DAY,
    );
    clock += DAY;
    await ucpMerchantCrawler(db as never, deps);
    expect(new Date((await row('https://tea.example'))?.next_check_at as string).getTime()).toBe(
      clock + 2 * DAY,
    );
    clock += 7 * DAY;
    await ucpMerchantCrawler(db as never, deps);
    expect(await row('https://tea.example')).toMatchObject({
      state: 'unusable',
      reason: 'unreachable',
      capabilities: [],
    });
  });

  it('a profile it cannot use is unusable at once, with the reason; a later good one is usable again', async () => {
    docs.set(
      'https://tea.example/.well-known/ucp',
      doc(profileBytes('https://tea.example', ['checkout'], { version: '2027-01-01' })),
    );
    await ucpMerchantCrawler(db as never, deps);
    expect(await row('https://tea.example')).toMatchObject({
      state: 'unusable',
      reason: 'no_shared_version',
    });
    docs.set(
      'https://tea.example/.well-known/ucp',
      doc(new TextEncoder().encode('{"ucp":1,"ucp":2}')),
    );
    clock += DAY;
    await ucpMerchantCrawler(db as never, deps);
    expect(await row('https://tea.example')).toMatchObject({
      state: 'unusable',
      reason: 'profile_malformed',
    });
    docs.set(
      'https://tea.example/.well-known/ucp',
      doc(profileBytes('https://tea.example', ['checkout'])),
    );
    clock += DAY;
    await ucpMerchantCrawler(db as never, deps);
    expect(await row('https://tea.example')).toMatchObject({ state: 'usable', reason: null });
  });

  it('a leaf on another host is never fetched: the merchant is unusable', async () => {
    docs.set(
      'https://tea.example/.well-known/ucp',
      doc(
        profileBytes('https://tea.example', ['checkout'], {
          version: '2027-01-01',
          supported_versions: { [V]: 'https://elsewhere.example/leaf' },
        }),
      ),
    );
    await ucpMerchantCrawler(db as never, deps);
    expect(asked.map((a) => a.url)).toEqual(['https://tea.example/.well-known/ucp']);
    expect(await row('https://tea.example')).toMatchObject({
      state: 'unusable',
      reason: 'leaf_unusable',
    });
  });

  it('through a leaf profile: no ETag kept (the leaf may change on its own), the leaf asked every time', async () => {
    const leaf = 'https://tea.example/.well-known/ucp/2026-08-25';
    docs.set(
      'https://tea.example/.well-known/ucp',
      doc(
        profileBytes('https://tea.example', ['checkout'], {
          version: '2027-01-01',
          supported_versions: { [V]: leaf },
        }),
        '"root"',
      ),
    );
    docs.set(leaf, doc(profileBytes('https://tea.example', ['checkout'])));
    await ucpMerchantCrawler(db as never, deps);
    expect(await row('https://tea.example')).toMatchObject({ state: 'usable', etag: null });
    expect(asked.map((a) => a.url)).toContain(leaf);
    // The next read asks both again, unconditionally (the leaf may have changed on its own).
    clock += DAY;
    asked = [];
    await ucpMerchantCrawler(db as never, deps);
    expect(asked).toEqual([{ url: 'https://tea.example/.well-known/ucp' }, { url: leaf }]);
    // The leaf out of reach for a while: the merchant out of reach, its read standing.
    docs.set(leaf, { kind: 'failed', reason: 'unreachable', detail: 'timeout' });
    clock += DAY;
    await ucpMerchantCrawler(db as never, deps);
    expect(await row('https://tea.example')).toMatchObject({ state: 'usable', failures: 1 });
  });
});

describe('the table as the migration made it', () => {
  it('its CHECK constraints and its search index exist (the schema file declares the same)', async () => {
    const checks = (
      (await db.execute(sql`
      SELECT conname FROM pg_constraint WHERE conrelid = 'ucp_merchants'::regclass AND contype = 'c' ORDER BY conname`)) as unknown as {
        rows: { conname: string }[];
      }
    ).rows.map((r) => r.conname);
    expect(checks).toEqual([
      'ucp_merchants_state_check',
      'ucp_merchants_transport_check',
      'ucp_merchants_trust_score_check',
    ]);
    const indexes = (
      (await db.execute(
        sql`SELECT indexname FROM pg_indexes WHERE tablename = 'ucp_merchants' ORDER BY indexname`,
      )) as unknown as { rows: { indexname: string }[] }
    ).rows.map((r) => r.indexname);
    expect(indexes).toEqual([
      'ucp_merchants_capabilities_idx',
      'ucp_merchants_due_idx',
      'ucp_merchants_pkey',
      'ucp_merchants_search_idx',
    ]);
    await expect(
      db.execute(
        sql`INSERT INTO ucp_merchants (origin, state) VALUES ('https://x.example', 'odd')`,
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(
        sql`INSERT INTO ucp_merchants (origin, trust_score) VALUES ('https://y.example', 2)`,
      ),
    ).rejects.toThrow();
  });
});

describe('trust copied from PeerLens', () => {
  it('every merchant in turn: each run refreshes the longest-unrefreshed first', async () => {
    const tea = await org('https://tea.example', 'Tea House', { weighted: 0.5, total: 1 });
    await org('https://rice.example', 'Rice Co', { weighted: 0.5, total: 1 });
    await ucpMerchantCrawler(db as never, deps);
    // PeerLens's view of tea changes; refreshed one at a time, rice goes first (refreshed at the same
    // moment, ordered by origin), then tea.
    await db.execute(
      sql`UPDATE subject_scores SET weighted_score = 0.95 WHERE subject_id = ${tea}`,
    );
    clock += 1000;
    expect(await refreshTrust(db as never, clock, 1)).toBe(1);
    expect((await row('https://tea.example'))?.trust_score).toBeCloseTo(0.5, 5);
    clock += 1000;
    await refreshTrust(db as never, clock, 1);
    expect((await row('https://tea.example'))?.trust_score).toBeCloseTo(0.95, 5);
  });
});

describe('the two xRPC methods', () => {
  beforeEach(async () => {
    await org('https://tea.example', 'Tea House', { weighted: 0.9, total: 5 });
    const rice = await org('https://rice.example', 'Rice Co', { weighted: 0.3, total: 2 });
    await org('https://flour.example', 'Flour Mill');
    await attest(rice, 'https://rice.example', { category: 'groceries' });
    await ucpMerchantCrawler(db as never, deps);
  });

  it('usable first, then by trust; one that cannot be used last; unverified said', async () => {
    const out = await searchMerchants(db as never, { limit: 20 });
    expect(out.merchants.map((m) => [m.origin, m.state, m.trustScore, m.verified])).toEqual([
      ['https://tea.example', 'usable', expect.closeTo(0.9, 5), true],
      ['https://rice.example', 'usable', expect.closeTo(0.3, 5), true],
      ['https://flour.example', 'unusable', null, false],
    ]);
    expect(out.merchants[2]?.reason).toBe('not_found');
  });

  it('state outranks trust: a well-trusted merchant not read yet, or unusable, comes after a less trusted usable one', async () => {
    await org('https://trusted-broken.example', 'Broken', { weighted: 0.99, total: 9 });
    await org('https://trusted-new.example', 'New', { weighted: 0.98, total: 9 });
    await ucpMerchantCrawler(db as never, deps);
    await db.execute(
      sql`UPDATE ucp_merchants SET state = 'pending' WHERE origin = 'https://trusted-new.example'`,
    );
    const order = (await searchMerchants(db as never, { limit: 20 })).merchants.map((m) => [
      m.origin,
      m.state,
    ]);
    expect(order).toEqual([
      ['https://tea.example', 'usable'],
      ['https://rice.example', 'usable'],
      ['https://trusted-new.example', 'pending'],
      ['https://trusted-broken.example', 'unusable'],
      ['https://flour.example', 'unusable'],
    ]);
  });

  it('PeerLens avoid, from PeerLens itself, sinks below the merchants not avoided', async () => {
    await org('https://bad.example', 'Bad Shop', { weighted: 0.1, total: 9 });
    docs.set(
      'https://bad.example/.well-known/ucp',
      doc(profileBytes('https://bad.example', ['checkout'])),
    );
    await ucpMerchantCrawler(db as never, deps);
    expect(await row('https://bad.example')).toMatchObject({
      recommendation: 'avoid',
      state: 'usable',
    });
    const usable = (await searchMerchants(db as never, { limit: 20 })).merchants
      .filter((m) => m.state === 'usable')
      .map((m) => m.origin);
    expect(usable.at(-1)).toBe('https://bad.example');
  });

  it('under a text filter, trust still orders: a stronger text match does not outrank a better-trusted shop', async () => {
    await org('https://leaf-leaf.example', 'Leaf Leaf Leaf Tea Tea', { weighted: 0.2, total: 3 });
    docs.set(
      'https://leaf-leaf.example/.well-known/ucp',
      doc(profileBytes('https://leaf-leaf.example', ['checkout'])),
    );
    await ucpMerchantCrawler(db as never, deps);
    const out = await searchMerchants(db as never, { q: 'tea', limit: 20 });
    expect(out.merchants.map((m) => m.origin)).toEqual([
      'https://tea.example',
      'https://leaf-leaf.example',
    ]);
  });

  it('the merchant’s own words never enter the search text', async () => {
    docs.set(
      'https://tea.example/.well-known/ucp',
      doc(
        profileBytes('https://tea.example', ['checkout'], {
          name: 'Best Deals Megastore',
          description: 'deals deals',
        }),
      ),
    );
    clock += DAY;
    await ucpMerchantCrawler(db as never, deps);
    expect((await searchMerchants(db as never, { q: 'deals', limit: 20 })).merchants).toEqual([]);
    expect((await row('https://tea.example'))?.search_text).toBe('Tea House tea.example shopping');
  });

  it('a NUL in the query or the cursor is refused (400) through the real dispatcher', async () => {
    for (const searchParams of [
      new URLSearchParams({ q: 'tea\u0000' }),
      new URLSearchParams({ cursor: 'x\u0000' }),
    ]) {
      const outcome = await dispatchXrpc({
        routes: XRPC_ROUTES,
        db: db as never,
        methodId: 'com.dinakernel.ucp.searchMerchants',
        searchParams,
      });
      expect(outcome.status).toBe(400);
    }
  });

  it('a capability filters; text over PeerLens’s name and categories filters, trust still orders', async () => {
    expect(
      (
        await searchMerchants(db as never, {
          capability: 'dev.ucp.shopping.catalog.search',
          limit: 20,
        })
      ).merchants.map((m) => m.origin),
    ).toEqual(['https://tea.example']);
    expect(
      (await searchMerchants(db as never, { q: 'groceries', limit: 20 })).merchants.map(
        (m) => m.origin,
      ),
    ).toEqual(['https://rice.example']);
    expect(
      (await searchMerchants(db as never, { q: 'tea', limit: 20 })).merchants.map((m) => m.origin),
    ).toEqual(['https://tea.example']);
  });

  it('the cursor walks every merchant once, in order, through ties, avoid and a text query; a foreign cursor is refused', async () => {
    const walk = async (q?: string) => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 20; i++) {
        const page = await searchMerchants(db as never, {
          limit: 1,
          ...(q !== undefined ? { q } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        seen.push(...page.merchants.map((m) => m.origin));
        if (page.cursor === null) break;
        cursor = page.cursor;
      }
      return seen;
    };
    expect(await walk()).toEqual([
      'https://tea.example',
      'https://rice.example',
      'https://flour.example',
    ]);
    // Ties of trust (broken by origin), and one PeerLens says to avoid.
    for (const name of ['b-tie', 'a-tie', 'c-tie']) {
      await org(`https://${name}.example`, `${name} Grocer`, { weighted: 0.5, total: 3 });
      docs.set(
        `https://${name}.example/.well-known/ucp`,
        doc(profileBytes(`https://${name}.example`, ['checkout'])),
      );
    }
    await org('https://zz-avoid.example', 'Avoid Grocer', { weighted: 0.1, total: 9 });
    docs.set(
      'https://zz-avoid.example/.well-known/ucp',
      doc(profileBytes('https://zz-avoid.example', ['checkout'])),
    );
    await ucpMerchantCrawler(db as never, deps);
    const all = (await searchMerchants(db as never, { limit: 50 })).merchants.map((m) => m.origin);
    expect(await walk()).toEqual(all);
    expect(all.indexOf('https://a-tie.example')).toBeLessThan(all.indexOf('https://b-tie.example'));
    const grocers = (await searchMerchants(db as never, { q: 'grocer', limit: 50 })).merchants.map(
      (m) => m.origin,
    );
    expect(grocers).toEqual([
      'https://a-tie.example',
      'https://b-tie.example',
      'https://c-tie.example',
      'https://zz-avoid.example',
    ]);
    expect(await walk('grocer')).toEqual(grocers);
    await expect(
      searchMerchants(db as never, { limit: 1, cursor: 'bm90LWEtY3Vyc29y' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('getMerchant reads one merchant by its origin, normalised; none, or not an origin, is refused', async () => {
    expect(
      (await getMerchant(db as never, { origin: 'https://TEA.example/' })).merchant,
    ).toMatchObject({
      origin: 'https://tea.example',
      name: 'Tea House',
      state: 'usable',
      transport: 'mcp',
      // PeerLens's own word for a high score on few reviews (confidence still low).
      recommendation: 'caution',
    });
    await expect(
      getMerchant(db as never, { origin: 'https://none.example' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(getMerchant(db as never, { origin: 'http://tea.example' })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('the scheduler’s lock (one connection per job)', () => {
  it('a second taker finds it held; released on its own connection, it can be taken again', async () => {
    const first = await takeJobLock(db as never, 424242, 'ucp-merchant-crawler');
    expect(first).not.toBe('held');
    expect(await takeJobLock(db as never, 424242, 'ucp-merchant-crawler')).toBe('held');
    if (first !== 'held') await first.release();
    const again = await takeJobLock(db as never, 424242, 'ucp-merchant-crawler');
    expect(again).not.toBe('held');
    if (again !== 'held') await again.release();
  });
});
