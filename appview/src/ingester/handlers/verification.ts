import { sql } from 'drizzle-orm'
import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Verification } from '@/shared/types/lexicon-types.js'
import { verifications } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'

/**
 * Handler for com.dina.reputation.verification records.
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

    // If the verification confirms the attestation, mark it as verified.
    // Uses raw SQL because is_verified/verified_by_uri are attestation
    // columns that may be added via migration.
    if (record.result === 'confirmed') {
      await ctx.db.execute(sql`
        UPDATE attestations
        SET is_verified = true, verified_by_uri = ${op.uri}
        WHERE uri = ${record.targetUri}
      `)
    }

    ctx.metrics.incr('ingester.verification.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'verification', verifications)
    ctx.metrics.incr('ingester.verification.deleted')
  },
}
