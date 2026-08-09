/**
 * Catalog feed ingest (§10.2, §10.3) — producer and consumer meet.
 *
 * These drive ChairMaker's REAL publisher output through Sancho's ingester, so
 * the two halves are checked against each other rather than against fixtures
 * one of them invented. Then a hostile feed host tries every substitution the
 * chain exists to refuse.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  fetchUnderPolicy,
  ingestCatalog,
  type FeedResponse,
  type FeedTransport,
} from '../../src/commerce/catalog_ingest';
import { buildCatalogSnapshot, buildCatalogWithdrawal } from '../../src/commerce/catalog_publisher';

import type { CatalogPointer } from '@dina/commerce-protocol';

const hash = (data: Uint8Array): Uint8Array => sha256(data);

const MANUFACTURER = 'did:plc:chairmaker';
const CATALOG = 'chairmaker-main';
const SNAPSHOT_URL = 'https://feed.chairmaker.example/snapshot.json';
const pageUrl = (i: number): string => `https://feed.chairmaker.example/page-${String(i)}.json`;

function ok(body: string, overrides: Partial<FeedResponse> = {}): FeedResponse {
  return {
    status: 200,
    contentType: 'application/json',
    connectedAddress: '203.0.113.10',
    body,
    compressedBytes: body.length,
    decompressedBytes: body.length,
    ...overrides,
  };
}

/** ChairMaker publishes; the map is what its feed host would serve. */
function publishCatalog(itemCount: number, pageSize = 2) {
  const result = buildCatalogSnapshot({
    supplierDid: MANUFACTURER,
    catalogId: CATALOG,
    protocolVersion: '1.0',
    publishedAt: '2026-08-08T10:00:00.000Z',
    items: Array.from({ length: itemCount }, (_, i) => ({ sku: `CHAIR-${String(i)}` })),
    previous: null,
    pageSize,
    sha256: hash,
  });
  if (!result.ok || result.snapshot === undefined || result.pages === undefined) {
    throw new Error('publish failed');
  }
  const served = new Map<string, string>([[SNAPSHOT_URL, JSON.stringify(result.snapshot)]]);
  result.pages.forEach((page, i) => served.set(pageUrl(i), JSON.stringify(page)));
  return { ...result, snapshot: result.snapshot, pages: result.pages, served };
}

function transportFor(
  served: Map<string, string>,
  tamper?: (url: string, r: FeedResponse) => FeedResponse,
): FeedTransport {
  return (url) => {
    const body = served.get(url);
    if (body === undefined) return Promise.resolve(ok('{}', { status: 404 }));
    const response = ok(body);
    return Promise.resolve(tamper === undefined ? response : tamper(url, response));
  };
}

describe('Sancho ingests what ChairMaker actually published', () => {
  it('verifies the whole chain and returns the items in payload order', async () => {
    const published = publishCatalog(5);

    const result = await ingestCatalog({
      pointer: published.pointer,
      previousPointer: null,
      snapshotUrl: SNAPSHOT_URL,
      pageUrl,
      transport: transportFor(published.served),
      sha256: hash,
    });

    if (!result.ok) throw new Error(result.error);
    expect(result.value.items).toEqual(
      Array.from({ length: 5 }, (_, i) => ({ sku: `CHAIR-${String(i)}` })),
    );
    expect(result.value.snapshot.snapshot_digest).toBe(published.snapshot.snapshot_digest);
  });

  it('refuses a pointer that does not advance from what it last accepted', async () => {
    const first = publishCatalog(2);
    // Replaying the genesis pointer as if it were new: an ingester that always
    // passed null would index an old catalog as current.
    const result = await ingestCatalog({
      pointer: first.pointer,
      previousPointer: first.pointer,
      snapshotUrl: SNAPSHOT_URL,
      pageUrl,
      transport: transportFor(first.served),
      sha256: hash,
    });

    expect(!result.ok && result.refusal).toBe('pointer_refused');
  });

  it('refuses a withdrawn catalog without fetching anything', async () => {
    const first = publishCatalog(2);
    const withdrawal = buildCatalogWithdrawal({
      supplierDid: MANUFACTURER,
      catalogId: CATALOG,
      protocolVersion: '1.0',
      publishedAt: '2026-08-08T12:00:00.000Z',
      previous: { pointer: first.pointer, snapshotDigest: first.snapshot.snapshot_digest },
    });
    if (!withdrawal.ok) throw new Error('withdrawal failed');

    let fetched = 0;
    const result = await ingestCatalog({
      pointer: withdrawal.pointer,
      previousPointer: first.pointer,
      snapshotUrl: SNAPSHOT_URL,
      pageUrl,
      transport: () => {
        fetched += 1;
        return Promise.resolve(ok('{}'));
      },
      sha256: hash,
    });

    expect(!result.ok && result.refusal).toBe('snapshot_refused');
    // A tombstone publishes nothing, so there is nothing to go and get.
    expect(fetched).toBe(0);
  });
});

