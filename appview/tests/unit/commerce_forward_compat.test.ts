/**
 * §9.13 forward compatibility, through the layer that ACTUALLY RUNS.
 *
 * WHAT THIS CLOSES, and it is the most consequential gap of five review rounds.
 * Every commerce scenario written so far calls a handler DIRECTLY with the raw
 * record. Production does not: `jetstream-consumer.ts` hands the handler
 * `validation.data` — the Zod-parsed record — and `z.object()` strips what it
 * does not name.
 *
 * Because catalog records are DIGEST-BOUND, stripping is not lossy-but-benign:
 * the recomputed page digest stops matching the one the supplier committed to,
 * and the whole publication is refused. So a supplier publishing on a newer
 * MINOR became silently unindexable — the exact law `schema_evolution.json`
 * freezes, inverted in the consumer of it, and asserted the RIGHT way round by
 * a suite that never touched the wired path.
 */

import { expect, it, describe } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { validateRecord } from '@/ingester/record-validator.js'
import { catalogPageDigest, catalogSnapshotDigest } from '@/shared/commerce/catalog-verify.js'

const PUBLICATION = JSON.parse(
  readFileSync(
    path.join(
      __dirname, '..', '..', '..',
      'packages', 'commerce-protocol', 'conformance', 'interop', 'catalog_publication.json',
    ),
    'utf8',
  ),
) as { pointer: Record<string, unknown>; snapshot: Record<string, unknown>; pages: Record<string, unknown>[] }

/** A page as a supplier on a newer minor publishes it: field present, digest over it. */
function pageWithFutureField(): Record<string, unknown> {
  const { page_digest: _old, ...rest } = PUBLICATION.pages[0] as Record<string, unknown>
  const withFuture = { ...rest, future_field: 'from-a-later-minor' }
  return { ...withFuture, page_digest: catalogPageDigest(withFuture as never) }
}

describe('an unknown field survives the layer that runs in production', () => {
  it('keeps a page-level unknown field, so its digest still verifies', () => {
    const published = pageWithFutureField()

    const out = validateRecord('com.dinakernel.commerce.catalogSnapshot', {
      snapshot: PUBLICATION.snapshot,
      pages: [published],
    })
    expect(out.success).toBe(true)

    const parsed = (out as { data: { pages: Record<string, unknown>[] } }).data.pages[0]

    // BOTH assertions matter. The field surviving is the mechanism; the digest
    // still verifying is the CONSEQUENCE, and it is the consequence that
    // decides whether the supplier's catalog is indexable at all.
    expect('future_field' in parsed).toBe(true)
    expect(catalogPageDigest(parsed as never)).toBe(published.page_digest)
  })

  it('keeps a snapshot-level unknown field, so ITS digest still verifies', () => {
    const { snapshot_digest: _old, ...rest } = PUBLICATION.snapshot
    const withFuture = { ...rest, future_field: 'from-a-later-minor' }
    const published = { ...withFuture, snapshot_digest: catalogSnapshotDigest(withFuture as never) }

    const out = validateRecord('com.dinakernel.commerce.catalogSnapshot', {
      snapshot: published,
      pages: PUBLICATION.pages,
    })
    expect(out.success).toBe(true)

    const parsed = (out as { data: { snapshot: Record<string, unknown> } }).data.snapshot
    expect('future_field' in parsed).toBe(true)
    expect(catalogSnapshotDigest(parsed as never)).toBe(published.snapshot_digest)
  })

  it('keeps a pointer-level unknown field', () => {
    const out = validateRecord('com.dinakernel.commerce.catalog', {
      ...PUBLICATION.pointer,
      future_field: 'from-a-later-minor',
    })
    expect(out.success).toBe(true)

    const parsed = (out as { data: Record<string, unknown> }).data
    expect('future_field' in parsed).toBe(true)
  })

  it('keeps an unknown field on a RELATIONSHIP CLAIM, so the verbatim table is verbatim', () => {
    // Not digest-bound, so stripping breaks no verification — it breaks the
    // schema's promise that this table "holds what people SAID, verbatim and
    // durably". `rebuildSubject` re-derives edges from `claim_json` on every
    // later claim touching the subject, so a field stripped at insert is gone
    // for good and a later version that understands it cannot recover it.
    const out = validateRecord('com.dinakernel.commerce.relationshipClaim', {
      claim_id: 'rc-fwd',
      subject: { scheme: 'gtin', value: '05012345678900' },
      relationship: 'variant_of',
      object: { scheme: 'gtin', value: '05012345678917' },
      issuer_did: 'did:plc:chairmaker99',
      future_field: 'from-a-later-minor',
    })
    expect(out.success).toBe(true)

    const parsed = (out as { data: Record<string, unknown> }).data
    expect('future_field' in parsed).toBe(true)
  })

  it('still REFUSES a record that breaks a named rule, so passthrough is not a bypass', () => {
    // Tolerating the unknown must not mean tolerating the known-and-wrong.
    const out = validateRecord('com.dinakernel.commerce.catalog', {
      ...PUBLICATION.pointer,
      snapshot_sequence: -1,
    })

    expect(out.success).toBe(false)
  })
})

