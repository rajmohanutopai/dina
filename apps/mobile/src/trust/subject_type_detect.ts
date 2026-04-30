/**
 * Subject-type auto-detect for the compose flow (TN-MOB-023).
 *
 * Per plan §8.5 — when the user pastes / types into the "what are you
 * reviewing?" field, infer the canonical `SubjectType` from the input
 * shape so the compose form can pre-fill `SubjectRef.type` and skip
 * the 3-row chooser.
 *
 * Rules in priority order — first match wins, no later rule second-
 * guesses an earlier one. Order is what makes the function pure: the
 * same input always picks the same rule, no probabilistic ranking,
 * no LLM, no network round-trip.
 *
 *   1. `did:` prefix                        → did
 *   2. `parseIdentifier` matches a product
 *      identifier (asin/isbn/ean/upc)       → product
 *   3. `parseIdentifier` matches an academic
 *      identifier (doi / arxiv)             → content
 *   4. `parseIdentifier` matches a Place ID  → place
 *   5. URL with commerce signals
 *      (host or path)                       → product
 *   6. URL with maps signals                 → place
 *   7. URL otherwise                         → content
 *   8. else                                  → null  (caller shows
 *                                                     the 3-row chooser)
 *
 * Returns `null` rather than guessing a generic default so the
 * compose UI can disambiguate honestly. The user can always override;
 * we only lose if a confident-wrong guess steers them past a chooser
 * they would have used.
 *
 * Pure function, zero state, runs under plain Jest. The screen layer
 * (`apps/mobile/app/trust/write.tsx` once it lands) consumes this.
 *
 * Why not host the detection inside `@dina/protocol`'s identifier
 * parser? That parser is the cross-implementation contract — every
 * Dina-compatible runtime must agree byte-for-byte on what an ASIN
 * looks like. URL heuristics are mobile-UX, not wire-format: the
 * commerce-host list will drift over time as we tune what feels right
 * for users, and that drift must NOT bind every other implementation.
 * Mobile owns its own detection layer; AppView's enricher
 * (TN-ENRICH-001) does the same on the server side with its own
 * curated lists.
 */

import { parseIdentifier, type SubjectType } from '@dina/protocol';

// ─── Public types ─────────────────────────────────────────────────────────

/** Which detection rule fired. Useful for analytics + UX feedback. */
export type SubjectTypeRule =
  | 'did_prefix'
  | 'product_identifier'
  | 'doi_arxiv'
  | 'place_id'
  | 'commerce_url'
  | 'maps_url'
  | 'url';

export interface SubjectTypeDetection {
  readonly type: SubjectType;
  readonly rule: SubjectTypeRule;
}

// ─── Heuristic data ───────────────────────────────────────────────────────

/**
 * Hostnames whose presence in a URL flags it as a commerce listing.
 * Comparison is suffix-based on the registrable parent so e.g.
 * `www.amazon.com` and `smile.amazon.co.uk` both match. The list is
 * deliberately tiny — adding everything is the AppView enricher's
 * job (TN-ENRICH-001 with ~50 hosts); mobile only needs the long-tail
 * defaults that cover what a user is most likely to paste.
 *
 * Not exported: this is an implementation detail; downstream callers
 * should depend on the boolean classification, not the list.
 */
const COMMERCE_HOST_SUFFIXES: readonly string[] = Object.freeze([
  'amazon.com',
  'amazon.co.uk',
  'amazon.ca',
  'amazon.de',
  'amazon.fr',
  'amazon.in',
  'amazon.co.jp',
  'ebay.com',
  'ebay.co.uk',
  'walmart.com',
  'target.com',
  'bestbuy.com',
  'etsy.com',
  'aliexpress.com',
  'shopify.com',
]);

/**
 * URL pathname patterns that signal a commerce listing even on hosts
 * we don't recognise. These are conventions used by storefront
 * platforms (Shopify, Magento, BigCommerce) — false-positive risk is
 * low because they're sufficiently specific.
 */
