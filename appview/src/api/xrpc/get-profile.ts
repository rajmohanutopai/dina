import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { didProfiles } from '@/db/schema/index.js'
import { withSWR, CACHE_TTLS } from '../middleware/swr-cache.js'
import { normalizeHandle } from '@/util/handle_normalize.js'
import type { GetProfileResponse } from '@/shared/types/api-types.js'

export const GetProfileParams = z.object({
  did: z.string().min(8).max(2048).regex(/^did:[a-z]+:/),
})

export type GetProfileParamsType = z.infer<typeof GetProfileParams>

export async function getProfile(
  db: DrizzleDB,
  params: GetProfileParamsType,
): Promise<GetProfileResponse | null> {
  const cacheKey = `profile:${params.did}`

  return withSWR(cacheKey, CACHE_TTLS.GET_PROFILE, async () => {
    const profile = await db.select().from(didProfiles)
      .where(eq(didProfiles.did, params.did))
      .limit(1).then(r => r[0] ?? null)

    if (!profile) return null

    return {
      did: profile.did,
      handle: normalizeHandle(profile.handle),
      overallTrustScore: profile.overallTrustScore,
      attestationSummary: {
        total: profile.totalAttestationsAbout ?? 0,
        positive: profile.positiveAbout ?? 0,
        neutral: profile.neutralAbout ?? 0,
        negative: profile.negativeAbout ?? 0,
      },
      vouchCount: profile.vouchCount ?? 0,
      endorsementCount: profile.endorsementCount ?? 0,
      reviewerStats: {
        totalAttestationsBy: profile.totalAttestationsBy ?? 0,
        corroborationRate: profile.corroborationRate ?? 0,
        evidenceRate: profile.evidenceRate ?? 0,
        helpfulRatio: profile.averageHelpfulRatio ?? 0,
      },
      activeDomains: profile.activeDomains ?? [],
      lastActive: profile.lastActive?.toISOString() ?? null,
    }
  })
}
