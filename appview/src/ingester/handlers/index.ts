import type { DrizzleDB } from '@/db/connection.js'
import type { Logger } from '@/shared/utils/logger.js'
import type { Metrics } from '@/shared/utils/metrics.js'

// ── Context ─────────────────────────────────────────────────────────

/** Shared context passed to every record handler */
export interface HandlerContext {
  db: DrizzleDB
  logger: Logger
  metrics: Metrics
}

// ── Record operation ────────────────────────────────────────────────

/** A single record operation from the Jetstream firehose */
export interface RecordOp {
  /** AT Protocol URI (at://did/collection/rkey) */
  uri: string
  /** DID of the record author */
  did: string
  /** Collection NSID (e.g. com.dina.reputation.attestation) */
  collection: string
  /** Record key within the collection */
  rkey: string
  /** CID of the record (present on create/update) */
  cid?: string
  /** The record data (present on create/update, absent on delete) */
  record?: Record<string, unknown>
}

// ── Handler interface ───────────────────────────────────────────────

/** Interface that every record handler must implement */
export interface RecordHandler {
  /** Handle a record creation or update */
  handleCreate(ctx: HandlerContext, op: RecordOp): Promise<void>
  /** Handle a record deletion */
  handleDelete(ctx: HandlerContext, op: RecordOp): Promise<void>
}

// ── Handler registry ────────────────────────────────────────────────

import { attestationHandler } from './attestation.js'
import { vouchHandler } from './vouch.js'
import { endorsementHandler } from './endorsement.js'
import { flagHandler } from './flag.js'
import { replyHandler } from './reply.js'
import { reactionHandler } from './reaction.js'
import { reportRecordHandler } from './report-record.js'
import { revocationHandler } from './revocation.js'
import { delegationHandler } from './delegation.js'
import { collectionHandler } from './collection.js'
import { mediaHandler } from './media.js'
import { subjectHandler } from './subject.js'
import { amendmentHandler } from './amendment.js'
import { verificationHandler } from './verification.js'
import { reviewRequestHandler } from './review-request.js'
import { comparisonHandler } from './comparison.js'
import { subjectClaimHandler } from './subject-claim.js'
import { trustPolicyHandler } from './trust-policy.js'
import { notificationPrefsHandler } from './notification-prefs.js'

const handlers: Record<string, RecordHandler> = {
  'com.dina.reputation.attestation': attestationHandler,
  'com.dina.reputation.vouch': vouchHandler,
  'com.dina.reputation.endorsement': endorsementHandler,
  'com.dina.reputation.flag': flagHandler,
  'com.dina.reputation.reply': replyHandler,
  'com.dina.reputation.reaction': reactionHandler,
  'com.dina.reputation.reportRecord': reportRecordHandler,
  'com.dina.reputation.revocation': revocationHandler,
  'com.dina.reputation.delegation': delegationHandler,
  'com.dina.reputation.collection': collectionHandler,
  'com.dina.reputation.media': mediaHandler,
  'com.dina.reputation.subject': subjectHandler,
  'com.dina.reputation.amendment': amendmentHandler,
  'com.dina.reputation.verification': verificationHandler,
  'com.dina.reputation.reviewRequest': reviewRequestHandler,
  'com.dina.reputation.comparison': comparisonHandler,
  'com.dina.reputation.subjectClaim': subjectClaimHandler,
  'com.dina.reputation.trustPolicy': trustPolicyHandler,
  'com.dina.reputation.notificationPrefs': notificationPrefsHandler,
}

/**
 * Look up the handler for a collection NSID.
 * Returns null if no handler is registered (unknown collection).
 */
export function routeHandler(collection: string): RecordHandler | null {
  return handlers[collection] ?? null
}

/**
 * Get all registered collection NSIDs.
 */
export function getRegisteredCollections(): string[] {
  return Object.keys(handlers)
}
