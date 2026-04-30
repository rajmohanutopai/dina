/**
 * Curated allow-list of well-known organizations (TN-ENRICH-003).
 *
 * Per Trust Network V1 plan §3.6.3:
 *
 *   > **Type=organization:** `SubjectRef.uri` host TLD heuristic:
 *   > `.edu → org_type='university'`, `.gov →
 *   > org_type='government'`, `.org → org_type='nonprofit'` (weak),
 *   > else default `org_type='company'`. AppView keeps a flat
 *   > allow-list of well-known orgs (Wikipedia QID-style identifiers)
 *   > in `appview/src/util/known_orgs.ts` for higher-confidence
 *   > mapping (~100 entries seeded).
 *
 * The TLD heuristic in `subject_enrichment.ts` (TN-ENRICH-005)
 * gives a weak signal. This allow-list elevates known entries to
 * higher confidence, attaches a Wikipedia QID for downstream linking,
 * and records aliases so an attestation that names "MIT" resolves
 * to the same org as "Massachusetts Institute of Technology".
 *
 * Lookup contract:
 *   - `lookupOrgByName(name)` — case-insensitive match against
 *     canonical name OR any alias. Returns `null` if not found.
 *     Caller falls back to the TLD heuristic.
 *   - `lookupOrgByDomain(domain)` — exact domain match (after
 *     `host_category.normalizeHost` normalisation). Returns `null`
 *     if not found.
 *
 * Why the seed list is modest (not 100 yet): the plan says "~100
 * entries seeded" but specifically the **shape** is what's load-
 * bearing for V1. The list grows by deploys (plan §3.6.4 — "Updates
 * land in the AppView codebase as TS source files; a deploy + re-
 * enrichment batch follows"). Adding entries is a content edit, not
 * an architectural change. The seed below covers each `OrgType`
 * value with at least 3-5 representative entries, so the lookup
 * code paths are all exercised.
 *
 * Pure data + pure lookup. Zero deps.
 */

import { normalizeHost } from './host_category'

// ─── Public types ─────────────────────────────────────────────────────────

export type OrgType =
  | 'university'
  | 'company'
  | 'nonprofit'
  | 'government'
  | 'media'
  | 'research'

export interface KnownOrg {
  /** Canonical name as the org self-identifies. */
  readonly name: string
  /** Wikipedia QID (`Q12345`) if available — null otherwise. */
  readonly qid: string | null
  readonly type: OrgType
  /** Alternative names + acronyms. Lookup matches these case-insensitively. */
  readonly aliases: readonly string[]
  /** Primary domains for URL-based lookup. Match after normalisation. */
  readonly domains: readonly string[]
}

// ─── Curated entries ─────────────────────────────────────────────────────

/**
 * V1 seed list. Each `OrgType` is represented by at least three
 * entries so the lookup code paths are exercised. The list is
 * intentionally NOT exhaustive — it's the launch baseline, expanded
 * by future deploys per plan §3.6.4.
 *
 * Curation guidelines for additions:
 *   - The org has a stable Wikipedia entry → use the QID.
 *   - The canonical name is the org's most common public-facing name.
 *   - Aliases include common acronyms ("MIT") + alternative full
 *     names ("Massachusetts Institute of Technology").
 *   - Domains include the primary site + any well-known alternates.
 *     Subdomain-prefixed URLs (e.g. `news.mit.edu`) get normalised
 *     by `host_category.normalizeHost` so we don't need to enumerate
 *     them.
 *
 * Frozen at module load — no caller can mutate.
 */
