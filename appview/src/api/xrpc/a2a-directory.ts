/**
 * The A2A directory's two xRPC methods (Lane 3, design §8.3):
 * `com.dinakernel.a2a.searchAgents` and `com.dinakernel.a2a.getCard`.
 *
 * The directory relays; it never authors and never authorizes. Every result
 * is a candidate: a caller fetches the live card, authenticates the
 * endpoint, and (a Dina) runs its owner's approval. The card served is the
 * published bytes, unchanged; trust and index facts sit beside it.
 *
 * Both methods serve only while the directory is `ready`, and only cards
 * that pass every gate: present in the repository, signatures verified
 * against the DID document as it is now, not superseded by a newer invalid
 * record, the account active, proved under the current gap generation, not
 * taken down by a moderator, and the DID not redacted.
 *
 * Ranking: relevance filters, trust orders. A skill or text match decides
 * whether a card is a candidate; candidates order by (fresh before stale,
 * trust, text relevance, DID). A composite of text and trust is rejected on
 * purpose: it would let a zero-trust card stuffed with matching words
 * outrank a trusted one. Trust is the DID's profile score, and 0 for a DID a
 * moderator tombstoned as a PeerLens subject, as `resolve` gives it none.
 */

import { z } from 'zod'
import { sql, type SQL } from 'drizzle-orm'

import { A2A_DIRECTORY_PAGE_MAX, A2A_DIRECTORY_QUERY_MAX_LENGTH, MAX_ID_LENGTH, parseQualifiedSkill } from '@dina/a2a'

import { CONSTANTS } from '@/config/constants.js'
import type { DrizzleDB } from '@/db/connection.js'
import { loadSubjectTrustFacts, recommendFromFacts } from '@/db/queries/subject-trust.js'
import { resolveCanonicalCapability } from '@/shared/capability-registry.js'
import type { RecommendedAction } from '@/scorer/algorithms/recommendation.js'
import { decodeCursor, encodeCursor } from '@/util/cursor.js'
import { XrpcError } from '@/web/xrpc-dispatch.js'

/** A card is stale once this long has passed since it was indexed, measured by AppView's clock. */
export const A2A_CARD_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000
/** The ordering's version: a cursor from another ordering is refused. */
export const A2A_RANKING_VERSION = 'a2a-v1'

const DID_RE = /^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.:%-]{1,253})$/

export const SearchAgentsParams = z.object({
  skill: z.string().min(1).max(MAX_ID_LENGTH).optional(),
  q: z.string().min(1).max(A2A_DIRECTORY_QUERY_MAX_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(A2A_DIRECTORY_PAGE_MAX).default(20),
  cursor: z.string().max(500).optional(),
})
export type SearchAgentsParamsType = z.infer<typeof SearchAgentsParams>

export const GetCardParams = z.object({
  did: z.string().regex(DID_RE),
})
export type GetCardParamsType = z.infer<typeof GetCardParams>

const SearchCursor = z.object({
  rv: z.literal(A2A_RANKING_VERSION),
  s: z.union([z.literal(0), z.literal(1)]),
  t: z.number().finite(),
  r: z.number().finite(),
  d: z.string().regex(DID_RE),
})

export interface A2AAgentResult {
  did: string
  displayName: string
  endpoint: string
  skills: string[]
  trustScore: number
  recommendation: RecommendedAction
  indexedAt: string
  stale: boolean
  cardHash: string
}

export interface SearchAgentsResponse {
  agents: A2AAgentResult[]
  cursor: string | null
  rankingVersion: string
}

export interface GetCardResponse {
  /** The card exactly as published: its bytes hash to `cardHash`. */
  card: string
  cardHash: string
  signatureState: 'verified'
  indexedAt: string
  stale: boolean
  trust: {
    score: number
    recommendation: RecommendedAction
    trustLevel: string
    confidence: number
  }
}

interface ServedRow {
  did: string
  display_name: string
  endpoint: string
  skill_ids: string[]
  card_json: string
  card_hash: string
  indexed_at: Date
  stale: boolean
  trust: number
  relevance: number
}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows
}

/** Refused unless the directory is open. (The query re-checks it in its own statement.) */
async function requireOpen(db: DrizzleDB): Promise<void> {
  const rows = rowsOf<{ phase: string }>(await db.execute(sql`SELECT phase FROM a2a_directory_state WHERE id = 1`))
  if (rows[0]?.phase !== 'ready') {
    throw new XrpcError(503, 'DirectoryUnavailable', 'the agent directory is not open')
  }
}

