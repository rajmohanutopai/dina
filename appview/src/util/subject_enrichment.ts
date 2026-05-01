/**
 * Subject enrichment heuristic (TN-ENRICH-005).
 *
 * Per Trust Network V1 plan §3.6 — the lexicon `SubjectRef` is
 * intentionally sparse; AppView enriches each subject row at ingest
 * with category + metadata so search filters work. **Enrichment is
 * server-side; publishers don't need to know the taxonomy.**
 *
 * This module composes the four pure-data lookups built in earlier
 * iterations:
 *
 *   - `host_category` (TN-ENRICH-001): host → content media_type
 *   - `category_keywords` (TN-ENRICH-002): name → category segment
 *   - `known_orgs` (TN-ENRICH-003): URL/name → org type + QID
 *   - `identifier_parser` (TN-ENRICH-004): identifier → typed canonical
 *
 * Output shape per plan §3.6.1:
 *
 *   {
 *     category: string         // 'product:furniture' / 'place:cafe' / ...
 *     metadata: Record<string, unknown>  // type-specific (§3.6.2)
 *   }
 *
 * The `language` column is detected separately via `franc-min` and is
 * NOT this module's concern.
 *
 * Per-subject-type rules (verbatim from plan §3.6.3):
 *
 *   **product** (in priority order):
 *     1. identifier → ASIN: category='product', identifier_kind='asin'
 *     2. identifier → ISBN-13/10: category='product:book', identifier_kind=...
 *     3. uri host → amazon/flipkart/bestbuy/etc: category='product', host=...
 *     4. name keyword match: appends segment ('product:furniture')
 *
 *   **place** (in priority order):
 *     1. identifier 'place_id:...': category='place', google_place_id=...
 *     2. uri 'google.com/maps/...': category='place', parse lat/lng + query
 *     3. name keyword match: appends segment ('place:cafe'); place_type set
 *
 *   **content**:
 *     - uri host: category='content', host=<host>; lookup → media_type
 *
 *   **dataset**:
 *     - uri 'arxiv.org/abs/<id>': arxiv_id + publication_year (parsed from id)
 *     - identifier 'doi:10.*': doi
 *
 *   **organization** (TLD heuristic, with known_orgs override):
 *     - .edu: university; .gov: government; .org: nonprofit (weak); else company
 *     - known_orgs lookup (by domain or name) overrides with QID + canonical type
 *
 *   **did**:
 *     - method extracted from `did:plc:...` prefix
 *     - is_service / capability resolution is async (not in this pure layer);
 *       caller does the DID-document fetch and merges those fields
 *
 *   **claim**:
 *     - name keyword scan for `health` / `finance` / `political` / `scientific`
 *
 * Pure function. No I/O. The actual AT-URI fetch + DID resolution
 * are caller concerns; this module only handles the deterministic
 * parts the plan calls out.
 */

import { lookupCategorySegment } from './category_keywords'
import { lookupHost, normalizeHost } from './host_category'
import { hostToRegion } from './host_to_region'
import { parseIdentifier, type ParsedIdentifier } from './identifier_parser'
import { lookupOrgByDomain, lookupOrgByName, type OrgType } from './known_orgs'
import { parseJsonLdSchedule } from './parse_json_ld_schedule'
import { parseOpenGraphPrice } from './parse_open_graph_price'

// ─── Public types ─────────────────────────────────────────────────────────

export type SubjectType =
  | 'did'
  | 'content'
  | 'product'
  | 'dataset'
  | 'organization'
  | 'claim'
  | 'place'

export interface SubjectRef {
  readonly type: SubjectType
  readonly did?: string
  readonly uri?: string
  readonly name?: string
  readonly identifier?: string
}

export interface SubjectEnrichment {
  /** Lowercase, optional second segment after `:`. */
  readonly category: string
  /** Type-specific metadata per plan §3.6.2. Always returns an object (possibly empty). */
  readonly metadata: Readonly<Record<string, unknown>>
}