/**
 * The rules AppView applies to commerce records, through `validateRecord`.
 *
 * Every case here drives the layer `jetstream-consumer.ts` actually calls. An
 * earlier round proved why that matters: the suite asserted §9.13 correctly
 * against handlers called directly, while the wired path stripped the field
 * and made conformant catalogs unindexable.
 */
describe('what the wired validator admits and refuses', () => {
  const claim = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    claim_id: 'c1',
    subject: { scheme: 'gtin', value: '0012345678905' },
    relationship: 'variant_of',
    object: { scheme: 'gtin', value: '0012345678912' },
    issuer_did: 'did:plc:issuer1',
    ...over,
  })
  const claimResult = (over: Record<string, unknown> = {}) =>
    validateRecord('com.dinakernel.commerce.relationshipClaim', claim(over))

  const pointer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...PUBLICATION.pointer,
    ...over,
  })
  const pointerResult = (over: Record<string, unknown> = {}) =>
    validateRecord('com.dinakernel.commerce.catalog', pointer(over))

  describe('§9.13 version admission', () => {
    it('admits a higher MINOR, because minors are additive', () => {
      expect(pointerResult({ protocol_version: '1.7' }).success).toBe(true)
    })

    it('refuses an unknown MAJOR instead of best-effort indexing it', () => {
      // A publisher can recompute every commitment; what they cannot do is
      // make this AppView implement a protocol it does not have.
      expect(pointerResult({ protocol_version: '2.0' }).success).toBe(false)
    })

    it('refuses a version that is not a version', () => {
      expect(pointerResult({ protocol_version: 'banana' }).success).toBe(false)
    })
  })

  describe('record keys', () => {
    it('refuses an rkey longer than every conformant reader accepts', () => {
      // Indexing it would build a `service_uri` that the buyer's own parser
      // refuses, so the supplier's products vanish with nothing to explain it.
      expect(pointerResult({ service_rkey: 'r'.repeat(200) }).success).toBe(false)
    })

    it('refuses a null rkey rather than dereferencing it', () => {
      // `decideCatalogPointer` guards on `!== undefined` and then reads
      // `.length`, so `null` used to throw out of the ingest lane.
      expect(pointerResult({ service_rkey: null }).success).toBe(false)
    })
  })

  describe('§10.3 relationship claims', () => {
    it('accepts a well-formed claim', () => {
      expect(claimResult().success).toBe(true)
    })

    it('keeps unknown fields nested inside the claim, not just at the top', () => {
      // `.passthrough()` only ever protected the TOP level; `z.object()` kept
      // stripping every level below it, and this table promises to hold what
      // people said verbatim.
      const out = claimResult({
        subject: {
          scheme: 'gtin',
          value: '0012345678905',
          future_qualifier: 'from-a-later-minor',
        },
      })
      expect(out.success).toBe(true)
      const stored = (out as { data: { subject: Record<string, unknown> } }).data.subject
      expect('future_qualifier' in stored).toBe(true)
    })

    it('refuses an object that is both a ProductRef and a DID', () => {
      // Zod's union picked ProductRef and DROPPED `did`, so a claim the
      // protocol refuses arrived downstream looking valid.
      expect(
        claimResult({
          object: { scheme: 'gtin', value: '0012345678912', did: 'did:plc:maker1' },
        }).success,
      ).toBe(false)
    })

    it('refuses an operator relationship pointing at a product', () => {
      // "manufactured BY another product" is an edge that means nothing, and
      // it still composes manufacturer standing along itself.
      expect(
        claimResult({
          relationship: 'manufactured_by',
          object: { scheme: 'gtin', value: '0012345678912' },
        }).success,
      ).toBe(false)
    })

    it('refuses a product relationship pointing at an operator', () => {
      expect(claimResult({ object: { did: 'did:plc:maker1' } }).success).toBe(false)
    })

    it('refuses an unscoped manufacturer SKU, which collides across issuers', () => {
      expect(
        claimResult({ subject: { scheme: 'manufacturer_sku', value: 'A-1' } }).success,
      ).toBe(false)
    })

    it('refuses a GTIN that is not 8-14 digits', () => {
      expect(claimResult({ subject: { scheme: 'gtin', value: 'not-a-gtin' } }).success).toBe(
        false,
      )
    })

    it('refuses a validity range that ends before it starts', () => {
      expect(
        claimResult({
          effective_from: '2026-06-01T00:00:00.000Z',
          effective_until: '2026-01-01T00:00:00.000Z',
        }).success,
      ).toBe(false)
    })

    it('accepts every relationship §10.3 defines', () => {
      // The gate this replaced refused five of these seven outright.
      for (const relationship of ['variant_of', 'packaging_variant_of', 'same_formulation_as', 'replaces']) {
        expect(claimResult({ relationship }).success).toBe(true)
      }
      for (const relationship of ['manufactured_by', 'marketed_under', 'sold_by']) {
        expect(claimResult({ relationship, object: { did: 'did:plc:op1' } }).success).toBe(true)
      }
    })
  })
})
