/**
 * Subject-type auto-detect tests (TN-MOB-023).
 *
 * Pins the priority-order rules from plan §8.5 + the URL heuristics
 * mobile owns:
 *
 *   - DID prefix wins over everything (an `did:plc:abc` text is never
 *     interpreted as a product identifier just because of length).
 *   - Identifier parser only applies to non-URL input — a product URL
 *     containing an ASIN segment is classified by the URL host/path,
 *     NOT by the embedded identifier (catches a real order-of-rule
 *     bug where the parser would otherwise fire on the path slug).
 *   - Empty / whitespace / unrecognised → null (caller picker).
 *   - Mobile owns its commerce-host list — assertions cover the
 *     curated entries + suffix matching for subdomains.
 *
 * Pure function — runs under plain Jest, no RN deps, no network.
 */

import {
  detectSubjectType,
  type SubjectTypeDetection,
} from '../../src/trust/subject_type_detect';

function expectMatch(
  result: SubjectTypeDetection | null,
  expected: Pick<SubjectTypeDetection, 'type' | 'rule'>,
): void {
  expect(result).not.toBeNull();
  expect(result?.type).toBe(expected.type);
  expect(result?.rule).toBe(expected.rule);
}

// ─── Null / no-match paths ────────────────────────────────────────────────

describe('detectSubjectType — null paths', () => {
  it('returns null on empty / whitespace input', () => {
    expect(detectSubjectType('')).toBeNull();
    expect(detectSubjectType('   ')).toBeNull();
    expect(detectSubjectType('\n\t')).toBeNull();
  });

  it('returns null on free-text that matches no rule', () => {
    expect(detectSubjectType('Hello world')).toBeNull();
    expect(detectSubjectType('the quick brown fox')).toBeNull();
    expect(detectSubjectType('1234567')).toBeNull(); // 7 digits — not ISBN-10/13, not EAN, not UPC
  });

  it('returns null on non-string input (defensive)', () => {
    // @ts-expect-error — runtime guard for callers that ignore TS
    expect(detectSubjectType(undefined)).toBeNull();
    // @ts-expect-error — runtime guard for null at the boundary
    expect(detectSubjectType(null)).toBeNull();
    // @ts-expect-error — runtime guard for numeric input bug
    expect(detectSubjectType(42)).toBeNull();
  });
});

// ─── Rule 1: DID prefix ───────────────────────────────────────────────────

describe('detectSubjectType — DID prefix', () => {
  it('did:plc:… → did', () => {
    expectMatch(detectSubjectType('did:plc:abc123'), { type: 'did', rule: 'did_prefix' });
  });

  it('did:web:… → did', () => {
    expectMatch(detectSubjectType('did:web:example.com'), {
      type: 'did',
      rule: 'did_prefix',
    });
  });

  it('does NOT match "did" without the colon-method shape', () => {
    expect(detectSubjectType('did')).toBeNull();
    expect(detectSubjectType('did:plc')).toBeNull(); // no method-specific id
    expect(detectSubjectType('did:')).toBeNull();
  });

  it('strips leading whitespace before matching', () => {
    expectMatch(detectSubjectType('  did:plc:abc  '), {
      type: 'did',
      rule: 'did_prefix',
    });
  });
});

// ─── Rule 2: product identifiers (ASIN / ISBN / EAN / UPC) ────────────────

describe('detectSubjectType — product identifiers', () => {
  it('valid ASIN → product (10 alnum, has letter+digit mix)', () => {
    expectMatch(detectSubjectType('B0CHX1W1XY'), {
      type: 'product',
      rule: 'product_identifier',
    });
  });

  it('ISBN-10 with valid mod-11 checksum → product', () => {
    // The C Programming Language, 2nd ed.
    expectMatch(detectSubjectType('0131103628'), {
      type: 'product',
      rule: 'product_identifier',
    });
  });

  it('ISBN-13 with valid checksum → product', () => {
    // 978-0-13-110362-7 → 9780131103627
    expectMatch(detectSubjectType('9780131103627'), {
      type: 'product',
      rule: 'product_identifier',
    });
  });
});

// ─── Rule 3: academic identifiers (DOI / arxiv) ───────────────────────────

describe('detectSubjectType — academic identifiers', () => {
  it('DOI → content', () => {
    expectMatch(detectSubjectType('10.1145/3597503.3623306'), {
      type: 'content',
      rule: 'doi_arxiv',
    });
  });

  it('arxiv (modern format) → content', () => {
    expectMatch(detectSubjectType('2401.00001'), {
      type: 'content',
      rule: 'doi_arxiv',
    });
  });
});