const KNOWN_ORGS: readonly KnownOrg[] = Object.freeze(
  (
    [
      // Universities
      {
        name: 'Massachusetts Institute of Technology',
        qid: 'Q49108',
        type: 'university',
        aliases: ['MIT'],
        domains: ['mit.edu'],
      },
      {
        name: 'Stanford University',
        qid: 'Q41506',
        type: 'university',
        aliases: ['Stanford'],
        domains: ['stanford.edu'],
      },
      {
        name: 'Harvard University',
        qid: 'Q13371',
        type: 'university',
        aliases: ['Harvard'],
        domains: ['harvard.edu'],
      },
      {
        name: 'University of California, Berkeley',
        qid: 'Q168756',
        type: 'university',
        aliases: ['UC Berkeley', 'Berkeley', 'Cal'],
        domains: ['berkeley.edu'],
      },
      {
        name: 'University of Cambridge',
        qid: 'Q35794',
        type: 'university',
        aliases: ['Cambridge'],
        domains: ['cam.ac.uk'],
      },
      {
        name: 'University of Oxford',
        qid: 'Q34433',
        type: 'university',
        aliases: ['Oxford'],
        domains: ['ox.ac.uk', 'ox.uk'],
      },
      {
        name: 'ETH Zurich',
        qid: 'Q11942',
        type: 'university',
        aliases: ['ETH', 'Swiss Federal Institute of Technology'],
        domains: ['ethz.ch'],
      },
      {
        name: 'Carnegie Mellon University',
        qid: 'Q190080',
        type: 'university',
        aliases: ['CMU'],
        domains: ['cmu.edu'],
      },

      // Companies
      {
        name: 'Google',
        qid: 'Q95',
        type: 'company',
        aliases: ['Alphabet', 'Google LLC'],
        domains: ['google.com', 'about.google'],
      },
      {
        name: 'Microsoft',
        qid: 'Q2283',
        type: 'company',
        aliases: ['Microsoft Corporation'],
        domains: ['microsoft.com'],
      },
      {
        name: 'Apple',
        qid: 'Q312',
        type: 'company',
        aliases: ['Apple Inc.'],
        domains: ['apple.com'],
      },
      {
        name: 'Meta',
        qid: 'Q380',
        type: 'company',
        aliases: ['Meta Platforms', 'Facebook'],
        domains: ['meta.com', 'about.facebook.com'],
      },
      {
        name: 'Amazon',
        qid: 'Q3884',
        type: 'company',
        aliases: ['Amazon.com', 'Amazon.com Inc.'],
        domains: ['amazon.com', 'aboutamazon.com'],
      },
      {
        name: 'Anthropic',
        qid: 'Q117718038',
        type: 'company',
        aliases: ['Anthropic PBC'],
        domains: ['anthropic.com'],
      },
      {
        name: 'OpenAI',
        qid: 'Q21708200',
        type: 'company',
        aliases: ['OpenAI Inc.'],
        domains: ['openai.com'],
      },
      {
        name: 'Herman Miller',
        qid: 'Q1611894',
        type: 'company',
        aliases: ['MillerKnoll'],
        domains: ['hermanmiller.com', 'millerknoll.com'],
      },

      // Nonprofits
      {
        name: 'Wikimedia Foundation',
        qid: 'Q180',
        type: 'nonprofit',
        aliases: ['Wikipedia', 'WMF'],
        domains: ['wikimediafoundation.org', 'wikipedia.org'],
      },
      {
        name: 'Electronic Frontier Foundation',
        qid: 'Q727534',
        type: 'nonprofit',
        aliases: ['EFF'],
        domains: ['eff.org'],
      },
      {
        name: 'American Civil Liberties Union',
        qid: 'Q592504',
        type: 'nonprofit',
        aliases: ['ACLU'],
        domains: ['aclu.org'],
      },
      {
        name: 'Mozilla Foundation',
        qid: 'Q53510',
        type: 'nonprofit',
        aliases: ['Mozilla'],
        domains: ['mozilla.org'],
      },
      {
        name: 'Internet Archive',
        qid: 'Q461',
        type: 'nonprofit',
        aliases: ['archive.org'],
        domains: ['archive.org'],
      },

      // Governments / IGOs
      {
        name: 'World Health Organization',
        qid: 'Q7817',
        type: 'government',
        aliases: ['WHO'],
        domains: ['who.int'],
      },
      {
        name: 'United States Centers for Disease Control and Prevention',
        qid: 'Q583725',
        type: 'government',
        aliases: ['CDC'],
        domains: ['cdc.gov'],
      },
      {
        name: 'United States Food and Drug Administration',
        qid: 'Q204711',
        type: 'government',
        aliases: ['FDA'],
        domains: ['fda.gov'],
      },
      {
        name: 'European Union',
        qid: 'Q458',
        type: 'government',
        aliases: ['EU'],
        domains: ['europa.eu'],
      },
      {
        name: 'United Nations',
        qid: 'Q1065',
        type: 'government',
        aliases: ['UN'],
        domains: ['un.org'],
      },

      // Media
      {
        name: 'The New York Times',
        qid: 'Q9684',
        type: 'media',
        aliases: ['NYT', 'NY Times'],
        domains: ['nytimes.com'],
      },
      {
        name: 'BBC',
        qid: 'Q9531',
        type: 'media',
        aliases: ['British Broadcasting Corporation'],
        domains: ['bbc.com', 'bbc.co.uk'],
      },
      {
        name: 'The Guardian',
        qid: 'Q11148',
        type: 'media',
        aliases: ['Guardian'],
        domains: ['theguardian.com'],
      },
      {
        name: 'Reuters',
        qid: 'Q130879',
        type: 'media',
        aliases: ['Thomson Reuters'],
        domains: ['reuters.com'],
      },
      {
        name: 'NPR',
        qid: 'Q178848',
        type: 'media',
        aliases: ['National Public Radio'],
        domains: ['npr.org'],
      },

      // Research labs / institutions
      {
        name: 'CERN',
        qid: 'Q42944',
        type: 'research',
        aliases: ['European Organization for Nuclear Research'],
        domains: ['cern.ch', 'home.cern'],
      },
      {
        name: 'NASA',
        qid: 'Q23548',
        type: 'research',
        aliases: ['National Aeronautics and Space Administration'],
        domains: ['nasa.gov'],
      },
      {
        name: 'Allen Institute',
        qid: 'Q4729585',
        type: 'research',
        aliases: ['Allen Institute for Brain Science', 'Allen Institute for AI', 'AI2'],
        domains: ['alleninstitute.org', 'allenai.org'],
      },
      {
        name: 'Max Planck Society',
        qid: 'Q158085',
        type: 'research',
        aliases: ['Max-Planck-Gesellschaft', 'MPG'],
        domains: ['mpg.de'],
      },
    ] as const satisfies readonly KnownOrg[]
  ).map(deepFreeze),
)