/**
 * Optional inputs to the enricher beyond the bare `SubjectRef`.
 *
 * Today: pre-fetched HTML for invoking the META-009 (price) +
 * META-010 (schedule) parsers without making the enricher do its
 * own network I/O. The HTTP-fetch wrapper is deliberately deferred —
 * this options surface is the integration point future
 * orchestration layers (rate-limited fetcher, cache, fallback) plug
 * into. Callers that don't have HTML pass nothing; the enricher
 * returns the same shape it always has, just without the HTML-
 * derived fields.
 *
 * Tomorrow: this object is the natural home for any other deferred
 * input (e.g. pre-resolved DID document, pre-computed identifier
 * canonical form). Keeping it as an options bag means adding a
 * field doesn't break call sites.
 */
export interface EnrichmentOptions {
  readonly html?: string
}

/**
 * Subset of curated commerce hosts that get the bare `category='product'`
 * mapping per plan §3.6.3 line 365 — independent of the wider host_category
 * map (which is content-flavoured). Keeping these here as the explicit list
 * the plan enumerates ("amazon.* / flipkart.com / bestbuy.com / etc.").
 *
 * For host suffixes (e.g. `amazon.*`), we match by the leading-host-component
 * comparison rather than substring — `amazon.com`, `amazon.in`,
 * `amazon.co.uk` all match the `amazon.` prefix; `notamazon.com` does NOT.
 */
const COMMERCE_HOSTS_EXACT: ReadonlySet<string> = new Set([
  'flipkart.com',
  'bestbuy.com',
  'walmart.com',
  'target.com',
  'ebay.com',
  'etsy.com',
  'aliexpress.com',
  'shopify.com',
])
const COMMERCE_HOSTS_PREFIX: readonly string[] = ['amazon.']

/**
 * Curated claim-domain keyword rules per plan §3.6.3 type=claim. Tiny —
 * claim enrichment is best-effort and the domain is a rough filter, not
 * a precise taxonomy.
 *
 * Pre-compiled at module load (one RegExp per keyword) so per-call cost
 * is just a `.test()` against the lower-cased name. Pattern uses `\b`
 * word-boundaries to avoid `'crypto'` matching `'cryptography'`.
 *
 * All keywords are plain ASCII letters, so no regex-metacharacter
 * escaping is needed. If a non-letter keyword is ever added, escape it
 * via a helper before constructing the RegExp.
 */
const CLAIM_DOMAIN_RULES: ReadonlyArray<{ readonly pattern: RegExp; readonly domain: string }> =
  Object.freeze([
    { keyword: 'drug', domain: 'health' },
    { keyword: 'medication', domain: 'health' },
    { keyword: 'vaccine', domain: 'health' },
    { keyword: 'therapy', domain: 'health' },
    { keyword: 'diet', domain: 'health' },
    { keyword: 'stock', domain: 'finance' },
    { keyword: 'investment', domain: 'finance' },
    { keyword: 'crypto', domain: 'finance' },
    { keyword: 'election', domain: 'political' },
    { keyword: 'policy', domain: 'political' },
    { keyword: 'government', domain: 'political' },
    { keyword: 'climate', domain: 'scientific' },
    { keyword: 'research', domain: 'scientific' },
    { keyword: 'study', domain: 'scientific' },
  ].map(({ keyword, domain }) =>
    Object.freeze({ pattern: new RegExp(`\\b${keyword}\\b`), domain }),
  ))

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Enrich a subject row from its `SubjectRef`. Pure function — same
 * input always returns the same output.
 *
 * Always returns a value: at minimum, `category` is the bare type
 * (e.g. `'product'`) and `metadata` is `{}`. Best-effort enrichment
 * fills in segment + metadata when the heuristics match.
 */
