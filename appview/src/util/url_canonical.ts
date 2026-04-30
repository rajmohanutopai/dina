/**
 * URL canonicalisation for subject deduplication (TN-TEST-006 /
 * Plan §3.6 line 487).
 *
 * The problem: two attestations referencing the same product page —
 * one with `?utm_source=newsletter`, one without — currently
 * deduplicate to TWO different subjects (`resolveSubject` hashes
 * the raw URI, so any differing byte produces a different
 * `subject_id`). The canonicaliser produces a stable form of
 * "same content" URLs so the dedup hash collapses them.
 *
 * **Pure function**, no I/O, no globals — cheap to call from any
 * code path. The intended integration point is the ingest-time
 * subject resolution path; operators wiring it must own the
 * migration story for already-indexed subjects keyed by raw URI
 * (V2 same-as merging, manual backfill, or just letting the
 * weekly enrich-recompute land on already-stored URIs).
 *
 * **Returns `null` for non-canonicalisable inputs** rather than
 * throwing — the caller should treat null as "use the raw URI as
 * the dedup key". Mailto, tel, javascript:, data: schemes return
 * the input unchanged (no query string to canonicalise; they are
 * their own canonical form).
 *
 * **What we DO canonicalise** (default options):
 *   - Lowercase the host (DNS is case-insensitive)
 *   - Strip default port (80 for http, 443 for https)
 *   - Strip fragment (#anchor — different anchors point to the
 *     same content for dedup purposes; the user's review of an
 *     article doesn't change because they linked to a section)
 *   - Strip tracking query params (utm_*, gclid, fbclid, etc. —
 *     curated allow-list-by-exclusion below)
 *   - Sort remaining query params alphabetically (key-stable
 *     ordering; values within a repeated key preserve order)
 *   - Strip trailing slash (except for the root "/")
 *   - Strip the optional `stripWww` if `www.` prefix → host
 *
 * **What we DO NOT canonicalise**:
 *   - Path case (some hosts ARE case-sensitive — Apache `Files`
 *     directive, GitHub repo names; lowercasing a path could
 *     map two distinct resources to the same key)
 *   - Trailing slash on the root path "/" (this is the canonical
 *     form for a host's homepage — stripping would produce
 *     `https://example.com` without trailing slash, which is
 *     valid but inconsistent with the WHATWG URL parser's output)
 *   - Path traversal segments (`/foo/../bar`); URL spec already
 *     resolves these via `URL` constructor — no extra work needed
 *   - Userinfo (`user:pass@host`) — preserved as-is; if a URI
 *     carries auth, it carries auth
 */

/** Tracking query-param keys that should be stripped from the
 *  canonical URL. The list is conservative — adding a key here is
 *  a one-way decision (subjects keyed by URLs containing the
 *  pre-strip param will dedup against the post-strip form on
 *  re-ingestion). When in doubt, keep it; the canonicaliser is
 *  for noise reduction, not aggressive dedup.
 *
 *  **Why a closed list rather than a regex catch-all** like
 *  `/^utm_/`: explicit beats clever. A future param `utm_foo`
 *  becomes a deliberate decision rather than silent inclusion.
 *  The frozen Set guards against accidental mutation. */
export const TRACKING_PARAM_KEYS: ReadonlySet<string> = new Set([
  // Google Analytics / Marketing
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_referrer',
  'gclid',
  'gclsrc',
  '_ga',
  // Facebook / Meta
  'fbclid',
  // Microsoft / Bing
  'msclkid',
  // HubSpot
  '_hsenc',
  '_hsmi',
  '_hsfp',
  // Mailchimp
  'mc_eid',
  'mc_cid',
  // Vero / SendGrid / Mailgun
  'vero_id',
  'vero_conv',
  // Generic referral / share trackers
  'ref',
  'ref_src',
  'ref_url',
  'igshid',
  'icid',
  // Yandex
  'yclid',
  // Cloudflare email-protection
  '__cf_email__',
])

/**
 * Schemes whose URLs are passed through unchanged. These don't
 * have host/path/query in the standard URL sense; canonicalising
 * them would either be a no-op (mailto already has its own
 * canonical form) or actively wrong (data: URLs encode payload).
 */
const PASSTHROUGH_SCHEMES: ReadonlySet<string> = new Set([
  'mailto:',
  'tel:',
  'sms:',
  'javascript:',
  'data:',
  'blob:',
  'file:',
])

