import { eq, and, sql } from 'drizzle-orm'
import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Verification } from '@/shared/types/lexicon-types.js'
import { verifications, attestations } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'
import { markDirty } from '@/db/queries/dirty-flags.js'

/**
 * Handler for com.dina.trust.verification records.
 *
 * Verifications are third-party confirmations of attestation claims.
 * When a verification result is 'confirmed', the target attestation
 * is marked as verified with a back-reference to the verification URI.
 */
export const verificationHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as Verification

    // Upsert the verification record
    await ctx.db.insert(verifications).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      targetUri: record.targetUri,
      verificationType: record.verificationType,
      evidenceJson: record.evidence ?? null,
      result: record.result,
      text: record.text ?? null,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoUpdate({
      target: verifications.uri,
      set: {
        cid: op.cid!,
        targetUri: record.targetUri,
        verificationType: record.verificationType,
        evidenceJson: record.evidence ?? null,
        result: record.result,
        text: record.text ?? null,
        recordCreatedAt: new Date(record.createdAt),
      },
    })

    // HIGH-05: Use Drizzle ORM instead of raw SQL for type-safe schema access
    // HIGH-11 fix: Handle update transitions — flip isVerified back when
    // result changes from confirmed to denied/inconclusive
    if (record.result === 'confirmed') {
      await ctx.db.update(attestations)
        .set({ isVerified: true, verifiedByUri: op.uri })
        .where(eq(attestations.uri, record.targetUri))
    } else {
      // Result is denied or inconclusive — check if this was the only
      // confirming verification; if so, clear the verified flag
      const otherConfirmed = await ctx.db.select({ uri: verifications.uri })
        .from(verifications)
        .where(and(
          eq(verifications.targetUri, record.targetUri),
          eq(verifications.result, 'confirmed'),
        ))
        .limit(1)
      if (otherConfirmed.length === 0) {
        await ctx.db.update(attestations)
          .set({ isVerified: false, verifiedByUri: null })
          .where(eq(attestations.uri, record.targetUri))
      }
    }

    // HIGH-12 fix: Mark target attestation author + subject dirty (not just verifier)
    const targetAtt = await ctx.db.select({
      authorDid: attestations.authorDid,
      subjectId: attestations.subjectId,
    }).from(attestations).where(eq(attestations.uri, record.targetUri)).limit(1)

    await markDirty(ctx.db, {
      subjectId: targetAtt[0]?.subjectId ?? null,
      authorDid: op.did,
      subjectDid: undefined,
    })
    if (targetAtt[0]?.authorDid && targetAtt[0].authorDid !== op.did) {
      await markDirty(ctx.db, {
        subjectId: null,
        authorDid: targetAtt[0].authorDid,
      })
    }

    ctx.metrics.incr('ingester.verification.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    // HIGH-11: Before deleting, check if this verification confirmed an attestation
    const verRow = await ctx.db.select({ targetUri: verifications.targetUri })
      .from(verifications).where(eq(verifications.uri, op.uri)).limit(1)

    await deletionHandler.process(ctx.db, op.uri, op.did, 'verification', verifications)

    // Recompute isVerified: check if any OTHER verifications confirm same attestation
    if (verRow[0]?.targetUri) {
      const remaining = await ctx.db.select({ uri: verifications.uri })
        .from(verifications)
        .where(and(
          eq(verifications.targetUri, verRow[0].targetUri),
          eq(verifications.result, 'confirmed'),
        ))
        .limit(1)
      if (remaining.length === 0) {
        await ctx.db.update(attestations)
          .set({ isVerified: false, verifiedByUri: null })
          .where(eq(attestations.uri, verRow[0].targetUri))
      }
    }

    // HIGH-12 fix: Mark verifier + target attestation author dirty
    await markDirty(ctx.db, { subjectId: null, authorDid: op.did })
    if (verRow[0]?.targetUri) {
      const targetAtt = await ctx.db.select({ authorDid: attestations.authorDid, subjectId: attestations.subjectId })
        .from(attestations).where(eq(attestations.uri, verRow[0].targetUri)).limit(1)
      if (targetAtt[0]?.authorDid && targetAtt[0].authorDid !== op.did) {
        await markDirty(ctx.db, { subjectId: targetAtt[0].subjectId, authorDid: targetAtt[0].authorDid })
      }
    }

    ctx.metrics.incr('ingester.verification.deleted')
  },
}
