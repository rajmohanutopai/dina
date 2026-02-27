import { sql, eq, and } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import {
  attestations,
  vouches,
  endorsements,
  flags,
  replies,
  reactions,
  reportRecords,
  revocations,
  delegations,
  collections,
  media,
  amendments,
  verifications,
  reviewRequests,
  comparisons,
  subjectClaims,
  trustPolicies,
  notificationPrefs,
  tombstones,
  trustEdges,
} from '@/db/schema/index.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'
import { markDirty } from '@/db/queries/dirty-flags.js'
import type { ReputationCollection } from '@/config/lexicons.js'

/**
 * Deletion handler with tombstone logic (Fix 13).
 *
 * When a user deletes a record, we check if it was disputed (reported,
 * had dispute replies, or suspicious reactions). If it was disputed,
 * we create a tombstone to preserve the reputation signal (the deletion
 * itself is evidence of bad behavior). If not disputed, the record is
 * simply removed.
 *
 * Trust edges are always cleaned up regardless.
 */

// ── Collection → Table mapping ──────────────────────────────────────

// Each table's Drizzle object, keyed by collection NSID.
// The 'subject' collection maps to the subjects table but deletions
// of subject records are a special case — handled separately.
export const COLLECTION_TABLE_MAP: Record<string, any> = {
  'com.dina.reputation.attestation': attestations,
  'com.dina.reputation.vouch': vouches,
  'com.dina.reputation.endorsement': endorsements,
  'com.dina.reputation.flag': flags,
  'com.dina.reputation.reply': replies,
  'com.dina.reputation.reaction': reactions,
  'com.dina.reputation.reportRecord': reportRecords,
  'com.dina.reputation.revocation': revocations,
  'com.dina.reputation.delegation': delegations,
  'com.dina.reputation.collection': collections,
  'com.dina.reputation.media': media,
  'com.dina.reputation.amendment': amendments,
  'com.dina.reputation.verification': verifications,
  'com.dina.reputation.reviewRequest': reviewRequests,
  'com.dina.reputation.comparison': comparisons,
  'com.dina.reputation.subjectClaim': subjectClaims,
  'com.dina.reputation.trustPolicy': trustPolicies,
  'com.dina.reputation.notificationPrefs': notificationPrefs,
}

/**
 * Get the Drizzle table object for a collection NSID.
 * Returns null for unknown collections.
 */
export function getSourceTable(collection: string): any | null {
  return COLLECTION_TABLE_MAP[collection] ?? null
}

// ── Dispute detection ───────────────────────────────────────────────

interface DisputeSignals {
  reportCount: number
  disputeReplyCount: number
  suspiciousReactionCount: number
}

/**
 * Check how many dispute signals exist against a given record URI.
 */
async function getDisputeSignals(
  db: DrizzleDB,
  uri: string,
): Promise<DisputeSignals> {
  // Count reports targeting this URI
  const reportResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reportRecords)
    .where(eq(reportRecords.targetUri, uri))

  // Count replies with dispute intent targeting this URI
  const disputeResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(replies)
    .where(and(
      eq(replies.rootUri, uri),
      eq(replies.intent, 'dispute'),
    ))

  // Count suspicious reactions
  const suspiciousResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reactions)
    .where(and(
      eq(reactions.targetUri, uri),
      eq(reactions.reaction, 'suspicious'),
    ))

  return {
    reportCount: reportResult[0]?.count ?? 0,
    disputeReplyCount: disputeResult[0]?.count ?? 0,
    suspiciousReactionCount: suspiciousResult[0]?.count ?? 0,
  }
}

// ── Tombstone creation ──────────────────────────────────────────────

/**
 * Fetch attestation metadata for tombstone enrichment.
 * Returns null if the URI is not an attestation or not found.
 */
