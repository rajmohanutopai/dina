import {
  InMemoryReviewPublishRepository,
  PUBLISH_CLAIM_LEASE_MS,
  publishClaimedReview,
  runReviewPublishTick,
  type ClassifiedError,
} from '../../src';

const OWNER = 'did:plc:owner';
const RECORD = JSON.stringify({
  subject: { type: 'product', identifier: 'chair-123' },
  category: 'furniture',
  sentiment: 'positive',
  createdAt: '2026-07-25T10:00:00.000Z',
});

function create(repo: InMemoryReviewPublishRepository, id = 'job-1'): void {
  repo.create({
    jobId: id,
    ownerDid: OWNER,
    rkey: id,
    recordJSON: RECORD,
    draftJSON: '{}',
    createdAt: 1,
  });
}

const classify = (error: unknown): ClassifiedError => ({
  class: error instanceof TypeError ? 'permanent' : 'retryable',
  code: error instanceof TypeError ? 'bad_request' : 'network',
  message: error instanceof Error ? error.message : String(error),
});

describe('review publish pipeline', () => {
  it('claims and completes a due job with its durable receipt', async () => {
    const repo = new InMemoryReviewPublishRepository();
    create(repo);
    const publish = jest.fn(async () => ({ uri: 'at://review/1', cid: 'bafy1' }));

    await expect(
      runReviewPublishTick({
        ownerDid: OWNER,
        repo,
        publish,
        classifyError: classify,
        now: () => 100,
      }),
    ).resolves.toEqual({ reclaimed: 0, published: 1, requeued: 0, failed: 0 });
    expect(repo.getById('job-1')).toMatchObject({
      status: 'published',
      publishedUri: 'at://review/1',
      publishedCid: 'bafy1',
    });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('requeues retryable errors and terminalizes permanent errors', async () => {
    const retryRepo = new InMemoryReviewPublishRepository();
    create(retryRepo, 'retry');
    await runReviewPublishTick({
      ownerDid: OWNER,
      repo: retryRepo,
      publish: async () => {
        throw new Error('offline');
      },
      classifyError: classify,
      now: () => 1_000,
    });
    expect(retryRepo.getById('retry')).toMatchObject({
      status: 'queued',
      attempts: 1,
      lastErrorCode: 'network',
      nextAttemptAt: 6_000,
    });

    const failRepo = new InMemoryReviewPublishRepository();
    create(failRepo, 'fail');
    await runReviewPublishTick({
      ownerDid: OWNER,
      repo: failRepo,
      publish: async () => {
        throw new TypeError('invalid');
      },
      classifyError: classify,
      now: () => 2_000,
    });
    expect(failRepo.getById('fail')).toMatchObject({
      status: 'failed',
      lastErrorCode: 'bad_request',
    });
  });

  it('fails malformed persisted JSON without calling the writer', async () => {
    const repo = new InMemoryReviewPublishRepository();
    repo.create({
      jobId: 'corrupt',
      ownerDid: OWNER,
      rkey: 'corrupt',
      recordJSON: '{',
      draftJSON: '{}',
      createdAt: 1,
    });
    const publish = jest.fn();
    await runReviewPublishTick({
      ownerDid: OWNER,
      repo,
      publish,
      classifyError: classify,
      now: () => 100,
    });
    expect(repo.getById('corrupt')).toMatchObject({
      status: 'failed',
      lastErrorCode: 'lexicon_invalid',
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not let a stale lease complete a reclaimed attempt', async () => {
    const repo = new InMemoryReviewPublishRepository();
    create(repo);
    expect(repo.claim('job-1', 100, PUBLISH_CLAIM_LEASE_MS)).toBe(true);
    const stale = repo.getById('job-1')!;

    expect(repo.reclaimExpiredLeases(OWNER, 100 + PUBLISH_CLAIM_LEASE_MS + 1)).toBe(1);
    expect(repo.claim('job-1', 100 + PUBLISH_CLAIM_LEASE_MS + 2, PUBLISH_CLAIM_LEASE_MS)).toBe(
      true,
    );

    await expect(
      publishClaimedReview(stale, {
        repo,
        publish: async () => ({ uri: 'at://stale', cid: 'stale' }),
        classifyError: classify,
        now: () => 100 + PUBLISH_CLAIM_LEASE_MS + 3,
      }),
    ).resolves.toEqual({ kind: 'lost' });
    expect(repo.getById('job-1')).toMatchObject({
      status: 'publishing',
      publishedUri: null,
    });
  });

  it('isolates queues by owner DID', async () => {
    const repo = new InMemoryReviewPublishRepository();
    create(repo, 'own');
    repo.create({
      jobId: 'foreign',
      ownerDid: 'did:plc:other',
      rkey: 'foreign',
      recordJSON: RECORD,
      draftJSON: '{}',
      createdAt: 1,
    });
    const publish = jest.fn(async () => ({ uri: 'at://own', cid: 'own' }));
    await runReviewPublishTick({
      ownerDid: OWNER,
      repo,
      publish,
      classifyError: classify,
      now: () => 100,
    });
    expect(repo.getById('own')?.status).toBe('published');
    expect(repo.getById('foreign')?.status).toBe('queued');
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
