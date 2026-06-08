/**
 * Review publish service (mobile-local).
 *
 * The publish decision tree for a PeerLens review, kept OUT of the
 * write-screen route file: choose between the dev test-inject shortcut,
 * the real sovereign PDS publish, and the durable offline outbox — with
 * the in-memory cap respected so the durable store can't grow unbounded.
 *
 * Free of UI concerns: it never navigates or sets component state. It
 * returns a discriminated outcome the screen maps to navigation / error
 * display.
 */

import { PDSPublisherError } from '@dina/brain';
import { FEATURE_NAMES } from '@dina/core';


import {
  injectAttestation,
  isTestPublishConfigured,
  type InjectAttestationRequest,
} from './appview_runtime';
import { MAX_QUEUE_SIZE } from './outbox';
import { enqueueLocal, dismissLocal, type AttestationDraftBody } from './outbox_store';
import {
  AttestationIdentityMismatchError,
  AttestationLexiconError,
  publishAttestationToPDS,
} from './publish_attestation';
import { countActivePendingReviews, persistPendingReview } from './review_outbox_durable';

import type { PDSPublisher } from '@dina/brain';

/** Everything the service needs to publish or durably queue a review. */
export interface PublishReviewInput {
  /** The owner DID the record publishes under (PDS repo owner = author). */
  did: string;
  /** Authed PDS publisher when the node has one; `undefined` for a no-PDS node. */
  pdsPublisher: PDSPublisher | undefined;
  /** AT-Proto record key — edit-aware (caller reuses the original on edits). */
  rkey: string;
  /** The built attestation record body (no `$type`; the publisher adds it). */
  record: Record<string, unknown>;
  /** Minimal body the Outbox screen renders for a queued review. */
  draft: AttestationDraftBody;
  /** Originating inline chat-draft card, for durable → publish linkage. */
  threadId: string | undefined;
  draftId: string | undefined;
}

export type PublishReviewOutcome =
  | { kind: 'published'; attestation: { uri: string; cid: string } }
  | { kind: 'queued' }
  | { kind: 'error'; message: string };

/** Local row id — also the outbox-screen key + durable KV key. */
function generateClientId(): string {
  return `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function queueErrorMessage(reason: 'cap_exceeded' | 'duplicate_client_id'): string {
  return reason === 'cap_exceeded'
    ? 'Your outbox is full. Dismiss some queued reviews and try again.'
    : "Couldn't queue this review. Please try again.";
}

/**
 * Queue a buildable review to the durable outbox, respecting the in-memory
 * cap: enqueue to the mirror FIRST, and only persist durably when the mirror
 * accepts it — so the durable store can't grow past the cap (and the user
 * sees the cap error).
 */
export async function queueReviewDurably(
  input: PublishReviewInput,
): Promise<PublishReviewOutcome> {
  const clientId = generateClientId();
  const queued = enqueueLocal(input.draft, clientId);
  if (!queued.ok) return { kind: 'error', message: queueErrorMessage(queued.reason) };
  // The mirror cap (enqueueLocal) only sees HYDRATED rows; if the durable store
  // wasn't mirrored yet (queued before/without a hydrate, or a hydrate failure)
  // the mirror undercounts and would wave a 51st review through — which then
  // persists and survives restart over-cap. Gate on the authoritative durable
  // count too, rolling back the optimistic mirror row when it's already full.
  // Count only THIS identity's rows: foreign-DID rows (restore / re-onboard) are
  // hidden + un-dismissable, so they must not occupy the current DID's cap.
  if ((await countActivePendingReviews(input.did)) >= MAX_QUEUE_SIZE) {
    dismissLocal(clientId);
    return { kind: 'error', message: queueErrorMessage('cap_exceeded') };
  }
  try {
    await persistPendingReview({
      clientId,
      did: input.did,
      rkey: input.rkey,
      record: input.record,
      draft: input.draft,
      attempts: 0,
      createdAt: new Date().toISOString(),
      threadId: input.threadId,
      draftId: input.draftId,
    });
  } catch {
    // The durable (SQLCipher/KV) write failed AFTER the mirror row was added.
    // Roll the mirror back so the user never sees a "queued" review that only
    // lives in memory and silently vanishes on the next restart — surface an
    // actionable error instead. (Mirror-first ordering is deliberate: it lets
    // enqueueLocal enforce the outbox cap before we persist.)
    dismissLocal(clientId);
    return {
      kind: 'error',
      message: "Couldn't save this review to publish later. Please try again.",
    };
  }
  return { kind: 'queued' };
}

/**
 * Publish a review. Path order:
 *   1. Dev test-inject shortcut (fast E2E; writes straight to AppView's DB).
 *   2. Real sovereign publish via the node's authed PDS publisher.
 *   3. Durable outbox — on offline / PDS failure / no publisher (the drainer
 *      retries, and it survives restart).
 *
 * Returns the outcome; the caller maps it to nav + error display.
 */
export async function publishReview(input: PublishReviewInput): Promise<PublishReviewOutcome> {
  if (isTestPublishConfigured()) {
    try {
      const result = await injectAttestation({
        authorDid: input.did,
        rkey: input.rkey,
        cid: `bafyreim${Date.now().toString(36)}`,
        record: input.record as InjectAttestationRequest['record'],
      });
      return { kind: 'published', attestation: result };
    } catch (err) {
      return {
        kind: 'error',
        message:
          err instanceof Error ? err.message : `Couldn't publish to ${FEATURE_NAMES.peerlens}.`,
      };
    }
  }

  if (input.pdsPublisher !== undefined) {
    try {
      const result = await publishAttestationToPDS(
        input.pdsPublisher,
        input.did,
        input.record,
        input.rkey,
      );
      return { kind: 'published', attestation: result };
    } catch (err) {
      // PERMANENT failures must NOT be queued — queueing only retries the same
      // failure until it dead-letters. Surface an actionable error instead.
      if (err instanceof AttestationIdentityMismatchError) {
        return {
          kind: 'error',
          message:
            "This device's PDS account doesn't match your identity. Check your infrastructure settings or re-onboard.",
        };
      }
      if (err instanceof AttestationLexiconError) {
        return { kind: 'error', message: err.message };
      }
      // A 4xx from the PDS is usually a PERMANENT, caller-side failure:
      // wrong/expired credentials (401/403) or a rejected request (400).
      // Retrying the same payload can't succeed without the user fixing
      // something, so surface an actionable error rather than queuing it to
      // retry-until-dead-letter. EXCEPT the retryable 4xx — 429 Too Many
      // Requests and 408 Request Timeout — which, like a network error
      // (`status === null`) or a 5xx server hiccup, are genuinely transient and
      // fall through to the durable outbox for the backoff retry it exists for.
      const RETRYABLE_4XX = new Set([408, 429]);
      if (
        err instanceof PDSPublisherError &&
        err.status !== null &&
        err.status < 500 &&
        !RETRYABLE_4XX.has(err.status)
      ) {
        return {
          kind: 'error',
          message:
            err.status === 401 || err.status === 403
              ? `Couldn't publish to ${FEATURE_NAMES.peerlens} — your PDS credentials may be wrong or expired. Check your infrastructure settings or re-onboard.`
              : `${FEATURE_NAMES.peerlens} couldn't accept this review. Please check the content and try again.`,
        };
      }
      // Otherwise transient / offline — fall through to the durable outbox.
    }
  }

  return queueReviewDurably(input);
}