// ─── Rule 4: Place ID ─────────────────────────────────────────────────────

describe('detectSubjectType — Place ID', () => {
  it('Google Place ID (ChIJ stem) → place', () => {
    expectMatch(detectSubjectType('ChIJN1t_tDeuEmsRUsoyG83frY4'), {
      type: 'place',
      rule: 'place_id',
    });
  });
});

// ─── Rules 5–7: URL paths ─────────────────────────────────────────────────

describe('detectSubjectType — commerce URL', () => {
  it('amazon.com → product (commerce_url, host match)', () => {
    expectMatch(detectSubjectType('https://www.amazon.com/dp/B07ZPC9QD4'), {
      type: 'product',
      rule: 'commerce_url',
    });
  });

  it('amazon.co.uk subdomain → product (suffix match)', () => {
    expectMatch(detectSubjectType('https://smile.amazon.co.uk/dp/B07ZPC9QD4'), {
      type: 'product',
      rule: 'commerce_url',
    });
  });

  it('ebay listing → product', () => {
    expectMatch(detectSubjectType('https://www.ebay.com/itm/123456789'), {
      type: 'product',
      rule: 'commerce_url',
    });
  });

  it('etsy listing → product', () => {
    expectMatch(detectSubjectType('https://www.etsy.com/listing/12345/handmade-thing'), {
      type: 'product',
      rule: 'commerce_url',
    });
  });

  it('shopify-pattern /products/ on an unknown host → product (path-only signal)', () => {
    expectMatch(detectSubjectType('https://shop.example.com/products/widget'), {
      type: 'product',
      rule: 'commerce_url',
    });
  });

  it('walmart /ip/ pattern → product', () => {
    expectMatch(detectSubjectType('https://www.walmart.com/ip/12345'), {
      type: 'product',
      rule: 'commerce_url',
    });
  });
});

describe('detectSubjectType — maps URL', () => {
  it('maps.google.com → place', () => {
    expectMatch(detectSubjectType('https://maps.google.com/?q=Castro+Station'), {
      type: 'place',
      rule: 'maps_url',
    });
  });

  it('maps.app.goo.gl (Google Maps shortener) → place', () => {
    expectMatch(detectSubjectType('https://maps.app.goo.gl/abc123'), {
      type: 'place',
      rule: 'maps_url',
    });
  });

  it('maps.apple.com → place', () => {
    expectMatch(detectSubjectType('https://maps.apple.com/?ll=37.762,-122.435'), {
      type: 'place',
      rule: 'maps_url',
    });
  });

  it('plain goo.gl shortener does NOT match place — host alone is too broad', () => {
    // Regression guard: an earlier draft had `goo.gl` in the maps
    // host suffix list, which would have classified every goo.gl
    // shortener (most of which are NOT maps links) as a place.
    const result = detectSubjectType('https://goo.gl/abc123');
    expect(result?.rule).not.toBe('maps_url');
    expect(result?.type).not.toBe('place');
  });
});

describe('detectSubjectType — generic URL', () => {
  it('generic content URL → content', () => {
    expectMatch(detectSubjectType('https://en.wikipedia.org/wiki/Trust'), {
      type: 'content',
      rule: 'url',
    });
  });

  it('non-http(s) scheme is NOT classified (mailto:, data:, etc.)', () => {
    expect(detectSubjectType('mailto:foo@bar.com')).toBeNull();
    expect(detectSubjectType('javascript:alert(1)')).toBeNull(); // not even called as a URL
  });
});

// ─── Rule-priority regression guards ──────────────────────────────────────

describe('detectSubjectType — rule priority', () => {
  it('a product URL containing an ASIN-like path slug is classified by the URL, not by the embedded identifier', () => {
    // The path `/dp/B0CHX1W1XY` contains a valid ASIN as a segment.
    // The order-of-rules contract says: URLs go through the URL
    // classifier, not the identifier parser. A bug that ran the
    // parser first would still produce `product` here (lucky), but
    // the `rule` would be `product_identifier` — which is the wrong
    // signal for analytics + UX feedback.
    const result = detectSubjectType('https://www.amazon.com/dp/B0CHX1W1XY');
    expect(result?.type).toBe('product');
    expect(result?.rule).toBe('commerce_url'); // NOT 'product_identifier'
  });

  it('a DID-shaped string starting with did: wins over everything else', () => {
    // Even though did:plc:foo could conceivably be parsed as
    // something else by a future parser, the DID prefix rule is
    // first and locks the classification.
    expectMatch(detectSubjectType('did:plc:foo'), { type: 'did', rule: 'did_prefix' });
  });
});
