import { z } from 'zod'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import {
  attestations,
  didProfiles,
  subjects,
  subjectScores,
} from '@/db/schema/index.js'
import { getCachedGraphContext } from '@/api/middleware/graph-context-cache.js'
import { normalizeHandle } from '@/util/handle_normalize.js'
import { resolveCanonicalChain } from '@/db/queries/subjects.js'

/**
 * `com.dina.peerlens.subjectGet` (TN-API-002 / Plan §6.2).
 *
 * Returns a subject's full reviewer roster grouped by network position
 * relative to the viewer. Backs the `app/trust/[subjectId].tsx` mobile
 * surface — a subject detail screen that renders three collapsible
 * sections: contacts (1-hop), extended (2-hop), strangers (3+/unknown).
 *
 * **viewerDid mandatory** because the network grouping is the whole
 * point of the endpoint. Without a viewer, all reviewers would land
 * in `strangers`, defeating the surface. Plan §6.2 also requires it.
 *
 * **Reviewer caps**: each group is bounded at `MAX_REVIEWERS_PER_GROUP`
 * (100 default). Subjects with > 300 total active reviewers are rare
 * in V1; the scorer's hot-subject bound (TN-SCORE-008, deferred) will
 * curate the most-trusted reviewers when they land. For V1 the cap is
 * a defensive bound — limits per-request cost, doesn't change UX for
 * realistic subjects.
 *
 * **Cursor pagination deferred**. Plan §6.2 lists `cursor?` as
 * optional; V1 returns all groups in one page (capped per group).
 * V2 can add cursor-per-group pagination when subject sizes warrant.
 *
 * **Sorting**: each group sorted by reviewer PeerLens rating descending,
 * NULLs last. Two reviewers with the same score break ties by
 * attestation `recordCreatedAt` desc — recency as a tiebreaker keeps
 * the surface fresh.
 *
 * **Excludes revoked attestations**. A reviewer who later revoked is
 * not surfaced (the attestation no longer represents their position).
 *
 * **Subject not found → null subject**: when the subjectId doesn't
 * resolve to a row, returns `{subject: null, score: null, band:
 * 'unrated', reviewCount: 0, reviewers: {empty groups}}`. The mobile
 * UI should render a "subject not found" state.
 */

const MAX_REVIEWERS_PER_GROUP = 100
const MAX_REVIEWER_TOTAL = MAX_REVIEWERS_PER_GROUP * 3

export const SubjectGetParams = z.object({
  subjectId: z.string().min(1).max(256),
  viewerDid: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^did:[a-z]+:/, 'must be a DID'),
})

export type SubjectGetParamsType = z.infer<typeof SubjectGetParams>

export type PeerlensBand = 'high' | 'moderate' | 'low' | 'very-low' | 'unrated'

/**
 * Map a `[0, 1]` PeerLens rating to its public band label. Mirrors
 * `packages/protocol/src/trust/score_bands.ts` so the AppView surface
 * agrees with the rest of the workspace.
 */
function trustBandFor(score: number | null | undefined): PeerlensBand {
  if (score === null || score === undefined || !Number.isFinite(score)) {
    return 'unrated'
  }
  if (score >= 0.8) return 'high'
  if (score >= 0.5) return 'moderate'
  if (score >= 0.3) return 'low'
  return 'very-low'
}

export interface SubjectRefShape {
  type: string
  did?: string
  name?: string
  identifiers?: unknown[]
}

export interface ReviewerEntry {
  did: string
  /**
   * Display handle from the reviewer's PLC document — the value of
   * `alsoKnownAs[0]` minus the `at://` prefix. Mobile clients render
   * this when present and fall back to a truncated DID otherwise.
   * Populated lazily by the `backfill-handles` scorer job; `null`
   * for any DID that hasn't been resolved yet OR that has no
   * published handle (in PLC the field may simply be empty).
   */
  handle: string | null
  trustScore: number | null
  trustBand: PeerlensBand
  attestation: {
    uri: string
    text: string | null
    sentiment: string
    createdAt: string
  }
}

export interface SubjectGetResponse {
  subject: SubjectRefShape | null
  score: number | null
  band: PeerlensBand
  reviewCount: number
  reviewers: {
    /**
     * The viewer's own attestations (when the user reviewed this
     * subject themselves). Surfaced separately so the mobile UI can
     * render a "Your review" section rather than dropping it on the
     * floor or sorting it under "strangers". Empty when the viewer
     * hasn't reviewed this subject.
     */
    self: ReviewerEntry[]
    contacts: ReviewerEntry[]
    extended: ReviewerEntry[]
    strangers: ReviewerEntry[]
  }
  // ── Forward-compat fields ──────────────────────────────────────────
  // Pagination cursor for the reviewer roster. V1 returns the entire
  // (capped) roster in one page, so `cursor` is always null. Locked
  // in the wire shape NOW so adding cursor-based pagination later
  // doesn't bump the response contract — clients that need pagination
  // will start reading this field; today's clients ignore it.
  cursor: string | null
  // Moderator takedown flag. `true` when the subject was tombstoned
  // by an operator (ToS / abuse / legal). The subject row + URL stay
  // resolvable so cached references don't 404, but readers know not
  // to surface it. The `reviewers.*` arrays are empty when tombstoned.
  tombstoned: boolean
  // Version of the scoring formula that produced `score`/`band`.
  // `null` when the subject has no score row yet (pre-scoring). When
  // the formula evolves to 'v2', the scorer writes 'v2' rows and the
  // xRPC will reflect that — letting clients detect formula drift
  // without out-of-band coordination.
  scoreVersion: string | null
}

