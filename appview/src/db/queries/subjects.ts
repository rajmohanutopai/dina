import { createHash } from 'crypto'
import { sql, eq } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import type { SubjectRef } from '@/shared/types/lexicon-types.js'
import { subjects } from '@/db/schema/index.js'
import { CONSTANTS } from '@/config/constants.js'
import { logger } from '@/shared/utils/logger.js'
import { enrichSubject } from '@/util/subject_enrichment.js'
import { detectLanguage } from '@/ingester/language-detect.js'

/**
 * Subject identity resolution.
 *
 * **Wire-format contract** — the output of `generateDeterministicId`
 * is a subject_id stored across the DB (attestations, scores, etc.)
 * AND in client URLs. Treat the hash inputs below as a frozen
 * format. Any change — even adding a space — invalidates every
 * existing subject_id and requires a migration. The `RESOLVER_VERSION`
 * prefix is the escape hatch: bump it to `v3:` if the formula ever
 * needs to evolve, and a migration can recompute hashes side-by-side.
 *
 * **Tiers** (highest priority first):
 *   Tier 1: Global identifiers — `did:` / `uri:` / `id:`. Same input
 *           → same subject for every caller. Use these when a stable
 *           global reference exists (DID, URL, ASIN, etc.).
 *   Tier 2: Name-based — `name:<type>:<normalized_name>`. PeerLens is
 *           a SHARED trust layer, so two reviewers of "Aeron Chair"
 *           land on ONE subject row that aggregates both reviews.
 *           Disambiguation for genuinely-different things sharing a
 *           name happens by supplying a Tier 1 identifier (e.g.
 *           `identifier: 'wikidata:Q28865'` for Python the language
 *           vs `identifier: 'wikidata:Q47570'` for Python the snake).
 *   Tier 3: Canonical chain — follows `canonical_subject_id` so
 *           admin-merged subjects resolve to the canonical at read
 *           time. Handled by `resolveCanonicalChain`, not here.
 *
 * **Normalization** (Tier 2 only):
 *   - Unicode NFC — "café" (composed) and "cafe + combining acute"
 *     (decomposed) collapse to the same hash.
 *   - Lowercased (Unicode-aware, locale-independent).
 *   - Internal whitespace runs collapsed to a single ASCII space and
 *     edges trimmed — "Aeron  Chair", "Aeron\nChair", and
 *     "  Aeron Chair  " all hash the same.
 *   - Length capped at `MAX_NAME_LENGTH`. Names beyond the cap are
 *     rejected (returns `null`) to prevent pathological input.
 *   - Type lowercased + trimmed defensively (the type enum is
 *     lowercase by convention, but a caller sending "Product"
 *     shouldn't fragment from "product").
 *
 * **Previously** Tier 2 was author-scoped (`name:type:name:authorDid`)
 * which silently fragmented every name-only product across authors.
 * The user saw one stranger's chair, wrote their own review, and the
 * publish minted a brand-new subject row instead of attaching to the
 * chair they were viewing.
 */

const RESOLVER_VERSION = 'v2'
// Re-exported so spec docs + tests can pin the value; the source of
// truth is `CONSTANTS.SUBJECT_REF_MAX_NAME_LEN` (matches the lexicon
// validator so the resolver and the wire-format gate never drift).
const MAX_NAME_LENGTH = CONSTANTS.SUBJECT_REF_MAX_NAME_LEN

function normalizeNameForHash(rawName: string | undefined | null): string | null {
  if (rawName === undefined || rawName === null) return null
  // NFC ensures "café" (U+00E9) and "café" (e + combining acute)
  // hash identically. NFC composes precomposed forms where available.
  const nfc = rawName.normalize('NFC')
  // No-argument toLowerCase uses Unicode case folding without a
  // locale tailoring, so Turkish 'I' doesn't produce a different
  // output in tr-TR environments.
  const lower = nfc.toLowerCase()
  // Collapse every whitespace run (space, tab, newline, NBSP, etc.)
  // to a single ASCII space, then trim.
  const collapsed = lower.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return null
  if (collapsed.length > MAX_NAME_LENGTH) return null
  return collapsed
}

function normalizeTypeForHash(rawType: string): string {
  return rawType.toLowerCase().trim()
}

/**
 * Defensive trim for Tier 1 identifier inputs (did / uri / identifier).
 *
 * Tier 1 inputs are NOT lowercased or NFC-normalized — those are
 * spec-bearing identity bits: DIDs are lowercase by `did:plc:` method
 * spec, URIs are case-sensitive in path + query, external identifiers
 * are opaque to AppView. Trimming is the only safe fold: a caller
 * submitting `"  did:plc:abc"` clearly meant `"did:plc:abc"`.
 *
 * Returns null if trimming leaves the empty string so the resolver
 * falls through to the next tier instead of hashing whitespace
 * (`v2:did:` with an empty payload would be a stable bug magnet).
 */
