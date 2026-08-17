/**
 * §4.2's minting policy — the pack's half, driving Core's ledger.
 *
 * The headline seller is the test: jars that have never had a SKU, a
 * photographed page, and every path out of repair that does not involve
 * inventing identifiers by hand.
 */

import { InMemorySkuLedgerRepository } from '../../src/commerce/sku_ledger';
import { applySkuMint } from '../../src/commerce/sku_mint';

import type { DraftRow } from '../../src/commerce/catalog_draft_store';

const ISSUER = 'did:plc:pickleseller';
const T0 = 1_800_000_000_000;

function mintArgs(
  rows: DraftRow[],
  overrides: Partial<Parameters<typeof applySkuMint>[0]> = {},
): Parameters<typeof applySkuMint>[0] {
  return {
    ledger: new InMemorySkuLedgerRepository(),
    issuerDid: ISSUER,
    catalogId: 'pickles-main',
    draftId: 'draft-1',
    defaultScheme: 'sku',
    rows,
    nowMs: T0,
    ...overrides,
  };
}

it('the pickle seller: identifier-less rows mint, in order, into the sku cell', () => {
  const result = applySkuMint(
    mintArgs([
      { row: 2, cells: { name: 'Red chilli pickle 250g' } },
      { row: 3, cells: { name: 'Green mango pickle 250g' } },
    ]),
  );
  expect(result.findings).toEqual([]);
  expect(result.changed).toBe(true);
  expect(result.rows[0]?.cells.sku).toBe('P-0001');
  expect(result.rows[1]?.cells.sku).toBe('P-0002');
  // Every row now carries its immutable identity.
  expect(result.rows[0]?.assignmentId).toBeDefined();
  expect(result.rows[0]?.assignmentId).not.toBe(result.rows[1]?.assignmentId);
});

it('SOURCE SKU VS MINT: a printed P-0001 is claimed first and the mint skips it', () => {
  const ledger = new InMemorySkuLedgerRepository();
  const result = applySkuMint(
    mintArgs(
      [
        { row: 2, cells: { sku: 'P-0001', name: 'Printed row' } },
        { row: 3, cells: { name: 'Unlabelled jar' } },
      ],
      { ledger },
    ),
  );
  expect(result.findings).toEqual([]);
  expect(result.rows[0]?.cells.sku).toBe('P-0001');
  expect(result.rows[1]?.cells.sku).toBe('P-0002');
});

it('IDEMPOTENT REPUBLICATION: re-running the same rows under a new draft changes nothing', () => {
  const ledger = new InMemorySkuLedgerRepository();
  const first = applySkuMint(mintArgs([{ row: 2, cells: { name: 'Jar' } }], { ledger }));
  const republished = applySkuMint(
    mintArgs(first.rows, { ledger, draftId: 'draft-2' }),
  );
  expect(republished.findings).toEqual([]);
  expect(republished.changed).toBe(false);
  expect(republished.rows).toEqual(first.rows);
});

it('SAME-ASSIGNMENT EDIT: an edited value re-claims cleanly under the same identity', () => {
  const ledger = new InMemorySkuLedgerRepository();
  const first = applySkuMint(mintArgs([{ row: 2, cells: { name: 'Jar' } }], { ledger }));
  const edited: DraftRow[] = [
    { ...(first.rows[0] as DraftRow), cells: { ...(first.rows[0] as DraftRow).cells, sku: 'PICKLE-RED' } },
  ];
  const result = applySkuMint(mintArgs(edited, { ledger }));
  expect(result.findings).toEqual([]);
  expect(result.rows[0]?.assignmentId).toBe(first.rows[0]?.assignmentId);
});

