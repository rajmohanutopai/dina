/**
 * Consuming a supplier's catalog (§10.2 — WS-5.1).
 *
 * `ingestCatalog` was built, tested and unreachable, and the ledger reason was
 * precise: it FETCHES, and Core makes no outbound HTTP. A route that
 * constructed a fetch would put egress behind an owner endpoint where the gates
 * cannot see it.
 *
 * The wiring keeps that boundary rather than crossing it. The composition root
 * — the half that owns transport — INSTALLS one; this route asks whether one
 * exists and refuses when it does not. Core stays the thing that verifies what
 * comes back, which is the part worth having on this side of the line.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import {
  installCatalogFeedTransport,
  type FeedResponse,
} from '../../../src/commerce/catalog_ingest';
import {
  buildCatalogSnapshot,
  buildCatalogWithdrawal,
} from '../../../src/commerce/catalog_publisher';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';

const hash: Sha256Fn = (data) => sha256(data);
const OWNER_CAP = 'test-owner-capability-secret';
const SUPPLIER = 'did:plc:chairmaker99';

let router: CoreRouter;
/** Every URL this node actually fetched, in order. */
let fetched: string[];

function req(body: Record<string, unknown>, callerType: string | undefined): CoreRequest {
  return {
    method: 'POST',
    path: '/v1/commerce/catalog/ingest',
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(callerType !== undefined ? { callerType, callerDID: 'did:key:caller' } : {}),
    ...(callerType === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
  };
}
const owner = (body: Record<string, unknown>): CoreRequest => req(body, 'owner');

function ok(body: string): FeedResponse {
  return {
    status: 200,
    contentType: 'application/json',
    connectedAddress: '203.0.113.10',
    body,
    compressedBytes: body.length,
    decompressedBytes: body.length,
  };
}

/**
 * A REAL publication, built by the REAL publisher.
 *
 * Hand-rolled snapshots and pointers were the first version of this file and
 * every one of them was refused, because a fixture that guesses at digest
 * domains and required fields tests the guess rather than the contract. The
 * publisher is the thing a supplier runs; using it here means the ingest is
 * verifying what a supplier actually emits.
 */
function publish(
  items: Record<string, unknown>[],
  previous: { pointer: CatalogPointer; snapshotDigest: string } | null = null,
  pageSize = 1,
): { pointer: CatalogPointer; snapshot: CatalogSnapshot; pages: CatalogSnapshotPage[] } {
  const built = buildCatalogSnapshot({
    supplierDid: SUPPLIER,
    catalogId: 'chairmaker-main',
    protocolVersion: '1.0',
    publishedAt: '2026-08-09T09:00:00.000Z',
    items,
    previous,
    pageSize,
    sha256: hash,
  });
  if (!built.ok) throw new Error(`fixture failed to publish: ${built.error}`);
  if (built.snapshot === undefined || built.pages === undefined) {
    throw new Error('fixture published no snapshot');
  }
  return { pointer: built.pointer, snapshot: built.snapshot, pages: built.pages };
}

/** The URLs a publication is served at, matching the template below. */
function serve(pub: ReturnType<typeof publish>): Record<string, string> {
  const docs: Record<string, string> = { [SNAP_URL]: JSON.stringify(pub.snapshot) };
  pub.pages.forEach((pg, index) => {
    docs[`https://feeds.example/chairmaker/page-${String(index)}.json`] = JSON.stringify(pg);
  });
  return docs;
}

/** A feed that serves exactly what it was given, and records what was asked. */
function feed(docs: Record<string, string>): void {
  installCatalogFeedTransport(async (url) => {
    fetched.push(url);
    const body = docs[url];
    if (body === undefined) {
      return { ...ok(''), status: 404, body: '' };
    }
    return ok(body);
  });
}

beforeEach(() => {
  fetched = [];
  installCatalogFeedTransport(null);
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => installCatalogFeedTransport(null));

const SNAP_URL = 'https://feeds.example/chairmaker/snapshot.json';
const PAGE_TEMPLATE = 'https://feeds.example/chairmaker/page-{index}.json';

describe('the boundary', () => {
  it.each([undefined, 'brain', 'agent', 'plugin', 'device', 'admin', 'service'])(
    'refuses caller type %s',
    async (callerType) => {
      // A catalog ingest reaches out to a named supplier on this node's behalf.
      // Who this business shops with is the owner's commercial position.
      feed({});
      const resp = await router.handle(
        req({ pointer: {}, snapshot_url: SNAP_URL, page_url_template: PAGE_TEMPLATE }, callerType),
      );
      expect(resp.status).toBe(403);
      expect(fetched).toEqual([]);
    },
  );

  it('fails closed with no transport installed, and fetches nothing', async () => {
    // The whole point of the registry: a node with no transport cannot ingest
    // and says so, rather than reaching for a global `fetch`.
    const resp = await router.handle(
      owner({ pointer: {}, snapshot_url: SNAP_URL, page_url_template: PAGE_TEMPLATE }),
    );
    expect(resp.status).toBe(503);
    expect((resp.body as { error: string }).error).toBe('no_catalog_feed_transport');
  });

  it('refuses a page template with no index slot rather than fetching page 0 forever', async () => {
    // The ingest WOULD catch it — each page carries its own index and is
    // checked — but reporting it as "the supplier served the wrong page" sends
    // an operator to argue with their supplier about their own typo.
    feed({});
    const resp = await router.handle(
      owner({
        pointer: {},
        snapshot_url: SNAP_URL,
        page_url_template: 'https://feeds.example/page.json',
      }),
    );
    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toContain('{index}');
    expect(fetched).toEqual([]);
  });

  it('requires both URLs', async () => {
    feed({});
    expect((await router.handle(owner({ pointer: {} }))).status).toBe(400);
  });
});

describe('a supplier catalog arriving over the feed', () => {
  it('ingests every page in order, flattened', async () => {
    const pub = publish([{ sku: 'oak-chair' }, { sku: 'oak-table' }]);
    feed(serve(pub));

    const resp = await router.handle(
      owner({
        pointer: pub.pointer,
        snapshot_url: SNAP_URL,
        page_url_template: PAGE_TEMPLATE,
      }),
    );
    expect(resp.status).toBe(200);
    const body = resp.body as { ok: boolean; value?: { items: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.value?.items).toEqual([{ sku: 'oak-chair' }, { sku: 'oak-table' }]);
    // The template's slot is substituted per index — the check the refusal
    // above exists to make meaningful.
    expect(fetched).toEqual([
      SNAP_URL,
      'https://feeds.example/chairmaker/page-0.json',
      'https://feeds.example/chairmaker/page-1.json',
    ]);
  });

  it('refuses a snapshot the pointer does not name', async () => {
    // Substituting one publication for another is the attack the pointer
    // exists to stop, and it is what an internally-valid snapshot looks like:
    // both of these verify perfectly on their own.
    const real = publish([{ sku: 'oak-chair' }]);
    const other = publish([{ sku: 'pine-stool' }]);
    feed({ ...serve(other), [SNAP_URL]: JSON.stringify(other.snapshot) });

    const resp = await router.handle(
      owner({
        pointer: real.pointer,
        snapshot_url: SNAP_URL,
        page_url_template: PAGE_TEMPLATE,
      }),
    );
    expect(resp.status).toBe(409);
    expect((resp.body as { refusal: string }).refusal).toBe('snapshot_refused');
  });

  it('refuses a rolled-back publication against what this consumer accepted', async () => {
    // Passing `previous_pointer` is what makes a replayed old catalog visible.
    // A consumer that always sent null would accept it as a first sighting.
    const first = publish([{ sku: 'oak-chair' }]);
    const second = publish([{ sku: 'oak-chair' }, { sku: 'oak-table' }], {
      pointer: first.pointer,
      snapshotDigest: first.snapshot.snapshot_digest,
    });
    feed(serve(first));

    const resp = await router.handle(
      owner({
        // The OLD publication offered again, after the consumer took the new one.
        pointer: first.pointer,
        previous_pointer: second.pointer,
        snapshot_url: SNAP_URL,
        page_url_template: PAGE_TEMPLATE,
      }),
    );
    expect(resp.status).toBe(409);
    expect((resp.body as { refusal: string }).refusal).toBe('pointer_refused');
    // And nothing was fetched: the pointer is checked before any byte moves.
    expect(fetched).toEqual([]);
  });

  it('reports a withdrawal rather than fetching a snapshot that is not there', async () => {
    const first = publish([{ sku: 'oak-chair' }]);
    const withdrawal = buildCatalogWithdrawal({
      supplierDid: SUPPLIER,
      catalogId: 'chairmaker-main',
      protocolVersion: '1.0',
      publishedAt: '2026-08-09T10:00:00.000Z',
      previous: { pointer: first.pointer, snapshotDigest: first.snapshot.snapshot_digest },
    });
    if (!withdrawal.ok) throw new Error('fixture failed to withdraw');
    feed({});

    const resp = await router.handle(
      owner({
        pointer: withdrawal.pointer,
        previous_pointer: first.pointer,
        snapshot_url: SNAP_URL,
        page_url_template: PAGE_TEMPLATE,
      }),
    );
    expect(resp.status).toBe(409);
    // A tombstone publishes no snapshot, so there was never anything to fetch.
    expect(fetched).toEqual([]);
  });

  it('refuses a page served for the wrong index', async () => {
    // A feed that served page 0 for every request would otherwise be caught
    // only by the digest, and only sometimes.
    const pub = publish([{ sku: 'oak-chair' }, { sku: 'oak-table' }]);
    const docs = serve(pub);
    docs['https://feeds.example/chairmaker/page-1.json'] =
      docs['https://feeds.example/chairmaker/page-0.json'] ?? '';
    feed(docs);

    const resp = await router.handle(
      owner({
        pointer: pub.pointer,
        snapshot_url: SNAP_URL,
        page_url_template: PAGE_TEMPLATE,
      }),
    );
    expect(resp.status).toBe(409);
  });
});