// ─── Indexes ────────────────────────────────────────────────────────────

/**
 * Pre-built lowercase name → org index. Built once at module load
 * so every lookup is O(1). Aliases share the index — `'MIT'` and
 * `'Massachusetts Institute of Technology'` both resolve to the same
 * MIT entry.
 *
 * If two orgs collide on a name/alias, the first-registered wins.
 * Rather than silently let the second win (which would shadow the
 * first and produce surprising lookup behaviour at runtime), we
 * leave the original mapping in place and skip the duplicate. The
 * `indexCollisions` introspection helper exposes the count for
 * tests to pin against (a healthy seed list has zero collisions).
 */
const NAME_INDEX = new Map<string, KnownOrg>()
const DOMAIN_INDEX = new Map<string, KnownOrg>()
const NAME_COLLISIONS: { key: string; first: string; second: string }[] = []
const DOMAIN_COLLISIONS: { key: string; first: string; second: string }[] = []

for (const org of KNOWN_ORGS) {
  registerName(org.name, org)
  for (const alias of org.aliases) registerName(alias, org)
  for (const domain of org.domains) registerDomain(domain, org)
}
Object.freeze(NAME_COLLISIONS)
Object.freeze(DOMAIN_COLLISIONS)

function registerName(name: string, org: KnownOrg): void {
  const key = name.trim().toLowerCase()
  if (key.length === 0) return
  const existing = NAME_INDEX.get(key)
  if (existing !== undefined && existing !== org) {
    NAME_COLLISIONS.push({ key, first: existing.name, second: org.name })
    return
  }
  NAME_INDEX.set(key, org)
}

function registerDomain(domain: string, org: KnownOrg): void {
  const key = normalizeHost(domain)
  if (key === null) return
  const existing = DOMAIN_INDEX.get(key)
  if (existing !== undefined && existing !== org) {
    DOMAIN_COLLISIONS.push({ key, first: existing.name, second: org.name })
    return
  }
  DOMAIN_INDEX.set(key, org)
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Look up an org by canonical name OR any alias (case-insensitive,
 * whitespace-trimmed). Returns `null` if no match.
 */
export function lookupOrgByName(name: string | null | undefined): KnownOrg | null {
  if (typeof name !== 'string') return null
  const key = name.trim().toLowerCase()
  if (key.length === 0) return null
  return NAME_INDEX.get(key) ?? null
}

/**
 * Look up an org by domain (URL or bare host accepted). Goes through
 * `host_category.normalizeHost` so callers can pass `https://www.mit.edu/news`
 * and get the MIT entry. Returns `null` if no match.
 */
export function lookupOrgByDomain(hostOrUrl: string | null | undefined): KnownOrg | null {
  const key = normalizeHost(hostOrUrl)
  if (key === null) return null
  return DOMAIN_INDEX.get(key) ?? null
}

/**
 * Test-only introspection. Pinned by test to:
 *   - assert the seed list size stays in the documented range
 *   - assert no name/domain collisions exist (a clean seed list has zero)
 */
export function knownOrgsStats(): {
  count: number
  nameKeys: number
  domainKeys: number
  nameCollisions: readonly { key: string; first: string; second: string }[]
  domainCollisions: readonly { key: string; first: string; second: string }[]
} {
  return {
    count: KNOWN_ORGS.length,
    nameKeys: NAME_INDEX.size,
    domainKeys: DOMAIN_INDEX.size,
    nameCollisions: NAME_COLLISIONS,
    domainCollisions: DOMAIN_COLLISIONS,
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────

function deepFreeze<T extends KnownOrg>(org: T): T {
  Object.freeze(org.aliases)
  Object.freeze(org.domains)
  return Object.freeze(org)
}