export function enrichSubject(ref: SubjectRef, options?: EnrichmentOptions): SubjectEnrichment {
  switch (ref.type) {
    case 'product':
      return enrichProduct(ref, options)
    case 'place':
      return enrichPlace(ref, options)
    case 'content':
      return enrichContent(ref)
    case 'dataset':
      return enrichDataset(ref)
    case 'organization':
      return enrichOrganization(ref)
    case 'did':
      return enrichDid(ref)
    case 'claim':
      return enrichClaim(ref)
    default:
      // Defensive: a future SubjectType not covered above gets the
      // bare-type category with empty metadata. Better than throwing
      // — enrichment is best-effort.
      return frozenEnrichment(String(ref.type), {})
  }
}

// ─── Type-specific enrichers ─────────────────────────────────────────────

function enrichProduct(ref: SubjectRef, options?: EnrichmentOptions): SubjectEnrichment {
  const metadata: Record<string, unknown> = {}

  // Step 1: identifier-based (highest specificity).
  const parsed = parseIfPresent(ref.identifier)
  if (parsed) {
    if (parsed.type === 'asin') {
      metadata.identifier_kind = 'asin'
      metadata.identifier = parsed.value
      // Don't return early — name-keyword match below can refine the
      // category segment ('product:furniture' is more useful than
      // bare 'product' even when an ASIN is present).
    } else if (parsed.type === 'isbn13') {
      metadata.identifier_kind = 'isbn-13'
      metadata.identifier = parsed.value
      return frozenEnrichment('product:book', metadata)
    } else if (parsed.type === 'isbn10') {
      metadata.identifier_kind = 'isbn-10'
      metadata.identifier = parsed.value
      return frozenEnrichment('product:book', metadata)
    } else if (parsed.type === 'ean13') {
      metadata.identifier_kind = 'ean-13'
      metadata.identifier = parsed.value
    } else if (parsed.type === 'upc') {
      metadata.identifier_kind = 'upc'
      metadata.identifier = parsed.value
    }
  }

  // Step 2: URI host — flag commerce hosts.
  const host = normalizeHost(ref.uri)
  if (host !== null && isCommerceHost(host)) {
    metadata.host = host
  }

  // Step 2b: URI host → storefront region (TN-V2-META-007). Covers
  // both ccTLD heuristic (`amazon.co.uk` → GB) and curated
  // overrides (`amazon.com` → US, `etsy.com` → US). Reviewer-
  // declared `availability.regions` (META-001) lives on the
  // ATTESTATION row (`availability_regions text[]`) — the
  // subject-level merge unifying that with this enricher's
  // signal is the deferred unified-pipeline work, not the
  // enricher's job. Today this fills `metadata.availability` on
  // SUBJECT enrichment; reviewer-declared values per attestation
  // are persisted independently and merged at score time.
  applyAvailabilityRegion(metadata, ref.uri)

  // Step 3: name keyword — refines the category segment.
  const segment = lookupCategorySegment(ref.name)

  // Step 4: TN-V2-META-009 — OpenGraph / JSON-LD price extraction
  // when the caller pre-fetched the subject's HTML. Pure parser
  // path; HTTP fetcher orchestration is deferred. The reviewer-
  // declared `price` (META-002 wire field) will eventually take
  // priority at the subject-level merge stage; this enricher only
  // fills the gap when no reviewer signal is present.
  applyPrice(metadata, options?.html)

  if (segment !== null) {
    return frozenEnrichment(`product:${segment}`, metadata)
  }

  return frozenEnrichment('product', metadata)
}

