/**
 * Catalog connectors (§6.3, §6.5, §24 — WS-9.1).
 *
 * §24's acceptance is "connector replacement does not change capability
 * semantics", and the first suite below is that sentence written as a test:
 * the same catalog, served two ways, must produce the same items and the same
 * refusals. It is written against EQUIVALENT-NOT-IDENTICAL inputs on purpose —
 * a CSV and a JSON feed carrying the same data — because a test that fed both
 * connectors the same bytes would prove only that one function is
 * deterministic.
 */

import {
  classifyConnectorChange,
  loadCatalogThroughConnector,
  type ConnectorSpec,
} from '../../src/commerce/connectors';
import { CredentialBroker, type BrokeredExecutor } from '../../src/commerce/credential_broker';
import { InMemoryCredentialStore } from '../../src/commerce/credential_store';

import type { CatalogImport } from '../../src/commerce/catalog_import';

const SUPPLIER = 'did:plc:chairmaker';

const CSV = [
  'sku,name,unit_code,pack_size,list_price_minor_units,currency',
  'CHAIR-1,Oak chair,each,1,4500,EUR',
  'CHAIR-2,Ash chair,each,4,3900,EUR',
].join('\n');

const JSON_ROWS = [
  {
    sku: 'CHAIR-1',
    name: 'Oak chair',
    unit_code: 'each',
    pack_size: '1',
    list_price_minor_units: '4500',
    currency: 'EUR',
  },
  {
    sku: 'CHAIR-2',
    name: 'Ash chair',
    unit_code: 'each',
    pack_size: '4',
    list_price_minor_units: '3900',
    currency: 'EUR',
  },
];

function brokerServing(result: unknown, operation = 'read_catalog'): CredentialBroker {
  const store = new InMemoryCredentialStore();
  store.rotate({
    resource: 'catalog.source',
    installId: 'install-1',
    operations: [operation],
    material: 'sk-live-catalog-source-0123456789',
    nowMs: 1_000,
  });
  const executor: BrokeredExecutor = async () => ({ ok: true, result });
  return new CredentialBroker({
    store,
    executors: () => ({ [`catalog.source:${operation}`]: executor }),
  });
}

/**
 * Load through a connector and assert it got as far as reading rows.
 *
 * The comparisons below used to be written `expect(a.ok && a.import).toEqual(b.ok && b.import)`,
 * which passes when BOTH sides are `false` — two connectors that each failed to
 * reach their backend would have read as agreeing. Unwrapping here means a
 * comparison can only compare two real imports.
 */
async function mustLoad(
  args: Parameters<typeof loadCatalogThroughConnector>[0],
): Promise<CatalogImport> {
  const result = await loadCatalogThroughConnector(args);
  if (!result.ok) {
    throw new Error(`connector refused before reading rows: ${result.refusal} ${result.error}`);
  }
  return result.import;
}

const REST_SPEC: ConnectorSpec = {
  kind: 'rest',
  credentialResource: 'catalog.source',
  operation: 'read_catalog',
};
const URL_SPEC: ConnectorSpec = {
  kind: 'spreadsheet_url',
  credentialResource: 'catalog.source',
  operation: 'read_catalog',
};
const UPLOAD_SPEC: ConnectorSpec = {
  kind: 'spreadsheet_upload',
  credentialResource: null,
  operation: 'read_catalog',
};

