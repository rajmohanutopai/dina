/**
 * Subject Tier-1 identity resolution — type-specific precedence + the
 * per-type identifier canonicalizer.
 *
 * SERVICES_LAUNCH_ARCHITECTURE.md Part 3. This is the fifth instance of
 * the canonicalization theme (after capability, category, dimension):
 * extract the stable identity, drop the noise, converge — applied to the
 * subject a review attaches to.
 *
 * Two problems it solves, both BEFORE the subject_id hash:
 *
 *  1. **Type-specific Tier-1 precedence (P1b).** A ref can carry more
 *     than one global id (mobile emits both `uri` and `identifier`). The
 *     old resolver hard-coded `did > uri > identifier`, so a PRODUCT
 *     carrying a store URL + a barcode resolved by the URL — the weaker,
 *     page-level, fragmenting key — instead of the barcode (the correct
 *     variant-level key). Precedence is now BY TYPE:
 *       - `did` always wins (strongest global identity).
 *       - Product / dataset (physical goods): `identifier` (SKU/barcode/
 *         ASIN) beats `uri`. The SKU is more precise than a page URL.
 *       - Content / place / org / claim: `uri` (canonical content URL)
 *         beats `identifier`. The URL *is* the content's identity.
 *       - Name is always the last resort (Tier 2, handled by the caller).
 *
 *  2. **Per-type identifier canonicalizer.** A raw URL is as fragmenting
 *     as a free-typed name (one YouTube video has many URL spellings:
 *     `www.`/no-`www.`, `youtu.be`, `&t=`/`&list=` tracking, http/https).
 *     So the URL is reduced to the platform's stable content id before
 *     hashing; barcodes/ASINs are format-normalized. Drop-don't-guess: an
 *     unparseable URL is NOT invented into a platform id — it falls
 *     through to conservative RFC normalization (and ultimately, if the
 *     whole ref has no usable Tier-1 field, the caller drops to Tier-2
 *     name).
 *
 * Hashing lives ONLY in AppView (`subjects.ts` is the sole hasher), so
 * this module is AppView-local — there is no cross-workspace copy/drift
 * gate (unlike the capability/dimension registries, which several
 * packages import). The wire-format contract is pinned by
 * `RESOLVER_VERSION` + `packages/protocol/docs/features/subject-id.md`.
 */

import type { SubjectRef } from '@/shared/types/lexicon-types.js'

/** A Tier-1 field name, in the order it's consulted. */
type Tier1Field = 'did' | 'uri' | 'identifier'

/**
 * Tier-1 field precedence for a subject type. `did` is always first
 * (strongest global identity). After that the order is type-specific:
 * physical-good types prefer the precise SKU `identifier`; content-style
 * types prefer the canonical content `uri`.
 */
export function tier1Precedence(type: SubjectRef['type']): readonly Tier1Field[] {
  switch (type) {
    // Physical goods: the barcode / ASIN / MPN identifies the exact SKU
    // the buyer buys — more precise than whatever store page URL was handy.
    case 'product':
    case 'dataset':
      return ['did', 'identifier', 'uri']
    // Content / place / org / claim: the canonical URL/ID *is* the
    // identity (a YouTube video, an article, a place). A stray store-style
    // identifier shouldn't outrank it.
    default:
      return ['did', 'uri', 'identifier']
  }
}

// ─── URL → platform content id ─────────────────────────────────────────

/**
 * Tracking / presentation query params that never change which resource a
 * URL addresses. Dropped from the canonical form so `?utm_source=…`,
 * `&t=42s` (a YouTube timestamp), playlist context, etc. don't fragment a
 * subject. Deliberately a DENYLIST (not "strip all query"): query strings
 * are the routing key on many sites (`?p=123`, `?id=…`), so blanket
 * stripping would CONFLATE distinct resources. We only drop params known
 * to be noise.
 */
