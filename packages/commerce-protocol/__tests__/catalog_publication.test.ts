/**
 * Catalog publication wire contract (§10.2, §10.3 — WS-1.8).
 *
 * The spec states one trust chain and everything here checks a link in it:
 *
 *     pointer -> snapshot metadata -> payload root -> bounded pages
 *
 * The chain is only worth having if each hop REFUSES a substitution, so most
 * of these tests tamper with something and assert the verifier notices.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  catalogPageDigest,
  catalogPayloadRoot,
  catalogSnapshotDigest,
  validateCatalogPointer,
  validateCatalogSnapshot,
  validateCatalogSnapshotPage,
  verifyCatalogPage,
  verifyCatalogPointerAdvance,
  verifyCatalogSnapshot,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
} from '../src/catalog_publication';

const hash = (data: Uint8Array): Uint8Array => sha256(data);
/** Hex of a string, for fixtures that need a digest-shaped literal. */
const hexOf = (input: string): string =>
  Array.from(sha256(new TextEncoder().encode(input)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const SUPPLIER = 'did:plc:chairmaker';
const CATALOG = 'chairmaker-main';

function makePage(overrides: Partial<CatalogSnapshotPage> = {}): CatalogSnapshotPage {
  const draft: CatalogSnapshotPage = {
    catalog_id: CATALOG,
    snapshot_sequence: 1,
    page_index: 0,
    items: [{ sku: 'CHAIR-1', name: 'Oak dining chair' }],
    page_digest: '',
    ...overrides,
  };
  return { ...draft, page_digest: catalogPageDigest(draft, hash) };
}

/** Build a snapshot that genuinely commits to the pages it names. */
function makeSnapshot(pages: CatalogSnapshotPage[], sequence = 1): CatalogSnapshot {
  const pageDigests = pages.map((p) => p.page_digest);
  const draft: CatalogSnapshot = {
    supplier_did: SUPPLIER,
    catalog_id: CATALOG,
    snapshot_sequence: sequence,
    protocol_version: '1.0',
    published_at: '2026-08-08T10:00:00.000Z',
    page_digests: pageDigests,
    item_count: pages.reduce((n, p) => n + p.items.length, 0),
    payload_root: catalogPayloadRoot(pageDigests, hash),
    snapshot_digest: '',
  };
  return { ...draft, snapshot_digest: catalogSnapshotDigest(draft, hash) };
}

function makePointer(snapshot: CatalogSnapshot, previous?: CatalogSnapshot): CatalogPointer {
  return {
    supplier_did: SUPPLIER,
    catalog_id: CATALOG,
    snapshot_sequence: snapshot.snapshot_sequence,
    protocol_version: '1.0',
    published_at: '2026-08-08T10:00:00.000Z',
    snapshot_rkey: `snap-${String(snapshot.snapshot_sequence)}`,
    snapshot_digest: snapshot.snapshot_digest,
    ...(previous === undefined ? {} : { previous_snapshot_digest: previous.snapshot_digest }),
  };
}

describe('the whole trust chain holds, and each hop refuses a substitution', () => {
  it('verifies pointer, snapshot and every page of a well-formed publication', () => {
    const pages = [makePage(), makePage({ page_index: 1, items: [{ sku: 'CHAIR-2' }] })];
    const snapshot = makeSnapshot(pages);

    expect(verifyCatalogPointerAdvance(null, makePointer(snapshot))).toBeNull();
    expect(verifyCatalogSnapshot(snapshot, hash)).toBeNull();
    for (const page of pages) expect(verifyCatalogPage(page, snapshot, hash)).toBeNull();
  });

  it('rejects a page whose items were edited after publication', () => {
    const page = makePage();
    const snapshot = makeSnapshot([page]);
    // The feed host is transport, not authority: a modified page must fail.
    const tampered: CatalogSnapshotPage = {
      ...page,
      items: [{ sku: 'CHAIR-1', name: 'Oak chair (was £40)' }],
    };

    expect(verifyCatalogPage(tampered, snapshot, hash)).toBe(
      'page: content does not match the digest this snapshot commits to',
    );
  });

  it('rejects a page moved to a different position', () => {
    const first = makePage();
    const snapshot = makeSnapshot([
      first,
      makePage({ page_index: 1, items: [{ sku: 'CHAIR-2' }] }),
    ]);
    // Different content, so the digests differ and the move is caught.
    const moved: CatalogSnapshotPage = { ...first, page_index: 1 };

    expect(verifyCatalogPage(moved, snapshot, hash)).toBe(
      'page: content does not match the digest this snapshot commits to',
    );
  });

  it('commits the payload root to page ORDER, not just the set of pages', () => {
    // Order is the payload order (§10.2: v1 snapshots are full-state and
    // pages are consumed in sequence). A root that ignored order would let a
    // feed serve the same pages in a different order under the same
    // commitment, which is what a paged consumer actually reads.
    const a = hexOf('page-a');
    const b = hexOf('page-b');
    expect(catalogPayloadRoot([a, b], hash)).not.toBe(catalogPayloadRoot([b, a], hash));
  });

  it('binds each page to the slot it declares', () => {
    // `page_index` is inside the digest, so two pages carrying IDENTICAL items
    // still have different digests. Stated precisely because a mutation showed
    // the earlier framing was wrong: this is a correctness binding (a record is
    // self-describing, not context-dependent), NOT a reordering mitigation —
    // pages with identical content are interchangeable by definition, and pages
    // with different content are already distinguished by their content.
    const same = [{ sku: 'CHAIR-1', name: 'Oak dining chair' }];
    expect(makePage({ page_index: 0, items: same }).page_digest).not.toBe(
      makePage({ page_index: 1, items: same }).page_digest,
    );
  });

  it('rejects a page whose own digest field disagrees with its content', () => {
    const page = makePage();
    const snapshot = makeSnapshot([page]);
    // The content hashes correctly but the record's self-declared digest is a
    // lie. Recomputing is what makes the field advisory rather than trusted.
    const lying: CatalogSnapshotPage = { ...page, page_digest: hexOf('not my digest') };

    expect(verifyCatalogPage(lying, snapshot, hash)).toBe(
      'page: page_digest field disagrees with the snapshot',
    );
  });

  it('rejects a page from another catalog or another sequence', () => {
    const snapshot = makeSnapshot([makePage()]);

    expect(verifyCatalogPage(makePage({ catalog_id: 'other' }), snapshot, hash)).toBe(
      'page: belongs to a different catalog',
    );
    expect(verifyCatalogPage(makePage({ snapshot_sequence: 2 }), snapshot, hash)).toBe(
      'page: belongs to a different snapshot sequence',
    );
  });

  it('rejects a page index outside the snapshot', () => {
    const snapshot = makeSnapshot([makePage()]);
    expect(verifyCatalogPage(makePage({ page_index: 7 }), snapshot, hash)).toBe(
      'page: page_index is outside this snapshot',
    );
  });

  it('rejects a snapshot whose payload root does not commit to its pages', () => {
    const snapshot = makeSnapshot([makePage()]);
    const swapped = { ...snapshot, page_digests: [hexOf('a different page')] };

    expect(verifyCatalogSnapshot(swapped, hash)).toBe(
      'snapshot: payload_root does not commit to these page digests',
    );
  });

  it('rejects a snapshot edited in place', () => {
    const snapshot = makeSnapshot([makePage()]);
    // An in-place overwrite must fail, which is the point of an immutable
    // record with a content-derived binding.
    const edited = { ...snapshot, published_at: '2027-01-01T00:00:00.000Z' };

    expect(verifyCatalogSnapshot(edited, hash)).toBe(
      'snapshot: snapshot_digest does not match the record',
    );
  });
});

describe('pointer chain — compare-and-swap on the previous sequence (§10.2)', () => {
  const first = makeSnapshot([makePage()], 1);
  const second = makeSnapshot([makePage({ snapshot_sequence: 2 })], 2);

  it('accepts a genesis pointer at sequence 1 with no predecessor', () => {
    expect(verifyCatalogPointerAdvance(null, makePointer(first))).toBeNull();
  });

  it('refuses a genesis pointer that does not start at 1', () => {
    // `makePointer(second)` already omits the predecessor link.
    expect(verifyCatalogPointerAdvance(null, makePointer(second))).toBe(
      'pointer chain: a genesis pointer must start at sequence 1',
    );
  });

  it('refuses a genesis pointer claiming a predecessor', () => {
    expect(verifyCatalogPointerAdvance(null, makePointer(first, second))).toBe(
      'pointer chain: a genesis pointer has no predecessor to name',
    );
  });

  it('accepts the next sequence linked to the prior snapshot digest', () => {
    expect(verifyCatalogPointerAdvance(makePointer(first), makePointer(second, first))).toBeNull();
  });

  it('refuses a rollback and a repeat of the same sequence', () => {
    const prior = makePointer(second, first);
    // Rolling back would let a supplier re-publish an older catalog as
    // current; repeating a sequence would fork the chain at one position.
    expect(verifyCatalogPointerAdvance(prior, makePointer(first))).toBe(
      'pointer chain: sequence must advance (rollback or fork refused)',
    );
    expect(verifyCatalogPointerAdvance(prior, makePointer(second, first))).toBe(
      'pointer chain: sequence must advance (rollback or fork refused)',
    );
  });

  it('refuses a gap, because a missing snapshot is a publication fault', () => {
    const third = makeSnapshot([makePage({ snapshot_sequence: 3 })], 3);
    expect(verifyCatalogPointerAdvance(makePointer(first), makePointer(third, first))).toBe(
      'pointer chain: sequence gap — a missing snapshot is a publication fault',
    );
  });

  it('refuses a link that names the wrong predecessor', () => {
    const wrongLink = { ...makePointer(second, first), previous_snapshot_digest: hexOf('nope') };
    expect(verifyCatalogPointerAdvance(makePointer(first), wrongLink)).toBe(
      'pointer chain: previous_snapshot_digest does not match the prior pointer',
    );
  });

  it('refuses a chain that changes supplier or catalog mid-flight', () => {
    const prior = makePointer(first);
    expect(
      verifyCatalogPointerAdvance(prior, {
        ...makePointer(second, first),
        supplier_did: 'did:plc:someoneelse',
      }),
    ).toBe('pointer chain: supplier_did changed mid-chain');
    expect(
      verifyCatalogPointerAdvance(prior, {
        ...makePointer(second, first),
        catalog_id: 'other-catalog',
      }),
    ).toBe('pointer chain: catalog_id changed mid-chain');
  });
});

describe('withdrawal is an explicit tombstone (§10.2)', () => {
  const first = makeSnapshot([makePage()], 1);

  function tombstone(): CatalogPointer {
    return {
      supplier_did: SUPPLIER,
      catalog_id: CATALOG,
      snapshot_sequence: 2,
      protocol_version: '1.0',
      published_at: '2026-08-08T11:00:00.000Z',
      previous_snapshot_digest: first.snapshot_digest,
      withdrawn: true,
    };
  }

  it('advances the chain carrying the next sequence', () => {
    // Withdrawal is a publication, not an absence: a consumer LEARNS the
    // catalog is gone rather than merely ceasing to hear about it.
    expect(verifyCatalogPointerAdvance(makePointer(first), tombstone())).toBeNull();
  });

  it('must not name a snapshot', () => {
    expect(validateCatalogPointer({ ...tombstone(), snapshot_rkey: 'snap-2' })).toBe(
      'pointer: a withdrawal must not name a snapshot',
    );
    expect(validateCatalogPointer({ ...tombstone(), snapshot_digest: hexOf('x') })).toBe(
      'pointer: a withdrawal must not name a snapshot',
    );
  });
});

describe('shape validation', () => {
  it.each([
    ['not an object', null, 'pointer: must be an object'],
    [
      'no supplier',
      { catalog_id: CATALOG, snapshot_sequence: 1, protocol_version: '1.0', published_at: 'x' },
      'pointer.supplier_did: must be a non-empty string',
    ],
    [
      'sequence zero',
      {
        supplier_did: SUPPLIER,
        catalog_id: CATALOG,
        snapshot_sequence: 0,
        protocol_version: '1.0',
        published_at: 'x',
      },
      'pointer: snapshot_sequence must be >= 1',
    ],
    [
      'live pointer with no snapshot',
      {
        supplier_did: SUPPLIER,
        catalog_id: CATALOG,
        snapshot_sequence: 1,
        protocol_version: '1.0',
        // A CANONICAL timestamp now, because the placeholder `'x'` was only
        // ever accepted while these records were checked for emptiness alone.
        // Leaving it would make this case assert the timestamp rule and never
        // reach the one it is named for.
        published_at: '2026-08-08T09:00:00.000Z',
      },
      'pointer.snapshot_rkey: must be a non-empty string',
    ],
  ])('pointer: %s', (_label, value, expected) => {
    expect(validateCatalogPointer(value)).toBe(expected);
  });

  it('bounds page size so a fetcher can cap work before trusting', () => {
    const huge = makePage({ items: Array.from({ length: 501 }, (_, i) => ({ sku: String(i) })) });
    expect(validateCatalogSnapshotPage(huge)).toBe('page: too many items for one page');
  });

  it('rejects a snapshot whose page digests are not all strings', () => {
    const snapshot = makeSnapshot([makePage()]);
    // Page digests ARE digests, and are now held to that: the old check
    // accepted any non-empty string, so a producer could publish `'ok'` as a
    // page commitment and a stricter consumer would refuse the record.
    expect(validateCatalogSnapshot({ ...snapshot, page_digests: ['ok', 42] })).toBe(
      'snapshot.page_digests[0]: must be a 64-char lowercase hex string',
    );
  });

  it('separates its commitment domain from the §9.12 record digests', () => {
    // The same bytes under a different domain must not collide, or a page
    // could be presented as a snapshot.
    const value = ['a', 'b'];
    expect(catalogPayloadRoot(value, hash)).not.toBe(
      catalogPageDigest(
        { catalog_id: 'a', snapshot_sequence: 1, page_index: 0, items: [], page_digest: '' },
        hash,
      ),
    );
  });
});

describe('§9.13 forward compatibility: an additive field is tolerated AND committed', () => {
  // The two halves have to hold together. Tolerating an unknown field
  // without committing to it would let a supplier publish content the
  // digest does not cover — a page that verifies while carrying whatever
  // the producer chose to smuggle in. Committing without tolerating would
  // break every consumer on the first additive minor.
  it('accepts a page carrying a field this version does not know', () => {
    const page = { ...makePage(), future_field: 'a later minor added this' };
    expect(validateCatalogSnapshotPage(page)).toBeNull();
  });

  it('changes the page digest, so the unknown field is inside the commitment', () => {
    const plain = makePage();
    const extended = { ...plain, future_field: 'a later minor added this' };
    const plainDigest = catalogPageDigest(plain, hash);
    const extendedDigest = catalogPageDigest(extended as typeof plain, hash);
    expect(extendedDigest).not.toEqual(plainDigest);

    // And the digest is stable for the same content, so "different" above
    // means the field, not nondeterminism.
    expect(catalogPageDigest({ ...extended } as typeof plain, hash)).toEqual(extendedDigest);
  });

  it('does the same for a snapshot record', () => {
    const plain = makeSnapshot([makePage()]);
    const extended = { ...plain, future_field: 42 };
    expect(validateCatalogSnapshot(extended)).toBeNull();
    expect(catalogSnapshotDigest(extended as typeof plain, hash)).not.toEqual(
      catalogSnapshotDigest(plain, hash),
    );
  });
});

/**
 * §10.5 (DR-5) — which service listing serves this catalog.
 *
 * §10.2 identifies a catalog by `catalog_id` and says nothing about the
 * listing a buyer should send a quote request to, so an index had nowhere to
 * learn it and every candidate said `self`. Right for a supplier with one
 * listing; wrong for the rkey-keyed model §10 assumes.
 */
describe('the pointer may name the listing that serves the catalog', () => {
  const pointer = (over: Record<string, unknown>) => ({
    ...makePointer(makeSnapshot([makePage()])),
    ...over,
  });

  it('accepts a pointer that names one', () => {
    expect(validateCatalogPointer(pointer({ service_rkey: 'chairs' }))).toBeNull();
  });

  it('accepts a pointer that names none — the field is additive', () => {
    // Every catalog published before this field existed omits it, and none of
    // them became invalid the day it was added.
    expect(validateCatalogPointer(pointer({}))).toBeNull();
  });

  it('refuses an empty listing name rather than reading it as absent', () => {
    expect(validateCatalogPointer(pointer({ service_rkey: '' }))).toBe(
      'pointer.service_rkey: must be a non-empty string',
    );
  });

  it('refuses a non-string listing name', () => {
    expect(validateCatalogPointer(pointer({ service_rkey: 7 }))).toBe(
      'pointer.service_rkey: must be a non-empty string',
    );
  });

  it('validates it on a TOMBSTONE too', () => {
    // A withdrawal names no snapshot, but a malformed field is malformed
    // whatever else the record says.
    const tombstone = {
      supplier_did: SUPPLIER,
      catalog_id: CATALOG,
      snapshot_sequence: 2,
      protocol_version: '1.0',
      published_at: '2026-08-08T10:00:00.000Z',
      previous_snapshot_digest: 'a'.repeat(64),
      withdrawn: true,
      service_rkey: '',
    };
    expect(validateCatalogPointer(tombstone)).toBe(
      'pointer.service_rkey: must be a non-empty string',
    );
  });
});
