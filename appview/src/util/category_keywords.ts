/**
 * Curated keyword → category-segment map for subject enrichment
 * (TN-ENRICH-002).
 *
 * Per Trust Network V1 plan §3.6.3:
 *
 *   > **Type=product:** ... `SubjectRef.name` matched against a
 *   > curated keyword map (`furniture`, `book`, `phone`, ...) →
 *   > adds second segment to category. The keyword map is
 *   > `appview/src/util/category_keywords.ts`, ~200 entries,
 *   > maintained as a flat TS file.
 *
 * And for places:
 *
 *   > **Type=place:** ... `SubjectRef.name` matched against place
 *   > keyword map (`restaurant`, `cafe`, `hotel`, ...) →
 *   > `metadata.place_type` and category second segment.
 *
 * The category_keywords map serves BOTH product and place enrichment
 * — the segment is the same regardless of subject type. Caller (the
 * heuristic enricher in TN-ENRICH-005) composes the full category
 * string by prefixing with the SubjectRef.type:
 *
 *     type=product, name="Aeron chair" → keyword 'chair' → 'furniture'
 *                                       → category = 'product:furniture'
 *     type=place,   name="Mona Cafe"   → keyword 'cafe'  → 'cafe'
 *                                       → category = 'place:cafe'
 *
 * **Matching rules:**
 *   - Case-insensitive.
 *   - Word-boundary match — `chair` matches "Aeron chair" but NOT
 *     "chairman" (regression-pinned). For multi-word keywords like
 *     `dining table`, the entire phrase must appear with word
 *     boundaries around it (so "round dining table 6-seat" matches,
 *     "dining-table" does not — hyphens count as word characters in
 *     the JS `\b` regex).
 *   - First match wins. The keyword list is pre-sorted so longer
 *     keywords (e.g. `dining table`) are tried before any shorter
 *     keyword that would otherwise win on a substring match.
 *   - Whitespace in the input is normalized to single spaces before
 *     matching, so "Aeron  chair" (double space) matches "chair"
 *     just like "Aeron chair".
 *
 * **Curation guidelines for additions:**
 *   - Use the canonical English noun. Hyphenated forms (e.g.
 *     `t-shirt`) are added as separate entries (the `\b` regex
 *     treats `-` as a word character).
 *   - Avoid ambiguous words ("apple" — fruit or company? skip both;
 *     the brand is in `known_orgs.ts` and the fruit is too generic
 *     to enrich).
 *   - Plurals inflect — "chairs" matches "chair" because we match
 *     `chair` as a substring with word boundaries on the start side
 *     only? NO — we use full `\b` on both sides. The list includes
 *     both singular and common plural where users typically write
 *     either. (E.g. "headphones" — almost always plural.)
 *
 * Updates land in this file as PRs; deploy + re-enrichment batch
 * follows (plan §3.6.4).
 *
 * Pure data + pure lookup. Zero deps.
 */

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Category segments are free-form strings rather than a closed enum
 * because the curator should be able to add new segments without
 * touching the type — the segment is just metadata for downstream
 * filtering. Common segments are documented in plan §3.6.1's
 * examples (`product:chair`, `place:restaurant`, `content:video`).
 */
export type CategorySegment = string

export interface KeywordEntry {
  /** Lowercase keyword. Multi-word allowed (e.g. `dining table`). */
  readonly keyword: string
  readonly segment: CategorySegment
}

// ─── Curated entries ─────────────────────────────────────────────────────

/**
 * V1-launch baseline. Plan target is ~200 entries; the table below
 * seeds ~85 representative keywords spanning the categories users
 * actually type into review names. Future expansions add more —
 * this file IS the editorial source of truth, plain TypeScript so
 * a code review can scan diffs at a glance.
 *
 * Multi-word entries appear FIRST in their semantic group so the
 * lookup's longest-first sort matches "dining table" before "table".
 */
