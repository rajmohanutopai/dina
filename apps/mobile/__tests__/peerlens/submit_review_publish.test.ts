/**
 * `submitReviewPublish` — the single publish entrypoint. Covers the gate order
 * (demo → lexicon → credentials → cap), the durable-job create, and the inline
 * fast-path mapping (published / queued-on-retryable / error-on-permanent),
 * including the atomic receipt-on-success.
 */

import { PDSPublisherError } from '@dina/brain';
import { InMemoryReviewPublishRepository, MAX_PUBLISH_QUEUE } from '@dina/core';

import { submitReviewPublish, type SubmitReviewInput } from '../../src/peerlens/submit_review_publish';

import type { AttestationDraftBody } from '../../src/peerlens/review_draft_body';
import type { PDSPublisher } from '@dina/brain';

const DID = 'did:plc:owner';
const PUBLISHER = {} as unknown as PDSPublisher; // publishToPDS is always stubbed
const DRAFT: AttestationDraftBody = {
  sentiment: 'positive',
  headline: 'Solid',
  body: 'Good support.',
  confidence: 'high',
  subjectTitle: 'Chair',
};

function baseInput(over: Partial<SubmitReviewInput> = {}): SubmitReviewInput {
  return {
    did: DID,
    publisher: PUBLISHER,
    rkey: 'mob-1',
    record: { subject: { name: 'Chair' }, text: 'short review' },
    draft: DRAFT,
    repo: new InMemoryReviewPublishRepository(),
    nowMs: 1_000,
    newJobId: () => 'job-1',
    publishToPDS: async () => ({ uri: 'at://x', cid: 'cid1' }), // success by default
    isDemoScope: () => false,
    now: () => 2_000,
    ...over,
  };
}

describe('submitReviewPublish — gates (nothing persisted)', () => {
  it('demo scope → demo_scope, no job', async () => {
    const repo = new InMemoryReviewPublishRepository();
    const out = await submitReviewPublish(baseInput({ repo, isDemoScope: () => true }));
    expect(out.kind).toBe('demo_scope');
    expect(repo.countActive(DID)).toBe(0);
  });

  it('over-long text → lexicon error, no job', async () => {
    const repo = new InMemoryReviewPublishRepository();
    const out = await submitReviewPublish(
      baseInput({ repo, record: { text: 'x'.repeat(2_001) } }),
    );
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.code).toBe('lexicon_invalid');
    expect(repo.countActive(DID)).toBe(0);
  });

  it('no publisher → no_credentials, no job (hard error, never queued)', async () => {
    const repo = new InMemoryReviewPublishRepository();
    const out = await submitReviewPublish(baseInput({ repo, publisher: undefined }));
    expect(out.kind).toBe('no_credentials');
    expect(repo.countActive(DID)).toBe(0);
  });

  it('at the per-DID cap → cap_exceeded, no new job', async () => {
    const repo = new InMemoryReviewPublishRepository();
    for (let i = 0; i < MAX_PUBLISH_QUEUE; i++) {
      repo.create({
        jobId: `seed-${i}`,
        ownerDid: DID,
        rkey: 'r',
        recordJSON: '{}',
        draftJSON: '{}',
        createdAt: 1,
      });
    }
    const out = await submitReviewPublish(baseInput({ repo, newJobId: () => 'overflow' }));
    expect(out.kind).toBe('cap_exceeded');
    expect(repo.getById('overflow')).toBeNull();
    expect(repo.countActive(DID)).toBe(MAX_PUBLISH_QUEUE);
  });
});

describe('submitReviewPublish — inline fast-path', () => {
  it('online success → published; job retained with the receipt on the row (card projects it)', async () => {
    const repo = new InMemoryReviewPublishRepository();
    const out = await submitReviewPublish(baseInput({ repo, threadId: 't1', draftId: 'd1' }));
    expect(out).toEqual({ kind: 'published', uri: 'at://x', cid: 'cid1' });
    const j = repo.findLatestForDraft(DID, 't1', 'd1');
    expect(j?.status).toBe('published');
    expect(j?.publishedUri).toBe('at://x');
    expect(j?.publishedCid).toBe('cid1');
  });

  it('success without a chat draft → published (no draft back-reference)', async () => {
    const repo = new InMemoryReviewPublishRepository();
    const out = await submitReviewPublish(baseInput({ repo, newJobId: () => 'j2' })); // no thread/draft
    expect(out.kind).toBe('published');
    expect(repo.getById('j2')?.status).toBe('published');
  });

  it('retryable (offline/network) failure → queued; job kept with backoff', async () => {
    const repo = new InMemoryReviewPublishRepository();
    const out = await submitReviewPublish(
      baseInput({
        repo,
        publishToPDS: async () => {
          throw new PDSPublisherError('network', null);
        },
      }),
    );
    expect(out).toEqual({ kind: 'queued', jobId: 'job-1' });
    const j = repo.getById('job-1');
    expect(j?.status).toBe('queued');
    expect(j?.attempts).toBe(1);
    expect(j?.nextAttemptAt).toBeGreaterThan(0);
  });

  it('permanent failure → error; job kept as failed for the user to act on', async () => {
    const repo = new InMemoryReviewPublishRepository();
    const out = await submitReviewPublish(
      baseInput({
        repo,
        publishToPDS: async () => {
          throw new PDSPublisherError('unauthorized', 401);
        },
      }),
    );
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.code).toBe('unauthorized');
      expect(out.message).toMatch(/credentials|infrastructure|re-onboard/i);
    }
    expect(repo.getById('job-1')?.status).toBe('failed');
  });
});