export interface CanonicaliseOptions {
  /**
   * Strip a leading `www.` from the host. Default: false. We default
   * OFF because `www` is sometimes a real subdomain that's meaningful
   * — a per-deployment decision based on the URL corpus. When the
   * curator KNOWS their input set treats `www.example.com` and
   * `example.com` as the same content, set this to true.
   */
  stripWww?: boolean
  /**
   * Strip the URL fragment (`#anchor`). Default: true. Almost always
   * the right call — different anchors point to the same content for
   * dedup purposes. Operators with anchor-routed SPAs (where the
   * fragment IS the route) should override.
   */
  stripFragment?: boolean
  /**
   * Custom additional tracking-param keys to strip on top of the
   * built-in `TRACKING_PARAM_KEYS`. Operator escape hatch — add
   * deployment-specific noise params without forking the const.
   */
  extraTrackingParams?: ReadonlyArray<string>
}

const DEFAULT_OPTIONS: Required<CanonicaliseOptions> = {
  stripWww: false,
  stripFragment: true,
  extraTrackingParams: [],
}

/**
 * Canonicalise a URL string for subject deduplication. Returns the
 * canonical form, the input unchanged for passthrough schemes, or
 * `null` for inputs that don't parse as URLs.
 *
 * Examples (with default options):
 *   `https://Example.com:443/foo/?utm_source=x&id=42#anchor`
 *     → `https://example.com/foo?id=42`
 *   `mailto:alice@example.com` → `mailto:alice@example.com` (passthrough)
 *   `not a url` → `null`
 */
export function canonicaliseUrl(
  input: string,
  options: CanonicaliseOptions = {},
): string | null {
  if (typeof input !== 'string' || input.length === 0) return null
  const opts = { ...DEFAULT_OPTIONS, ...options }

  // Passthrough check before URL parsing — `mailto:` etc. parse fine
  // but the canonicalisation logic below assumes a host/path/query
  // structure that doesn't apply to those schemes.
  for (const scheme of PASSTHROUGH_SCHEMES) {
    if (input.toLowerCase().startsWith(scheme)) {
      return input
    }
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }

  // Lowercase the host. The WHATWG URL parser already does this for
  // most cases, but defence in depth — explicit ToLowerCase keeps
  // the contract clear regardless of underlying parser quirks.
  let host = url.hostname.toLowerCase()
  if (opts.stripWww && host.startsWith('www.')) {
    // 'www.example.com' → 'example.com'. Keep 'wwwsomething.com'
    // (no trailing dot) untouched — only the literal 'www.' prefix
    // is treated as canonicalisable; defensive against false matches
    // on hosts that happen to start with the four chars 'wwwx'.
    host = host.slice(4)
  }

  // Strip default port (80 for http, 443 for https). Other schemes
  // keep their port because there's no portless "default" assumed.
  let portPart = ''
  if (url.port !== '') {
    if (
      (url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'https:' && url.port === '443')
    ) {
      portPart = ''
    } else {
      portPart = `:${url.port}`
    }
  }

  // Userinfo: preserve as-is. If the URI carries auth, it carries
  // auth (we don't pretend to dedup credentialled vs un-credentialled
  // forms — those are semantically different requests).
  const userInfo = url.username
    ? `${url.username}${url.password ? `:${url.password}` : ''}@`
    : ''

  // Strip trailing slash from path EXCEPT for root `/`. The WHATWG
  // URL parser canonicalises empty path to `/` already (so the input
  // `https://example.com` round-trips as `https://example.com/`).
  // Stripping the trailing slash from `/foo/` → `/foo` is the dedup
  // win; stripping the root `/` would produce `https://example.com`
  // which is NOT what the URL parser emits, breaking string-equality
  // comparisons against other code paths.
  let path = url.pathname
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1)
  }

  // Filter + sort query params. Tracking params from the closed list
  // (plus any operator-supplied extras) get dropped; remaining keys
  // sort alphabetically with stable per-key value ordering. Empty
  // result → no `?` in the output.
  const tracking = new Set([
    ...TRACKING_PARAM_KEYS,
    ...opts.extraTrackingParams,
  ])
  const params: Array<[string, string]> = []
  for (const [k, v] of url.searchParams) {
    if (!tracking.has(k)) {
      params.push([k, v])
    }
  }
  // Sort by key; ties (same-key repeated values) preserve insertion
  // order — important when an API uses `?id=1&id=2` to mean "both".
  params.sort((a, b) => {
    if (a[0] < b[0]) return -1
    if (a[0] > b[0]) return 1
    return 0
  })
  let queryPart = ''
  if (params.length > 0) {
    const usp = new URLSearchParams()
    for (const [k, v] of params) usp.append(k, v)
    queryPart = `?${usp.toString()}`
  }

  const fragment = opts.stripFragment ? '' : url.hash

  return `${url.protocol}//${userInfo}${host}${portPart}${path}${queryPart}${fragment}`
}