const TRACKING_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref',
  'ref_src',
  'ref_url',
  'source',
  // YouTube presentation context — same video regardless.
  't',
  'list',
  'index',
  'start_radio',
  'feature',
  'ab_channel',
  'pp',
  'si',
])

const YOUTUBE_HOSTS: ReadonlySet<string> = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
])

/** A YouTube video id is 11 chars of `[A-Za-z0-9_-]`. */
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/

/**
 * Extract a YouTube video id from any of its URL spellings, or `null`
 * when the URL isn't a recognised YouTube video link:
 *   - `youtube.com/watch?v=<id>`     (canonical)
 *   - `youtu.be/<id>`                (short)
 *   - `youtube.com/embed/<id>`       (embed)
 *   - `youtube.com/shorts/<id>`      (shorts)
 *   - `youtube.com/live/<id>`        (live permalink)
 * `m.`/`www.`/`music.` hosts all fold. Tracking + timestamp params are
 * irrelevant (we read only the id).
 */
function extractYouTubeId(parsed: URL): string | null {
  const host = parsed.hostname.toLowerCase()
  if (!YOUTUBE_HOSTS.has(host)) return null

  if (host === 'youtu.be') {
    const id = parsed.pathname.split('/').filter(Boolean)[0]
    return id !== undefined && YOUTUBE_ID_RE.test(id) ? id : null
  }

  // watch?v=<id>
  const v = parsed.searchParams.get('v')
  if (v !== null && YOUTUBE_ID_RE.test(v)) return v

  // /embed/<id>, /shorts/<id>, /live/<id>
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length >= 2) {
    const [prefix, id] = segments
    if (
      (prefix === 'embed' || prefix === 'shorts' || prefix === 'live') &&
      id !== undefined &&
      YOUTUBE_ID_RE.test(id)
    ) {
      return id
    }
  }
  return null
}

const URI_DEFAULT_PORTS: Readonly<Record<string, string>> = {
  'http:': '80',
  'https:': '443',
  'ftp:': '21',
  'ssh:': '22',
  'telnet:': '23',
  'smtp:': '25',
}

/**
 * Conservative RFC 3986 normalization for a generic (non-platform) URL,
 * PLUS tracking-param stripping. Folds scheme/host case, default ports,
 * root trailing slash, and the fragment; drops known tracking params but
 * PRESERVES other query params verbatim, in original order (they may be
 * the routing key, and order MAY be semantic — we don't risk conflating
 * distinct resources by reordering).
 */
function normalizeGenericUri(parsed: URL): string {
  const defaultPort = URI_DEFAULT_PORTS[parsed.protocol]
  if (defaultPort !== undefined && parsed.port === defaultPort) {
    parsed.port = ''
  }

  // Fragment: client-side anchor, never changes resource identity.
  parsed.hash = ''

  // Drop tracking params; PRESERVE the rest verbatim, in original order.
  // We deliberately do NOT sort or otherwise reorder: query order MAY be
  // semantic on some servers, and the surviving query is often the
  // routing key (`?id=1` vs `?id=2` are different resources). Dropping
  // known noise (utm_*, t, list…) converges the fragmenting variants the
  // spec targets without risking conflation of genuinely-distinct URLs.
  const kept: [string, string][] = []
  for (const [k, val] of parsed.searchParams.entries()) {
    if (!TRACKING_QUERY_PARAMS.has(k.toLowerCase())) kept.push([k, val])
  }
  parsed.search = ''
  for (const [k, val] of kept) parsed.searchParams.append(k, val)

  let serialized = parsed.toString()
  // Root trailing slash folds (`https://x/` == `https://x`). Non-root
  // trailing slashes are preserved (servers MAY distinguish `/p` vs `/p/`).
  if (parsed.pathname === '/' && parsed.search === '') {
    if (serialized.endsWith('/')) serialized = serialized.slice(0, -1)
  }
  return serialized
}