describe('a hostile feed host cannot substitute anything', () => {
  it('refuses a snapshot the pointer does not name, even a valid one', async () => {
    const real = publishCatalog(2);
    const other = publishCatalog(3);
    // The impostor is internally perfect — it just is not the publication the
    // supplier's pointer commits to.
    const served = new Map(real.served);
    served.set(SNAPSHOT_URL, JSON.stringify(other.snapshot));

    const result = await ingestCatalog({
      pointer: real.pointer,
      previousPointer: null,
      snapshotUrl: SNAPSHOT_URL,
      pageUrl,
      transport: transportFor(served),
      sha256: hash,
    });

    expect(!result.ok && result.refusal).toBe('snapshot_refused');
    expect(!result.ok && result.error).toBe(
      'catalog feed: snapshot is not the one the pointer names',
    );
  });

  it('refuses an edited page', async () => {
    const published = publishCatalog(4);
    const served = new Map(published.served);
    const page = JSON.parse(served.get(pageUrl(0)) ?? '{}') as { items: unknown[] };
    page.items = [{ sku: 'CHAIR-CHEAP' }];
    served.set(pageUrl(0), JSON.stringify(page));

    const result = await ingestCatalog({
      pointer: published.pointer,
      previousPointer: null,
      snapshotUrl: SNAPSHOT_URL,
      pageUrl,
      transport: transportFor(served),
      sha256: hash,
    });

    expect(!result.ok && result.refusal).toBe('page_refused');
  });

  it('refuses when the pages do not add up to the snapshot count', async () => {
    const published = publishCatalog(4);
    const served = new Map(published.served);
    // Serve page 0 in place of page 1 — each page verifies on its own terms
    // only if its index matches, so this is caught as a positional fault.
    served.set(pageUrl(1), served.get(pageUrl(0)) ?? '');

    const result = await ingestCatalog({
      pointer: published.pointer,
      previousPointer: null,
      snapshotUrl: SNAPSHOT_URL,
      pageUrl,
      transport: transportFor(served),
      sha256: hash,
    });

    expect(result.ok).toBe(false);
  });
});

describe('fetch policy is applied by the pipeline, not left to the caller', () => {
  const body = '{"ok":true}';

  it('refuses a non-HTTPS URL before any request is made', async () => {
    let called = 0;
    const result = await fetchUnderPolicy('http://feed.example/x.json', () => {
      called += 1;
      return Promise.resolve(ok(body));
    });

    expect(!result.ok && result.refusal).toBe('url_refused');
    // The interesting failure is the request that should never have happened.
    expect(called).toBe(0);
  });

  it('refuses when the CONNECTED address is blocked, even from a clean URL', async () => {
    // DNS rebinding: the name validated, the socket landed on metadata.
    const result = await fetchUnderPolicy('https://feed.example/x.json', () =>
      Promise.resolve(ok(body, { connectedAddress: '169.254.169.254' })),
    );

    expect(!result.ok && result.refusal).toBe('blocked_connected_address');
  });

  it('re-validates every redirect target', async () => {
    const result = await fetchUnderPolicy('https://feed.example/x.json', (url) =>
      Promise.resolve(
        url === 'https://feed.example/x.json'
          ? ok('', { status: 302, location: 'https://169.254.169.254/latest/meta-data/' })
          : ok(body),
      ),
    );

    expect(!result.ok && result.refusal).toBe('redirect_refused');
  });

  it('follows a legitimate redirect and returns the body', async () => {
    const result = await fetchUnderPolicy('https://feed.example/x.json', (url) =>
      Promise.resolve(
        url === 'https://feed.example/x.json'
          ? ok('', { status: 302, location: 'https://cdn.example/x.json' })
          : ok(body),
      ),
    );

    expect(result.ok && result.value).toBe(body);
  });

  it('stops a redirect loop at the hop cap', async () => {
    const result = await fetchUnderPolicy('https://feed.example/x.json', () =>
      Promise.resolve(ok('', { status: 302, location: 'https://feed.example/x.json' })),
    );

    expect(!result.ok && result.refusal).toBe('redirect_refused');
  });

  it.each([
    ['a wrong content type', { contentType: 'text/html' }, 'content_type_refused'],
    ['an oversized body', { compressedBytes: 9 * 1024 * 1024 }, 'too_large'],
    [
      'a decompression bomb',
      { compressedBytes: 1_000, decompressedBytes: 5_000_000 },
      'decompression_refused',
    ],
    ['a non-200 status', { status: 500 }, 'bad_status'],
  ])('refuses %s', async (_label, overrides, refusal) => {
    const result = await fetchUnderPolicy('https://feed.example/x.json', () =>
      Promise.resolve(ok(body, overrides)),
    );
    expect(!result.ok && result.refusal).toBe(refusal);
  });

  it('refuses a body that is not JSON', async () => {
    const published = publishCatalog(2);
    const served = new Map(published.served);
    served.set(SNAPSHOT_URL, 'not json at all');

    const result = await ingestCatalog({
      pointer: published.pointer,
      previousPointer: null,
      snapshotUrl: SNAPSHOT_URL,
      pageUrl,
      transport: transportFor(served),
      sha256: hash,
    });

    expect(!result.ok && result.refusal).toBe('body_unreadable');
  });
});

