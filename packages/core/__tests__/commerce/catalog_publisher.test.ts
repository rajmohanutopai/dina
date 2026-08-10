/**
 * Supplier-side catalog publication (§10.2, WS-5 producer half).
 *
 * The claim worth testing is not "the builder returns objects" — it is that
 * everything it produces VERIFIES under the consumer's own rules, and that a
 * publisher which would fork the chain is refused before anything reaches the
 * wire. So most of these run ChairMaker's output straight back through the
 * verifiers a retailer would use.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  validateCatalogPointer,
  verifyCatalogPage,
  verifyCatalogPointerAdvance,
  verifyCatalogSnapshot,
  type CatalogPointer,
} from '@dina/commerce-protocol';

import { buildCatalogSnapshot, buildCatalogWithdrawal } from '../../src/commerce/catalog_publisher';

const hash = (data: Uint8Array): Uint8Array => sha256(data);

const MANUFACTURER = 'did:plc:chairmaker';
const CATALOG = 'chairmaker-main';

function chairs(count: number): { sku: string; name: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    sku: `CHAIR-${String(i)}`,
    name: `Oak dining chair ${String(i)}`,
  }));
}

function publish(
  items: readonly unknown[],
  previous: { pointer: CatalogPointer; snapshotDigest: string } | null = null,
  pageSize?: number,
) {
  return buildCatalogSnapshot({
    supplierDid: MANUFACTURER,
    catalogId: CATALOG,
    protocolVersion: '1.0',
    publishedAt: '2026-08-08T10:00:00.000Z',
    items,
    previous,
    ...(pageSize === undefined ? {} : { pageSize }),
    sha256: hash,
  });
}

describe('ChairMaker publishes a catalog a retailer can verify', () => {
  it('produces a genesis publication that passes every consumer check', () => {
    const result = publish(chairs(7), null, 3);
    if (!result.ok) throw new Error(result.error);
    const { pointer, snapshot, pages } = result;
    if (snapshot === undefined || pages === undefined) throw new Error('expected a snapshot');

    // The retailer's side, run against the manufacturer's output.
    expect(verifyCatalogPointerAdvance(null, pointer)).toBeNull();
    expect(verifyCatalogSnapshot(snapshot, hash)).toBeNull();
    for (const page of pages) expect(verifyCatalogPage(page, snapshot, hash)).toBeNull();

    // 7 chairs at 3 per page is 3 pages, the last one short.
    expect(pages.map((p) => p.items.length)).toEqual([3, 3, 1]);
    expect(snapshot.item_count).toBe(7);
    expect(snapshot.snapshot_sequence).toBe(1);
    expect(pointer.previous_snapshot_digest).toBeUndefined();
  });

  it('is deterministic: the same catalog publishes byte-identically', () => {
    // Two publishers of the same items must agree, or a consumer comparing
    // digests across mirrors would see a difference that means nothing.
    const a = publish(chairs(5), null, 2);
    const b = publish(chairs(5), null, 2);
    if (!a.ok || !b.ok) throw new Error('both should publish');
    expect(a.snapshot?.snapshot_digest).toBe(b.snapshot?.snapshot_digest);
    expect(a.snapshot?.payload_root).toBe(b.snapshot?.payload_root);
  });

  it('changes the payload root when a single product changes', () => {
    const before = publish(chairs(3), null, 3);
    const after = publish([...chairs(2), { sku: 'CHAIR-2', name: 'Oak chair, restyled' }], null, 3);
    if (!before.ok || !after.ok) throw new Error('both should publish');
    expect(after.snapshot?.payload_root).not.toBe(before.snapshot?.payload_root);
  });

  it('publishes an empty catalog as zero pages, not one empty page', () => {
    const result = publish([]);
    if (!result.ok) throw new Error(result.error);
    // "Currently offers nothing" is a real state; inventing an empty page
    // would make the root depend on the splitter's mood.
    const { snapshot } = result;
    if (snapshot === undefined) throw new Error('expected a snapshot');
    expect(result.pages).toEqual([]);
    expect(snapshot.page_digests).toEqual([]);
    expect(snapshot.item_count).toBe(0);
    expect(verifyCatalogSnapshot(snapshot, hash)).toBeNull();
  });
});

describe('the chain advances, or the publication is refused', () => {
  function first() {
    const result = publish(chairs(2), null, 2);
    if (!result.ok || result.snapshot === undefined) throw new Error('genesis failed');
    return { pointer: result.pointer, snapshotDigest: result.snapshot.snapshot_digest };
  }

  it('links the second publication to the first and verifies as an advance', () => {
    const previous = first();
    const second = publish(chairs(4), previous, 2);
    if (!second.ok) throw new Error(second.error);

    expect(second.pointer.snapshot_sequence).toBe(2);
    expect(second.pointer.previous_snapshot_digest).toBe(previous.snapshotDigest);
    expect(verifyCatalogPointerAdvance(previous.pointer, second.pointer)).toBeNull();
  });

  it('runs the CONSUMER validator on its own output, so a fork is refused here', () => {
    const previous = first();
    // A publisher that believed it was still at sequence 1 would mint a
    // pointer that forks the chain. The builder derives the sequence from the
    // predecessor and then re-checks with the consumer's rule, so the only way
    // to see this refusal is to lie about the predecessor.
    const lying = {
      pointer: { ...previous.pointer, catalog_id: 'a-different-catalog' },
      snapshotDigest: previous.snapshotDigest,
    };
    const result = publish(chairs(1), lying, 2);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusal).toBe('chain_refused');
    expect(!result.ok && result.error).toBe('pointer chain: catalog_id changed mid-chain');
  });

  it('refuses a catalog larger than the v1 page bound rather than truncating', () => {
    // Truncating would publish a valid full-state snapshot that silently omits
    // products, and nothing in the record would say so — the supplier could
    // not tell from its own publication that half the catalog vanished.
    // The bound is pageSize * MAX_CATALOG_PAGES, so 1001 items at 1/page is
    // one page too many.
    const over = publish(chairs(1001), null, 1);
    expect(!over.ok && over.refusal).toBe('too_many_items');

    // Exactly at the bound still publishes.
    const at = publish(chairs(1000), null, 1);
    expect(at.ok).toBe(true);
    expect(at.ok && at.pages?.length).toBe(1000);
  });

  it.each([0, -1, 501, 1.5])('refuses page size %s', (pageSize) => {
    const result = publish(chairs(1), null, pageSize);
    expect(!result.ok && result.refusal).toBe('invalid_page_size');
  });
});

describe('withdrawal (§10.2)', () => {
  it('tombstones the catalog at the next sequence, and verifies', () => {
    const genesis = publish(chairs(2), null, 2);
    if (!genesis.ok || genesis.snapshot === undefined) throw new Error('genesis failed');
    const previous = { pointer: genesis.pointer, snapshotDigest: genesis.snapshot.snapshot_digest };

    const withdrawal = buildCatalogWithdrawal({
      supplierDid: MANUFACTURER,
      catalogId: CATALOG,
      protocolVersion: '1.0',
      publishedAt: '2026-08-08T12:00:00.000Z',
      previous,
    });
    if (!withdrawal.ok) throw new Error(withdrawal.error);

    expect(withdrawal.pointer.withdrawn).toBe(true);
    expect(withdrawal.pointer.snapshot_digest).toBeUndefined();
    expect(withdrawal.snapshot).toBeUndefined();
    expect(verifyCatalogPointerAdvance(previous.pointer, withdrawal.pointer)).toBeNull();
  });

  it('ends the chain: nothing may follow a tombstone', () => {
    // Design decision the tests forced. A tombstone names no snapshot, so a
    // successor has nothing to link to, and a consumer that saw it has already
    // stopped following. Withdrawal therefore RETIRES the catalog_id; a
    // supplier who wants to trade again publishes under a new one, which is
    // also the honest signal since the old identity was publicly withdrawn.
    const genesis = publish(chairs(1), null, 2);
    if (!genesis.ok || genesis.snapshot === undefined) throw new Error('genesis failed');
    const afterGenesis = {
      pointer: genesis.pointer,
      snapshotDigest: genesis.snapshot.snapshot_digest,
    };

    const withdrawal = buildCatalogWithdrawal({
      supplierDid: MANUFACTURER,
      catalogId: CATALOG,
      protocolVersion: '1.0',
      publishedAt: '2026-08-08T12:00:00.000Z',
      previous: afterGenesis,
    });
    if (!withdrawal.ok) throw new Error(withdrawal.error);

    const relaunch = publish(chairs(3), {
      pointer: withdrawal.pointer,
      snapshotDigest: afterGenesis.snapshotDigest,
    });

    expect(!relaunch.ok && relaunch.refusal).toBe('chain_refused');
    expect(!relaunch.ok && relaunch.error).toBe(
      'pointer chain: this catalog was withdrawn; publish under a new catalog_id',
    );
  });
});

/**
 * §10.5 (DR-5) — the producer half, which was the half that did not exist.
 *
 * `CatalogPointer.service_rkey` was added to the protocol type and to
 * AppView's copy, carried through ingest and read by `toCandidate` — and no
 * Dina node could emit one. The publish route accepted no such field and
 * neither builder set it, so every catalog this implementation publishes had a
 * null listing and every candidate fell back to `self`: the original symptom,
 * unchanged, behind a fix that read as complete.
 *
 * A read path with no producer is the same defect as a rule with no caller,
 * one layer out — and it survived a round of review because the tests that
 * covered it wrote the pointer by hand.
 */