it('ROW REORDER leaves assignments untouched', () => {
  const ledger = new InMemorySkuLedgerRepository();
  const first = applySkuMint(
    mintArgs(
      [
        { row: 2, cells: { name: 'Jar A' } },
        { row: 3, cells: { name: 'Jar B' } },
      ],
      { ledger },
    ),
  );
  const reordered = [first.rows[1] as DraftRow, first.rows[0] as DraftRow];
  const result = applySkuMint(mintArgs(reordered, { ledger }));
  expect(result.findings).toEqual([]);
  expect(result.changed).toBe(false);
  // The assignment travels with the ROW ENTRY, not its position.
  expect(result.rows[0]?.assignmentId).toBe(first.rows[1]?.assignmentId);
  expect(result.rows[1]?.assignmentId).toBe(first.rows[0]?.assignmentId);
});

it('EDIT COLLISION: taking another product\'s value is a finding, not a merge', () => {
  const ledger = new InMemorySkuLedgerRepository();
  const first = applySkuMint(
    mintArgs(
      [
        { row: 2, cells: { name: 'Jar A' } },
        { row: 3, cells: { name: 'Jar B' } },
      ],
      { ledger },
    ),
  );
  // The seller edits row 3's sku to row 2's value.
  const collided: DraftRow[] = [
    first.rows[0] as DraftRow,
    {
      ...(first.rows[1] as DraftRow),
      cells: { ...(first.rows[1] as DraftRow).cells, sku: 'P-0001' },
    },
  ];
  const result = applySkuMint(mintArgs(collided, { ledger }));
  expect(result.findings).toEqual([
    {
      refusal: 'identifier_claimed',
      row: 3,
      column: 'sku',
      detail: '"P-0001" already belongs to another product in this catalog',
    },
  ]);
});

it('SECOND CATALOG: the refusal names the owning catalog', () => {
  const ledger = new InMemorySkuLedgerRepository();
  applySkuMint(mintArgs([{ row: 2, cells: { sku: 'JAR-RED-01', name: 'Jar' } }], { ledger }));
  const second = applySkuMint(
    mintArgs([{ row: 2, cells: { sku: 'JAR-RED-01', name: 'Same jar' } }], {
      ledger,
      catalogId: 'pickles-secondary',
      draftId: 'draft-9',
    }),
  );
  expect(second.findings[0]).toMatchObject({
    refusal: 'identifier_claimed',
    detail: expect.stringContaining('catalog "pickles-main"'),
  });
});

it('GTIN rows never mint and never claim — the namespace is not this supplier\'s', () => {
  const ledger = new InMemorySkuLedgerRepository();
  const result = applySkuMint(
    mintArgs(
      [
        { row: 2, cells: { scheme: 'gtin', identifier: '04012345678905', name: 'Branded jar' } },
        { row: 3, cells: { scheme: 'gtin', name: 'GTIN row with no code' } },
      ],
      { ledger },
    ),
  );
  expect(result.findings).toEqual([]);
  expect(result.changed).toBe(false);
  expect(result.rows[0]?.assignmentId).toBeUndefined();
  // The identifier-less GTIN row stays identifier-less: the importer's
  // missing_required finding is the honest answer, because a GTIN cannot
  // be invented here.
  expect(result.rows[1]?.cells.identifier).toBeUndefined();
  expect(ledger.highWater(ISSUER)).toBe(0);
});

it('an EXPLICIT identifier column claims under it, and a mint fills the sku cell', () => {
  const ledger = new InMemorySkuLedgerRepository();
  const result = applySkuMint(
    mintArgs([{ row: 2, cells: { identifier: 'CUSTOM-9', name: 'Jar' } }], { ledger }),
  );
  expect(result.findings).toEqual([]);
  expect(ledger.holder(ISSUER, 'manufacturer_sku', 'CUSTOM-9')).not.toBeNull();
});

it('never replaces an existing assignment id — replacing would fork the product', () => {
  const ledger = new InMemorySkuLedgerRepository();
  const rows: DraftRow[] = [{ row: 2, cells: { sku: 'P-9999', name: 'Jar' }, assignmentId: 'asg_prior' }];
  const result = applySkuMint(mintArgs(rows, { ledger }));
  expect(result.rows[0]?.assignmentId).toBe('asg_prior');
});
