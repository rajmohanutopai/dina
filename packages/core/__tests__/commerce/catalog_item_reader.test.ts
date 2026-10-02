/**
 * A buyer reading one offered item out of a supplier's published catalogue.
 * The records are built by the real publisher, so the digests are the ones a
 * supplier's PDS would serve; every refusal is a record that does not prove
 * itself, and none of them yields an item.
 */

import { readPublishedItem } from '../../src/commerce/catalog_item_reader';
import { buildCatalogSnapshot } from '../../src/commerce/catalog_publisher';

import { hash } from './helpers';

import type { CatalogItem } from '@dina/commerce-protocol';

const SUPPLIER = 'did:plc:oakandoven01';
const PHOTO = 'https://images.example.test/floral-cake.jpg';

function item(sku: string, name: string, extra: Partial<CatalogItem> = {}): CatalogItem {
  return {
    product: { scheme: 'manufacturer_sku', value: sku, issuer_did: SUPPLIER },
    supplier_did: SUPPLIER,
    catalog_id: 'oak-and-oven',
    item_revision: 'r1',
    name,
    category_ids: ['bakery'],
    pack: { sell_unit: { value: '1', unit_code: 'each' } },
    fulfilment_regions: [{ scheme: 'admin_area', value: 'US-CA' }],
    freshness: { generated_at: '2026-09-30T00:00:00.000Z' },
    ...extra,
  };
}

function published() {
  const built = buildCatalogSnapshot({
    supplierDid: SUPPLIER,
    catalogId: 'oak-and-oven',
    protocolVersion: '1.0',
    publishedAt: '2026-09-30T00:00:00.000Z',
    items: [
      item('OO-1', 'Sourdough loaf'),
      item('OO-7', 'Floral celebration cake', {
        description: 'Vanilla sponge, buttercream flowers',
        images: [PHOTO],
      }),
    ],
    previous: null,
    sha256: hash,
  });
  if (!built.ok) throw new Error(JSON.stringify(built));
  return {
    pointer: built.pointer,
    snapshotRecord: { snapshot: built.snapshot, pages: built.pages ?? [] },
  };
}

const CAKE = { scheme: 'manufacturer_sku' as const, value: 'OO-7' };

describe('readPublishedItem', () => {
  it('finds the offered item, photo and description included', () => {
    const read = readPublishedItem({
      supplierDid: SUPPLIER,
      ...published(),
      product: CAKE,
      sha256: hash,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.item?.name).toBe('Floral celebration cake');
    expect(read.item?.images).toEqual([PHOTO]);
    expect(read.item?.description).toBe('Vanilla sponge, buttercream flowers');
  });

  it('a verified catalogue that does not list the product is no item, not a refusal', () => {
    const read = readPublishedItem({
      supplierDid: SUPPLIER,
      ...published(),
      product: { scheme: 'manufacturer_sku', value: 'NOPE' },
      sha256: hash,
    });
    expect(read).toEqual({ ok: true, item: null });
  });

  it('refuses a catalogue published by someone else', () => {
    const read = readPublishedItem({
      supplierDid: 'did:plc:someoneelse1',
      ...published(),
      product: CAKE,
      sha256: hash,
    });
    expect(read.ok).toBe(false);
  });

  it('refuses a page whose item was changed after publishing', () => {
    const { pointer, snapshotRecord } = published();
    const page = snapshotRecord.pages[0];
    if (page === undefined) throw new Error('no page');
    const tampered = {
      ...page,
      items: page.items.map((i) =>
        (i as CatalogItem).name === 'Floral celebration cake'
          ? { ...(i as CatalogItem), images: ['https://attacker.example.test/x.jpg'] }
          : i,
      ),
    };
    const read = readPublishedItem({
      supplierDid: SUPPLIER,
      pointer,
      snapshotRecord: { ...snapshotRecord, pages: [tampered] },
      product: CAKE,
      sha256: hash,
    });
    expect(read).toEqual({
      ok: false,
      reason: 'page: content does not match the digest this snapshot commits to',
    });
  });

  it('refuses a snapshot the pointer does not name', () => {
    const current = published();
    const other = buildCatalogSnapshot({
      supplierDid: SUPPLIER,
      catalogId: 'oak-and-oven',
      protocolVersion: '1.0',
      publishedAt: '2026-09-29T00:00:00.000Z',
      items: [item('OO-7', 'Older cake')],
      previous: null,
      sha256: hash,
    });
    if (!other.ok) throw new Error('fixture');
    const read = readPublishedItem({
      supplierDid: SUPPLIER,
      pointer: current.pointer,
      snapshotRecord: { snapshot: other.snapshot, pages: other.pages },
      product: CAKE,
      sha256: hash,
    });
    expect(read).toEqual({ ok: false, reason: 'snapshot: not the one the pointer names' });
  });

  it('refuses a record with no pages', () => {
    const { pointer } = published();
    expect(
      readPublishedItem({
        supplierDid: SUPPLIER,
        pointer,
        snapshotRecord: null,
        product: CAKE,
        sha256: hash,
      }).ok,
    ).toBe(false);
  });
});
