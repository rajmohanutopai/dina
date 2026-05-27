import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { subjects, subjectScores, didProfiles, flags } from '@/db/schema/index.js'
import { resolveSubject } from '@/db/queries/subjects.js'
import { computeRecommendation } from '@/scorer/algorithms/recommendation.js'
import { withSWR, resolveKey, CACHE_TTLS } from '../middleware/swr-cache.js'
import { getCachedGraphContext } from '../middleware/graph-context-cache.js'
import { CONSTANTS } from '@/config/constants.js'
import type { ResolveResponse, GraphContext } from '@/shared/types/api-types.js'
import type { SubjectRef } from '@/shared/types/lexicon-types.js'

/**
 * Shape of the `subject` JSON string after parsing. Validated (rather than
 * trusted as `any`) so a malformed/hostile `subject` param fails closed into
 * the "Invalid subject" response instead of flowing untyped into queries +
 * deterministic-id hashing. Unknown keys are stripped (Zod default); only the
 * SubjectRef fields are consumed downstream.
 */
const SubjectRefSchema = z.object({
  type: z.enum(['did', 'content', 'product', 'dataset', 'organization', 'claim', 'place']),
  did: z.string().optional(),
  uri: z.string().optional(),
  name: z.string().optional(),
  identifier: z.string().optional(),
})

export const ResolveParams = z.object({
  subject: z.string().max(4096),
  requesterDid: z.string().optional(),
  domain: z.string().max(253).regex(/^[a-z0-9.-]+$/i).optional(),
  context: z.enum([
    'before-transaction', 'before-interaction',
    'content-verification', 'product-evaluation', 'general-lookup',
  ]).optional(),
})

export type ResolveParamsType = z.infer<typeof ResolveParams>

export async function resolve(
  db: DrizzleDB,
  params: ResolveParamsType,
): Promise<ResolveResponse> {
  const { subject: subjectJson, requesterDid, domain, context } = params

  const cacheKey = resolveKey(subjectJson, requesterDid, domain, context)

  return withSWR(cacheKey, CACHE_TTLS.RESOLVE, async () => {
    return computeResolveResponse(db, subjectJson, requesterDid, domain, context)
  })
}

async function computeResolveResponse(
  db: DrizzleDB,
  subjectJson: string,
  requesterDid?: string,
  domain?: string,
  context?: string,
): Promise<ResolveResponse> {
  let subjectRef: SubjectRef
  try {
    const parsed: unknown = JSON.parse(subjectJson)
    const validated = SubjectRefSchema.safeParse(parsed)
    if (!validated.success) {
      throw new Error('subject does not match the SubjectRef shape')
    }
    subjectRef = validated.data
  } catch {
    return {
      // TN-API-003 fields — null on parse failure (subject can't be resolved):
      subjectId: null,
      reviewCount: 0,
      lastAttestedAt: null,
      // Legacy fields:
      subjectType: 'unknown',
      trustLevel: 'none',
      confidence: 0,
      attestationSummary: null,
      flags: [],
      authenticity: null,
      graphContext: null,
      recommendation: 'error',
      reasoning: 'Invalid subject JSON',
    }
  }

  const subjectId = await resolveSubject(db, subjectRef)

  // Moderator-tombstoned subjects must not feed a trust decision —
  // `resolve` drives proceed/caution/verify/avoid, and a removed
  // subject should never green-light a transaction. Short-circuit
  // with the subjectId preserved (so cached references don't 404)
  // but every trust-bearing field zeroed and a hard `avoid`.
  if (subjectId) {
    const [subjectRow] = await db
      .select({ tombstonedAt: subjects.tombstonedAt })
      .from(subjects)
      .where(eq(subjects.id, subjectId))
      .limit(1)
    if (subjectRow?.tombstonedAt != null) {
      return {
        subjectId,
        reviewCount: 0,
        lastAttestedAt: null,
        subjectType: subjectRef.type,
        trustLevel: 'none',
        confidence: 0,
        attestationSummary: null,
        flags: [],
        authenticity: null,
        graphContext: null,
        recommendation: 'avoid',
        reasoning: 'Subject was removed by a moderator',
      }
    }
  }

  const scores = subjectId
    ? await db.select().from(subjectScores)
        .where(eq(subjectScores.subjectId, subjectId))
        .limit(1).then(r => r[0] ?? null)
    : null

  let didProfile = null
  if (subjectRef.type === 'did' && subjectRef.did) {
    didProfile = await db.select().from(didProfiles)
      .where(eq(didProfiles.did, subjectRef.did))
      .limit(1).then(r => r[0] ?? null)
  }

  const activeFlags = subjectId
    ? await db.select().from(flags)
        .where(and(eq(flags.subjectId, subjectId), eq(flags.isActive, true)))
        .limit(10)
    : []

  let graphContext: GraphContext | null = null
  if (requesterDid && subjectRef.type === 'did' && subjectRef.did) {
    // Pass MAX_GRAPH_DEPTH explicitly so the cache key matches
    // subjectGet's depth=2 entry — a `resolve` call after a
    // `subjectGet` for the same viewer reuses the cached graph.
    const graph = await getCachedGraphContext(db, requesterDid, CONSTANTS.MAX_GRAPH_DEPTH)
    const targetNode = graph.nodes.find(n => n.did === subjectRef.did)
    graphContext = {
      shortestPath: targetNode?.depth ?? null,
      mutualConnections: null,
      trustedAttestors: [],
    }
  }

  let authenticity = null
  if (scores?.authenticityConsensus) {
    authenticity = {
      predominantAssessment: scores.authenticityConsensus,
      confidence: scores.authenticityConfidence,
    }
  }

  const rec = computeRecommendation({
    scores, didProfile, flags: activeFlags.map(f => ({
      flagType: f.flagType, severity: f.severity,
    })),
    graphContext, authenticity, context, domain,
  })

  return {
    // TN-API-003 / Plan §6.3 fields:
    //   - `subjectId` is the canonical resolved ID (or null when the
    //     SubjectRef doesn't yet exist in the index)
    //   - `reviewCount` is total attestations as seen by the scorer
    //     (0 when subjectId is null OR when the row hasn't been
    //     scored yet — `subjectScores` may be absent if the scorer
    //     hasn't ticked since the first attestation landed)
    //   - `lastAttestedAt` is `subject_scores.last_attestation_at`,
    //     populated by `refresh-subject-scores`. Null when the row
    //     hasn't been scored OR has no attestations.
    //   - `conflicts` is intentionally omitted — V1 doesn't perform
    //     fuzzy/same-as merging (Plan §13.10), so a single resolution
    //     always wins. V2 fills this when the merge resolver lands.
    subjectId,
    reviewCount: scores?.totalAttestations ?? 0,
    lastAttestedAt: scores?.lastAttestationAt
      ? scores.lastAttestationAt.toISOString()
      : null,

    // Legacy trust-decision fields (kept verbatim):
    subjectType: subjectRef.type,
    trustLevel: rec.trustLevel,
    confidence: rec.confidence,
    attestationSummary: scores ? {
      total: scores.totalAttestations ?? 0,
      positive: scores.positive ?? 0,
      neutral: scores.neutral ?? 0,
      negative: scores.negative ?? 0,
      averageDimensions: scores.dimensionSummaryJson,
    } : null,
    flags: activeFlags.map(f => ({ flagType: f.flagType, severity: f.severity })),
    authenticity,
    graphContext,
    recommendation: rec.action,
    reasoning: rec.reasoning,
  }
}
