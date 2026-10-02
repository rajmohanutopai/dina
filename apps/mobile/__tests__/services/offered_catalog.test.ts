/**
 * Reading an offered item from the supplier's own published catalogue: the
 * pointer and snapshot come from its PDS, Core checks the digests, and every
 * failure is "nothing to add" so the Tender screen keeps the quote's words.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { buildCatalogSnapshot, type CatalogItem } from '@dina/core';

import {
  publishedItemFor,
  resetOfferedCatalogCacheForTest,
} from '../../src/services/offered_catalog';

const SUPPLIER = 'did:plc:oakandoven01';
const PDS = 'https://pds.example.test';
const PHOTO = 'https://images.example.test/floral-cake.jpg';
const CAKE = { scheme: 'manufacturer_sku', value: 'OO-7' };

function records(images: string[] = [PHOTO]) {
  const item: CatalogItem = {
    product: { scheme: 'manufacturer_sku', value: 'OO-7', issuer_did: SUPPLIER },
    supplier_did: SUPPLIER,
    catalog_id: 'oak-and-oven',
    item_revision: 'r1',
    name: 'Floral celebration cake',
    description: 'Vanilla sponge, buttercream flowers',
    category_ids: ['bakery'],
    pack: { sell_unit: { value: '1', unit_code: 'each' } },
    fulfilment_regions: [{ scheme: 'admin_area', value: 'US-CA' }],
    freshness: { generated_at: '2026-09-30T00:00:00.000Z' },
    images,
  };
  const built = buildCatalogSnapshot({
    supplierDid: SUPPLIER,
    catalogId: 'oak-and-oven',
    protocolVersion: '1.0',
    publishedAt: '2026-09-30T00:00:00.000Z',
    items: [item],
    previous: null,
    sha256,
  });
  if (!built.ok) throw new Error(JSON.stringify(built));
  return built;
}

function pdsServing(built: ReturnType<typeof records>, snapshotOverride?: unknown) {
  const calls: string[] = [];
  const fetchFn = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('com.atproto.repo.listRecords')) {
      return json({ records: [{ uri: 'at://x', value: built.pointer }] });
    }
    if (url.includes('com.atproto.repo.getRecord')) {
      return json({
        value: snapshotOverride ?? { snapshot: built.snapshot, pages: built.pages },
      });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof globalThis.fetch;
  return { fetchFn, calls };
}

beforeEach(() => resetOfferedCatalogCacheForTest());

describe('publishedItemFor', () => {
  it('reads the verified item, photo included, from the supplier PDS', async () => {
    const built = records();
    const { fetchFn, calls } = pdsServing(built);
    const item = await publishedItemFor(SUPPLIER, CAKE, { fetchFn, pdsOf: async () => PDS });
    expect(item?.images).toEqual([PHOTO]);
    expect(item?.description).toBe('Vanilla sponge, buttercream flowers');
    expect(calls[0]).toBe(
      `${PDS}/xrpc/com.atproto.repo.listRecords?repo=did%3Aplc%3Aoakandoven01&collection=com.dinakernel.commerce.catalog&limit=20`,
    );
    expect(calls[1]).toContain(`rkey=${built.pointer.snapshot_rkey ?? ''}`);
  });

  it('shows nothing from records that do not verify', async () => {
    const built = records();
    const page = built.pages[0];
    if (page === undefined) throw new Error('fixture');
    const tampered = {
      snapshot: built.snapshot,
      pages: [{ ...page, items: [{ ...(page.items[0] as object), name: 'Something else' }] }],
    };
    const { fetchFn } = pdsServing(built, tampered);
    expect(await publishedItemFor(SUPPLIER, CAKE, { fetchFn, pdsOf: async () => PDS })).toBeNull();
  });

  it('an unreachable PDS or a DID without one is nothing to add', async () => {
    const failing = jest.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof globalThis.fetch;
    expect(
      await publishedItemFor(SUPPLIER, CAKE, { fetchFn: failing, pdsOf: async () => PDS }),
    ).toBeNull();
    resetOfferedCatalogCacheForTest();
    expect(await publishedItemFor(SUPPLIER, CAKE, { pdsOf: async () => null })).toBeNull();
  });

  it('reads a supplier once per few minutes, not on every refresh', async () => {
    const { fetchFn } = pdsServing(records());
    let clock = 0;
    const deps = { fetchFn, pdsOf: async () => PDS, now: () => clock };
    await publishedItemFor(SUPPLIER, CAKE, deps);
    await publishedItemFor(SUPPLIER, CAKE, deps);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    clock = 10 * 60_000;
    await publishedItemFor(SUPPLIER, CAKE, deps);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });
});