/** Build a SubjectRef-shaped object from the persisted subject row. */
function subjectRefFromRow(row: {
  subjectType: string
  did: string | null
  name: string
  identifiersJson: unknown
}): SubjectRefShape {
  const out: SubjectRefShape = {
    type: row.subjectType,
    name: row.name,
  }
  if (row.did) out.did = row.did
  if (Array.isArray(row.identifiersJson) && row.identifiersJson.length > 0) {
    out.identifiers = row.identifiersJson
  }
  return out
}

interface AttestationRow {
  uri: string
  text: string | null
  sentiment: string
  recordCreatedAt: Date
  authorDid: string
}

/** Compose a ReviewerEntry from an attestation + the author's score + handle. */
function reviewerEntryOf(
  att: AttestationRow,
  score: number | null,
  handle: string | null,
): ReviewerEntry {
  return {
    did: att.authorDid,
    handle: normalizeHandle(handle),
    trustScore: score,
    trustBand: trustBandFor(score),
    attestation: {
      uri: att.uri,
      text: att.text,
      sentiment: att.sentiment,
      createdAt: att.recordCreatedAt.toISOString(),
    },
  }
}

/** Sort reviewers by PeerLens rating desc with createdAt desc tiebreak. */
function sortReviewers(rows: ReviewerEntry[]): ReviewerEntry[] {
  return rows.sort((a, b) => {
    // NULL scores last (treat as -Infinity).
    const sa = a.trustScore ?? Number.NEGATIVE_INFINITY
    const sb = b.trustScore ?? Number.NEGATIVE_INFINITY
    if (sb !== sa) return sb - sa
    // Tiebreak: more recent first.
    return (
      new Date(b.attestation.createdAt).getTime() -
      new Date(a.attestation.createdAt).getTime()
    )
  })
}