/**
 * Every gate a served card must pass (see the header), read in the same
 * statement as the cards: the open phase and the gap generation come from
 * the state row joined as `st`, so one answer never mixes two states.
 */
const SERVED_GATES = sql`
    st.id = 1 AND st.phase = 'ready'
    AND c.presence = 'present' AND c.signature_state = 'verified' AND NOT c.unavailable AND c.account_active
    AND NOT c.identity_check_pending
    AND c.proved_generation = st.gap_generation
    AND NOT EXISTS (SELECT 1 FROM a2a_card_takedowns t WHERE t.did = c.did)
    AND NOT EXISTS (SELECT 1 FROM did_redactions r WHERE r.did = c.did)`

/**
 * The band `resolve` gives this DID (design §8.3: "reuse resolve
 * semantics"): its subject scores, its profile, its active flags, and the
 * moderator's tombstone; nothing relative to a viewer. The score shown is the
 * one the directory orders by: none for a tombstoned subject, as `resolve`
 * gives it none.
 */
async function trustOf(
  db: DrizzleDB,
  row: ServedRow,
): Promise<{ score: number; recommendation: RecommendedAction; trustLevel: string; confidence: number }> {
  const facts = await loadSubjectTrustFacts(db, { type: 'did', did: row.did })
  const rec = recommendFromFacts(facts)
  return {
    score: facts.tombstoned ? 0 : Number(row.trust),
    recommendation: rec.action,
    trustLevel: rec.trustLevel,
    confidence: rec.confidence,
  }
}

/**
 * The served DIDs a moderator tombstoned as PeerLens subjects, as `resolve`
 * decides it. One query finds every served DID whose subject merge chain
 * touches a tombstoned subject (a superset: it walks as far as the chain
 * rule ever looks); `loadSubjectTrustFacts` then decides each, so the chain
 * rules (merges, dangling pointers, cycles) live in one place. Tombstones are
 * rare, so the second step reads few DIDs.
 */
async function tombstonedServedDids(db: DrizzleDB): Promise<string[]> {
  const candidates = rowsOf<{ did: string }>(
    await db.execute(sql`
      WITH RECURSIVE chain(did, id, depth) AS (
        SELECT c.did, s.id, 0
          FROM a2a_cards c
          CROSS JOIN a2a_directory_state st
          JOIN subjects s ON s.did = c.did
         WHERE ${SERVED_GATES}
        UNION ALL
        SELECT chain.did, next.id, chain.depth + 1
          FROM chain
          JOIN subjects cur ON cur.id = chain.id
          JOIN subjects next ON next.id = cur.canonical_subject_id
         WHERE chain.depth < ${CONSTANTS.MAX_CHAIN_DEPTH}
      )
      SELECT DISTINCT chain.did FROM chain JOIN subjects t ON t.id = chain.id WHERE t.tombstoned_at IS NOT NULL`),
  )
  const decided = await Promise.all(
    candidates.map(async ({ did }) => ((await loadSubjectTrustFacts(db, { type: 'did', did })).tombstoned ? did : null)),
  )
  return decided.filter((did): did is string => did !== null)
}

/** The trust a card orders by: its profile score, and 0 for a DID in `tombstoned`. */
function trustExpression(tombstoned: readonly string[]): SQL {
  const score = sql`COALESCE(p.overall_trust_score, 0)`
  if (tombstoned.length === 0) return sql`${score}::double precision`
  return sql`(CASE WHEN c.did IN (${sql.join(tombstoned.map((did) => sql`${did}`), sql`, `)}) THEN 0 ELSE ${score} END)::double precision`
}

