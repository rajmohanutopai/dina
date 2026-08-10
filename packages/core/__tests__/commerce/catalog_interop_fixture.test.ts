/**
 * §10.2 / §25.3 — the bytes ChairMaker publishes, frozen for AppView to ingest.
 *
 * WHAT THIS CLOSES. The AppView discovery suite builds its catalog records with
 * AppView's OWN `catalogPageDigest` / `catalogSnapshotDigest`, then asserts
 * AppView accepts them. Both sides of that check are AppView's, so it is the
 * defect class this whole review has been about, sitting in a test I wrote: if
 * AppView's digest functions drifted from Core's, discovery would stay green
 * while no real supplier's catalog could be indexed.
 *
 * AppView takes no `@dina/*` dependency on purpose — it deploys independently,
 * which is exactly why it keeps its own copy of `CatalogPointer` and why a
 * field added on one side and not the other went unnoticed (NEW-2). So the two
 * halves cannot be joined by an import. They are joined by the BYTES, which is
 * what the contract actually is.
 *
 * This test is the producer half: it runs the real `buildCatalogSnapshot` over
 * a real manufacturer's catalog and writes the publication to a fixture the
 * AppView suite ingests through its real handlers. Regenerating must produce
 * byte-identical output, so the fixture cannot drift away from the publisher
 * that claims to have made it.
 *
 * WHAT IT DOES NOT CLAIM. This is not a PDS. A PDS is the transport that
 * carries these records between the two nodes; what a transport delivers is
 * these bytes, and those are what both sides are checked against here. The
 * "two real Dinas over a live PDS" step stays open and is stated as open in
 * WBS 11.3.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';

import { buildCatalogSnapshot } from '../../src/commerce/catalog_publisher';

const hash = (data: Uint8Array): Uint8Array => sha256(data);

/**
 * The fixture lives in `@dina/commerce-protocol`, beside the conformance
 * vectors, because that package IS the wire contract both sides target. It is
 * read by path rather than imported, so no dependency edge is created in
 * either direction — the same relationship a conformance vector has to the
 * implementations it pins.
 */
const FIXTURE = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'commerce-protocol',
  'conformance',
  'interop',
  'catalog_publication.json',
);

/** ChairMaker, the manufacturer. Sancho's retailer node has never heard of it. */
const MANUFACTURER = 'did:plc:chairmaker99';
const CATALOG = 'chairmaker-seating';
const SERVICE_RKEY = 'seating';

/**
 * A real manufacturer's catalog, in the shape a spreadsheet import produces.
 *
 * The GTINs are chosen to be ORDINARY rather than convenient: `5901234123457`
 * is a real GTIN-13 that passes Luhn and `712345678904` a valid UPC-A, both of
 * which the §12.1 leakage gate refused at some point during this review. A
 * fixture that avoided them would publish cleanly while the catalogs suppliers
 * actually upload did not.
 */
function chairmakerItems(): unknown[] {
  return [
    {
      product: { scheme: 'gtin', value: '5901234123457' },
      supplier_did: MANUFACTURER,
      catalog_id: CATALOG,
      item_revision: '1',
      name: 'Oak dining chair',
      brand: 'ChairMaker',
      description: 'Solid oak, four legs, 45 cm seat height.',
      category_ids: ['furniture.seating'],
      pack: { sell_unit: { value: '1', unit_code: 'each' } },
      identifiers: [{ scheme: 'manufacturer_sku', value: 'CHAIR2024B', issuer_did: MANUFACTURER }],
      fulfilment_regions: [{ scheme: 'admin_area', value: 'IN-KA' }],
      indicative_price: { currency: 'INR', minor_units: '450000' },
      freshness: { generated_at: '2026-08-08T09:00:00.000Z' },
    },
    {
      product: { scheme: 'gtin', value: '712345678904' },
      supplier_did: MANUFACTURER,
      catalog_id: CATALOG,
      item_revision: '1',
      name: 'Teak bar stool',
      brand: 'ChairMaker',
      description: 'Teak, footrest, 75 cm.',
      category_ids: ['furniture.seating'],
      pack: { sell_unit: { value: '1', unit_code: 'each' } },
      identifiers: [{ scheme: 'manufacturer_sku', value: 'ACME012345X', issuer_did: MANUFACTURER }],
      fulfilment_regions: [
        { scheme: 'admin_area', value: 'IN-KA' },
        { scheme: 'admin_area', value: 'IN-TN' },
      ],
      freshness: { generated_at: '2026-08-08T09:00:00.000Z' },
    },
  ];
}

function publish(): unknown {
  const built = buildCatalogSnapshot({
    supplierDid: MANUFACTURER,
    catalogId: CATALOG,
    protocolVersion: '1.0',
    publishedAt: '2026-08-08T09:00:00.000Z',
    items: chairmakerItems(),
    previous: null,
    serviceRkey: SERVICE_RKEY,
    sha256: hash,
  });
  if (!built.ok) throw new Error(`the publisher refused its own fixture: ${built.error}`);
  return { pointer: built.pointer, snapshot: built.snapshot, pages: built.pages };
}

describe('the records a manufacturer actually publishes', () => {
  it('publishes a catalog the §12.1 leakage gate does not refuse', () => {
    // The gate runs INSIDE `buildCatalogSnapshot`, so a refusal here would be
    // the publisher declining its own fixture — which is how a catalog full of
    // ordinary GTINs would have failed during three rounds of this review.
    expect(() => publish()).not.toThrow();
  });

  it('matches the committed fixture byte for byte', () => {
    // REGENERATE-AND-COMPARE rather than assert-some-fields. The fixture's
    // whole value is that AppView ingests exactly what this publisher emits;
    // a fixture allowed to drift is a fixture that stops testing the join.
    //
    // To regenerate after an intentional publisher change:
    //   DINA_WRITE_INTEROP_FIXTURE=1 npx jest catalog_interop_fixture
    const produced = `${JSON.stringify(publish(), null, 2)}\n`;
    if (process.env.DINA_WRITE_INTEROP_FIXTURE === '1') {
      writeFileSync(FIXTURE, produced, 'utf8');
    }

    expect(readFileSync(FIXTURE, 'utf8')).toBe(produced);
  });

  it('names the listing the manufacturer serves this catalog from', () => {
    // §10.5 end to end starts here: if the producer omits it, AppView answers
    // `self` for every candidate and no assertion downstream can tell.
    const { pointer } = publish() as { pointer: { service_rkey?: string } };
    expect(pointer.service_rkey).toBe(SERVICE_RKEY);
  });
});
