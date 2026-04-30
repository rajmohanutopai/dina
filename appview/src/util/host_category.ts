/**
 * Curated host → category map for content subject enrichment (TN-ENRICH-001).
 *
 * Per Trust Network V1 plan §3.6.3:
 *
 *   > **Type=content:** `SubjectRef.uri` host present →
 *   > `metadata.host = <host>`, `category = 'content'`. Host map:
 *   > `youtube.com / youtu.be → media_type='video'`,
 *   > `medium.com / substack.com / *.blog → media_type='article'`,
 *   > `spotify.com/episode/... → media_type='podcast'`,
 *   > `twitter.com / x.com / bsky.app → media_type='social_post'`.
 *   > Map lives in `appview/src/util/host_category.ts`, ~50 entries.
 *
 * And test contract per plan line 1274:
 *
 *   > Each entry in the host map produces the documented `category`
 *   > + `media_type`; unknown hosts default to `category='content'`
 *   > with `host` populated.
 *
 * The default-handling lives at the caller (subject_enrichment.ts);
 * this module returns `null` for unknown hosts and lets the caller
 * compose the fallback. Reason: the default is metadata-bearing
 * (it populates `metadata.host`) so it crosses module boundaries
 * and shouldn't be swallowed by a "lookup returned default" path.
 *
 * Wildcard semantics:
 *   - Exact host match (`youtube.com` matches `youtube.com`).
 *   - Subdomain noise stripped: leading `www.` and `m.` removed
 *     before matching, so `www.youtube.com` resolves to the
 *     `youtube.com` entry.
 *   - Suffix wildcards `*.<suffix>` match any host ending in
 *     `.<suffix>` (`*.blog` matches `mike.blog`, `kara.blog`, but
 *     NOT `blog.com`).
 *
 * Path-specific rules (e.g. `spotify.com/episode/...` → podcast vs
 * `spotify.com/track/...` → music) are NOT covered by this map; the
 * map keys on host only. The seed list intentionally excludes hosts
 * whose category depends on path — adding them would require a
 * structural change (path predicates) that V1 doesn't need yet.
 *
 * Updates to this map require a deploy + re-enrichment batch
 * (`subject_enrich_recompute`, plan §3.6.4). The seeded entries
 * here are the V1 launch set; expand by editing this file.
 *
 * Pure data + pure lookup. Zero deps.
 */

// ─── Public types ─────────────────────────────────────────────────────────

export type ContentMediaType =
  | 'video'
  | 'article'
  | 'podcast'
  | 'social_post'
  | 'forum'
  | 'code'
  | 'image'
  | 'shortform_video'

export interface HostCategoryEntry {
  /** Always `'content'` in V1 — non-content hosts route through other heuristics. */
  readonly category: 'content'
  readonly media_type: ContentMediaType
}

// ─── Curated entries ─────────────────────────────────────────────────────

/**
 * Exact-host entries. Keys are normalized (lowercase, no leading
 * `www.` / `m.`). Subdomains beyond `www.` / `m.` (e.g.
 * `staff.medium.com`) do NOT match — the curator should add them
 * explicitly if needed. We DO NOT match by suffix on these: a host
 * like `notyoutube.com` must not silently pick up the youtube entry.
 *
 * Frozen at module load so a downstream import can't poison the map.
 */
