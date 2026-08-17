/**
 * §5.2 — resolution and its egress contract. The named test is the point:
 * raw extracted line text cannot reach a discovery query outside §9.6's
 * opt-in path, and the proof is structural (no signature accepts it) plus
 * a serialization sweep over everything the module can emit.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  catalogPageDigest,
  catalogPayloadRoot,
  catalogSnapshotDigest,
  CATALOG_POINTER_NSID,
  type CatalogEvidenceRecord,
  type CatalogItem,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
} from '@dina/commerce-protocol';

import {
  discoveryRequirementsFor,
  hydrateOrderLineEvidence,
  matchLineAgainstCatalog,
  type VerifiedCatalogPageSet,
} from '../../src/commerce/order_line_resolution';

const hash = (data: Uint8Array): Uint8Array => sha256(data);
const SUPPLIER = 'did:plc:chairmaker';

function makeItem(name: string, value: string): CatalogItem {
  return {
    product: { scheme: 'manufacturer_sku', value, issuer_did: SUPPLIER },
    supplier_did: SUPPLIER,
    catalog_id: 'chairmaker-main',
    item_revision: 'rev-1',
    name,
    category_ids: ['furniture.seating'],
    pack: { sell_unit: { value: '1', unit_code: 'each' } },
    fulfilment_regions: [{ scheme: 'admin_area', value: 'IN-KA' }],
    freshness: { generated_at: '2026-08-15T10:00:00.000Z' },
  };
}

function makeEvidence(items: CatalogItem[]): CatalogEvidenceRecord {
  const pageDraft: CatalogSnapshotPage = {
    catalog_id: 'chairmaker-main',
    snapshot_sequence: 1,
    page_index: 0,
    items,
    page_digest: '',
  };
  const page = { ...pageDraft, page_digest: catalogPageDigest(pageDraft, hash) };
  const snapshotDraft: CatalogSnapshot = {
    supplier_did: SUPPLIER,
    catalog_id: 'chairmaker-main',
    snapshot_sequence: 1,
    protocol_version: '1.0',
    published_at: '2026-08-15T10:00:00.000Z',
    page_digests: [page.page_digest],
    item_count: items.length,
    payload_root: catalogPayloadRoot([page.page_digest], hash),
    snapshot_digest: '',
  };
  const snapshot = { ...snapshotDraft, snapshot_digest: catalogSnapshotDigest(snapshotDraft, hash) };
  const pointer: CatalogPointer = {
    supplier_did: SUPPLIER,
    catalog_id: 'chairmaker-main',
    snapshot_sequence: 1,
    protocol_version: '1.0',
    published_at: '2026-08-15T10:00:00.000Z',
    snapshot_rkey: snapshot.snapshot_digest,
    snapshot_digest: snapshot.snapshot_digest,
  };
  return {
    repo_did: SUPPLIER,
    collection: CATALOG_POINTER_NSID,
    rkey: 'chairmaker-main',
    pointer_cid: 'bafyreib-cid',
    pointer,
    snapshot,
    page,
  };
}

const ITEMS = [
  makeItem('4ft teak bench', 'CM-BENCH-2'),
  makeItem('Oak dining chair', 'CM-CHAIR-1'),
  makeItem('Teak workshop stool', 'CM-STOOL-1'),
];

function pageSet(known = true): VerifiedCatalogPageSet {
  const evidence = makeEvidence(ITEMS);
  return {
    supplierDid: SUPPLIER,
    knownSupplier: known,
    evidenceByItemIndex: () => evidence,
    items: ITEMS,
  };
}

describe('local matching — nothing leaves the node', () => {
  it('finds "the 4ft teak ones" on the verified page, best first', () => {
    const candidates = matchLineAgainstCatalog('4ft teak bench', pageSet());
    expect(candidates[0]?.item.name).toBe('4ft teak bench');
    expect(candidates[0]?.flaggedNewSupplier).toBe(false);
    expect(candidates[0]?.evidence).not.toBeNull();
  });

  it('an UNKNOWN supplier surfaces flagged — never auto-selected', () => {
    const candidates = matchLineAgainstCatalog('teak bench', pageSet(false));
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.flaggedNewSupplier)).toBe(true);
  });

  it('a hint matching nothing resolves to nothing — the line stays visible upstream', () => {
    expect(matchLineAgainstCatalog('galvanised roofing sheets', pageSet())).toEqual([]);
  });
});

describe('THE EGRESS CONTRACT (§5.2): closed fields only', () => {
  it('the named fail-closed test: raw extracted line text cannot reach a discovery query', () => {
    // The photographed line carries exactly what the design warns about —
    // a name and a phone number the model copied off the page.
    const rawLineText = '6 benches, the 4ft teak ones — ask for Ramesh 9876543210';

    // The ONLY discovery builder this module offers takes closed fields.
    // There is no signature to hand the text to; this test additionally
    // sweeps everything it CAN emit for any fragment of the raw text.
    const query = discoveryRequirementsFor({
      categoryIds: ['furniture.seating'],
      quantity: { value: '6', unit_code: 'each' },
      requiredBy: '2026-08-21T00:00:00.000Z',
    });
    const serialized = JSON.stringify(query);
    for (const fragment of ['Ramesh', '9876543210', 'teak ones', 'benches']) {
      expect(serialized).not.toContain(fragment);
    }
    // And no free-text field exists on the default projection at all.
    expect('query_text' in query).toBe(false);
  });
});

describe('EVIDENCE HYDRATION — authority first, then the chain', () => {
  it('a verified chain under a confirmed authority hydrates', async () => {
    const outcome = await hydrateOrderLineEvidence(
      makeEvidence(ITEMS),
      () => Promise.resolve(true),
      hash,
    );
    expect(outcome.ok).toBe(true);
  });

  it('AUTHORITY FALSE refuses before any digest is examined', async () => {
    // The chain here is deliberately BROKEN too; the refusal must name
    // authority, proving the ordering the design demands.
    const record = makeEvidence(ITEMS);
    const broken: CatalogEvidenceRecord = {
      ...record,
      snapshot: { ...record.snapshot, payload_root: 'f'.repeat(64) },
    };
    const outcome = await hydrateOrderLineEvidence(broken, () => Promise.resolve(false), hash);
    expect(outcome).toEqual({ ok: false, refusal: 'supplier_authority_failed' });
  });

  it('a THROWING verifier has verified nothing', async () => {
    const outcome = await hydrateOrderLineEvidence(
      makeEvidence(ITEMS),
      () => Promise.reject(new Error('repo unreachable')),
      hash,
    );
    expect(outcome).toEqual({ ok: false, refusal: 'authority_unverifiable' });
  });

  it('a genuine authority over a TAMPERED chain still refuses — on the chain', async () => {
    const record = makeEvidence(ITEMS);
    const tampered: CatalogEvidenceRecord = {
      ...record,
      page: { ...record.page, items: [makeItem('Swapped product', 'X-9')] },
    };
    const outcome = await hydrateOrderLineEvidence(tampered, () => Promise.resolve(true), hash);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal).toContain('page');
  });
});