const RAW_KEYWORDS: readonly KeywordEntry[] = [
  // ── Furniture ─────────────────────────────────────────────────
  { keyword: 'dining table', segment: 'furniture' },
  { keyword: 'coffee table', segment: 'furniture' },
  { keyword: 'office chair', segment: 'furniture' },
  { keyword: 'chair', segment: 'furniture' },
  { keyword: 'table', segment: 'furniture' },
  { keyword: 'sofa', segment: 'furniture' },
  { keyword: 'couch', segment: 'furniture' },
  { keyword: 'bed', segment: 'furniture' },
  { keyword: 'mattress', segment: 'furniture' },
  { keyword: 'desk', segment: 'furniture' },
  { keyword: 'shelf', segment: 'furniture' },
  { keyword: 'bookshelf', segment: 'furniture' },
  { keyword: 'wardrobe', segment: 'furniture' },
  { keyword: 'cabinet', segment: 'furniture' },
  { keyword: 'lamp', segment: 'furniture' },
  { keyword: 'rug', segment: 'furniture' },

  // ── Electronics ───────────────────────────────────────────────
  { keyword: 'smart phone', segment: 'electronics' },
  { keyword: 'smartphone', segment: 'electronics' },
  { keyword: 'phone', segment: 'electronics' },
  { keyword: 'laptop', segment: 'electronics' },
  { keyword: 'computer', segment: 'electronics' },
  { keyword: 'monitor', segment: 'electronics' },
  { keyword: 'keyboard', segment: 'electronics' },
  { keyword: 'mouse', segment: 'electronics' },
  { keyword: 'headphones', segment: 'electronics' },
  { keyword: 'earbuds', segment: 'electronics' },
  { keyword: 'speaker', segment: 'electronics' },
  { keyword: 'camera', segment: 'electronics' },
  { keyword: 'tv', segment: 'electronics' },
  { keyword: 'television', segment: 'electronics' },
  { keyword: 'tablet', segment: 'electronics' },
  { keyword: 'watch', segment: 'electronics' },
  { keyword: 'router', segment: 'electronics' },

  // ── Books ─────────────────────────────────────────────────────
  { keyword: 'textbook', segment: 'book' },
  { keyword: 'cookbook', segment: 'book' },
  { keyword: 'novel', segment: 'book' },
  { keyword: 'memoir', segment: 'book' },
  { keyword: 'biography', segment: 'book' },
  { keyword: 'book', segment: 'book' },

  // ── Apparel ───────────────────────────────────────────────────
  { keyword: 't-shirt', segment: 'apparel' },
  { keyword: 'tshirt', segment: 'apparel' },
  { keyword: 'shirt', segment: 'apparel' },
  { keyword: 'jacket', segment: 'apparel' },
  { keyword: 'coat', segment: 'apparel' },
  { keyword: 'sweater', segment: 'apparel' },
  { keyword: 'hoodie', segment: 'apparel' },
  { keyword: 'sneakers', segment: 'apparel' },
  { keyword: 'shoes', segment: 'apparel' },
  { keyword: 'boots', segment: 'apparel' },
  { keyword: 'dress', segment: 'apparel' },
  { keyword: 'pants', segment: 'apparel' },
  { keyword: 'jeans', segment: 'apparel' },
  { keyword: 'backpack', segment: 'apparel' },

  // ── Beauty ────────────────────────────────────────────────────
  { keyword: 'shampoo', segment: 'beauty' },
  { keyword: 'conditioner', segment: 'beauty' },
  { keyword: 'lipstick', segment: 'beauty' },
  { keyword: 'foundation', segment: 'beauty' },
  { keyword: 'mascara', segment: 'beauty' },
  { keyword: 'perfume', segment: 'beauty' },
  { keyword: 'cologne', segment: 'beauty' },
  { keyword: 'sunscreen', segment: 'beauty' },
  { keyword: 'moisturizer', segment: 'beauty' },

  // ── Tools / Outdoors ──────────────────────────────────────────
  { keyword: 'power drill', segment: 'tools' },
  { keyword: 'drill', segment: 'tools' },
  { keyword: 'saw', segment: 'tools' },
  { keyword: 'hammer', segment: 'tools' },
  { keyword: 'wrench', segment: 'tools' },
  { keyword: 'tent', segment: 'outdoors' },
  { keyword: 'sleeping bag', segment: 'outdoors' },
  { keyword: 'bicycle', segment: 'outdoors' },
  { keyword: 'bike', segment: 'outdoors' },
  { keyword: 'kayak', segment: 'outdoors' },

  // ── Place: food / drink ──────────────────────────────────────
  { keyword: 'coffee shop', segment: 'cafe' },
  { keyword: 'wine bar', segment: 'bar' },
  { keyword: 'restaurant', segment: 'restaurant' },
  // `café` (with accent) doesn't need its own entry — `normaliseInput`
  // strips accents (NFD + drop combining marks) before matching, so
  // both "café" and "cafe" hit the plain `cafe` keyword.
  { keyword: 'cafe', segment: 'cafe' },
  { keyword: 'coffee', segment: 'cafe' },
  { keyword: 'bar', segment: 'bar' },
  { keyword: 'pub', segment: 'bar' },
  { keyword: 'bakery', segment: 'bakery' },
  { keyword: 'diner', segment: 'restaurant' },
  { keyword: 'pizzeria', segment: 'restaurant' },

  // ── Place: accommodation ─────────────────────────────────────
  { keyword: 'hotel', segment: 'hotel' },
  { keyword: 'motel', segment: 'hotel' },
  { keyword: 'hostel', segment: 'hostel' },
  { keyword: 'inn', segment: 'hotel' },

  // ── Place: services / health ─────────────────────────────────
  { keyword: 'gym', segment: 'gym' },
  { keyword: 'salon', segment: 'salon' },
  { keyword: 'barbershop', segment: 'salon' },
  { keyword: 'library', segment: 'library' },
  { keyword: 'hospital', segment: 'hospital' },
  { keyword: 'clinic', segment: 'clinic' },
  { keyword: 'dentist', segment: 'dentist' },
  { keyword: 'dental clinic', segment: 'dentist' },
  { keyword: 'pharmacy', segment: 'pharmacy' },

  // ── Place: retail ────────────────────────────────────────────
  { keyword: 'grocery store', segment: 'grocery' },
  { keyword: 'bookstore', segment: 'bookstore' },
  { keyword: 'store', segment: 'store' },
  { keyword: 'shop', segment: 'store' },
  { keyword: 'market', segment: 'market' },
  { keyword: 'mall', segment: 'mall' },

  // ── Place: leisure ───────────────────────────────────────────
  { keyword: 'park', segment: 'park' },
  { keyword: 'museum', segment: 'museum' },
  { keyword: 'theater', segment: 'theater' },
  { keyword: 'theatre', segment: 'theater' },
  { keyword: 'cinema', segment: 'cinema' },
  { keyword: 'gallery', segment: 'gallery' },
]

