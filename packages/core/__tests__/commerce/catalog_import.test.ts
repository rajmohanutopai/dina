/**
 * WS-5.2 — supplier catalog import (§12.1, FR-S2, FR-S3).
 *
 * The property under test is mostly ONE property, stated many ways: a bad row
 * is never dropped. A catalog snapshot is full state (§10.2), so a partial
 * import publishes a catalog that silently omits products — buyers do not see
 * an error, they see a supplier who does not stock the thing. Every case below
 * is a way a lenient importer would have quietly lost a row.
 */

import { importCatalogCsv } from '../../src/commerce/catalog_import';
import { buildCatalogSnapshot } from '../../src/commerce/catalog_publisher';

import { hash } from './helpers';

const SUPPLIER = 'did:plc:chairmaker99';
const HEADER = 'sku,name,unit_code,pack_size,lead_time_days';

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

describe('importing a supplier spreadsheet', () => {
  it('turns an ordinary export into catalog items', () => {
    const result = importCatalogCsv({
      csv: csv('CHAIR-1,Oak dining chair,each,1,14', 'CHAIR-2,Ash dining chair,each,1,21'),
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.findings));
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual({
      // A CSV `sku` is a protocol `manufacturer_sku` SCOPED to the supplier —
      // two suppliers may both call something CHAIR-1.
      product: { scheme: 'manufacturer_sku', value: 'CHAIR-1', issuer_did: SUPPLIER },
      sku: 'CHAIR-1',
      name: 'Oak dining chair',
      unit_code: 'each',
      pack_size: '1',
      lead_time_days: 14,
    });
  });

  it('handles quoted fields, commas inside them, and doubled quotes', () => {
    const result = importCatalogCsv({
      csv: 'sku,name,description\nC-1,"Chair, oak","He said ""solid"" oak"',
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.findings));
    expect(result.items[0]?.name).toBe('Chair, oak');
    expect(result.items[0]?.description).toBe('He said "solid" oak');
  });

  it('accepts a variant whose parent appears LATER in the file', () => {
    // Refusing on row order would be an accident of how the supplier sorted
    // their spreadsheet, not a fact about their catalog.
    const result = importCatalogCsv({
      csv: 'sku,name,variant_of\nCHAIR-1-OAK,Oak,CHAIR-1\nCHAIR-1,Chair,',
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(result.ok).toBe(true);
  });
});

describe('a bad row is never dropped', () => {
  /**
   * The single most important assertion in this file. A lenient importer
   * returns two items and a warning; this one returns nothing, because two
   * items would be published as a COMPLETE catalog.
   */
  it('yields NO items when any row is bad, not the rows that parsed', () => {
    const result = importCatalogCsv({
      csv: csv('CHAIR-1,Oak,each,1,14', 'CHAIR-2,Ash,furlong,1,21', 'CHAIR-3,Elm,each,1,7'),
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a bad row was tolerated');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ refusal: 'unknown_unit', row: 3 });
    expect('items' in result).toBe(false);
  });

  it('numbers rows the way the supplier sees them, header first', () => {
    // A finding that says "row 2" about the third line of a file is a finding
    // the supplier cannot act on.
    const result = importCatalogCsv({
      csv: csv('CHAIR-1,Oak,each,1,14', 'CHAIR-2,Ash,each,1,notanumber'),
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(!result.ok && result.findings[0]).toMatchObject({
      refusal: 'bad_integer',
      row: 3,
      column: 'lead_time_days',
    });
  });

  it('reports an unknown COLUMN rather than ignoring it', () => {
    // A column silently dropped is a column the supplier believes they
    // published — and `internal_cost` would then reach the leakage gate as a
    // surprise rather than as something they were told about here.
    const result = importCatalogCsv({
      csv: 'sku,internal_cost\nC-1,4200',
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.findings[0]).toMatchObject({
      refusal: 'unknown_column',
      row: 1,
      column: 'internal_cost',
    });
  });
});

describe('identity and vocabulary (§9.2, §9.3, §9.4)', () => {
  it('refuses two rows claiming one identity rather than merging them', () => {
    // §9.4: identity is never merged. Which of the two is the product is a
    // question only the supplier can answer.
    const result = importCatalogCsv({
      csv: csv('CHAIR-1,Oak,each,1,14', 'CHAIR-1,Oak (old),each,1,14'),
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(!result.ok && result.findings[0]).toMatchObject({
      refusal: 'duplicate_identifier',
      row: 3,
    });
    expect(!result.ok && result.findings[0]?.detail).toContain('row 2');
  });

  it('refuses a unit outside the closed v1 vocabulary', () => {
    // Owner decision (§27 Q4): the vocabulary is closed. An unknown unit
    // publishes a catalog nobody can price against.
    for (const unit of ['furlong', 'dozen', 'kilogram']) {
      expect(
        importCatalogCsv({
          csv: csv(`C-1,Chair,${unit},1,14`),
          defaultScheme: 'sku',
          supplierDid: SUPPLIER,
        }).ok,
      ).toBe(false);
    }
  });

  it('trims whitespace but does NOT fold case', () => {
    // Two different judgements, and the difference is not fussiness. A
    // trailing space is a spreadsheet artefact and refusing it would be
    // hostile for no safety gain. Case is part of the code: a vocabulary that
    // folded case would have two spellings for one unit, and two spellings is
    // how two implementations come to disagree about what was ordered.
    expect(
      importCatalogCsv({
        csv: csv('C-1,Chair, each ,1,14'),
        defaultScheme: 'sku',
        supplierDid: SUPPLIER,
      }).ok,
    ).toBe(true);
    expect(
      importCatalogCsv({
        csv: csv('C-1,Chair,EACH,1,14'),
        defaultScheme: 'sku',
        supplierDid: SUPPLIER,
      }).ok,
    ).toBe(false);
  });

  it('refuses a quantity with more precision than its unit allows', () => {
    // `each` has scale 0. A fractional count would round somewhere later, and
    // "somewhere later" is how two implementations disagree about how much was
    // ordered.
    expect(
      importCatalogCsv({
        csv: csv('C-1,Chair,each,1.5,14'),
        defaultScheme: 'sku',
        supplierDid: SUPPLIER,
      }).ok,
    ).toBe(false);
    // `kg` has scale 3, so three decimals are legal and four are not.
    expect(
      importCatalogCsv({
        csv: csv('C-1,Rope,kg,1.500,14'),
        defaultScheme: 'sku',
        supplierDid: SUPPLIER,
      }).ok,
    ).toBe(true);
    expect(
      importCatalogCsv({
        csv: csv('C-1,Rope,kg,1.5001,14'),
        defaultScheme: 'sku',
        supplierDid: SUPPLIER,
      }).ok,
    ).toBe(false);
  });

  it('refuses a variant pointing at a product no row declares', () => {
    const result = importCatalogCsv({
      csv: 'sku,name,variant_of\nCHAIR-1-OAK,Oak,CHAIR-NOPE',
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(!result.ok && result.findings[0]?.refusal).toBe('unknown_variant_parent');
  });

  it('refuses a scheme it cannot import', () => {
    const result = importCatalogCsv({
      csv: 'scheme,identifier,name\nean13,5012345678900,Chair',
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(!result.ok && result.findings[0]?.refusal).toBe('unknown_scheme');
  });

  it('refuses a row with no identifier at all', () => {
    const result = importCatalogCsv({
      csv: csv(',Oak,each,1,14'),
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(!result.ok && result.findings[0]?.refusal).toBe('missing_required');
  });
});

describe('malformed files', () => {
  it('refuses a file with only a header', () => {
    expect(importCatalogCsv({ csv: HEADER, defaultScheme: 'sku', supplierDid: SUPPLIER }).ok).toBe(
      false,
    );
  });

  it('refuses a row that ends inside a quote', () => {
    const result = importCatalogCsv({
      csv: 'sku,name\nC-1,"Chair, oak',
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(!result.ok && result.findings[0]?.refusal).toBe('malformed_csv');
  });
});

/**
 * Import and publication are SEPARATE, and the leakage gate has exactly one
 * home. These assertions are about that division, not about either rule.
 */
describe('import feeds publication without duplicating its gate', () => {
  it('an imported catalog publishes', () => {
    const imported = importCatalogCsv({
      csv: csv('CHAIR-1,Oak dining chair,each,1,14'),
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error(JSON.stringify(imported.findings));

    const published = buildCatalogSnapshot({
      supplierDid: 'did:plc:chairmaker99',
      catalogId: 'chairmaker-main',
      protocolVersion: '1.0',
      publishedAt: '2026-08-08T10:00:00.000Z',
      items: imported.items,
      previous: null,
      sha256: hash,
    });
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error(JSON.stringify(published));
    expect(published.snapshot?.item_count).toBe(1);
  });

  it('the importer does NOT check for leakage — the publisher does', () => {
    // Two gates for one rule is two places to drift. The importer's closed
    // COLUMN list already refuses an unknown header, so a secret arriving in
    // a KNOWN column is the case that must fall through to the publisher.
    const imported = importCatalogCsv({
      csv: 'sku,description\nC-1,api_key = sk-live-abcdefghijklmnop1234',
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    // The import itself is structurally fine: `description` is a real column.
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error('unreachable');

    // And the publisher refuses it, which is where that rule lives.
    const published = buildCatalogSnapshot({
      supplierDid: 'did:plc:chairmaker99',
      catalogId: 'chairmaker-main',
      protocolVersion: '1.0',
      publishedAt: '2026-08-08T10:00:00.000Z',
      items: imported.items,
      previous: null,
      sha256: hash,
    });
    expect(published.ok).toBe(false);
    expect(!published.ok && published.refusal).toBe('leakage_refused');
  });
});
