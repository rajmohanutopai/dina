import { eq, and } from 'drizzle-orm'
import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Amendment } from '@/shared/types/lexicon-types.js'
import { amendments, attestations } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'
import { markDirty } from '@/db/queries/dirty-flags.js'

/**
 * Handler for com.dina.trust.amendment records.
 *
 * Amendments modify existing attestations (corrections, updates, retractions).
 * On create, the handler upserts the amendment record and also marks the
 * target attestation as amended with a back-reference to this amendment URI.
 */
export const amendmentHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as Amendment

    // HIGH-11 fix: Read old targetUri BEFORE upsert to detect retarget
    const existingAmd = await ctx.db.select({ targetUri: amendments.targetUri })
      .from(amendments).where(eq(amendments.uri, op.uri)).limit(1)
    const oldTargetUri = existingAmd[0]?.targetUri ?? null

    // Upsert the amendment record
    await ctx.db.insert(amendments).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      targetUri: record.targetUri,
      amendmentType: record.amendmentType,
      text: record.text ?? null,
      newValuesJson: record.newValues ?? null,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoUpdate({
      target: amendments.uri,
      set: {
        cid: op.cid!,
        targetUri: record.targetUri,
        amendmentType: record.amendmentType,
        text: record.text ?? null,
        newValuesJson: record.newValues ?? null,
        recordCreatedAt: new Date(record.createdAt),
      },
    })

    // HIGH-11 fix: Handle retarget — if this amendment previously pointed to a
    // different attestation (update operation), clear the old target's amended flag
    if (oldTargetUri && oldTargetUri !== record.targetUri) {
      // Check if any other amendments still target the old attestation
      const remaining = await ctx.db.select({ uri: amendments.uri })
        .from(amendments)
        .where(eq(amendments.targetUri, oldTargetUri))
        .limit(1)
      if (remaining.length === 0) {
        await ctx.db.update(attestations)
          .set({ isAmended: false, latestAmendmentUri: null })
          .where(eq(attestations.uri, oldTargetUri))
      }
    }

    // Mark the target attestation as amended (only if authored by same DID)
    await ctx.db.update(attestations)
      .set({
        isAmended: true,
        latestAmendmentUri: op.uri,
      })
      .where(and(
        eq(attestations.uri, record.targetUri),
        eq(attestations.authorDid, op.did),
      ))

    // HIGH-12 fix: Mark target attestation author + subject dirty
    const targetAtt = await ctx.db.select({
      authorDid: attestations.authorDid,
      subjectId: attestations.subjectId,
    }).from(attestations).where(eq(attestations.uri, record.targetUri)).limit(1)

    await markDirty(ctx.db, {
      subjectId: targetAtt[0]?.subjectId ?? null,
      authorDid: op.did,
    })
    if (targetAtt[0]?.authorDid && targetAtt[0].authorDid !== op.did) {
      await markDirty(ctx.db, { subjectId: null, authorDid: targetAtt[0].authorDid })
    }

    ctx.metrics.incr('ingester.amendment.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    // HIGH-11: Before deleting, find which attestation this amendment targeted
    const amd = await ctx.db.select({ targetUri: amendments.targetUri })
      .from(amendments).where(eq(amendments.uri, op.uri)).limit(1)

    await deletionHandler.process(ctx.db, op.uri, op.did, 'amendment', amendments)

    // Recompute isAmended: check if any OTHER amendments target same attestation
    if (amd[0]?.targetUri) {
      const remaining = await ctx.db.select({ uri: amendments.uri })
        .from(amendments).where(eq(amendments.targetUri, amd[0].targetUri)).limit(1)
      if (remaining.length === 0) {
        await ctx.db.update(attestations)
          .set({ isAmended: false, latestAmendmentUri: null })
          .where(eq(attestations.uri, amd[0].targetUri))
      }
    }

    // HIGH-12 fix: Mark amender + target attestation author dirty
    await markDirty(ctx.db, { subjectId: null, authorDid: op.did })
    if (amd[0]?.targetUri) {
      const targetAtt = await ctx.db.select({ authorDid: attestations.authorDid, subjectId: attestations.subjectId })
        .from(attestations).where(eq(attestations.uri, amd[0].targetUri)).limit(1)
      if (targetAtt[0]?.authorDid && targetAtt[0].authorDid !== op.did) {
        await markDirty(ctx.db, { subjectId: targetAtt[0].subjectId, authorDid: targetAtt[0].authorDid })
      }
    }

    ctx.metrics.incr('ingester.amendment.deleted')
  },
}
