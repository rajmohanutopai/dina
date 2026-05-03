import { z } from 'zod'
import { and, eq, inArray } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { flags, subjects } from '@/db/schema/index.js'
import { getCachedGraphContext } from '@/api/middleware/graph-context-cache.js'

/**
 * `com.dina.trust.getNegativeSpace` (TN-V2-RANK-010 / Plan §6.X).
 *
 * Returns subjects in a category that the viewer's 1-hop contacts
 * have actively flagged. Powers the proactive warning surface — the
 * mobile UI shows "your contacts have warned about these" before the
 * user even searches, surfacing risk that the user wouldn't have
 * stumbled across through positive search alone.
 *
 * **1-hop only.** Negative space is a high-trust signal (someone the
 * viewer directly trusts says "avoid this"). Pulling 2-hop flags
 * would dilute the signal — strangers' warnings carry too much
 * noise for an unsolicited surface. The mobile detail screen's
 * "flagged by N of your contacts" banner is the same trust tier.
 *
 * **Active flags only.** A revoked / withdrawn flag (`isActive=false`)
 * does NOT contribute. The flag handler sets `isActive` to false on
 * revocation; this query honours that.
 *
 * **Self-exclusion.** A flag the viewer themselves authored is NOT
 * surfaced — the user already knows about their own flags. Without
 * this filter, a single self-flagger would see their own flags
 * echoed back in the warning surface.
 *
 * **Subject dedup.** Multiple 1-hop contacts flagging the same
 * subject collapse to one entry. The `flaggerCount` field carries
 * the multiplicity so the UI can render "3 of your contacts flagged
 * this." Sort is by `flaggerCount DESC` (consensus matters most),
 * tiebroken by most-recent flag descending.
 *
 * **Empty graph → empty response.** A viewer with no 1-hop contacts
 * has no negative space to surface; we return `{subjects: []}`
 * rather than 404 so the mobile UI suppresses the surface uniformly.
 */

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

export const GetNegativeSpaceParams = z.object({
  viewerDid: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^did:[a-z]+:/, 'must be a DID'),
  category: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
})

export type GetNegativeSpaceParamsType = z.infer<typeof GetNegativeSpaceParams>

export interface NegativeSpaceEntry {
  subjectId: string
  name: string
  subjectType: string
  category: string
  /**
   * Distinct 1-hop contacts who flagged this subject. >= 1 by
   * construction — subjects with zero flagger contacts wouldn't
   * appear in the response.
   */
  flaggerCount: number
  /**
   * Highest severity across this subject's flags from 1-hop
   * contacts. Ranked: critical > serious > warning > informational.
   * The mobile UI uses this to colour the warning banner — a single
   * `critical` flag from a contact should not be quietly averaged
   * down to `warning` by other softer flags on the same subject.
   */
  highestSeverity: 'critical' | 'serious' | 'warning' | 'informational'
  /** Most-recent flag timestamp across the contributing flaggers. */
  lastFlaggedAt: string
}

export interface GetNegativeSpaceResponse {
  subjects: NegativeSpaceEntry[]
}

/** Severity ordering — lower index = higher severity. */
const SEVERITY_ORDER: ReadonlyArray<NegativeSpaceEntry['highestSeverity']> = [
  'critical',
  'serious',
  'warning',
  'informational',
] as const

function rankSeverity(s: string): number {
  const ix = SEVERITY_ORDER.indexOf(s as NegativeSpaceEntry['highestSeverity'])
  // Unknown severities sort below the known set rather than crashing.
  return ix === -1 ? SEVERITY_ORDER.length : ix
}

export async function getNegativeSpace(
  db: DrizzleDB,
  params: GetNegativeSpaceParamsType,
): Promise<GetNegativeSpaceResponse> {
  const { viewerDid, category, limit } = params

  // Phase 1 — viewer's 1-hop contacts. Depth 1 covers everyone the
  // viewer has directly vouched / endorsed / positively attested.
  const graph = await getCachedGraphContext(db, viewerDid, 1)
  const oneHopDids = new Set<string>()
  for (const node of graph.nodes) {
    if (node.depth === 1 && node.did !== viewerDid) {
      oneHopDids.add(node.did)
    }
  }

  if (oneHopDids.size === 0) {
    // No 1-hop contacts → no negative space.
    return { subjects: [] }
  }

  // Phase 2 — flags by 1-hop authors against subjects in the
  // requested category. Self-flags excluded. Active flags only.
  const flagRows = await db
    .select({
      subjectId: flags.subjectId,
      authorDid: flags.authorDid,
      severity: flags.severity,
      recordCreatedAt: flags.recordCreatedAt,
      name: subjects.name,
      subjectType: subjects.subjectType,
      subjectCategory: subjects.category,
    })
    .from(flags)
    .innerJoin(subjects, eq(flags.subjectId, subjects.id))
    .where(
      and(
        inArray(flags.authorDid, [...oneHopDids]),
        eq(subjects.category, category),
        eq(flags.isActive, true),
      ),
    )

  if (flagRows.length === 0) return { subjects: [] }

  // Phase 3 — collapse by subjectId. Track distinct flagger DIDs
  // (the multiplicity) and roll up severity + recency. The dedup
  // happens in JS rather than SQL because we want both the highest
  // severity AND the recent timestamp in a single pass — Postgres
  // would need a CTE or a window function for the same shape, and
  // the row count is bounded by 1-hop flag count which is small in
  // practice.
  interface Bucket {
    subjectId: string
    name: string
    subjectType: string
    category: string
    flaggers: Set<string>
    severityRank: number
    severity: NegativeSpaceEntry['highestSeverity']
    lastFlaggedAt: Date
  }
  const buckets = new Map<string, Bucket>()
  for (const r of flagRows) {
    if (!r.subjectId || !r.subjectCategory) continue
    let b = buckets.get(r.subjectId)
    if (!b) {
      b = {
        subjectId: r.subjectId,
        name: r.name,
        subjectType: r.subjectType,
        category: r.subjectCategory,
        flaggers: new Set<string>(),
        severityRank: SEVERITY_ORDER.length,
        severity: 'informational',
        lastFlaggedAt: new Date(0),
      }
      buckets.set(r.subjectId, b)
    }
    b.flaggers.add(r.authorDid)
    const rank = rankSeverity(r.severity)
    if (rank < b.severityRank) {
      b.severityRank = rank
      b.severity = r.severity as NegativeSpaceEntry['highestSeverity']
    }
    if (r.recordCreatedAt > b.lastFlaggedAt) b.lastFlaggedAt = r.recordCreatedAt
  }

  // Phase 4 — rank: flaggerCount desc, then recency desc. Sorting
  // by consensus first matches the surface intent — "many of your
  // contacts agree" is the strongest warning signal we can show.
  const ranked = [...buckets.values()].sort((a, b) => {
    if (b.flaggers.size !== a.flaggers.size) return b.flaggers.size - a.flaggers.size
    return b.lastFlaggedAt.getTime() - a.lastFlaggedAt.getTime()
  })

  return {
    subjects: ranked.slice(0, limit).map((b) => ({
      subjectId: b.subjectId,
      name: b.name,
      subjectType: b.subjectType,
      category: b.category,
      flaggerCount: b.flaggers.size,
      highestSeverity: b.severity,
      lastFlaggedAt: b.lastFlaggedAt.toISOString(),
    })),
  }
}
