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

/**
 * §12.1 step 10 — the structured-identifier half of the value scan (DR-4).
 *
 * The spec asks for BOTH halves: "the existing structured-identifier PII
 * patterns (phone, email, account and ID number shapes) PLUS a
 * secret-shaped-token detector". Only the token detector was built. The
 * patterns were already in Core, running on the egress path, so nothing looked
 * absent — the gap was one import.
 */
describe('structured-identifier scan (§12.1 step 10)', () => {
  const dirty = (item: Record<string, unknown>) => gateCatalogForPublication([item]);

  it.each([
    ['email', 'questions to raj.mohan@example.com'],
    ['phone', 'call 98765 43210 to order'],
    ['card number', 'legacy ref 4111 1111 1111 1111'],
    ['aadhaar', 'ref 2345 6789 0123'],
    ['pan', 'billing under ABCDE1234F'],
    ['ifsc', 'remit to HDFC0001234'],
  ])('refuses a %s left in a free-text field', (_label, text) => {
    const verdict = dirty({ sku: 'C-1', description: text });

    expect(verdict.clean).toBe(false);
    expect(verdict.findings[0]?.refusal).toBe('personal_identifier_value');
    expect(verdict.findings[0]?.path).toBe('items[0].description');
  });

  it('NEVER echoes the identifier it found', () => {
    // Same rule as the secret scan: the finding names the field and the shape.
    // A refusal that quoted the phone number would copy it into the log.
    const verdict = dirty({ sku: 'C-1', description: 'call 98765 43210' });

    expect(JSON.stringify(verdict)).not.toContain('98765');
    expect(JSON.stringify(verdict)).not.toContain('43210');
  });

  it('reports one finding per TYPE per field, not one per occurrence', () => {
    // Three emails in a description is one problem to fix, and listing it
    // three times pushes other findings past the reporting cap.
    const verdict = dirty({
      sku: 'C-1',
      description: 'a@example.com then b@example.com then c@example.com',
    });

    expect(verdict.findings.filter((f) => f.refusal === 'personal_identifier_value')).toHaveLength(
      1,
    );
  });

  it('does not refuse an ordinary GTIN in the identity field', () => {
    // The false positive that drove the identifier-field rule: the US phone
    // pattern is not start-anchored, so it finds a ten-digit window inside any
    // longer digit run, and a GTIN-14 is exactly that.
    const verdict = gateCatalogForPublication([
      { sku: 'C-1', product: { scheme: 'gtin', value: '09506000134352' } },
    ]);

    expect(verdict.clean).toBe(true);
  });

  it('does not refuse a ten-digit MPN, which is the collision the rule exists for', () => {
    // The unanchored US phone pattern reads any ten-digit run as a phone.
    const verdict = gateCatalogForPublication([{ mpn: '9876543210' }]);
    expect(verdict.clean).toBe(true);
  });

  it('does not refuse a LUHN-VALID GTIN-13, which two of five real ones are', () => {
    // The over-correction this case exists for. `CREDIT_CARD` accepts 13-19
    // digits behind a Luhn check, a GTIN-13 is thirteen, and the two check
    // digits are computed on independent weightings — so about one honest GTIN
    // in ten passes Luhn. `5901234123457` is one of them. The module's own
    // fixture happens to fail Luhn, which is exactly why the suite stayed
    // green while a tenth of real catalogs would have been refused.
    const verdict = gateCatalogForPublication([
      { product: { scheme: 'gtin', value: '5901234123457' } },
      { product: { scheme: 'gtin', value: '4901234567894' } },
    ]);

    expect(verdict.clean).toBe(true);
  });

  it('does not refuse a valid UPC-A, which is twelve digits like an Aadhaar', () => {
    // The third collision in this rule, found by assuming the list was still
    // wrong rather than by trusting it. `712345678904` is a valid UPC-A
    // (number-system digit 7); the AADHAAR pattern is twelve digits and
    // rejects only leading 0 or 1, so every UPC-A from 2 to 9 was refused.
    const verdict = gateCatalogForPublication([
      { product: { scheme: 'gtin', value: '712345678904' } },
      { sku: '234567890128' },
    ]);

    expect(verdict.clean).toBe(true);
  });

  it('STILL refuses a SEPARATED Aadhaar in an identifier field', () => {
    // The separator is the only signal that tells the two apart, so it has to
    // be the thing the rule keys on — a product number is not written in
    // four-digit groups.
    const verdict = gateCatalogForPublication([{ sku: '2345 6789 0123' }]);

    expect(verdict.clean).toBe(false);
    expect(verdict.findings[0]?.refusal).toBe('personal_identifier_value');
  });

  it('REFUSES a card number hidden in a SKU column', () => {
    // This case asserted `clean` in my first attempt at the rule, which is the
    // finding: the exclusion list had grown past the collision that justified
    // it. A GTIN is 8, 12, 13 or 14 digits, so nothing honest reaches the
    // sixteen-digit account shape or survives a Luhn check by design.
    const verdict = gateCatalogForPublication([{ sku: '4111111111111111' }]);

    expect(verdict.clean).toBe(false);
    expect(verdict.findings[0]?.refusal).toBe('personal_identifier_value');
  });

  it('REFUSES a sixteen-digit bank account in an identifier field', () => {
    const verdict = gateCatalogForPublication([
      { sku: 'C-1', product: { scheme: 'custom', value: '1234567890123456' } },
    ]);

    expect(verdict.clean).toBe(false);
    expect(verdict.findings[0]?.refusal).toBe('personal_identifier_value');
  });

  it('STILL refuses an email in an identifier field', () => {
    // The narrowing is about digit runs. An `@` is not something a product
    // number contains by accident, so the structured classes survive there.
    const verdict = gateCatalogForPublication([{ sku: 'contact-raj@example.com' }]);

    expect(verdict.clean).toBe(false);
    expect(verdict.findings[0]?.refusal).toBe('personal_identifier_value');
  });

  it('does not refuse ordinary product prose', () => {
    const verdict = dirty({
      sku: 'C-1',
      name: 'Oak dining chair',
      description: 'Solid oak, 45 cm seat height, ships in 3 days from Kochi.',
    });

    expect(verdict.clean).toBe(true);
  });

  it('separates a credential from a personal identifier', () => {
    // Two refusal codes because they send an operator to different places:
    // one means rotate that key, the other means a person's details are in
    // your catalog export.
    const verdict = gateCatalogForPublication([
      { sku: 'C-1', description: 'sk-live-01234567890123456789' },
      { sku: 'C-2', description: 'reach us at raj@example.com' },
    ]);

    expect(verdict.findings.map((f) => f.refusal)).toEqual([
      'secret_shaped_value',
      'personal_identifier_value',
    ]);
  });
});