function trimTier1Field(raw: string): string | null {
  const trimmed = raw.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Conservative URI canonicalization for Tier 1 hashing.
 *
 * Without this, every typographic variant of the same URL mints a
 * distinct subject forever: `https://example.com/` vs
 * `https://example.com` vs `HTTPS://Example.com` are three different
 * subject_ids despite addressing the same resource.
 *
 * What we normalize (safe to fold per RFC 3986):
 *   - Lowercase scheme (RFC 3986 sec 3.1, case-insensitive).
 *   - Lowercase host (sec 3.2.2). IPv6 hosts stay bracketed.
 *   - Strip default ports: `:80` on http, `:443` on https,
 *     `:21` on ftp, `:22` on ssh, `:23` on telnet, `:25` on smtp.
 *   - Strip a single trailing slash when path is exactly `/`
 *     (path-empty). Trailing slashes on non-root paths are
 *     preserved (servers MAY treat `/page` and `/page/` differently).
 *
 * Fragment handling: fragments are RFC 3986 client-side anchors —
 * the server returns the same resource regardless of `#section`. We
 * strip them so `https://wiki/Python#History` and
 * `https://wiki/Python#Syntax` collapse to one subject (the same
 * Wikipedia article reviewed at different sections). Publishers
 * that genuinely want per-fragment identity (e.g. SPA routes) should
 * use the `identifier` field instead.
 *
 * What we deliberately do NOT touch (could be semantic):
 *   - Path case (case-sensitive on most servers).
 *   - Query string (order, case, percent-encoding all carry meaning).
 *   - Percent-encoding (decoding `%2F` to `/` would change route).
 *   - Userinfo (`user:pass@`) passes through.
 *
 * On malformed URIs: if `new URL(raw)` throws, fall back to hashing
 * the raw string. The lexicon validator has already bounded length;
 * we just stop trying to canonicalize.
 */
const URI_DEFAULT_PORTS: Readonly<Record<string, string>> = {
  'http:': '80',
  'https:': '443',
  'ftp:': '21',
  'ssh:': '22',
  'telnet:': '23',
  'smtp:': '25',
}

function normalizeUriForHash(rawUri: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUri)
  } catch {
    return rawUri
  }

  // URL constructor already lowercases scheme + host. Strip default
  // port if it matches the scheme's default.
  const defaultPort = URI_DEFAULT_PORTS[parsed.protocol]
  if (defaultPort !== undefined && parsed.port === defaultPort) {
    parsed.port = ''
  }

  // Strip fragment. RFC 3986 fragments are client-side anchors and
  // don't affect resource identity — same article, different section.
  parsed.hash = ''

  // Drop a single trailing slash when path is exactly `/` (i.e. the
  // host root). Anything more substantive is preserved verbatim.
  let serialized = parsed.toString()
  if (parsed.pathname === '/' && parsed.search === '') {
    if (serialized.endsWith('/')) {
      serialized = serialized.slice(0, -1)
    }
  }
  return serialized
}

function generateDeterministicId(ref: SubjectRef): { id: string } {
  const hash = createHash('sha256')

  // Tier 1 inputs are trimmed before the truthy check so a
  // whitespace-only string (`"   "`) falls through to the next tier
  // instead of hashing `v2:did:   `. The lexicon would already reject
  // a whitespace-only DID via its `^did:[a-z]+:` regex, but
  // defense-in-depth: the resolver doesn't assume the validator.
  const didTrim = ref.did != null ? trimTier1Field(ref.did) : null
  if (didTrim !== null) {
    hash.update(`${RESOLVER_VERSION}:did:${didTrim}`)
    return { id: `sub_${hash.digest('hex').slice(0, 32)}` }
  }
  const uriTrim = ref.uri != null ? trimTier1Field(ref.uri) : null
  if (uriTrim !== null) {
    hash.update(`${RESOLVER_VERSION}:uri:${normalizeUriForHash(uriTrim)}`)
    return { id: `sub_${hash.digest('hex').slice(0, 32)}` }
  }
  const identifierTrim = ref.identifier != null ? trimTier1Field(ref.identifier) : null
  if (identifierTrim !== null) {
    hash.update(`${RESOLVER_VERSION}:id:${identifierTrim}`)
    return { id: `sub_${hash.digest('hex').slice(0, 32)}` }
  }

  // Tier 2: name-based. Reject empty / pathological names so callers
  // can't manufacture a `name:product:undefined` ghost subject.
  const normName = normalizeNameForHash(ref.name)
  if (normName === null) {
    throw new Error(
      'SubjectRef: Tier 2 resolution requires a non-empty `name` ' +
        `(<= ${MAX_NAME_LENGTH} chars after normalization) when no ` +
        'did/uri/identifier is supplied.',
    )
  }
  const normType = normalizeTypeForHash(ref.type)
  hash.update(`${RESOLVER_VERSION}:name:${normType}:${normName}`)
  return { id: `sub_${hash.digest('hex').slice(0, 32)}` }
}

