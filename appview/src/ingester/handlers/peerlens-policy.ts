import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { PeerlensPolicy } from '@/shared/types/lexicon-types.js'
import { peerlensPolicies } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'

/**
 * Handler for com.dina.peerlens.trustPolicy records.
 *
 * Trust policies define per-user PeerLens graph parameters: how deep to
 * traverse the graph, which domains to trust, which DIDs to block,
 * and whether a vouch is required before trusting attestations.
 * Each user has at most one trust policy (authorDid is unique).
 */
export const peerlensPolicyHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as PeerlensPolicy

    await ctx.db.insert(peerlensPolicies).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      maxGraphDepth: record.maxGraphDepth ?? null,
      trustedDomainsJson: record.trustedDomains ?? null,
      blockedDidsJson: record.blockedDids ?? null,
      requireVouch: record.requireVouch ?? false,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoUpdate({
      target: peerlensPolicies.authorDid,
      set: {
        uri: op.uri,
        cid: op.cid!,
        maxGraphDepth: record.maxGraphDepth ?? null,
        trustedDomainsJson: record.trustedDomains ?? null,
        blockedDidsJson: record.blockedDids ?? null,
        requireVouch: record.requireVouch ?? false,
        recordCreatedAt: new Date(record.createdAt),
      },
    })

    ctx.metrics.incr('ingester.trustPolicy.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'trustPolicy', peerlensPolicies)
    ctx.metrics.incr('ingester.trustPolicy.deleted')
  },
}