function enrichPlace(ref: SubjectRef, options?: EnrichmentOptions): SubjectEnrichment {
  const metadata: Record<string, unknown> = {}

  // Step 1: identifier `place_id:...` prefix.
  if (typeof ref.identifier === 'string') {
    const trimmed = ref.identifier.trim()
    if (trimmed.toLowerCase().startsWith('place_id:')) {
      metadata.google_place_id = trimmed.slice('place_id:'.length).trim()
    } else {
      // Try the parser — it accepts bare ChIJ.../Eo... place IDs.
      const parsed = parseIdentifier(trimmed)
      if (parsed?.type === 'place_id') {
        metadata.google_place_id = parsed.value
      }
    }
  }

  // Step 2: URI google.com/maps/... — extract lat/lng from query string.
  if (typeof ref.uri === 'string') {
    const mapsCoords = parseGoogleMapsCoords(ref.uri)
    if (mapsCoords !== null) {
      metadata.lat = mapsCoords.lat
      metadata.lng = mapsCoords.lng
    }
  }

  // Step 3: name keyword — place_type + segment.
  const segment = lookupCategorySegment(ref.name)

  // Step 4: TN-V2-META-010 — JSON-LD OpeningHours extraction when
  // the caller pre-fetched the subject's HTML. Pure parser path.
  applySchedule(metadata, options?.html)

  if (segment !== null) {
    metadata.place_type = segment
    return frozenEnrichment(`place:${segment}`, metadata)
  }

  return frozenEnrichment('place', metadata)
}

function enrichContent(ref: SubjectRef): SubjectEnrichment {
  const metadata: Record<string, unknown> = {}
  const host = normalizeHost(ref.uri)
  if (host !== null) metadata.host = host

  const hostEntry = lookupHost(ref.uri)
  if (hostEntry !== null) {
    metadata.media_type = hostEntry.media_type
  }

  // TN-V2-META-007 — content subjects pick up region from their
  // host (e.g. `bbc.co.uk` → GB). Newsy/blog content is often
  // region-bound even when the article itself is global; the
  // signal is weak but better than null for region-aware ranking.
  applyAvailabilityRegion(metadata, ref.uri)

  return frozenEnrichment('content', metadata)
}

function enrichDataset(ref: SubjectRef): SubjectEnrichment {
  const metadata: Record<string, unknown> = {}

  // Identifier-based: DOI / arxiv / generic.
  const parsedId = parseIfPresent(ref.identifier)
  if (parsedId?.type === 'doi') {
    metadata.doi = parsedId.value
  } else if (parsedId?.type === 'arxiv') {
    metadata.arxiv_id = parsedId.value
    const year = arxivYearFromId(parsedId.value)
    if (year !== null) metadata.publication_year = year
  }

  // URI-based: arxiv URLs (`arxiv.org/abs/<id>`).
  if (typeof ref.uri === 'string') {
    const arxivFromUri = arxivIdFromUri(ref.uri)
    if (arxivFromUri !== null && metadata.arxiv_id === undefined) {
      metadata.arxiv_id = arxivFromUri
      const year = arxivYearFromId(arxivFromUri)
      if (year !== null) metadata.publication_year = year
    }
  }

  return frozenEnrichment('dataset', metadata)
}

function enrichOrganization(ref: SubjectRef): SubjectEnrichment {
  const metadata: Record<string, unknown> = {}
  let orgType: OrgType | null = null

  // Step 1: known_orgs override (highest confidence).
  const byDomain = lookupOrgByDomain(ref.uri)
  const byName = byDomain ?? lookupOrgByName(ref.name)
  if (byName !== null) {
    orgType = byName.type
    if (byName.qid !== null) metadata.qid = byName.qid
    metadata.canonical_name = byName.name
  }

  // Step 2: TLD heuristic fallback.
  if (orgType === null) {
    orgType = orgTypeFromTld(ref.uri)
  }

  if (orgType !== null) metadata.org_type = orgType

  return frozenEnrichment(
    orgType !== null ? `organization:${orgType}` : 'organization',
    metadata,
  )
}

function enrichDid(ref: SubjectRef): SubjectEnrichment {
  const metadata: Record<string, unknown> = {}
  const did = typeof ref.did === 'string' ? ref.did : ref.uri
  if (typeof did === 'string') {
    const method = didMethod(did)
    if (method !== null) metadata.did_method = method
  }
  // is_service / service_capability are async resolutions handled by
  // the caller; this pure layer only emits the deterministic field.
  return frozenEnrichment('did', metadata)
}