export { generateDeterministicId, MAX_NAME_LENGTH, RESOLVER_VERSION }

/**
 * Resolve an existing subject or create a new one.
 * Returns the canonical subject ID (following merge chains).
 */
export async function resolveOrCreateSubject(
  db: DrizzleDB,
  ref: SubjectRef,
  _authorDid: string,
): Promise<string> {
  const { id: deterministicId } = generateDeterministicId(ref)

  const identifiers: Record<string, string>[] = []
  if (ref.uri) identifiers.push({ uri: ref.uri })
  if (ref.identifier) identifiers.push({ id: ref.identifier })

  const name = ref.name || ref.uri || ref.did || 'Unknown Subject'

  // TN-ING-007: enrich on create. The ON CONFLICT branch deliberately
  // does NOT overwrite the enrichment columns (`category`, `metadata`,
  // `language`, `enriched_at`) on the existing row — idempotency for
  // re-ingest replays, and the first author's enrichment is fine
  // (the second author's payload carries no new heuristic info).
  const enrichment = enrichSubject(ref)
  const language = detectLanguage(name)

  const result = await db.execute(sql`
    INSERT INTO subjects (
      id, name, subject_type, did, identifiers_json,
      category, metadata, language, enriched_at,
      author_scoped_did, resolver_version, created_at, updated_at
    )
    VALUES (
      ${deterministicId},
      ${name},
      ${ref.type},
      ${ref.did ?? null},
      ${JSON.stringify(identifiers)}::jsonb,
      ${enrichment.category},
      ${JSON.stringify(enrichment.metadata)}::jsonb,
      ${language},
      NOW(),
      NULL,
      ${RESOLVER_VERSION},
      NOW(),
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      updated_at = NOW(),
      identifiers_json = subjects.identifiers_json || EXCLUDED.identifiers_json
    RETURNING id, canonical_subject_id
  `)

  const row = (result as any).rows[0]
  const canonicalId = row.canonical_subject_id as string | null

  if (canonicalId) {
    return resolveCanonicalChain(db, canonicalId)
  }

  return row.id as string
}

/**
 * Resolve an existing subject without creating. Returns null if not found.
 *
 * Uses the same `generateDeterministicId` formula as the write path so
 * the read formula CAN'T drift from the write formula — a recurring
 * class of bug where read-side hashing was kept inline (missed the
 * `v2:` prefix bump, missed Tier 2 normalization). Works for all
 * tiers now, not just Tier 1.
 */
export async function resolveSubject(
  db: DrizzleDB,
  ref: SubjectRef,
): Promise<string | null> {
  let id: string
  try {
    id = generateDeterministicId(ref).id
  } catch {
    // Ref didn't satisfy the resolver (Tier 2 with empty name).
    // Treat as "not found" — there's nothing for us to look up.
    return null
  }

  const result = await db.select().from(subjects).where(eq(subjects.id, id)).limit(1)
  if (result.length === 0) return null

  const canonicalId = result[0].canonicalSubjectId
  return canonicalId ? resolveCanonicalChain(db, canonicalId) : result[0].id
}

/**
 * Follow canonical_subject_id chain to find the root subject.
 * Guards against cycles and excessive depth.
 */
export async function resolveCanonicalChain(
  db: DrizzleDB,
  startId: string,
): Promise<string> {
  const visited = new Set<string>()
  let currentId = startId

  for (let depth = 0; depth < CONSTANTS.MAX_CHAIN_DEPTH; depth++) {
    if (visited.has(currentId)) {
      logger.warn(`[Subjects] Merge cycle detected at ${currentId}`)
      return currentId
    }
    visited.add(currentId)

    const result = await db.execute(sql`
      SELECT canonical_subject_id FROM subjects WHERE id = ${currentId}
    `)

    const nextId = (result as any).rows[0]?.canonical_subject_id as string | null
    if (!nextId) return currentId
    currentId = nextId
  }

  logger.warn(`[Subjects] Merge chain exceeded ${CONSTANTS.MAX_CHAIN_DEPTH} hops from ${startId}`)
  return currentId
}
