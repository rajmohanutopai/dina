/**
 * A review the OWNER writes, from their own Dina page (HOSTED_DINA §6.2).
 *
 * It goes on the same durable queue as every other PeerLens publish
 * (`publish_job_repository.ts`), and the host's publish supervisor writes it
 * to the owner's PDS repo. Unlike an agent's review it carries no
 * `isAgentGenerated` mark: the owner chose it, behind their passphrase.
 */

import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import { validateLexicon } from '../peerlens/pds_publish';

import { MAX_PUBLISH_QUEUE } from './publish_job';
import { getReviewPublishRepository } from './publish_job_repository';

import type { Attestation } from '@dina/protocol';

/** The repo identity reviews publish under; set by the host with its supervisor. */
let ownerDid: string | null = null;

export function setOwnerReviewIdentity(did: string | null): void {
  ownerDid = did;
}

export type OwnerReviewOutcome =
  | { ok: true; jobId: string; rkey: string }
  | {
      ok: false;
      refusal: 'reviews_unavailable' | 'review_publish_queue_full' | 'lexicon_invalid';
      detail?: string;
    };

/** Queue one owner review; the supervisor publishes it. */
export function queueOwnerReview(
  record: Omit<Attestation, 'createdAt' | 'isAgentGenerated'>,
  nowMs: number,
): OwnerReviewOutcome {
  const repo = getReviewPublishRepository();
  if (repo === null || ownerDid === null) return { ok: false, refusal: 'reviews_unavailable' };
  const full = { ...record, createdAt: new Date(nowMs).toISOString() } as Attestation;
  const errors = validateLexicon(full);
  if (errors.length > 0)
    return { ok: false, refusal: 'lexicon_invalid', detail: errors.join('; ') };
  if (repo.countActive(ownerDid) >= MAX_PUBLISH_QUEUE) {
    return { ok: false, refusal: 'review_publish_queue_full' };
  }
  const id = bytesToHex(randomBytes(12));
  const jobId = `review-publish-owner-${id}`;
  const rkey = `owner-${id}`;
  repo.create({
    jobId,
    ownerDid,
    rkey,
    recordJSON: JSON.stringify(full),
    draftJSON: JSON.stringify({
      subject: full.subject.name ?? full.subject.did ?? full.subject.type,
      category: full.category,
      sentiment: full.sentiment,
      text: full.text ?? '',
    }),
    createdAt: nowMs,
  });
  return { ok: true, jobId, rkey };
}
