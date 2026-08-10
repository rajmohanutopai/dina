/**
 * The protocol half of the AppView parity gate.
 *
 * `conformance/vectors/wire_rules_parity.json` is replayed here through the
 * protocol validators and, separately, in `appview/tests/unit/
 * commerce_wire_parity.test.ts` through AppView's independent copy of the same
 * rules. Both sides must agree on accept/reject for every case.
 *
 * This file is the side that says what the rules ARE. If a case here starts
 * failing, the protocol changed and the vector needs a deliberate decision —
 * not a quiet edit to whichever side is red.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateCatalogItem, validateProductRelationshipClaim } from '../src/catalog';
import { checkProtocolVersion, validateProtocolVersionShape } from '../src/common';
import { validateProductRef } from '../src/product';
import { validateRegionRef } from '../src/region';

interface ParityCase {
  kind: string;
  name: string;
  input: unknown;
  valid: boolean;
}

const vectors = JSON.parse(
  readFileSync(join(__dirname, '../conformance/vectors/wire_rules_parity.json'), 'utf8'),
) as { cases: ParityCase[] };

function accepts(testCase: ParityCase): boolean {
  switch (testCase.kind) {
    case 'product_ref':
      return validateProductRef(testCase.input) === null;
    case 'region_ref':
      return validateRegionRef(testCase.input) === null;
    case 'relationship_claim':
      return validateProductRelationshipClaim(testCase.input) === null;
    case 'catalog_item':
      return validateCatalogItem(testCase.input) === null;
    case 'protocol_version': {
      if (validateProtocolVersionShape(testCase.input, 'protocol_version') !== null) return false;
      return checkProtocolVersion(testCase.input as string) === null;
    }
    default:
      throw new Error(`unknown parity case kind: ${testCase.kind}`);
  }
}

describe('wire-rule parity vectors (protocol side)', () => {
  it('carries cases for every kind AppView reimplements', () => {
    const kinds = new Set(vectors.cases.map((c) => c.kind));
    expect([...kinds].sort()).toEqual([
      'catalog_item',
      'product_ref',
      'protocol_version',
      'region_ref',
      'relationship_claim',
    ]);
  });

  it('covers the whole §10.3 relationship vocabulary', () => {
    // The defect these vectors exist for was a vocabulary copy sharing two of
    // seven entries with the protocol. A parity file that happened to exercise
    // only the overlapping names would have passed over it just as the suite
    // did, so every name is asserted present by construction.
    const exercised = vectors.cases
      .filter((c) => c.kind === 'relationship_claim' && c.valid)
      .map((c) => (c.input as { relationship: string }).relationship);
    for (const relationship of [
      'manufactured_by',
      'marketed_under',
      'variant_of',
      'packaging_variant_of',
      'same_formulation_as',
      'replaces',
      'sold_by',
    ]) {
      expect(exercised).toContain(relationship);
    }
  });

  it.each(vectors.cases.map((c) => [`${c.kind}/${c.name}`, c] as const))(
    '%s',
    (_label, testCase) => {
      expect(accepts(testCase)).toBe(testCase.valid);
    },
  );
});
