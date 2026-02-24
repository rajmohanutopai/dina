import type { DrizzleDB } from '@/db/connection.js'
import { didProfiles, subjectScores } from '@/db/schema/index.js'

/**
 * Incremental dirty flag marking (Fix 9).
 *
 * When a record is created or deleted, mark all affected entities
 * (subjects and DID profiles) for score recalculation. The scorer
 * daemon picks up dirty entities in batches instead of recomputing everything.
 */

interface DirtyMarkParams {
  /** Subject that was referenced in the record */
  subjectId: string | null
  /** DID of the record author */
  authorDid: string
  /** DIDs mentioned in the record */
  mentionedDids?: { did: string }[]
  /** DID of the subject (if the subject is a DID-type entity) */
  subjectDid?: string | null
  /** DID of a co-signer (if attestation has a co-signature) */
  cosignerDid?: string | null
}

/**
 * Mark affected subjects and DID profiles as needing recalculation.
 * Uses upsert (INSERT ... ON CONFLICT DO UPDATE) so rows are created
 * if they don't exist yet.
 */
export async function markDirty(db: DrizzleDB, params: DirtyMarkParams): Promise<void> {
  // Mark subject for score recalculation
  if (params.subjectId) {
    await db.insert(subjectScores).values({
      subjectId: params.subjectId,
      needsRecalc: true,
      computedAt: new Date(0),
    }).onConflictDoUpdate({
      target: subjectScores.subjectId,
      set: { needsRecalc: true },
    })
  }

  // Collect all affected DIDs
  const affectedDids = new Set<string>()
  affectedDids.add(params.authorDid)
  if (params.subjectDid) affectedDids.add(params.subjectDid)
  if (params.cosignerDid) affectedDids.add(params.cosignerDid)
  if (params.mentionedDids) {
    for (const m of params.mentionedDids) affectedDids.add(m.did)
  }

  // Mark each DID profile for recalculation
  for (const did of affectedDids) {
    await db.insert(didProfiles).values({
      did,
      needsRecalc: true,
      computedAt: new Date(0),
    }).onConflictDoUpdate({
      target: didProfiles.did,
      set: { needsRecalc: true },
    })
  }
}