/**
 * NEW-18 — the two classes that cannot be measured, pinned in both directions.
 *
 * `PAN` and `IFSC` are the only remaining patterns that fire on a purely
 * alphanumeric uppercase product number, and unlike `PHONE`, `CREDIT_CARD` and
 * `AADHAAR` there is no boundary to derive: what they compete with is a
 * supplier-chosen `sku` or `mpn`, which has no length bound, no vocabulary and
 * no check digit. So the behaviour is a CHOICE, and a choice with no test is a
 * choice nobody can see. Both directions below, so a future reader who wants to
 * reverse it has to say which case they are changing.
 */
describe('the classes with no derivable boundary', () => {
  it('does not refuse an ordinary SKU that happens to be PAN-shaped', () => {
    // Measured, not assumed: `CHAIR2024B` is five letters, four digits, one
    // letter, which is the Indian tax-ID shape and also an unremarkable SKU.
    const verdict = gateCatalogForPublication([
      { sku: 'CHAIR2024B' },
      { sku: 'CHAIR2024B-01' },
    ]);

    expect(verdict.clean).toBe(true);
  });

  it('does not refuse an ordinary MPN that happens to be IFSC-shaped', () => {
    // Four letters, a zero, six alphanumerics — a manufacturer prefix and a
    // part number, and also a bank branch code.
    const verdict = gateCatalogForPublication([{ mpn: 'ACME012345X' }]);
    expect(verdict.clean).toBe(true);
  });

  it('STILL refuses a real PAN in a free-text field', () => {
    // The exclusion is scoped to product-number fields. Free text is where a
    // leaked contact block actually arrives, and it scans at full strength.
    const verdict = gateCatalogForPublication([
      { sku: 'C-1', description: 'invoice under ABCDE1234F' },
    ]);

    expect(verdict.clean).toBe(false);
    expect(verdict.findings[0]?.refusal).toBe('personal_identifier_value');
  });

  it('STILL refuses a real IFSC in a free-text field', () => {
    const verdict = gateCatalogForPublication([
      { sku: 'C-1', description: 'remit to HDFC0001234' },
    ]);

    expect(verdict.clean).toBe(false);
    expect(verdict.findings[0]?.refusal).toBe('personal_identifier_value');
  });

  it('keeps BANK_ACCT scanning in identifier fields, which has no such collision', () => {
    // Sixteen bare digits, and no product-code standard is sixteen. The
    // exclusion list is per-class, so this must not have drifted with them.
    const verdict = gateCatalogForPublication([{ sku: '1234567890123456' }]);

    expect(verdict.clean).toBe(false);
    expect(verdict.findings[0]?.refusal).toBe('personal_identifier_value');
  });
});

describe('§4.2 photo lanes: the identifier-column suppression is REMOVED', () => {
  // The lane doc's §7 bundled this with the SKU minting decision: the
  // collision excuse holds when a seller types their own SKU and fails when
  // a model reads digits off a photographed counter. Photo-derived drafts
  // scan sku/mpn/value like any other field.

  it('the named test: a phone-number-shaped sku is reported, not published', () => {
    const verdict = gateCatalogForPublication([{ sku: '9876543210' }], {
      scanIdentifierColumns: true,
    });
    expect(verdict.clean).toBe(false);
    expect(verdict.findings[0]).toMatchObject({
      refusal: 'personal_identifier_value',
      path: 'items[0].sku',
    });
  });

  it('a MINTED value never trips it — the P- shape carries no such digits', () => {
    const verdict = gateCatalogForPublication(
      [{ sku: 'P-0001' }, { sku: 'P-0417' }],
      { scanIdentifierColumns: true },
    );
    expect(verdict.clean).toBe(true);
  });

  it('typed-SKU lanes keep the suppression: the same value passes without the option', () => {
    // The asymmetry the original rule was built on still holds where a
    // seller typed the value themselves.
    const verdict = gateCatalogForPublication([{ sku: '9876543210' }]);
    expect(verdict.clean).toBe(true);
  });

  it('a genuinely printed part number that is not phone-shaped still publishes', () => {
    const verdict = gateCatalogForPublication([{ sku: 'CM-CHAIR-1' }, { mpn: 'MX41-B' }], {
      scanIdentifierColumns: true,
    });
    expect(verdict.clean).toBe(true);
  });
});