const EXACT_HOSTS: ReadonlyMap<string, HostCategoryEntry> = new Map([
  // Video — long-form
  ['youtube.com', frozen({ category: 'content', media_type: 'video' })],
  ['youtu.be', frozen({ category: 'content', media_type: 'video' })],
  ['vimeo.com', frozen({ category: 'content', media_type: 'video' })],
  ['twitch.tv', frozen({ category: 'content', media_type: 'video' })],
  ['nebula.tv', frozen({ category: 'content', media_type: 'video' })],
  ['rumble.com', frozen({ category: 'content', media_type: 'video' })],
  ['dailymotion.com', frozen({ category: 'content', media_type: 'video' })],

  // Video — short-form (algorithmic-feed sources)
  ['tiktok.com', frozen({ category: 'content', media_type: 'shortform_video' })],

  // Article / long-form text
  ['medium.com', frozen({ category: 'content', media_type: 'article' })],
  ['substack.com', frozen({ category: 'content', media_type: 'article' })],
  ['ghost.io', frozen({ category: 'content', media_type: 'article' })],
  ['wordpress.com', frozen({ category: 'content', media_type: 'article' })],
  ['blogger.com', frozen({ category: 'content', media_type: 'article' })],
  ['notion.site', frozen({ category: 'content', media_type: 'article' })],
  ['hashnode.dev', frozen({ category: 'content', media_type: 'article' })],
  ['dev.to', frozen({ category: 'content', media_type: 'article' })],

  // Podcast
  ['overcast.fm', frozen({ category: 'content', media_type: 'podcast' })],
  ['pca.st', frozen({ category: 'content', media_type: 'podcast' })],
  ['anchor.fm', frozen({ category: 'content', media_type: 'podcast' })],
  ['castro.fm', frozen({ category: 'content', media_type: 'podcast' })],
  // `podcasts.apple.com` is the canonical subdomain; the
  // path-flavoured `apple.com/podcasts` form normalises to bare
  // `apple.com` after path-stripping (which is a non-podcast
  // homepage), so we don't claim it here. Path-specific routing
  // lives in `subject_enrichment.ts`'s heuristic layer.
  ['podcasts.apple.com', frozen({ category: 'content', media_type: 'podcast' })],

  // Social post
  ['twitter.com', frozen({ category: 'content', media_type: 'social_post' })],
  ['x.com', frozen({ category: 'content', media_type: 'social_post' })],
  ['bsky.app', frozen({ category: 'content', media_type: 'social_post' })],
  ['mastodon.social', frozen({ category: 'content', media_type: 'social_post' })],
  ['threads.net', frozen({ category: 'content', media_type: 'social_post' })],
  ['linkedin.com', frozen({ category: 'content', media_type: 'social_post' })],
  ['facebook.com', frozen({ category: 'content', media_type: 'social_post' })],

  // Forum / Q&A
  ['reddit.com', frozen({ category: 'content', media_type: 'forum' })],
  ['old.reddit.com', frozen({ category: 'content', media_type: 'forum' })],
  ['news.ycombinator.com', frozen({ category: 'content', media_type: 'forum' })],
  ['lobste.rs', frozen({ category: 'content', media_type: 'forum' })],
  ['stackoverflow.com', frozen({ category: 'content', media_type: 'forum' })],
  ['stackexchange.com', frozen({ category: 'content', media_type: 'forum' })],
  ['superuser.com', frozen({ category: 'content', media_type: 'forum' })],
  ['serverfault.com', frozen({ category: 'content', media_type: 'forum' })],
  ['quora.com', frozen({ category: 'content', media_type: 'forum' })],

  // Code
  ['github.com', frozen({ category: 'content', media_type: 'code' })],
  ['gitlab.com', frozen({ category: 'content', media_type: 'code' })],
  ['bitbucket.org', frozen({ category: 'content', media_type: 'code' })],
  ['codeberg.org', frozen({ category: 'content', media_type: 'code' })],
  ['gist.github.com', frozen({ category: 'content', media_type: 'code' })],
  ['npmjs.com', frozen({ category: 'content', media_type: 'code' })],
  ['pypi.org', frozen({ category: 'content', media_type: 'code' })],
  ['crates.io', frozen({ category: 'content', media_type: 'code' })],

  // Image
  ['flickr.com', frozen({ category: 'content', media_type: 'image' })],
  ['imgur.com', frozen({ category: 'content', media_type: 'image' })],
  ['instagram.com', frozen({ category: 'content', media_type: 'image' })],
  ['unsplash.com', frozen({ category: 'content', media_type: 'image' })],
  ['pinterest.com', frozen({ category: 'content', media_type: 'image' })],
])

/**
 * Suffix-wildcard entries. Each `suffix` is the host suffix the
 * caller's normalized host must end with — including the leading
 * dot. So the literal `*.blog` is encoded as `.blog`.
 *
 * Order matters: longer suffixes match before shorter ones. Stored
 * pre-sorted by suffix length (descending) so the lookup loop is a
 * straight scan.
 */
