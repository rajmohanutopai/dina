/**
 * The PeerLens publish worker tick. Covers the demo-scope guard, lease reclaim
 * (crash recovery), the drain happy path (publish + prune + receipt), retryable
 * vs permanent outcomes, dead-lettering a reclaimed-past-cap job, single-flight
 * across overlapping ticks (CAS), and the backoff due-gate.
 */

import { PDSPublisherError } from '@dina/brain';
import {
  InMemoryReviewPublishRepository,
  MAX_PUBLISH_ATTEMPTS,
  PUBLISH_CLAIM_LEASE_MS,
  type NewPublishJob,
} from '@dina/core';

import {
  runReviewPublishTick,
  type ReviewPublishWorkerDeps,
} from '../../src/peerlens/review_publish_worker';

import type { PDSPublisher } from '@dina/brain';

const DID = 'did:plc:owner';
const PUBLISHER = {} as unknown as PDSPublisher;
const LEASE = PUBLISH_CLAIM_LEASE_MS;

function newJob(over: Partial<NewPublishJob> = {}): NewPublishJob {
  return {
    jobId: over.jobId ?? 'job-1',
    ownerDid: over.ownerDid ?? DID,
    rkey: over.rkey ?? 'mob-1',
    recordJSON: over.recordJSON ?? '{"text":"hi"}',
    draftJSON: over.draftJSON ?? '{}',
    threadId: over.threadId,
    draftId: over.draftId,
    createdAt: over.createdAt ?? 1,
  };
}

function deps(
  repo: InMemoryReviewPublishRepository,
  over: Partial<ReviewPublishWorkerDeps> = {},
): ReviewPublishWorkerDeps {
  return {
    repo,
    did: DID,
    publisher: PUBLISHER,
    publishToPDS: async () => ({ uri: 'at://x', cid: 'cid1' }),
    isDemoScope: () => false,
    now: () => 1_000_000,
    ...over,
  };
}

describe('runReviewPublishTick', () => {
  it('is a no-op under a guided-demo scope (no publish, job kept queued)', async () => {
    const repo = new InMemoryReviewPublishRepository();
    repo.create(newJob());
    const publishToPDS = jest.fn(async () => ({ uri: 'at://x', cid: 'c' }));
    const res = await runReviewPublishTick(deps(repo, { isDemoScope: () => true, publishToPDS }));
    expect(res).toEqual({ reclaimed: 0, published: 0, requeued: 0, failed: 0 });
    expect(publishToPDS).not.toHaveBeenCalled();
    expect(repo.getById('job-1')?.status).toBe('queued');
  });

  it('drains a due job: publishes, retains the receipt on the job row', async () => {
    const repo = new InMemoryReviewPublishRepository();
    repo.create(newJob({ threadId: 't1', draftId: 'd1' }));
    const res = await runReviewPublishTick(deps(repo));
    expect(res.published).toBe(1);
    const j = repo.findLatestForDraft(DID, 't1', 'd1');
    expect(j?.status).toBe('published');
    expect(j?.publishedUri).toBe('at://x'); // card reads the receipt from here
  });

  it('reaps an expired lease first, then re-publishes the reclaimed job', async () => {
    const repo = new InMemoryReviewPublishRepository();
    repo.create(newJob());
    repo.claim('job-1', 1, LEASE); // claimed long ago; lease lapsed by now()
    const res = await runReviewPublishTick(deps(repo)); // now()=1_000_000 ≫ 1+LEASE
    expect(res.reclaimed).toBe(1);
    expect(res.published).toBe(1); // reclaimed → queued → drained same tick
    expect(repo.getById('job-1')?.status).toBe('published');
  });

  it('a retryable failure requeues with attempts++', async () => {
    const repo = new InMemoryReviewPublishRepository();
    repo.create(newJob());
    const res = await runReviewPublishTick(
      deps(repo, {
        publishToPDS: async () => {
          throw new PDSPublisherError('net', null);
        },
      }),
    );
    expect(res.requeued).toBe(1);
    const j = repo.getById('job-1');
    expect(j?.status).toBe('queued');
    expect(j?.attempts).toBe(1);
  });

  it('a permanent failure marks the job failed', async () => {
    const repo = new InMemoryReviewPublishRepository();
    repo.create(newJob());
    const res = await runReviewPublishTick(
      deps(repo, {
        publishToPDS: async () => {
          throw new PDSPublisherError('forbidden', 403);
        },
      }),
    );
    expect(res.failed).toBe(1);
    expect(repo.getById('job-1')?.status).toBe('failed');
  });

  it('dead-letters a job reclaimed past the attempt cap (no re-publish)', async () => {
    const repo = new InMemoryReviewPublishRepository();
    repo.create(newJob());
    for (let i = 0; i < MAX_PUBLISH_ATTEMPTS; i++) {
      repo.claim('job-1', 1 + i, LEASE);
      repo.reclaimExpiredLeases(DID, 1 + i + LEASE + 1);
    }
    expect(repo.getById('job-1')?.attempts).toBe(MAX_PUBLISH_ATTEMPTS);
    const publishToPDS = jest.fn(async () => ({ uri: 'x', cid: 'c' }));
    const res = await runReviewPublishTick(deps(repo, { publishToPDS }));
    expect(publishToPDS).not.toHaveBeenCalled();
    expect(res.failed).toBe(1);
    const j = repo.getById('job-1');
    expect(j?.status).toBe('failed');
    expect(j?.lastErrorCode).toBe('retries_exhausted');
  });

  it('overlapping ticks publish the job exactly once (single-flight via CAS)', async () => {
    const repo = new InMemoryReviewPublishRepository();
    repo.create(newJob());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const publishToPDS = jest.fn(async () => {
      await gate; // hold the first tick mid-publish so a second tick overlaps
      return { uri: 'at://x', cid: 'c' };
    });
    const tick1 = runReviewPublishTick(deps(repo, { publishToPDS }));
    const tick2 = runReviewPublishTick(deps(repo, { publishToPDS })); // job already 'publishing' → no claim
    release();
    const [r1, r2] = await Promise.all([tick1, tick2]);
    expect(publishToPDS).toHaveBeenCalledTimes(1);
    expect(r1.published + r2.published).toBe(1);
    expect(repo.getById('job-1')?.status).toBe('published');
  });

  it('does not drain a job still inside its backoff window', async () => {
    const repo = new InMemoryReviewPublishRepository();
    repo.create(newJob());
    repo.claim('job-1', 1, LEASE);
    repo.requeue('job-1', 1, 2_000_000, { class: 'retryable', code: 'network', message: 'x' }, 1);
    const publishToPDS = jest.fn(async () => ({ uri: 'x', cid: 'c' }));
    const res = await runReviewPublishTick(deps(repo, { now: () => 1_000_000, publishToPDS })); // < 2_000_000
    expect(publishToPDS).not.toHaveBeenCalled();
    expect(res.published).toBe(0);
    expect(repo.getById('job-1')?.status).toBe('queued');
  });
});
