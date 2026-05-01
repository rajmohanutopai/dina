/**
 * Host → ISO 3166-1 alpha-2 region inference (TN-V2-META-007).
 *
 * Pure-data heuristic: given a host or URL, return a single ISO
 * 3166-1 alpha-2 country code (e.g. `'GB'`, `'IN'`, `'DE'`) or
 * `null` when the host gives no usable signal. Powers the
 * `metadata.availability.regions` enrichment for content + product
 * subjects when the reviewer didn't declare regions explicitly.
 *
 * **Lookup priority:**
 *   1. Per-host override (e.g. `amazon.com` → `US`, `etsy.com` →
 *      `US`). Required because a `.com` TLD is region-neutral but
 *      the storefront isn't.
 *   2. ccTLD heuristic (e.g. `.uk` → `GB`, `.de` → `DE`). Curated;
 *      not the full ISO ccTLD list — only the codes we'd actually
 *      see in trust-network attestations.
 *
 * **What this is NOT:**
 *   - A "ships-to" inference. `amazon.co.uk` ships to many places;
 *     we report the *storefront* region (`GB`). Reviewers express
 *     ship-to via the `availability.shipsTo` field downstream.
 *   - A geocoder. `place` subjects get region from their `place_id`
 *     enrichment, not from the host of the URL.
 *   - A fallback to `'US'` for `.com`. Returning `null` lets the
 *     downstream layer distinguish "no signal" from "signal is US".
 *     Reviewer-declared `availability.regions` is the source of
 *     truth; we only fill the gap when both signal and reviewer
 *     are silent.
 *
 * Pure function. No I/O. Same input always returns the same output.
 */

import { normalizeHost } from './host_category'

/**
 * Per-host overrides for hosts whose TLD doesn't reflect their
 * storefront region. Keys are normalized hosts (lowercase, no
 * `www.`, no port). Values are ISO 3166-1 alpha-2 codes.
 *
 * Coverage is intentionally narrow — only hosts where the
 * storefront-region signal is unambiguous. `shopify.com` (a host
 * for *many* stores in many regions) is deliberately omitted; the
 * region lives on the per-store subdomain (`*.myshopify.com`),
 * which we don't index.
 */
const HOST_OVERRIDES: ReadonlyMap<string, string> = new Map([
  // Amazon storefronts — explicit map; `.com` is US, ccTLDs would
  // also map via the TLD heuristic but the override stays
  // authoritative so future TLD-heuristic edits don't drift.
  ['amazon.com', 'US'],
  ['amazon.co.uk', 'GB'],
  ['amazon.de', 'DE'],
  ['amazon.fr', 'FR'],
  ['amazon.it', 'IT'],
  ['amazon.es', 'ES'],
  ['amazon.nl', 'NL'],
  ['amazon.in', 'IN'],
  ['amazon.co.jp', 'JP'],
  ['amazon.ca', 'CA'],
  ['amazon.com.au', 'AU'],
  ['amazon.com.mx', 'MX'],
  ['amazon.com.br', 'BR'],
  ['amazon.sg', 'SG'],
  ['amazon.ae', 'AE'],
  ['amazon.sa', 'SA'],
  // US-primary commerce hosts on `.com` — TLD heuristic returns
  // null for `.com` so without overrides these would all silently
  // miss.
  ['etsy.com', 'US'],
  ['ebay.com', 'US'],
  ['bestbuy.com', 'US'],
  ['target.com', 'US'],
  ['walmart.com', 'US'],
  ['homedepot.com', 'US'],
  ['costco.com', 'US'],
  // Region-primary commerce hosts whose TLD matches but where the
  // override is explicit-better-than-implicit.
  ['ebay.co.uk', 'GB'],
  ['ebay.de', 'DE'],
  ['flipkart.com', 'IN'],
  ['myntra.com', 'IN'],
  ['rakuten.co.jp', 'JP'],
  ['mercadolivre.com.br', 'BR'],
  ['mercadolibre.com.mx', 'MX'],
])

/**
 * ccTLD → ISO 3166-1 alpha-2. Curated, not exhaustive — only the
 * codes that show up in trust-network attestations matter.
 *
 * Note `.uk` → `GB`: the country code (ISO 3166-1) and the TLD
 * differ. The output is always the country code.
 *
 * Order doesn't matter (Map lookup is O(1)) but the entries are
 * grouped by region for review readability.
 */
const TLD_REGION: ReadonlyMap<string, string> = new Map([
  // Europe
  ['uk', 'GB'],
  ['de', 'DE'],
  ['fr', 'FR'],
  ['it', 'IT'],
  ['es', 'ES'],
  ['nl', 'NL'],
  ['be', 'BE'],
  ['ch', 'CH'],
  ['at', 'AT'],
  ['se', 'SE'],
  ['no', 'NO'],
  ['dk', 'DK'],
  ['fi', 'FI'],
  ['pl', 'PL'],
  ['ie', 'IE'],
  ['pt', 'PT'],
  ['gr', 'GR'],
  ['cz', 'CZ'],
  // Asia / Oceania
  ['in', 'IN'],
  ['jp', 'JP'],
  ['kr', 'KR'],
  ['cn', 'CN'],
  ['tw', 'TW'],
  ['hk', 'HK'],
  ['sg', 'SG'],
  ['my', 'MY'],
  ['th', 'TH'],
  ['ph', 'PH'],
  ['id', 'ID'],
  ['vn', 'VN'],
  ['au', 'AU'],
  ['nz', 'NZ'],
  // Americas
  ['ca', 'CA'],
  ['mx', 'MX'],
  ['br', 'BR'],
  ['ar', 'AR'],
  ['cl', 'CL'],
  ['co', 'CO'],
  // Middle East / Africa
  ['ae', 'AE'],
  ['sa', 'SA'],
  ['tr', 'TR'],
  ['il', 'IL'],
  ['za', 'ZA'],
  ['ng', 'NG'],
  ['ke', 'KE'],
  ['eg', 'EG'],
  // Other
  ['ru', 'RU'],
  ['ua', 'UA'],
])

/**
 * Resolve a host or URL to an ISO 3166-1 alpha-2 region code.
 *
 * Returns `null` when no signal applies — a `.com` host with no
 * override, an unknown ccTLD, or a malformed input. Callers wrap
 * the non-null result in a single-element array
 * (`metadata.availability.regions = [result]`).
 *
 * The override map takes priority over the TLD heuristic so future
 * ccTLD additions never silently change the storefront-region
 * answer for a curated host.
 */
export function hostToRegion(hostOrUrl: string | null | undefined): string | null {
  const host = normalizeHost(hostOrUrl)
  if (host === null) return null

  // Step 1: per-host override (highest specificity).
  const override = HOST_OVERRIDES.get(host)
  if (override !== undefined) return override

  // Step 2: ccTLD heuristic — strip composite suffixes like `.co.uk`
  // by checking the *outermost* label. `.uk` matches via the last
  // dot-segment; `.com.au` matches via `.au` (last segment).
  const lastDot = host.lastIndexOf('.')
  if (lastDot < 0 || lastDot === host.length - 1) return null
  const tld = host.slice(lastDot + 1)
  return TLD_REGION.get(tld) ?? null
}

/**
 * Test-only introspection: how many curated entries does each
 * map carry? Lets the test suite pin the budget so the maps
 * don't quietly bloat.
 */
export function curatedRegionCount(): { overrides: number; tlds: number } {
  return { overrides: HOST_OVERRIDES.size, tlds: TLD_REGION.size }
}