describe('a supplier can say which listing serves the catalog', () => {
  it('carries the listing onto the pointer it publishes', () => {
    const result = buildCatalogSnapshot({
      supplierDid: MANUFACTURER,
      catalogId: CATALOG,
      protocolVersion: '1.0',
      publishedAt: '2026-08-08T10:00:00.000Z',
      items: chairs(2),
      previous: null,
      serviceRkey: 'chairs',
      sha256: hash,
    });
    if (!result.ok) throw new Error(result.error);

    expect(result.pointer.service_rkey).toBe('chairs');
  });

  it('omits the field entirely when the supplier did not say', () => {
    // Absent and empty-string are different claims. An omitted field lets a
    // consumer apply the `self` convention; an empty one would be a listing
    // named nothing, which the validator refuses.
    const result = publish(chairs(2));
    if (!result.ok) throw new Error(result.error);

    expect('service_rkey' in result.pointer).toBe(false);
  });

  it('carries it onto a TOMBSTONE too, so a withdrawal stays self-describing', () => {
    const first = buildCatalogSnapshot({
      supplierDid: MANUFACTURER,
      catalogId: CATALOG,
      protocolVersion: '1.0',
      publishedAt: '2026-08-08T10:00:00.000Z',
      items: chairs(2),
      previous: null,
      serviceRkey: 'chairs',
      sha256: hash,
    });
    if (!first.ok) throw new Error(first.error);
    const firstSnapshot = first.snapshot;
    if (firstSnapshot === undefined) throw new Error('a snapshot publication has a snapshot');

    const withdrawal = buildCatalogWithdrawal({
      supplierDid: MANUFACTURER,
      catalogId: CATALOG,
      protocolVersion: '1.0',
      publishedAt: '2026-08-08T11:00:00.000Z',
      previous: { pointer: first.pointer, snapshotDigest: firstSnapshot.snapshot_digest },
      serviceRkey: 'chairs',
    });
    if (!withdrawal.ok) throw new Error(withdrawal.error);

    expect(withdrawal.pointer.service_rkey).toBe('chairs');
  });

  it('produces a pointer the CONSUMER validator accepts', () => {
    // The producer runs the consumer's own check on its output, so a field
    // added on one side and not the other fails here rather than in the wild.
    const result = buildCatalogSnapshot({
      supplierDid: MANUFACTURER,
      catalogId: CATALOG,
      protocolVersion: '1.0',
      publishedAt: '2026-08-08T10:00:00.000Z',
      items: chairs(2),
      previous: null,
      serviceRkey: 'chairs',
      sha256: hash,
    });
    if (!result.ok) throw new Error(result.error);

    expect(validateCatalogPointer(result.pointer)).toBeNull();
  });
});