function enrichClaim(ref: SubjectRef): SubjectEnrichment {
  const metadata: Record<string, unknown> = {}
  if (typeof ref.name === 'string') {
    const lower = ref.name.toLowerCase()
    for (const rule of CLAIM_DOMAIN_RULES) {
      if (rule.pattern.test(lower)) {
        metadata.domain = rule.domain
        break
      }
    }
  }
  return frozenEnrichment('claim', metadata)
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function frozenEnrichment(category: string, metadata: Record<string, unknown>): SubjectEnrichment {
  return Object.freeze({
    category,
    metadata: Object.freeze({ ...metadata }),
  })
}

function parseIfPresent(input: string | undefined): ParsedIdentifier | null {
  if (typeof input !== 'string' || input.trim().length === 0) return null
  return parseIdentifier(input)
}

/**
 * TN-V2-META-007 — set `metadata.availability.regions` from a URL's
 * host when a curated override or ccTLD heuristic resolves it.
 * No-op when `hostToRegion` returns null (unknown TLD, missing URI,
 * etc.) — never overwrites an existing `availability` object.
 *
 * The `availability` shape mirrors plan §3.6 META-001:
 *   { regions?: ISO2[], shipsTo?: ISO2[], soldAt?: host[] }.
 * This enricher only fills `regions`. Other sub-fields come from
 * the reviewer-declared META-001 fields on the attestation row
 * (`availability_ships_to`, `availability_sold_at`); the
 * subject-level merge across reviewers + this enricher is the
 * deferred unified-pipeline work.
 */
function applyAvailabilityRegion(metadata: Record<string, unknown>, uri: string | undefined): void {
  if (typeof uri !== 'string') return
  const region = hostToRegion(uri)
  if (region === null) return
  // Don't overwrite a reviewer-declared `availability` object — the
  // current call sites construct `metadata` fresh, but this stays
  // forward-compatible with a future caller that pre-fills it.
  const existing = metadata.availability
  if (existing && typeof existing === 'object' && 'regions' in (existing as Record<string, unknown>)) {
    return
  }
  metadata.availability = { regions: [region] }
}

/**
 * TN-V2-META-009 — set `metadata.price` from OpenGraph product /
 * JSON-LD Offer markup when caller pre-fetched the subject's HTML.
 * Pure parser invocation — no HTTP, no I/O. No-op when:
 *   - `html` is absent / empty
 *   - The parser returns null (no OG meta + no JSON-LD Offer)
 *   - `metadata.price` is already set (caller-supplied or
 *     reviewer-declared at the subject-merge stage takes priority).
 *
 * The output object matches the META-002 wire shape exactly so the
 * subject-level merge (deferred) can union over reviewer-declared
 * + enricher-declared price without a normalisation step.
 */
function applyPrice(metadata: Record<string, unknown>, html: string | undefined): void {
  if (typeof html !== 'string' || html.length === 0) return
  if (metadata.price !== undefined) return  // don't overwrite
  const price = parseOpenGraphPrice(html)
  if (price === null) return
  metadata.price = price
}

/**
 * TN-V2-META-010 — set `metadata.schedule` from JSON-LD
 * OpeningHours markup when caller pre-fetched the subject's HTML.
 * Same no-op conditions as `applyPrice`. The output matches the
 * META-004 wire shape (subset — `hours` only; `leadDays` /
 * `seasonal` are reviewer-declared only and don't have a JSON-LD
 * counterpart).
 */
function applySchedule(metadata: Record<string, unknown>, html: string | undefined): void {
  if (typeof html !== 'string' || html.length === 0) return
  if (metadata.schedule !== undefined) return  // don't overwrite
  const schedule = parseJsonLdSchedule(html)
  if (schedule === null) return
  metadata.schedule = schedule
}

function isCommerceHost(host: string): boolean {
  if (COMMERCE_HOSTS_EXACT.has(host)) return true
  for (const prefix of COMMERCE_HOSTS_PREFIX) {
    if (host.startsWith(prefix)) return true
  }
  return false
}

/**
 * Extract `lat`/`lng` from a Google Maps URL of the form
 * `google.com/maps/...?...&q=37.7749,-122.4194&...` or
 * `google.com/maps/place/.../@37.7749,-122.4194,17z/...`.
 *
 * Returns `null` if the URL doesn't match either pattern. Numeric
 * out-of-range values (e.g. lat>90) are rejected.
 */
function parseGoogleMapsCoords(url: string): { lat: number; lng: number } | null {
  const host = normalizeHost(url)
  if (host !== 'google.com' && host !== 'maps.google.com' && host !== 'maps.app.goo.gl') {
    return null
  }
  // `@lat,lng[,zoom]` form (most common in Maps share URLs).
  const atMatch = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
  if (atMatch) {
    const lat = Number.parseFloat(atMatch[1] ?? '')
    const lng = Number.parseFloat(atMatch[2] ?? '')
    if (isValidCoord(lat, lng)) return { lat, lng }
  }
  // `?q=lat,lng` form.
  const qMatch = url.match(/[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
  if (qMatch) {
    const lat = Number.parseFloat(qMatch[1] ?? '')
    const lng = Number.parseFloat(qMatch[2] ?? '')
    if (isValidCoord(lat, lng)) return { lat, lng }
  }
  return null
}

function isValidCoord(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  )
}

function arxivYearFromId(id: string): number | null {
  // Modern: YYMM.NNNNN — first 2 digits are year-of-century. arxiv
  // launched in 1991, so YY in [00..06] means 2000s, [07..98] means
  // current millennium (modern numbering started 2007). Pre-2007
  // archive/YYMMNNN: YY in [91..99] means 199x, [00..06] means 200x.
  const modern = id.match(/^(\d{2})(\d{2})\./)
  if (modern) {
    const yy = Number.parseInt(modern[1] ?? '', 10)
    if (Number.isNaN(yy)) return null
    return yy >= 91 ? 1900 + yy : 2000 + yy
  }
  const pre2007 = id.match(/\/(\d{2})\d{5}/)
  if (pre2007) {
    const yy = Number.parseInt(pre2007[1] ?? '', 10)
    if (Number.isNaN(yy)) return null
    return yy >= 91 ? 1900 + yy : 2000 + yy
  }
  return null
}

function arxivIdFromUri(uri: string): string | null {
  const m = uri.match(/arxiv\.org\/abs\/(.+?)(?:[/?#]|$)/i)
  if (!m) return null
  // Validate via the parser so we don't accept garbage that happens
  // to follow `/abs/`.
  const parsed = parseIdentifier(m[1] ?? '')
  return parsed?.type === 'arxiv' ? parsed.value : null
}

function orgTypeFromTld(uri: string | undefined): OrgType | null {
  const host = normalizeHost(uri)
  if (host === null) return null
  if (host.endsWith('.edu')) return 'university'
  if (host.endsWith('.gov')) return 'government'
  if (host.endsWith('.org')) return 'nonprofit'
  // Plan §3.6.3: "else default `org_type='company'`". This is a weak
  // signal on arbitrary `.com`/`.io`/etc. but matches the plan's V1
  // baseline; users refine via known_orgs entries (which override
  // this fallback in `enrichOrganization`).
  return 'company'
}

function didMethod(did: string): 'plc' | 'key' | 'web' | null {
  // did:plc:..., did:key:..., did:web:...
  const m = did.match(/^did:([a-z]+):/)
  if (!m) return null
  const method = m[1]
  if (method === 'plc' || method === 'key' || method === 'web') return method
  return null
}