const COMMERCE_PATH_PATTERNS: readonly RegExp[] = Object.freeze([
  /\/dp\/[A-Z0-9]+/i, //   amazon /dp/<asin>
  /\/gp\/product\//i, //   amazon /gp/product/<asin>
  /\/itm\/\d+/i, //        ebay /itm/<id>
  /\/products?\//i, //     shopify /products/, generic /product/
  /\/listing\/\d+/i, //    etsy /listing/<id>
  /\/ip\/\d+/i, //         walmart /ip/<id>
]);

const MAPS_HOST_SUFFIXES: readonly string[] = Object.freeze([
  'maps.google.com',
  // Google Maps app deep-link shortener — host alone implies a
  // maps URL because the shortener is maps-only. Plain `goo.gl`
  // is intentionally NOT here: it shortens arbitrary URLs, so a
  // host-only match would false-positive on every non-maps short
  // link. Legacy `goo.gl/maps/<id>` links exist but are too rare
  // to special-case without producing false positives elsewhere.
  'maps.app.goo.gl',
  'maps.apple.com',
  'osm.org',
  'openstreetmap.org',
]);

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Infer a `SubjectType` from free-text compose input. Returns `null`
 * if no rule matches; the caller then surfaces the picker.
 *
 * Empty / whitespace-only input is `null` (the caller has nothing to
 * detect on yet). The function is fully synchronous + pure; calling
 * it on every keystroke is cheap.
 */
export function detectSubjectType(input: string): SubjectTypeDetection | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // 1. DID prefix.
  if (/^did:[a-z]+:/.test(trimmed)) {
    return { type: 'did', rule: 'did_prefix' };
  }

  // 2-4. Identifier parser. We only consult it when the input is
  //      NOT a URL; a URL like https://example.com/dp/B0001 contains
  //      the substring "B0001" but the URL path patterns below are
  //      what should classify it, not the embedded ASIN. Otherwise a
  //      product URL on an unknown host would be classified by the
  //      embedded identifier even though the host signal is irrelevant.
  const url = tryParseURL(trimmed);
  if (url === null) {
    const parsed = parseIdentifier(trimmed);
    if (parsed) {
      switch (parsed.type) {
        case 'asin':
        case 'isbn13':
        case 'isbn10':
        case 'ean13':
        case 'upc':
          return { type: 'product', rule: 'product_identifier' };
        case 'doi':
        case 'arxiv':
          return { type: 'content', rule: 'doi_arxiv' };
        case 'place_id':
          return { type: 'place', rule: 'place_id' };
      }
    }
    // Non-URL input that didn't parse as any identifier — return null
    // so the caller can surface the picker. We deliberately don't
    // try to guess "place" from free text or "claim" from a sentence;
    // either guess fails too often to be useful.
    return null;
  }

  // 5-7. URL classification.
  if (isMapsURL(url)) {
    return { type: 'place', rule: 'maps_url' };
  }
  if (isCommerceURL(url)) {
    return { type: 'product', rule: 'commerce_url' };
  }
  return { type: 'content', rule: 'url' };
}

// ─── Internal ─────────────────────────────────────────────────────────────

function tryParseURL(s: string): URL | null {
  // `URL` accepts a wide variety of inputs — `mailto:`, `data:`,
  // even single words on some implementations. We restrict to
  // `http(s)` so a casual word like "abc" doesn't get treated as a
  // protocol-relative URL on an idiosyncratic implementation.
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

function hostMatchesSuffix(host: string, suffixes: readonly string[]): boolean {
  const h = host.toLowerCase();
  return suffixes.some((suf) => h === suf || h.endsWith(`.${suf}`));
}

function isMapsURL(url: URL): boolean {
  return hostMatchesSuffix(url.hostname, MAPS_HOST_SUFFIXES);
}

function isCommerceURL(url: URL): boolean {
  if (hostMatchesSuffix(url.hostname, COMMERCE_HOST_SUFFIXES)) return true;
  return COMMERCE_PATH_PATTERNS.some((re) => re.test(url.pathname));
}
