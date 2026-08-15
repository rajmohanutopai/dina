/**
 * The AppView catalog verifier, checked against the FROZEN conformance
 * vectors (§10.2, §25.1, FR-A1, FR-A2).
 *
 * `appview/src/shared/commerce/catalog-verify.ts` is a second implementation
 * of a contract `@dina/commerce-protocol` owns, because AppView deploys
 * standalone and cannot depend on the workspace. The vectors are what keeps
 * the two honest: this file reads
 * `packages/commerce-protocol/conformance/vectors/catalog.json` — the same
 * bytes the protocol's own suite runs — and asserts this implementation
 * produces the same digests and the same refusal STRINGS.
 *
 * If this fails after a protocol change, the vectors moved and this port has
 * not. That is the failure this test exists to produce, at the commit rather
 * than at the first cross-implementation disagreement in production.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  MAX_CATALOG_PAGES,
  MAX_CATALOG_PAGE_ITEMS,
  catalogPageDigest,
  catalogPayloadRoot,
  catalogSnapshotDigest,
  verifyCatalogPage,
  verifyCatalogPointerAdvance,
  verifyCatalogPublication,
  verifyCatalogSnapshot,
  verifyPointerNamesSnapshot,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
} from '@/shared/commerce/catalog-verify.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const VECTORS = path.resolve(
  here,
  '../../../packages/commerce-protocol/conformance/vectors/catalog.json',
)

interface CatalogVectors {
  pages: CatalogSnapshotPage[]
  snapshot: CatalogSnapshot
  genesis_pointer: CatalogPointer
  chain_cases: {
    name: string
    previous: CatalogPointer | null
    next: CatalogPointer
    expect: string | null
  }[]
}

const vectors = JSON.parse(readFileSync(VECTORS, 'utf8')) as CatalogVectors

/** A deep copy, so a mutation in one case cannot leak into the next. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('catalog verifier — frozen conformance vectors', () => {
  it('recomputes every frozen page digest', () => {
    for (const page of vectors.pages) {
      expect(catalogPageDigest(page)).toBe(page.page_digest)
    }
    // Two pages, so an implementation that ignored page_index or item order
    // cannot pass by accident on a single-page catalog.
    expect(vectors.pages.length).toBeGreaterThan(1)
  })

  it('recomputes the frozen payload root and snapshot digest', () => {
    expect(catalogPayloadRoot(vectors.snapshot.page_digests)).toBe(vectors.snapshot.payload_root)
    expect(catalogSnapshotDigest(vectors.snapshot)).toBe(vectors.snapshot.snapshot_digest)
  })

  it.each(vectors.chain_cases.map((c) => [c.name, c] as const))(
    'chain case %s matches the frozen verdict',
    (_name, testCase) => {
      // The STRING, not merely the fact of refusal: two implementations that
      // reject a rollback for differently-worded reasons diverge the first
      // time an operator reads a log across both.
      expect(verifyCatalogPointerAdvance(testCase.previous, testCase.next)).toBe(testCase.expect)
    },
  )

  it('accepts the frozen publication as a whole', () => {
    expect(
      verifyCatalogPublication({
        previous: null,
        pointer: vectors.genesis_pointer,
        snapshot: vectors.snapshot,
        pages: vectors.pages,
      }),
    ).toBeNull()
  })
})

describe('catalog verifier — what it refuses', () => {
  it('refuses a page whose content was edited after publication', () => {
    // The feed host is transport, not authority. This is the single property
    // the whole chain exists to deliver.
    const page = clone(vectors.pages[0]!)
    ;(page.items[0] as Record<string, unknown>).name = 'Oak dining chair (clearance)'
    expect(verifyCatalogPage(page, vectors.snapshot)).toBe(
      'page: content does not match the digest this snapshot commits to',
    )
  })

  it('refuses a page served from a slot it does not claim', () => {
    const page = clone(vectors.pages[0]!)
    page.page_index = 1
    expect(verifyCatalogPage(page, vectors.snapshot)).toBe(
      'page: content does not match the digest this snapshot commits to',
    )
  })

  it('refuses a page whose own digest field disagrees with the snapshot', () => {
    // Distinct from an edited page: the CONTENT still hashes correctly, and
    // only the self-reported field lies. An implementation that trusted the
    // field instead of recomputing would pass the previous test and fail here.
    const page = clone(vectors.pages[0]!)
    const snapshot = clone(vectors.snapshot)
    page.page_digest = 'f'.repeat(64)
    snapshot.page_digests = [catalogPageDigest(page), ...snapshot.page_digests.slice(1)]
    expect(verifyCatalogPage(page, snapshot)).toBe(
      'page: page_digest field disagrees with the snapshot',
    )
  })

  it('refuses a snapshot whose root does not commit to its own pages', () => {
    const snapshot = clone(vectors.snapshot)
    snapshot.page_digests = [snapshot.page_digests[1]!, snapshot.page_digests[0]!]
    expect(verifyCatalogSnapshot(snapshot)).toBe(
      'snapshot: payload_root does not commit to these page digests',
    )
  })

  it('refuses a snapshot record edited in place', () => {
    const snapshot = clone(vectors.snapshot)
    snapshot.published_at = '2026-06-01T00:00:00.000Z'
    expect(verifyCatalogSnapshot(snapshot)).toBe(
      'snapshot: snapshot_digest does not match the record',
    )
  })

  it('refuses a pointer that advances the chain while naming an older snapshot', () => {
    // Every record here is individually valid. Only the BINDING is wrong,
    // which is exactly how a supplier would serve last week's catalog under
    // this week's sequence.
    const pointer = clone(vectors.genesis_pointer)
    pointer.snapshot_digest = 'a'.repeat(64)
    expect(verifyPointerNamesSnapshot(pointer, vectors.snapshot)).toBe(
      'pointer: does not name this snapshot',
    )
  })

  it('refuses a publication whose pages do not add up to the snapshot', () => {
    // A full-state snapshot with a page missing projects a catalog that
    // silently omits products: buyers see a supplier who does not stock the
    // thing rather than an error.
    expect(
      verifyCatalogPublication({
        previous: null,
        pointer: vectors.genesis_pointer,
        snapshot: vectors.snapshot,
        pages: [vectors.pages[0]!],
      }),
    ).toBe('pages: count does not match the snapshot')
  })

  it('refuses a publication whose item count is inflated', () => {
    // Same page digests, same root, same snapshot digest — and the snapshot
    // CLAIMS more items than the pages carry. Caught only because the item
    // count is checked against the pages rather than believed.
    const snapshot = clone(vectors.snapshot)
    const pointer = clone(vectors.genesis_pointer)
    snapshot.item_count = 99
    snapshot.snapshot_digest = catalogSnapshotDigest(snapshot)
    pointer.snapshot_digest = snapshot.snapshot_digest
    pointer.snapshot_rkey = snapshot.snapshot_digest
    expect(
      verifyCatalogPublication({
        previous: null,
        pointer,
        snapshot,
        pages: vectors.pages,
      }),
    ).toBe('pages: item count does not match the snapshot')
  })

  it('refuses an over-large snapshot before fetching anything (FR-A2)', () => {
    // The cap is the difference between bounded work and a bill, so it is
    // checked on the METADATA — before the fetcher starts — not on arrival.
    const snapshot = clone(vectors.snapshot)
    snapshot.page_digests = Array.from({ length: MAX_CATALOG_PAGES + 1 }, () => 'a'.repeat(64))
    expect(verifyCatalogSnapshot(snapshot)).toBe('snapshot: too many pages')
  })

  it('refuses an over-large page (FR-A2)', () => {
    const page = clone(vectors.pages[0]!)
    page.items = Array.from({ length: MAX_CATALOG_PAGE_ITEMS + 1 }, () => ({ sku: 'X' }))
    expect(verifyCatalogPage(page, vectors.snapshot)).toBe('page: too many items for one page')
  })

  it('refuses to bind a withdrawal to a snapshot', () => {
    // A tombstone names no snapshot. Pairing one with a snapshot is itself the
    // fault — treating it as "no digest, therefore no mismatch" would index a
    // withdrawn catalog as live.
    const tombstone: CatalogPointer = {
      supplier_did: vectors.snapshot.supplier_did,
      catalog_id: vectors.snapshot.catalog_id,
      snapshot_sequence: 2,
      protocol_version: '1.0',
      published_at: '2026-02-01T00:00:00.000Z',
      previous_snapshot_digest: vectors.snapshot.snapshot_digest,
      withdrawn: true,
    }
    expect(verifyPointerNamesSnapshot(tombstone, vectors.snapshot)).toBe(
      'pointer: a withdrawal names no snapshot',
    )
  })
})
