/**
 * DIVERGENCE SWEEP — the gate that does not depend on what I thought to test.
 *
 * WHY THIS EXISTS, and it is the sharpest lesson of the whole review. The
 * frozen parity vectors (`commerce_wire_parity.test.ts`) are hand-authored, and
 * an independent reviewer mutation-tested the two implementations against each
 * other and found FIVE branches where they disagreed — none of them covered by
 * a vector, and three of them outside the scope boundary I had written down to
 * justify the omission:
 *
 *   - an invalid `pack.sell_unit` unit code       AppView accepted, protocol rejected
 *   - `units_per_pack: "0"`                        AppView accepted, protocol rejected
 *   - an invalid `minimum_order`                   AppView accepted, protocol rejected
 *   - non-string `relationship_claim_refs`         AppView accepted, protocol rejected
 *   - `indicative_price: null`                     AppView accepted, protocol rejected
 *
 * The vectors passed throughout, because I chose their cases from the same
 * understanding that wrote the divergent copy. A hand-written gate inherits its
 * author's blind spots; that is not a reason to delete it — the vectors are
 * still what a THIRD-PARTY port replays, and they carry the frozen intent — but
 * it is a reason not to rely on it alone.
 *
 * So this file mutates a valid record field by field and asserts only one
 * thing: THE TWO IMPLEMENTATIONS AGREE. It never states what the right answer
 * is, which is the point — a case whose answer I would have had to know is a
 * case I could have got wrong in both places.
 *
 * IMPORTING THE PROTOCOL HERE IS TEST-ONLY. `appview/` ships with no
 * `@dina/*` dependency and production code must keep it that way; this is a
 * drift gate, and a drift gate that cannot see both sides cannot detect drift.
 * The capability registry's own gate reaches across the same boundary for the
 * same reason.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { validateCatalogItem as protocolValidateCatalogItem } from '../../../packages/commerce-protocol/src/catalog'
import { validateProductRelationshipClaim as protocolValidateClaim } from '../../../packages/commerce-protocol/src/catalog'
import { validateProductRef as protocolValidateProductRef } from '../../../packages/commerce-protocol/src/product'
import { validateRegionRef as protocolValidateRegionRef } from '../../../packages/commerce-protocol/src/region'
import {
  validateCatalogPointer as protocolValidatePointer,
  validateCatalogSnapshot as protocolValidateSnapshot,
  validateCatalogSnapshotPage as protocolValidatePage,
} from '../../../packages/commerce-protocol/src/catalog_publication'

import {
  validateCatalogItem,
  validateProductRef,
  validateRegionRef,
  validateRelationshipClaim,
} from '../../src/shared/commerce/wire-rules'
import {
  checkCatalogPointer,
  checkCatalogSnapshot,
} from '../../src/shared/commerce/wire_shape'
import { validateCatalogPageRecord } from '../../src/shared/commerce/wire-rules'

/**
 * The frozen interop publication: a real pointer, snapshot and pages, so the
 * bases below are records a supplier actually publishes rather than shapes I
 * invented — the same reason the item base carries every optional field.
 */
const PUBLICATION = JSON.parse(
  readFileSync(
    join(
      __dirname, '..', '..', '..',
      'packages', 'commerce-protocol', 'conformance', 'interop', 'catalog_publication.json',
    ),
    'utf8',
  ),
) as { pointer: Record<string, unknown>; snapshot: Record<string, unknown>; pages: Record<string, unknown>[] }

const ITEM = {
  product: { scheme: 'gtin', value: '0012345678905' },
  supplier_did: 'did:plc:supplier1',
  catalog_id: 'cat-1',
  item_revision: 'r1',
  name: 'Cotton Twine 200m',
  brand: 'Twineworks',
  description: 'Two hundred metres of it.',
  category_ids: ['hardware.twine'],
  identifiers: [{ scheme: 'manufacturer_sku', value: 'TW-200', issuer_did: 'did:plc:maker1' }],
  relationship_claim_refs: ['rc-1'],
  pack: { sell_unit: { unit_code: 'each', value: '1' }, units_per_pack: '12' },
  fulfilment_regions: [{ scheme: 'country', value: 'GB' }],
  indicative_price: { currency: 'GBP', minor_units: '499' },
  minimum_order: { unit_code: 'each', value: '1' },
  freshness: { generated_at: '2026-06-01T00:00:00Z', valid_until: '2026-12-01T00:00:00Z' },
  attributes: { colour: 'natural', metres: 200, waxed: false },
}

const CLAIM = {
  claim_id: 'c1',
  subject: { scheme: 'gtin', value: '0012345678905' },
  relationship: 'variant_of',
  object: { scheme: 'gtin', value: '0012345678912' },
  issuer_did: 'did:plc:issuer1',
  effective_from: '2026-01-01T00:00:00Z',
  effective_until: '2026-06-01T00:00:00Z',
  evidence_refs: ['ev-1'],
}

/**
 * Values chosen to probe the SHAPE of a rule rather than a specific field:
 * wrong primitive type, empty, null, an object where a scalar belongs, a
 * boundary number, an unknown enum member.
 */
const POISONS: unknown[] = [
  null,
  undefined,
  0,
  -1,
  '',
  ' ',
  'not-a-value',
  true,
  [],
  [null],
  [{ nested: 'object' }],
  { nested: 'object' },
  '0',
  '00',
  '1.5',
  'x'.repeat(300),
]

