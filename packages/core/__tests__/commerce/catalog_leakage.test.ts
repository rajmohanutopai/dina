/**
 * WS-5.3 — the publication leakage gate (§12.1, §23).
 *
 * The asymmetry that shapes these tests: a rejected order can be resubmitted
 * and a bad quote expires, but a catalog snapshot is published, indexed and
 * content-addressed. It does not un-publish. So a miss here is permanent
 * disclosure, and every case below is written as "what would a supplier
 * plausibly do that must not reach the wire".
 */

import { gateCatalogForPublication, findCatalogLeakage } from '../../src/commerce/catalog_leakage';
import { buildCatalogSnapshot } from '../../src/commerce/catalog_publisher';

import { hash } from './helpers';

const SUPPLIER = 'did:plc:chairmaker99';

describe('closed public-field vocabulary (§12.1)', () => {
  it('passes an ordinary product', () => {
    expect(
      gateCatalogForPublication([
        {
          sku: 'CHAIR-1',
          name: 'Oak dining chair',
          description: 'Solid oak, flat packed.',
          category: 'furniture/seating',
          unit_code: 'each',
          list_price: { currency: 'INR', minor_units: '450000' },
          lead_time_days: 14,
        },
      ]),
    ).toEqual({ clean: true, findings: [], truncated: 0 });
  });

  /**
   * The load-bearing half. These are refused because the vocabulary does not
   * KNOW them, not because a pattern recognised them — which is why the rule
   * survives a field name nobody has thought of yet.
   */
  it.each([
    ['internal_cost', { sku: 'C-1', internal_cost: 120000 }],
    ['supplier_notes', { sku: 'C-1', supplier_notes: 'margin is thin, do not discount' }],
    ['api_key', { sku: 'C-1', api_key: 'abc' }],
    ['erp_connection', { sku: 'C-1', erp_connection: { host: 'db.internal' } }],
    ['customer_list', { sku: 'C-1', customer_list: ['Sancho'] }],
  ])('refuses an item carrying %s', (field, item) => {
    const verdict = gateCatalogForPublication([item]);
    expect(verdict.clean).toBe(false);
    expect(verdict.findings[0]?.refusal).toBe('unknown_public_field');
    expect(verdict.findings[0]?.path).toBe(`items[0].${field}`);
  });

  it('names the field but NEVER echoes the value', () => {
    // An error message is written to a log, and a log is one more place a
    // secret can come to rest. The finding must be actionable without
    // repeating what it found.
    const secret = 'sk-live-01234567890123456789';
    const verdict = gateCatalogForPublication([{ sku: 'C-1', description: secret }]);
    expect(verdict.clean).toBe(false);
    expect(JSON.stringify(verdict)).not.toContain(secret);
    expect(JSON.stringify(verdict)).not.toContain('01234567890123456789');
  });

  it('refuses a forbidden field nested inside a permitted one', () => {
    // A closed vocabulary that only checked the top level would be trivially
    // defeated by nesting.
    const verdict = gateCatalogForPublication([
      { sku: 'C-1', product: { scheme: 'gtin', value: '09506000134352', cost_basis: 42 } },
    ]);
    expect(verdict.clean).toBe(false);
    expect(verdict.findings[0]?.path).toBe('items[0].product.cost_basis');
  });

  it('reports a refused subtree ONCE, not once per leaf', () => {
    // A supplier who pasted a whole ERP record in wants one line telling them
    // which column to remove, not forty.
    const verdict = gateCatalogForPublication([
      { sku: 'C-1', erp: { a: 1, b: 2, c: { d: 3, e: 4 } } },
    ]);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]?.path).toBe('items[0].erp');
  });

  it('reports every problem in one pass, so a fix is one edit', () => {
    const verdict = gateCatalogForPublication([{ sku: 'C-1', cost: 1, notes: 'x', margin: 2 }]);
    expect(verdict.findings.map((f) => f.path).sort()).toEqual([
      'items[0].cost',
      'items[0].margin',
      'items[0].notes',
    ]);
  });
});