describe('connector replacement does not change capability semantics (§24)', () => {
  it('a spreadsheet upload and a REST feed produce the same catalog', async () => {
    const upload = await mustLoad({
      spec: UPLOAD_SPEC,
      installId: 'install-1',
      document: CSV,
      broker: null,
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    const rest = await mustLoad({
      spec: REST_SPEC,
      installId: 'install-1',
      broker: brokerServing(JSON_ROWS),
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });

    expect(rest).toEqual(upload);
    // And the catalog is what the supplier meant, not merely equal to itself:
    // asserted OUTSIDE a narrowing branch, because a conditional assertion is
    // an assertion that stops running the day the condition turns false.
    expect(upload.ok).toBe(true);
    expect(upload.ok && upload.items).toHaveLength(2);
    expect(upload.ok && upload.items[0]?.product).toEqual({
      scheme: 'manufacturer_sku',
      value: 'CHAIR-1',
      issuer_did: SUPPLIER,
    });
  });

  it('a hosted spreadsheet is read the same way as an uploaded one', async () => {
    const hosted = await mustLoad({
      spec: URL_SPEC,
      installId: 'install-1',
      broker: brokerServing(CSV),
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    const upload = await mustLoad({
      spec: UPLOAD_SPEC,
      installId: 'install-1',
      document: CSV,
      broker: null,
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(hosted).toEqual(upload);
    expect(upload.ok).toBe(true);
  });

  it('refuses the same rows whichever connector produced them', async () => {
    // §9.4 — two rows claiming one identity, and the same duplicate expressed
    // in JSON. Both must refuse, and neither may import the half that parsed.
    const duplicateCsv = [
      'sku,name,unit_code',
      'CHAIR-1,Oak chair,each',
      'CHAIR-1,Oak chair again,each',
    ].join('\n');
    const duplicateRows = [
      { sku: 'CHAIR-1', name: 'Oak chair', unit_code: 'each' },
      { sku: 'CHAIR-1', name: 'Oak chair again', unit_code: 'each' },
    ];

    const fromCsv = await mustLoad({
      spec: UPLOAD_SPEC,
      installId: 'install-1',
      document: duplicateCsv,
      broker: null,
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    const fromRest = await mustLoad({
      spec: REST_SPEC,
      installId: 'install-1',
      broker: brokerServing(duplicateRows),
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });

    expect(fromCsv.ok).toBe(false);
    expect(fromRest).toEqual(fromCsv);
    expect(fromCsv.ok || fromCsv.findings).toEqual([
      {
        refusal: 'duplicate_identifier',
        // Row 3 in both: a JSON feed numbers its rows the way a spreadsheet
        // does, so a supplier reading a finding need not know which connector
        // produced it.
        row: 3,
        detail: 'sku:CHAIR-1 already appears on row 2',
      },
    ]);
  });

  it('refuses an out-of-vocabulary unit identically on both sides', async () => {
    const badCsv = ['sku,name,unit_code', 'CHAIR-1,Oak chair,FURLONG'].join('\n');
    const badRows = [{ sku: 'CHAIR-1', name: 'Oak chair', unit_code: 'FURLONG' }];

    const fromCsv = await mustLoad({
      spec: UPLOAD_SPEC,
      installId: 'install-1',
      document: badCsv,
      broker: null,
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    const fromRest = await mustLoad({
      spec: REST_SPEC,
      installId: 'install-1',
      broker: brokerServing(badRows),
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(fromRest).toEqual(fromCsv);
    expect(fromCsv.ok).toBe(false);
    expect(fromCsv.ok || fromCsv.findings[0]?.refusal).toBe('unknown_unit');
  });

  it('reads a JSON number the way the CSV column reads its text', async () => {
    // `1.50` as a JSON NUMBER is `1.5`, which is a different quantity in a unit
    // that allows two fraction digits. Stringifying rather than coercing is
    // what keeps the two connectors saying the same thing.
    const rows = [{ sku: 'CHAIR-1', unit_code: 'kg', pack_size: 1.5 }];
    const csv = ['sku,unit_code,pack_size', 'CHAIR-1,kg,1.5'].join('\n');

    const fromRest = await mustLoad({
      spec: REST_SPEC,
      installId: 'install-1',
      broker: brokerServing(rows),
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    const fromCsv = await mustLoad({
      spec: UPLOAD_SPEC,
      installId: 'install-1',
      document: csv,
      broker: null,
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(fromRest).toEqual(fromCsv);
    expect(fromCsv.ok).toBe(true);
    expect(fromCsv.ok && fromCsv.items[0]?.pack_size).toBe('1.5');
  });

  it('reads a nested JSON value as absent rather than as [object Object]', async () => {
    // A localised name (`{en: "Oak chair"}`) is the shape that would otherwise
    // become the literal string `[object Object]` and be published as the
    // product's name — or, on an identifier column, as its identity.
    const nested = await mustLoad({
      spec: REST_SPEC,
      installId: 'install-1',
      broker: brokerServing([{ sku: 'CHAIR-1', name: { en: 'Oak chair' }, unit_code: 'each' }]),
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(nested.ok).toBe(true);
    expect(nested.ok && nested.items[0]?.name).toBeUndefined();
    expect(JSON.stringify(nested)).not.toContain('object Object');
  });

  it('refuses a row whose IDENTIFIER is a nested value', async () => {
    // Absent, not stringified — so the row has no identifier and the import
    // refuses rather than publishing a product called `[object Object]`.
    const result = await mustLoad({
      spec: REST_SPEC,
      installId: 'install-1',
      broker: brokerServing([{ sku: { value: 'CHAIR-1' }, unit_code: 'each' }]),
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(result.ok).toBe(false);
    expect(result.ok || result.findings[0]?.refusal).toBe('missing_required');
  });

  it('accepts a REST feed that wraps its rows in {items}', async () => {
    const wrapped = await mustLoad({
      spec: REST_SPEC,
      installId: 'install-1',
      broker: brokerServing({ items: JSON_ROWS }),
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    const bare = await mustLoad({
      spec: REST_SPEC,
      installId: 'install-1',
      broker: brokerServing(JSON_ROWS),
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(wrapped).toEqual(bare);
    expect(bare.ok).toBe(true);
  });
});

describe('a connector reads; it does not authenticate', () => {
  it('fails closed when the node has no broker', async () => {
    const result = await loadCatalogThroughConnector({
      spec: REST_SPEC,
      installId: 'install-1',
      broker: null,
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(result).toEqual({ ok: false, refusal: 'no_broker', error: expect.any(String) });
  });

  it('passes the broker refusal through rather than fetching anyway', async () => {
    const store = new InMemoryCredentialStore();
    store.rotate({
      resource: 'catalog.source',
      installId: 'someone-else',
      operations: ['read_catalog'],
      material: 'sk-live-catalog-source-0123456789',
      nowMs: 1_000,
    });
    const broker = new CredentialBroker({
      store,
      executors: () => ({
        'catalog.source:read_catalog': async () => ({ ok: true, result: JSON_ROWS }),
      }),
    });
    const result = await loadCatalogThroughConnector({
      spec: REST_SPEC,
      installId: 'install-1',
      broker,
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe('broker_refused');
      expect(result.error).toContain('install-1');
    }
  });

  it('sends nothing of its own to the backend', async () => {
    const store = new InMemoryCredentialStore();
    store.rotate({
      resource: 'catalog.source',
      installId: 'install-1',
      operations: ['read_catalog'],
      material: 'sk-live-catalog-source-0123456789',
      nowMs: 1_000,
    });
    let seenParams: unknown = 'never called';
    const broker = new CredentialBroker({
      store,
      executors: () => ({
        'catalog.source:read_catalog': async ({ params }) => {
          seenParams = params;
          return { ok: true, result: JSON_ROWS };
        },
      }),
    });
    await loadCatalogThroughConnector({
      spec: REST_SPEC,
      installId: 'install-1',
      broker,
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    // No caller-supplied field means no field for a token to hide in.
    expect(seenParams).toEqual({});
  });

  it('refuses an upload with no file rather than reporting a bad header', async () => {
    const result = await loadCatalogThroughConnector({
      spec: UPLOAD_SPEC,
      installId: 'install-1',
      broker: null,
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('no_document');
  });

  it('refuses a REST answer that is not a list of rows', async () => {
    for (const answer of [42, 'text', { rows: [] }, [1, 2, 3], [[]]]) {
      const result = await loadCatalogThroughConnector({
        spec: REST_SPEC,
        installId: 'install-1',
        broker: brokerServing(answer),
        defaultScheme: 'sku',
        supplierDid: SUPPLIER,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toBe('not_a_row_list');
    }
  });

  it('refuses a spreadsheet backend that answered with JSON', async () => {
    const result = await loadCatalogThroughConnector({
      spec: URL_SPEC,
      installId: 'install-1',
      broker: brokerServing(JSON_ROWS),
      defaultScheme: 'sku',
      supplierDid: SUPPLIER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('not_a_row_list');
  });
});

describe('changing backend is a consent question (§6.5)', () => {
  const spreadsheet = {
    domains: [],
    credentialResources: [],
    operations: ['read_catalog'],
  };
  const erp = {
    domains: ['erp.example.com'],
    credentialResources: ['erp.primary'],
    operations: ['read_catalog', 'submit_purchase_order'],
  };

  it('moving from a spreadsheet to an ERP needs re-consent, and says what widened', () => {
    const verdict = classifyConnectorChange(spreadsheet, erp);
    expect(verdict).toEqual({
      kind: 'requires_reconsent',
      widened: {
        domains: ['erp.example.com'],
        credentialResources: ['erp.primary'],
        operations: ['submit_purchase_order'],
      },
    });
  });

  it('each of the three fields alone is enough to require re-consent', () => {
    expect(
      classifyConnectorChange(spreadsheet, { ...spreadsheet, domains: ['a.example.com'] }).kind,
    ).toBe('requires_reconsent');
    expect(
      classifyConnectorChange(spreadsheet, {
        ...spreadsheet,
        credentialResources: ['erp.primary'],
      }).kind,
    ).toBe('requires_reconsent');
    expect(
      classifyConnectorChange(spreadsheet, {
        ...spreadsheet,
        operations: ['read_catalog', 'delete_everything'],
      }).kind,
    ).toBe('requires_reconsent');
  });

  it('narrowing is an ordinary edit — an owner may always give less', () => {
    expect(classifyConnectorChange(erp, spreadsheet)).toEqual({ kind: 'ordinary_edit' });
  });

  it('swapping one host for another at equal breadth still widens', () => {
    // A DIFFERENT host is a host the owner did not consent to, even though the
    // count is unchanged. Comparing lengths rather than membership is the
    // mistake this pins.
    const verdict = classifyConnectorChange(erp, { ...erp, domains: ['other.example.com'] });
    expect(verdict).toEqual({
      kind: 'requires_reconsent',
      widened: { domains: ['other.example.com'], credentialResources: [], operations: [] },
    });
  });

  it('reordering or repeating a declaration is not a widening', () => {
    expect(
      classifyConnectorChange(erp, {
        domains: ['erp.example.com', 'erp.example.com'],
        credentialResources: ['erp.primary'],
        operations: ['submit_purchase_order', 'read_catalog'],
      }),
    ).toEqual({ kind: 'ordinary_edit' });
  });
});