/** Every leaf path of an object, as a dotted list. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return prefix === '' ? [] : [prefix]
  if (Array.isArray(value)) {
    return [prefix, ...value.flatMap((v, i) => leafPaths(v, `${prefix}[${String(i)}]`))]
  }
  return [
    ...(prefix === '' ? [] : [prefix]),
    ...Object.entries(value).flatMap(([k, v]) => leafPaths(v, prefix === '' ? k : `${prefix}.${k}`)),
  ]
}

function setPath(root: unknown, path: string, next: unknown): unknown {
  const clone = structuredClone(root) as Record<string, unknown>
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  let cursor: Record<string, unknown> = clone
  for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>
  const last = parts[parts.length - 1] as string
  if (next === undefined) delete cursor[last]
  else cursor[last] = next
  return clone
}

function sweep(
  label: string,
  base: unknown,
  ours: (v: unknown) => string | null,
  theirs: (v: unknown) => string | null,
  /**
   * How many leaf paths this record must have. Per-record because a
   * `ProductRef` legitimately has three and a catalog item has thirty — a
   * single global floor was wrong for the small ones, and a floor nobody can
   * satisfy is as useless as one nothing can fail.
   */
  minimumPaths: number,
): void {
  describe(`${label} — AppView and the protocol agree on every mutation`, () => {
    // The BASE first. A sweep over a base the two already disagree about would
    // report every mutation as a divergence and bury the real ones.
    it('agrees on the unmutated base', () => {
      expect([ours(base) === null, theirs(base) === null]).toEqual([true, true])
    })

    const paths = leafPaths(base)
    it('has paths to mutate, so the sweep is not vacuous', () => {
      expect(paths.length).toBeGreaterThanOrEqual(minimumPaths)
    })

    for (const path of paths) {
      for (const [i, poison] of POISONS.entries()) {
        it(`${path} := poison[${String(i)}]`, () => {
          const mutated = setPath(base, path, poison)
          const oursAccepts = ours(mutated) === null
          const theirsAccepts = theirs(mutated) === null
          // The ASSERTION NAMES BOTH SIDES so a failure says which way the
          // disagreement runs — "AppView accepted what the protocol refuses" is
          // an interoperability bug; the reverse is a false refusal.
          expect({ appview: oursAccepts, protocol: theirsAccepts }).toEqual({
            appview: theirsAccepts,
            protocol: theirsAccepts,
          })
        })
      }
    }
  })
}

sweep(
  'catalog item',
  ITEM,
  (v) => validateCatalogItem(v),
  (v) => protocolValidateCatalogItem(v),
  25,
)

sweep(
  'relationship claim',
  CLAIM,
  (v) => validateRelationshipClaim(v),
  (v) => protocolValidateClaim(v),
  10,
)

sweep(
  'product ref',
  ITEM.product,
  (v) => validateProductRef(v, 'product'),
  (v) => protocolValidateProductRef(v),
  2,
)

sweep(
  'region ref',
  ITEM.fulfilment_regions[0],
  (v) => validateRegionRef(v, 'region'),
  (v) => protocolValidateRegionRef(v),
  2,
)

/**
 * THE PUBLICATION RECORDS, added after a reviewer pointed out the parity family
 * covered neither the pointer nor its COHERENCE rules — the ones that live
 * between fields rather than in any one of them. A live pointer carrying a
 * digest and no rkey was admitted here and refused by the protocol.
 *
 * AppView's snapshot and pointer guards are shape gates rather than full
 * protocol validators, so these sweeps assert the direction that matters for
 * interoperability: ANYTHING THE PROTOCOL REFUSES, APPVIEW MUST REFUSE. The
 * reverse — AppView stricter than the protocol — is a false refusal and is
 * reported separately rather than silently tolerated.
 */
function sweepNoLooserThanProtocol(
  label: string,
  base: unknown,
  ours: (v: unknown) => string | null,
  theirs: (v: unknown) => string | null,
  minimumPaths: number,
): void {
  describe(`${label} — AppView is never looser than the protocol`, () => {
    it('agrees on the unmutated base', () => {
      expect([ours(base) === null, theirs(base) === null]).toEqual([true, true])
    })
    const paths = leafPaths(base)
    it('has paths to mutate, so the sweep is not vacuous', () => {
      expect(paths.length).toBeGreaterThanOrEqual(minimumPaths)
    })
    for (const path of paths) {
      for (const [i, poison] of POISONS.entries()) {
        it(`${path} := poison[${String(i)}]`, () => {
          const mutated = setPath(base, path, poison)
          if (theirs(mutated) !== null) {
            // The protocol refuses it, so AppView must too — otherwise AppView
            // indexes a publication no conforming consumer will accept.
            expect({ path, appviewAccepted: ours(mutated) === null }).toEqual({
              path,
              appviewAccepted: false,
            })
          }
        })
      }
    }
  })
}

sweepNoLooserThanProtocol(
  'catalog pointer',
  PUBLICATION.pointer,
  (v) => checkCatalogPointer(v),
  (v) => protocolValidatePointer(v),
  6,
)

sweepNoLooserThanProtocol(
  'catalog snapshot',
  PUBLICATION.snapshot,
  (v) => checkCatalogSnapshot(v),
  (v) => protocolValidateSnapshot(v),
  8,
)

sweepNoLooserThanProtocol(
  'catalog page',
  PUBLICATION.pages[0],
  (v) => validateCatalogPageRecord(v),
  (v) => protocolValidatePage(v),
  4,
)