export async function subjectGet(
  db: DrizzleDB,
  params: SubjectGetParamsType,
): Promise<SubjectGetResponse> {
  const { subjectId: requestedSubjectId, viewerDid } = params

  // Resolve through the canonical merge chain so callers can pass an
  // old fragmented subject_id (from before the Tier 2 author-scope
  // removal) and still get the canonical merged subject's reviews.
  // The chain walk is cycle-safe (see resolveCanonicalChain).
  const subjectId = await resolveCanonicalChain(db, requestedSubjectId)

  // Phase 1 — subject row + score row (single-row PK lookups).
  const [[subjectRow], [scoreRow]] = await Promise.all([
    db.select().from(subjects).where(eq(subjects.id, subjectId)).limit(1),
    db
      .select()
      .from(subjectScores)
      .where(eq(subjectScores.subjectId, subjectId))
      .limit(1),
  ])

  if (!subjectRow) {
    // Subject not found. Return shaped empty response so the mobile
    // UI can render a "not found" state without an error 404.
    return {
      subject: null,
      score: null,
      band: 'unrated',
      reviewCount: 0,
      reviewers: { self: [], contacts: [], extended: [], strangers: [] },
      cursor: null,
      tombstoned: false,
      scoreVersion: null,
    }
  }

  const subject = subjectRefFromRow(subjectRow)
  const score = scoreRow?.weightedScore ?? null
  const scoreVersion = scoreRow?.scoreVersion ?? null
  // `tombstonedAt` is a `timestamp` column — Drizzle returns a Date
  // object when set, `null` when not. `!= null` covers both `null`
  // and `undefined` (the latter only matters for older test stubs
  // that pre-date this column).
  const tombstoned = subjectRow.tombstonedAt != null

  if (tombstoned) {
    // Operator-tombstoned subjects keep their row + URL resolvable so
    // cached references don't 404. The subject ref still flows so the
    // client can render the canonical title ("X was removed by a
    // moderator"), but every score-bearing field is hidden:
    //   - `score` → null (don't expose what it was before takedown)
    //   - `band` → 'unrated' (don't render "HIGH (REMOVED)")
    //   - `scoreVersion` → null (no active scoring on a tombstoned row)
    //   - reviewer roster → empty
    // The pre-takedown score remains in `subject_scores` + the
    // `admin_audit_log` row for operator forensics; it's just not
    // surfaced to read APIs.
    return {
      subject,
      score: null,
      band: 'unrated',
      reviewCount: 0,
      reviewers: { self: [], contacts: [], extended: [], strangers: [] },
      cursor: null,
      tombstoned: true,
      scoreVersion: null,
    }
  }

  // Phase 2 — attestation rows for this subject + the live count.
  //
  // We deliberately do NOT use `scoreRow.totalAttestations` for the
  // count: that field is materialized by the background scorer
  // (`scorer/jobs/subject_scoring.ts`), so a freshly-injected
  // attestation reads as `reviewCount: 0` until the next scoring tick.
  // The mobile detail screen showed "0 reviews" right after a publish
  // for exactly this reason. Counting non-revoked attestations
  // directly is one cheap COUNT(*) and is always current.
  const [attRows, [countRow]] = await Promise.all([
    db
      .select({
        uri: attestations.uri,
        text: attestations.text,
        sentiment: attestations.sentiment,
        recordCreatedAt: attestations.recordCreatedAt,
        authorDid: attestations.authorDid,
      })
      .from(attestations)
      .where(
        and(
          eq(attestations.subjectId, subjectId),
          eq(attestations.isRevoked, false),
          eq(attestations.isTakedownByModerator, false),
        ),
      )
      .orderBy(desc(attestations.recordCreatedAt))
      .limit(MAX_REVIEWER_TOTAL),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(attestations)
      .where(
        and(
          eq(attestations.subjectId, subjectId),
          eq(attestations.isRevoked, false),
          eq(attestations.isTakedownByModerator, false),
        ),
      ),
  ])

  const reviewCount = countRow?.c ?? 0

  if (attRows.length === 0) {
    return {
      subject,
      score,
      band: trustBandFor(score),
      reviewCount,
      reviewers: { self: [], contacts: [], extended: [], strangers: [] },
      cursor: null,
      tombstoned: false,
      scoreVersion,
    }
  }

  // Phase 3 — viewer's graph (depth ≤ 2 covers contacts + extended).
  // Strangers are inferred as anyone outside the graph.
  const graph = await getCachedGraphContext(db, viewerDid, 2)
  const depthByDid = new Map<string, number>()
  for (const node of graph.nodes) {
    if (node.did === viewerDid) continue // root, not a reviewer band
    depthByDid.set(node.did, node.depth)
  }

  // Phase 4 — author PeerLens ratings + display handles (single batched
  // lookup against `did_profiles`). The handle comes from the same
  // join we already do for scores; no extra round-trip.
  const authorDids = [...new Set(attRows.map((a) => a.authorDid))]
  const profileRows =
    authorDids.length > 0
      ? await db
          .select({
            did: didProfiles.did,
            overallTrustScore: didProfiles.overallTrustScore,
            handle: didProfiles.handle,
          })
          .from(didProfiles)
          .where(inArray(didProfiles.did, authorDids))
      : []
  const scoreByDid = new Map(
    profileRows.map((r) => [r.did, r.overallTrustScore]),
  )
  const handleByDid = new Map(profileRows.map((r) => [r.did, r.handle]))

  // Phase 5 — categorize each attestation by the author's depth.
  //
  // The viewer's own attestations land in `self` rather than being
  // dropped (the previous `continue` lost them entirely, so a user
  // viewing a subject they reviewed saw `reviewCount: 1` but no
  // review on the page — the mobile detail screen had no way to
  // render "Your review"). Depth=1 → contacts, depth=2 → extended,
  // anything else (including unknown / depth ≥3) → strangers.
  const self: ReviewerEntry[] = []
  const contacts: ReviewerEntry[] = []
  const extended: ReviewerEntry[] = []
  const strangers: ReviewerEntry[] = []
  for (const att of attRows) {
    const entry = reviewerEntryOf(
      att,
      scoreByDid.get(att.authorDid) ?? null,
      handleByDid.get(att.authorDid) ?? null,
    )
    if (att.authorDid === viewerDid) {
      self.push(entry)
      continue
    }
    const depth = depthByDid.get(att.authorDid)
    if (depth === 1) contacts.push(entry)
    else if (depth === 2) extended.push(entry)
    else strangers.push(entry)
  }

  return {
    subject,
    score,
    band: trustBandFor(score),
    reviewCount,
    reviewers: {
      self: sortReviewers(self).slice(0, MAX_REVIEWERS_PER_GROUP),
      contacts: sortReviewers(contacts).slice(0, MAX_REVIEWERS_PER_GROUP),
      extended: sortReviewers(extended).slice(0, MAX_REVIEWERS_PER_GROUP),
      strangers: sortReviewers(strangers).slice(0, MAX_REVIEWERS_PER_GROUP),
    },
    cursor: null,
    tombstoned: false,
    scoreVersion,
  }
}