// ─── Compiled lookup ─────────────────────────────────────────────────────

/**
 * Sorted by keyword length descending so multi-word keywords match
 * before single-word ones at the same prefix. Frozen at module load
 * — caller cannot mutate.
 *
 * Invariants pinned by test:
 *   - No duplicate keywords.
 *   - Sort order: keyword.length DESCENDING (with `keyword` ascending
 *     as a stable tiebreak for determinism across runs).
 */
const KEYWORDS: readonly KeywordEntry[] = Object.freeze(
  [...RAW_KEYWORDS].sort((a, b) => {
    if (b.keyword.length !== a.keyword.length) return b.keyword.length - a.keyword.length
    if (a.keyword < b.keyword) return -1
    if (a.keyword > b.keyword) return 1
    return 0
  }).map((e) => Object.freeze({ ...e })),
)

/**
 * Pre-compile each keyword to a `\b<keyword>\b` regex. Keywords are
 * lowercase + space-normalised already, so the only escaping we need
 * is for regex meta-chars (the seed list happens not to use any, but
 * defensive escaping protects against future additions like `c++`).
 */
const KEYWORD_REGEXES: readonly { regex: RegExp; segment: CategorySegment }[] = Object.freeze(
  KEYWORDS.map((e) => ({
    regex: new RegExp(`\\b${escapeRegex(e.keyword)}\\b`),
    segment: e.segment,
  })),
)

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Look up the best-matching category segment for a subject name.
 *
 * Returns the segment of the FIRST keyword that matches (longest-
 * first order), or `null` if no keyword matches.
 *
 * Caller composes the full category string:
 *   `${SubjectRef.type}:${segment}` (e.g. `'product:furniture'`).
 *
 * For empty / non-string input, returns `null` rather than throwing
 * — enrichment is best-effort per plan §3.6.1 and missing fields
 * just mean the subject won't surface for that filter.
 */
export function lookupCategorySegment(name: string | null | undefined): CategorySegment | null {
  if (typeof name !== 'string') return null
  const normalised = normaliseInput(name)
  if (normalised.length === 0) return null

  for (const { regex, segment } of KEYWORD_REGEXES) {
    if (regex.test(normalised)) return segment
  }
  return null
}

/**
 * Test-only introspection — pinned by test to assert curation
 * hygiene (zero duplicates, monotonic length-sort, in-budget size).
 */
export function categoryKeywordsStats(): {
  count: number
  segments: number
  sortedDescByLength: boolean
  hasDuplicates: boolean
} {
  const segments = new Set(KEYWORDS.map((e) => e.segment))
  const seenKeywords = new Set<string>()
  let hasDuplicates = false
  for (const e of KEYWORDS) {
    if (seenKeywords.has(e.keyword)) {
      hasDuplicates = true
      break
    }
    seenKeywords.add(e.keyword)
  }
  let sortedDescByLength = true
  for (let i = 1; i < KEYWORDS.length; i += 1) {
    const prev = KEYWORDS[i - 1]
    const cur = KEYWORDS[i]
    if (prev === undefined || cur === undefined) continue
    if (cur.keyword.length > prev.keyword.length) {
      sortedDescByLength = false
      break
    }
  }
  return {
    count: KEYWORDS.length,
    segments: segments.size,
    sortedDescByLength,
    hasDuplicates,
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────

function normaliseInput(name: string): string {
  return name
    .trim()
    .toLowerCase()
    // Strip combining marks (accents) so "café" matches `cafe`.
    // NFD splits `é` into `e` + `́` (combining acute); we drop
    // the marks and keep the base letter.
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
}

function escapeRegex(s: string): string {
  // Escape regex meta-characters. The seed list doesn't use any,
  // but a future addition like `c++` or `c#` needs this guard.
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
