/**
 * The AppView half of the wire-rule parity gate.
 *
 * `appview/` declares no `@dina/*` dependency, so it reimplements the commerce
 * wire rules in `shared/commerce/wire-rules.ts`. This test replays the SAME
 * frozen vectors that `packages/commerce-protocol/__tests__/
 * wire_rules_parity.test.ts` replays through the protocol validators. Where the
 * two disagree, one of them is wrong about the protocol.
 *
 * WHAT IT CATCHES, concretely: the previous hand-written gate listed a
 * relationship vocabulary of `successor_of`, `equivalent_to`, `distributed_by`,
 * `branded_as`, `sold_as` — five names §10.3 does not define — while refusing
 * five it does. Every commerce test used one of the two overlapping names, so
 * the suite stayed green. Five cases in this file fail against that gate.
 *
 * The vector file is read from the protocol package by path rather than
 * imported, which is how the capability-registry drift gate already reaches
 * across the same boundary.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  admitsProtocolVersion,
  validateCatalogItem,
  validateProductRef,
  validateRegionRef,
  validateRelationshipClaim,
  RELATIONSHIP_VOCABULARY,
} from '../../src/shared/commerce/wire-rules'

interface ParityCase {
  kind: string
  name: string
  input: unknown
  valid: boolean
}

const VECTOR_PATH = join(
  __dirname,
  '../../../packages/commerce-protocol/conformance/vectors/wire_rules_parity.json',
)

const vectors = JSON.parse(readFileSync(VECTOR_PATH, 'utf8')) as { cases: ParityCase[] }

function accepts(testCase: ParityCase): boolean {
  switch (testCase.kind) {
    case 'product_ref':
      return validateProductRef(testCase.input, 'product') === null
    case 'region_ref':
      return validateRegionRef(testCase.input, 'region') === null
    case 'relationship_claim':
      return validateRelationshipClaim(testCase.input) === null
    case 'catalog_item':
      return validateCatalogItem(testCase.input) === null
    case 'protocol_version':
      return admitsProtocolVersion(testCase.input, 'protocol_version') === null
    default:
      throw new Error(`unknown parity case kind: ${testCase.kind}`)
  }
}

describe('wire-rule parity vectors (AppView side)', () => {
  it('reads the frozen vectors the protocol package publishes', () => {
    expect(vectors.cases.length).toBeGreaterThan(30)
  })

  it('states the §10.3 vocabulary in the protocol’s own terms', () => {
    expect([...RELATIONSHIP_VOCABULARY]).toEqual([
      'manufactured_by',
      'marketed_under',
      'variant_of',
      'packaging_variant_of',
      'same_formulation_as',
      'replaces',
      'sold_by',
    ])
  })

  it.each(vectors.cases.map((c) => [`${c.kind}/${c.name}`, c] as const))(
    '%s',
    (_label, testCase) => {
      expect(accepts(testCase)).toBe(testCase.valid)
    },
  )
})