/**
 * Canonicalize a `uri` field to the stable identity used for hashing.
 * YouTube links collapse to `youtube:<videoId>`; everything else gets
 * conservative RFC normalization + tracking-param stripping. A malformed
 * URL (that `new URL` can't parse) falls back to the raw string — a
 * consistently-malformed input still converges, and we don't invent a
 * platform id we can't verify (drop-don't-guess).
 */
export function canonicalizeUri(rawUri: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUri)
  } catch {
    return rawUri
  }
  const yt = extractYouTubeId(parsed)
  if (yt !== null) return `youtube:${yt}`
  return normalizeGenericUri(parsed)
}

// ─── Barcode / ASIN identifier normalization ───────────────────────────

// UPC-A (12), EAN-13 (13), and GTIN-14 are the SAME GS1 identifier at
// different lengths — a UPC-A is the 14-digit GTIN with leading zeros, an
// EAN-13 likewise. So all three schemes normalize to ONE canonical key
// (`gtin:<14-digit>`); otherwise `upc:036000291452`, `ean:0036000291452`,
// and `gtin:00036000291452` would mint three subjects for one product.
const GTIN_SCHEMES: ReadonlySet<string> = new Set(['gtin', 'ean', 'upc'])

/**
 * Format-normalize a global `identifier` (mostly passthrough). Parses the
 * `<scheme>:<value>` shape:
 *   - scheme lowercased (`ASIN:` == `asin:`).
 *   - `asin` value uppercased (ASINs are case-insensitive alphanumerics).
 *   - `gtin`/`ean`/`upc` → unified to `gtin:<value left-zero-padded to 14>`
 *     so a UPC-A (12), the EAN-13, and the GTIN-14 of the SAME product all
 *     converge to one subject id (GS1 GTIN-14 canonical form). The scheme
 *     itself collapses to `gtin` — the digits, not the label, are identity.
 *   - any other scheme, or an identifier with no `:`, passes through
 *     verbatim — we don't guess at formats we don't recognise.
 */
export function canonicalizeIdentifier(rawIdentifier: string): string {
  const sep = rawIdentifier.indexOf(':')
  if (sep < 0) return rawIdentifier // no scheme — can't safely normalize
  const scheme = rawIdentifier.slice(0, sep).toLowerCase()
  const value = rawIdentifier.slice(sep + 1)

  if (scheme === 'asin') {
    return `asin:${value.toUpperCase()}`
  }
  if (GTIN_SCHEMES.has(scheme) && /^[0-9]+$/.test(value) && value.length <= 14) {
    // Unify the scheme to `gtin` so upc/ean/gtin of one product converge.
    return `gtin:${value.padStart(14, '0')}`
  }
  return `${scheme}:${value}`
}

// ─── Tier-1 key resolution ─────────────────────────────────────────────

/**
 * Resolve the canonical Tier-1 hash segment for a ref (e.g.
 * `'uri:youtube:dQw4w9WgXcQ'`, `'id:asin:B01234ABCD'`,
 * `'did:did:plc:abc'`), honouring the type-specific precedence and
 * routing each field through its canonicalizer. Returns `null` when the
 * ref carries NO usable Tier-1 field — the caller then falls to Tier-2
 * name (drop-don't-guess: no Tier-1 field is invented).
 *
 * Presence = a non-empty string. Matches the federation spec's "no trim
 * before the presence check" rule (the record-validator already rejects
 * whitespace-padded Tier-1 fields up front).
 */
export function resolveTier1Key(ref: SubjectRef): string | null {
  for (const field of tier1Precedence(ref.type)) {
    if (field === 'did' && ref.did != null && ref.did.length > 0) {
      return `did:${ref.did}`
    }
    if (field === 'uri' && ref.uri != null && ref.uri.length > 0) {
      return `uri:${canonicalizeUri(ref.uri)}`
    }
    if (field === 'identifier' && ref.identifier != null && ref.identifier.length > 0) {
      return `id:${canonicalizeIdentifier(ref.identifier)}`
    }
  }
  return null
}