async function getAttestationMeta(db: DrizzleDB, uri: string) {
  const result = await db
    .select({
      subjectId: attestations.subjectId,
      subjectRefRaw: attestations.subjectRefRaw,
      category: attestations.category,
      sentiment: attestations.sentiment,
      domain: attestations.domain,
      recordCreatedAt: attestations.recordCreatedAt,
      evidenceJson: attestations.evidenceJson,
      hasCosignature: attestations.hasCosignature,
    })
    .from(attestations)
    .where(eq(attestations.uri, uri))
    .limit(1)

  return result[0] ?? null
}

async function createTombstone(
  db: DrizzleDB,
  uri: string,
  authorDid: string,
  recordType: string,
  disputes: DisputeSignals,
): Promise<void> {
  // Try to enrich with attestation metadata
  const meta = await getAttestationMeta(db, uri)

  const now = new Date()
  const originalCreatedAt = meta?.recordCreatedAt ?? null
  const durationDays = originalCreatedAt
    ? Math.floor((now.getTime() - originalCreatedAt.getTime()) / (1000 * 60 * 60 * 24))
    : null

  await db.insert(tombstones).values({
    originalUri: uri,
    authorDid,
    recordType,
    subjectId: meta?.subjectId ?? null,
    subjectRefRaw: meta?.subjectRefRaw ?? null,
    category: meta?.category ?? null,
    sentiment: meta?.sentiment ?? null,
    domain: meta?.domain ?? null,
    originalCreatedAt,
    deletedAt: now,
    durationDays,
    hadEvidence: meta?.evidenceJson != null,
    hadCosignature: meta?.hasCosignature ?? false,
    reportCount: disputes.reportCount,
    disputeReplyCount: disputes.disputeReplyCount,
    suspiciousReactionCount: disputes.suspiciousReactionCount,
  }).onConflictDoNothing()

  logger.info(
    { uri, authorDid, reportCount: disputes.reportCount },
    '[Deletion] Tombstone created for disputed record',
  )
  metrics.incr('ingester.deletion.tombstone_created')
}

// ── Public API ──────────────────────────────────────────────────────

export const deletionHandler = {
  /**
   * Process a record deletion.
   *
   * 1. Check for dispute signals (reports, dispute replies, suspicious reactions)
   * 2. If disputed, create a tombstone to preserve the reputation signal
   * 3. Delete the record from the appropriate table
   * 4. Clean up trust edges referencing this record
   */
  async process(
    db: DrizzleDB,
    uri: string,
    authorDid: string,
    recordType: string,
    sourceTable: any,
  ): Promise<void> {
    // Step 0: Capture attestation metadata BEFORE deletion so dirty marking
    // can reference the subject. After delete, the row is gone.
    const attMeta = await getAttestationMeta(db, uri)

    // Step 1: Check dispute signals
    const disputes = await getDisputeSignals(db, uri)
    const isDisputed =
      disputes.reportCount > 0 ||
      disputes.disputeReplyCount > 0 ||
      disputes.suspiciousReactionCount > 0

    // Step 2: Create tombstone if disputed
    if (isDisputed) {
      await createTombstone(db, uri, authorDid, recordType, disputes)
    }

    // Step 3: Delete from the source table
    // All record tables use 'uri' as their primary key
    try {
      // MED-11: Guard deletion with author DID to prevent cross-author deletion
      if (sourceTable.authorDid) {
        await db.delete(sourceTable).where(
          and(eq(sourceTable.uri, uri), eq(sourceTable.authorDid, authorDid))
        )
      } else {
        await db.delete(sourceTable).where(eq(sourceTable.uri, uri))
      }
      metrics.incr('ingester.deletion.record_deleted', { collection: recordType })
    } catch (err) {
      logger.error({ err, uri, recordType }, '[Deletion] Failed to delete record')
      throw err
    }

    // Step 4: Clean up trust edges
    await db.delete(trustEdges).where(eq(trustEdges.sourceUri, uri))

    // Step 5: Mark affected entities dirty using pre-deletion metadata
    await markDirty(db, {
      subjectId: attMeta?.subjectId ?? null,
      authorDid,
    })

    logger.debug(
      { uri, authorDid, recordType, isDisputed },
      '[Deletion] Record deletion processed',
    )
  },
}