describe('one ingest shares one budget (§10.3 byte and time caps)', () => {
  it('stops when the pages together exceed the byte budget', async () => {
    // Each response is individually within the per-response cap; only the
    // SHARED budget notices that a thousand of them is not.
    const published = publishCatalog(20, 1);
    const fat = 7 * 1024 * 1024;

    const result = await ingestCatalog({
      pointer: published.pointer,
      previousPointer: null,
      snapshotUrl: SNAPSHOT_URL,
      pageUrl,
      transport: (url) =>
        Promise.resolve(ok(published.served.get(url) ?? '{}', { compressedBytes: fat })),
      sha256: hash,
    });

    expect(!result.ok && result.refusal).toBe('budget_bytes_exhausted');
  });

  it('stops when the ingest runs past its time budget', async () => {
    const published = publishCatalog(6, 1);
    // A feed that answers slowly enough to outlast the budget: each call
    // advances the clock, and the check runs BEFORE the next request so no
    // further call is made once the budget is spent.
    let clock = 0;
    const result = await ingestCatalog({
      pointer: published.pointer,
      previousPointer: null,
      snapshotUrl: SNAPSHOT_URL,
      pageUrl,
      transport: (url) => {
        clock += 20_000;
        return Promise.resolve(ok(published.served.get(url) ?? '{}'));
      },
      sha256: hash,
      now: () => clock,
    });

    expect(!result.ok && result.refusal).toBe('budget_time_exhausted');
  });

  it('lets an ordinary catalog through on both budgets', async () => {
    const published = publishCatalog(6, 2);
    const result = await ingestCatalog({
      pointer: published.pointer,
      previousPointer: null,
      snapshotUrl: SNAPSHOT_URL,
      pageUrl,
      transport: transportFor(published.served),
      sha256: hash,
      now: () => 0,
    });
    expect(result.ok).toBe(true);
  });
});

describe('a second publication ingests as an advance', () => {
  it('accepts sequence 2 linked to the pointer it last held', async () => {
    const first = publishCatalog(2);
    const second = buildCatalogSnapshot({
      supplierDid: MANUFACTURER,
      catalogId: CATALOG,
      protocolVersion: '1.0',
      publishedAt: '2026-08-08T11:00:00.000Z',
      items: [{ sku: 'CHAIR-0' }, { sku: 'CHAIR-1' }, { sku: 'CHAIR-2' }],
      previous: { pointer: first.pointer, snapshotDigest: first.snapshot.snapshot_digest },
      pageSize: 2,
      sha256: hash,
    });
    if (!second.ok || second.snapshot === undefined || second.pages === undefined) {
      throw new Error('second publish failed');
    }
    const served = new Map<string, string>([[SNAPSHOT_URL, JSON.stringify(second.snapshot)]]);
    second.pages.forEach((page, i) => served.set(pageUrl(i), JSON.stringify(page)));

    const result = await ingestCatalog({
      pointer: second.pointer,
      previousPointer: first.pointer as CatalogPointer,
      snapshotUrl: SNAPSHOT_URL,
      pageUrl,
      transport: transportFor(served),
      sha256: hash,
    });

    if (!result.ok) throw new Error(result.error);
    expect(result.value.items).toHaveLength(3);
    expect(result.value.pointer.snapshot_sequence).toBe(2);
  });
});
