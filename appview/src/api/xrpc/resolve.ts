import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { subjectScores, didProfiles, flags } from '@/db/schema/index.js'
import { computeGraphContext } from '@/db/queries/graph.js'
import { resolveSubject } from '@/db/queries/subjects.js'
import { computeRecommendation } from '@/scorer/algorithms/recommendation.js'
import { withSWR, resolveKey, CACHE_TTLS } from '../middleware/swr-cache.js'
import type { ResolveResponse, GraphContext } from '@/shared/types/api-types.js'

export const ResolveParams = z.object({
  subject: z.string(),
  requesterDid: z.string().optional(),
  domain: z.string().optional(),
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
  const subjectRef = JSON.parse(subjectJson)

  const subjectId = await resolveSubject(db, subjectRef)

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
        .where(eq(flags.subjectId, subjectId))
        .limit(10)
    : []

  let graphContext: GraphContext | null = null
  if (requesterDid && subjectRef.type === 'did' && subjectRef.did) {
    const graph = await computeGraphContext(db, requesterDid)
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