const WILDCARD_SUFFIXES: readonly { readonly suffix: string; readonly entry: HostCategoryEntry }[] =
  Object.freeze([
    { suffix: '.blog', entry: frozen({ category: 'content', media_type: 'article' }) },
    { suffix: '.tumblr.com', entry: frozen({ category: 'content', media_type: 'article' }) },
    { suffix: '.substack.com', entry: frozen({ category: 'content', media_type: 'article' }) },
    { suffix: '.medium.com', entry: frozen({ category: 'content', media_type: 'article' }) },
    { suffix: '.wordpress.com', entry: frozen({ category: 'content', media_type: 'article' }) },
  ].sort((a, b) => b.suffix.length - a.suffix.length))

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Normalize a URL or bare host into a lookup key.
 *
 *   - Strips `http(s)://` / `at://` / etc.
 *   - Strips port (`:8080`) and path / query.
 *   - Lowercases.
 *   - Strips leading `www.` and `m.` (common subdomain noise that
 *     shouldn't fork a curated entry).
 *
 * Returns `null` for empty or non-string input — the caller's
 * fallback (`metadata.host = null`) is the documented behaviour.
 */
export function normalizeHost(hostOrUrl: string | null | undefined): string | null {
  if (typeof hostOrUrl !== 'string') return null
  const trimmed = hostOrUrl.trim()
  if (trimmed.length === 0) return null

  // Strip scheme if present.
  let host = trimmed
  const schemeMatch = host.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//)
  if (schemeMatch) {
    host = host.slice(schemeMatch[0].length)
  }

  // Strip path / query / fragment.
  const slashIx = host.indexOf('/')
  if (slashIx >= 0) host = host.slice(0, slashIx)
  const qIx = host.indexOf('?')
  if (qIx >= 0) host = host.slice(0, qIx)
  const hashIx = host.indexOf('#')
  if (hashIx >= 0) host = host.slice(0, hashIx)

  // Strip user-info (e.g. `user:pass@host`).
  const atIx = host.indexOf('@')
  if (atIx >= 0) host = host.slice(atIx + 1)

  // Strip port — only when the segment after the LAST colon is all
  // digits. Naively splitting at the first `:` would corrupt
  // colon-bearing hosts like `did:plc:author` (used by AT-URIs).
  const portIx = host.lastIndexOf(':')
  if (portIx >= 0 && /^\d+$/.test(host.slice(portIx + 1))) {
    host = host.slice(0, portIx)
  }

  // Lowercase.
  host = host.toLowerCase()

  // Strip leading `www.` / `m.`.
  if (host.startsWith('www.')) host = host.slice(4)
  else if (host.startsWith('m.')) host = host.slice(2)

  return host.length > 0 ? host : null
}

/**
 * Look up a host or URL in the curated map.
 *
 * Returns the matching entry or `null` if unknown. Wildcard suffixes
 * match by host-ends-with check. Caller composes the fallback (per
 * plan §3.6.3 line 1274 — unknown hosts default to
 * `category='content'` with `host` populated, which is metadata-
 * level info this lookup doesn't own).
 */
export function lookupHost(hostOrUrl: string | null | undefined): HostCategoryEntry | null {
  const host = normalizeHost(hostOrUrl)
  if (host === null) return null

  const exact = EXACT_HOSTS.get(host)
  if (exact !== undefined) return exact

  for (const { suffix, entry } of WILDCARD_SUFFIXES) {
    if (host.endsWith(suffix) && host.length > suffix.length) {
      return entry
    }
  }
  return null
}

/**
 * Test-only introspection: how many curated entries does the map
 * carry? Pinned by test to stay near the plan's ~50 budget so
 * future expansions stay scoped.
 */
export function curatedHostCount(): { exact: number; wildcards: number } {
  return { exact: EXACT_HOSTS.size, wildcards: WILDCARD_SUFFIXES.length }
}

// ─── Internal ─────────────────────────────────────────────────────────────

function frozen(entry: HostCategoryEntry): HostCategoryEntry {
  return Object.freeze({ ...entry })
}
