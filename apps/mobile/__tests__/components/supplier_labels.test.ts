/**
 * Supplier names on the Ask for quotes picker (ASK_FOR_QUOTES_PLAN §1). A
 * listing's name is the supplier's own claim: on the test bed three suppliers
 * all called themselves "ChairMaker Workshop", and a buyer could not tell
 * which was which. Pinned: a name shared on screen carries the DID beside it,
 * a unique name stands alone, and a nameless listing shows its DID.
 */

import { supplierLabels } from '../../src/services/supplier_names';

const A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'did:plc:cccccccccccccccccccccccc';

it('a shared name carries each supplier’s DID; a unique name stands alone', () => {
  const labels = supplierLabels([
    { supplierDid: A, name: 'ChairMaker Workshop' },
    { supplierDid: B, name: 'ChairMaker Workshop' },
    { supplierDid: C, name: 'Sancho Bakery' },
  ]);
  expect(labels.get(A)).toBe('ChairMaker Workshop · did:plc:aaaa…aaaa');
  expect(labels.get(B)).toBe('ChairMaker Workshop · did:plc:bbbb…bbbb');
  expect(labels.get(C)).toBe('Sancho Bakery');
});

it('the same supplier listed twice (a picked chip and a result) is not a clash', () => {
  const labels = supplierLabels([
    { supplierDid: A, name: 'ChairMaker Workshop' },
    { supplierDid: A, name: 'ChairMaker Workshop' },
  ]);
  expect(labels.get(A)).toBe('ChairMaker Workshop');
});

it('a listing with no name shows its DID', () => {
  expect(supplierLabels([{ supplierDid: A, name: null }]).get(A)).toBe('did:plc:aaaa…aaaa');
});