export async function searchAgents(
  db: DrizzleDB,
  params: SearchAgentsParamsType,
  nowMs: number = Date.now(),
): Promise<SearchAgentsResponse> {
  await requireOpen(db)
  const empty = { agents: [], cursor: null, rankingVersion: A2A_RANKING_VERSION }
  const filters: SQL[] = [SERVED_GATES]

  if (params.skill !== undefined) {
    const qualified = parseQualifiedSkill(params.skill)
    if (qualified === null) throw new XrpcError(400, 'InvalidRequest', 'skill: not a skill name')
    if (qualified.rkey !== undefined) {
      // An exact identifier (`capability@rkey`).
      filters.push(sql`c.skill_ids @> ARRAY[${params.skill}]::text[]`)
    } else {
      // A capability: its canonical name, through the shared registry's aliases.
      const canonical = resolveCanonicalCapability(qualified.capability)
      if (canonical === null) return empty
      filters.push(sql`c.skill_keys @> ARRAY[${canonical}]::text[]`)
    }
  }
  const relevance =
    params.q !== undefined
      ? sql`ts_rank(to_tsvector('simple', coalesce(c.search_text, '')), plainto_tsquery('simple', ${params.q}))`
      : sql`0::real`
  if (params.q !== undefined) {
    filters.push(sql`to_tsvector('simple', coalesce(c.search_text, '')) @@ plainto_tsquery('simple', ${params.q})`)
  }
  const staleBefore = new Date(nowMs - A2A_CARD_STALE_AFTER_MS)
  const stale = sql`(c.indexed_at <= ${staleBefore}::timestamptz)`
  const staleRank = sql`(CASE WHEN ${stale} THEN 1 ELSE 0 END)`
  const trust = trustExpression(await tombstonedServedDids(db))
  const rank = sql`(${relevance})::double precision`

  if (params.cursor !== undefined) {
    let at: z.infer<typeof SearchCursor>
    try {
      at = decodeCursor(params.cursor, SearchCursor)
    } catch {
      throw new XrpcError(400, 'InvalidRequest', 'cursor: not one this ordering issued')
    }
    filters.push(sql`(
      ${staleRank} > ${at.s}
      OR (${staleRank} = ${at.s} AND (
        ${trust} < ${at.t}
        OR (${trust} = ${at.t} AND (
          ${rank} < ${at.r}
          OR (${rank} = ${at.r} AND c.did > ${at.d}))))))`)
  }

  const rows = rowsOf<ServedRow>(
    await db.execute(sql`
      SELECT c.did, c.display_name, c.endpoint, c.skill_ids, c.card_json, c.card_hash, c.indexed_at,
             ${stale} AS stale, ${trust} AS trust, ${rank} AS relevance
        FROM a2a_cards c
        CROSS JOIN a2a_directory_state st
        LEFT JOIN did_profiles p ON p.did = c.did
       WHERE ${sql.join(filters, sql` AND `)}
       ORDER BY ${staleRank} ASC, ${trust} DESC, ${rank} DESC, c.did ASC
       LIMIT ${params.limit + 1}`),
  )
  const page = rows.slice(0, params.limit)
  const last = page[page.length - 1]
  const cursor =
    rows.length > params.limit && last !== undefined
      ? encodeCursor({ rv: A2A_RANKING_VERSION, s: last.stale ? 1 : 0, t: Number(last.trust), r: Number(last.relevance), d: last.did })
      : null
  const trusts = await Promise.all(page.map((row) => trustOf(db, row)))
  return {
    agents: page.map((row, i) => {
      const trustInfo = trusts[i] as Awaited<ReturnType<typeof trustOf>>
      return {
        did: row.did,
        displayName: row.display_name,
        endpoint: row.endpoint,
        skills: row.skill_ids,
        trustScore: trustInfo.score,
        recommendation: trustInfo.recommendation,
        indexedAt: new Date(row.indexed_at).toISOString(),
        stale: row.stale,
        cardHash: row.card_hash,
      }
    }),
    cursor,
    rankingVersion: A2A_RANKING_VERSION,
  }
}

export async function getCard(db: DrizzleDB, params: GetCardParamsType, nowMs: number = Date.now()): Promise<GetCardResponse> {
  await requireOpen(db)
  const staleBefore = new Date(nowMs - A2A_CARD_STALE_AFTER_MS)
  const rows = rowsOf<ServedRow>(
    await db.execute(sql`
      SELECT c.did, c.display_name, c.endpoint, c.skill_ids, c.card_json, c.card_hash, c.indexed_at,
             (c.indexed_at <= ${staleBefore}::timestamptz) AS stale,
             COALESCE(p.overall_trust_score, 0)::double precision AS trust, 0::double precision AS relevance
        FROM a2a_cards c
        CROSS JOIN a2a_directory_state st
        LEFT JOIN did_profiles p ON p.did = c.did
       WHERE c.did = ${params.did} AND ${SERVED_GATES}`),
  )
  const row = rows[0]
  if (row === undefined) throw new XrpcError(404, 'NotFound', 'no agent card for that DID')
  return {
    card: row.card_json,
    cardHash: row.card_hash,
    signatureState: 'verified',
    indexedAt: new Date(row.indexed_at).toISOString(),
    stale: row.stale,
    trust: await trustOf(db, row),
  }
}