describe('secret-shaped value detector (§12.1)', () => {
  /**
   * Rule 1 cannot catch these: every one sits in a field a catalog is
   * SUPPOSED to have. That is precisely why both rules exist.
   */
  it.each([
    ['vendor api key', 'Contact support with sk-live-abcdefghijklmnop1234'],
    ['github token', 'build token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
    ['slack token', 'notify via xoxb-1234567890-abcdefghijkl'],
    ['aws access key id', 'bucket user AKIAIOSFODNN7EXAMPLE'],
    ['jwt', 'session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'],
    ['pem block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n'],
    ['credentials in url', 'feed at https://admin:hunter2@erp.example.com/catalog'],
    ['labelled secret', 'internal note: password = correcthorsebattery'],
  ])('refuses a %s pasted into a permitted field', (_label, description) => {
    const verdict = gateCatalogForPublication([{ sku: 'C-1', description }]);
    expect(verdict.clean).toBe(false);
    expect(verdict.findings[0]?.refusal).toBe('secret_shaped_value');
    expect(verdict.findings[0]?.path).toBe('items[0].description');
  });

  it('does not refuse ordinary product prose', () => {
    // A gate that cried wolf on real catalogs would be turned off, and a gate
    // that is off protects nothing. These are the false positives that would
    // matter most.
    for (const description of [
      'Chair with a secret compartment under the seat.',
      'Token oak finish, price on application.',
      'Passwords to the workshop are not included, obviously.',
      'Model AKIA-12 chair, oak.',
      'Visit https://chairmaker.example.com/catalog for more.',
    ]) {
      expect(gateCatalogForPublication([{ sku: 'C-1', description }]).clean).toBe(true);
    }
  });

  it('checks values inside arrays and nested permitted objects', () => {
    expect(
      gateCatalogForPublication([
        { sku: 'C-1', regions: ['IN-KL', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'] },
      ]).clean,
    ).toBe(false);
  });
});

describe('structural limits', () => {
  it('refuses an item that is not an object', () => {
    for (const junk of ['a chair', 42, null, ['nested']]) {
      const verdict = gateCatalogForPublication([junk]);
      expect(verdict.clean).toBe(false);
      expect(verdict.findings[0]?.refusal).toBe('malformed_item');
    }
  });

  it('refuses a product nested deeper than a product should be', () => {
    // Past a few levels a "product" is a document, and a document is where
    // things hide.
    const deep = { product: { value: { value: { value: { value: { value: 'x' } } } } } };
    expect(findCatalogLeakage(deep).some((f) => f.refusal === 'malformed_item')).toBe(true);
  });

  it('caps the report and SAYS it capped', () => {
    // An operator who fixes what they were shown and republishes needs to
    // know whether they were shown everything.
    const items = Array.from({ length: 200 }, (_, i) => ({ sku: `C-${String(i)}`, bad: i }));
    const verdict = gateCatalogForPublication(items);
    expect(verdict.clean).toBe(false);
    expect(verdict.findings).toHaveLength(100);
    expect(verdict.truncated).toBe(100);
  });
});

/**
 * The gate lives INSIDE the publisher, not beside it.
 *
 * A gate a caller must remember to run is a gate that will be missed by
 * whichever caller is written next — and this codebase has produced that
 * failure repeatedly. These assertions are about reachability, not about the
 * rules, which the sections above already cover.
 */
describe('the publisher cannot be made to publish a leak', () => {
  function publish(items: readonly unknown[]) {
    return buildCatalogSnapshot({
      supplierDid: SUPPLIER,
      catalogId: 'chairmaker-main',
      protocolVersion: '1.0',
      publishedAt: '2026-08-08T10:00:00.000Z',
      items,
      previous: null,
      sha256: hash,
    });
  }

  it('refuses the publication and computes NO snapshot', () => {
    const result = publish([{ sku: 'C-1', internal_cost: 120000 }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('leakage_refused');
    // No digest, no pointer, no pages. A refused catalog must leave no
    // artefact a later caller could mistake for a publishable one.
    expect('snapshot' in result).toBe(false);
    expect('pages' in result).toBe(false);
    expect(result.leakage?.findings[0]?.path).toBe('items[0].internal_cost');
  });

  it('still publishes a clean catalog', () => {
    const result = publish([{ sku: 'C-1', name: 'Oak dining chair', unit_code: 'each' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.snapshot?.item_count).toBe(1);
  });

  it('refuses when ONE item in a large clean catalog is dirty', () => {
    // The realistic case: a thousand-row export where row 400 has a stray
    // column. A gate that sampled, or that stopped at the first page, would
    // publish it.
    const items: unknown[] = Array.from({ length: 600 }, (_, i) => ({ sku: `C-${String(i)}` }));
    items[400] = { sku: 'C-400', margin_pct: 32 };
    const result = publish(items);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusal).toBe('leakage_refused');
    expect(!result.ok && result.leakage?.findings[0]?.path).toBe('items[400].margin_pct');
  });
});
