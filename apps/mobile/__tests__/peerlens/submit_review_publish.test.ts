/**
 * `submitReviewPublish` — the single publish entrypoint. Covers the gate order
 * (demo → lexicon → credentials → cap), the durable-job create, and the inline
 * fast-path mapping (published / queued-on-retryable / error-on-permanent),
 * including the atomic receipt-on-success.
 */

import { PDSPublisherError } from '@dina/brain';
import { InMemoryReviewPublishRepository, MAX_PUBLISH_QUEUE } from '@dina/core';

import { buildAttestationRecord } from '../../src/peerlens/publish_helpers';
import {
  submitReviewPublish,
  type SubmitReviewInput,
} from '../../src/peerlens/submit_review_publish';
import { emptyWriteFormStateWithSubject } from '../../src/peerlens/write_form_data';

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
const FORM = {
  ...emptyWriteFormStateWithSubject('product'),
  sentiment: 'positive' as const,
  headline: 'Solid',
  body: 'Good support.',
  confidence: 'high' as const,
  subject: {
    kind: 'product' as const,
    name: 'Chair',
    did: '',
    uri: '',
    identifier: '',
  },
};

function baseInput(over: Partial<SubmitReviewInput> = {}): SubmitReviewInput {
  return {
    did: DID,
    publisher: PUBLISHER,
    rkey: 'mob-1',
    record: buildAttestationRecord(FORM),
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
    const out = await submitReviewPublish(baseInput({ repo, record: { text: 'x'.repeat(2_001) } }));
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

  it('existing queued job + no publisher → no_credentials (not a stuck queued projection)', async () => {
    const repo = new InMemoryReviewPublishRepository();
    repo.create({
      jobId: 'j1',
      ownerDid: DID,
      rkey: 'r',
      recordJSON: '{}',
      draftJSON: '{}',
      threadId: 't1',
      draftId: 'd1',
      createdAt: 1,
    });
    // j1 is queued; this boot has no publisher → surface the hard setup state,
    // not a `queued` for a job the worker can never drain.
    const out = await submitReviewPublish(
      baseInput({
        repo,
        publisher: undefined,
        threadId: 't1',
        draftId: 'd1',
        newJobId: () => 'j2',
      }),
    );
    expect(out.kind).toBe('no_credentials');
    expect(repo.getById('j2')).toBeNull();
  });

  it('a rejected re-submit (lexicon) preserves the existing failed job', async () => {
    const repo = new InMemoryReviewPublishRepository();
    repo.create({
      jobId: 'f1',
      ownerDid: DID,
      rkey: 'r',
      recordJSON: '{}',
      draftJSON: '{}',
      threadId: 't1',
      draftId: 'd1',
      createdAt: 1,
    });
    repo.claim('f1', 1, 60_000);
    repo.fail('f1', { class: 'permanent', code: 'bad_request', message: 'x' }, 2, 1);
    // Edited re-submit is invalid → the failed row must SURVIVE (it's the user's
    // only retry/dismiss handle; supersede happens only after all gates pass).
    const out = await submitReviewPublish(
      baseInput({
        repo,
        threadId: 't1',
        draftId: 'd1',
        record: { text: 'x'.repeat(2_001) },
        newJobId: () => 'f2',
      }),
    );
    expect(out.kind).toBe('error');
    expect(repo.getById('f1')?.status).toBe('failed'); // preserved
    expect(repo.getById('f2')).toBeNull();
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

  it('success without a chat draft → published, retained as a receipt (dashboard projects it inline)', async () => {
    const repo = new InMemoryReviewPublishRepository();
    const out = await submitReviewPublish(baseInput({ repo, newJobId: () => 'j2' })); // no thread/draft
    expect(out.kind).toBe('published');
    // Full-form publishes now RETAIN a `published` receipt (prune-when-listed)
    // so the reviewer dashboard shows them inline until AppView indexes the
    // review; they're reconcile-pruned later, not on publish.
    const j = repo.getById('j2');
    expect(j?.status).toBe('published');
    expect(j?.publishedUri).toBe('at://x');
  });

  it('success with only ONE back-reference half → retained as a published receipt', async () => {
    const repo = new InMemoryReviewPublishRepository();
    const out = await submitReviewPublish(
      baseInput({ repo, threadId: 't1', newJobId: () => 'jhalf' }),
    ); // no draftId
    expect(out.kind).toBe('published');
    // No longer pruned: the chat card can't project a half-reference row, but the
    // reviewer dashboard projects all published receipts by owner+URI, so it's
    // retained (reconcile-/TTL-pruned later), not deleted on publish.
    const j = repo.getById('jhalf');
    expect(j?.status).toBe('published');
    expect(j?.publishedUri).toBe('at://x');
  });

  it('a second submit for the same chat draft reuses the in-flight job (no duplicate)', async () => {
    const repo = new InMemoryReviewPublishRepository();
    // First submit fails network-retryable → queued (job-1).
    const first = await submitReviewPublish(
      baseInput({
        repo,
        threadId: 't1',
        draftId: 'd1',
        newJobId: () => 'job-1',
        publishToPDS: async () => {
          throw new PDSPublisherError('net', null);
        },
      }),
    );
    expect(first).toEqual({ kind: 'queued', jobId: 'job-1' });
    // Second submit for the SAME (thread, draft) → projects job-1, mints nothing.
    const second = await submitReviewPublish(
      baseInput({ repo, threadId: 't1', draftId: 'd1', newJobId: () => 'job-2' }),
    );
    expect(second).toEqual({ kind: 'queued', jobId: 'job-1' });
    expect(repo.getById('job-2')).toBeNull();
    expect(repo.findLatestForDraft(DID, 't1', 'd1')?.jobId).toBe('job-1');
  });

  it('re-submit after a failed attempt supersedes the stale failed job (one publishable job)', async () => {
    const repo = new InMemoryReviewPublishRepository();
    // First attempt fails permanently → failed job-1.
    const first = await submitReviewPublish(
      baseInput({
        repo,
        threadId: 't1',
        draftId: 'd1',
        newJobId: () => 'job-1',
        publishToPDS: async () => {
          throw new PDSPublisherError('bad', 400);
        },
      }),
    );
    expect(first.kind).toBe('error');
    expect(repo.getById('job-1')?.status).toBe('failed');
    // Re-submit (edited) → the stale failed row is superseded, job-2 publishes.
    const second = await submitReviewPublish(
      baseInput({ repo, threadId: 't1', draftId: 'd1', newJobId: () => 'job-2' }),
    );
    expect(second.kind).toBe('published');
    expect(repo.getById('job-1')).toBeNull(); // old failed gone — no stale "Try again" row
    expect(repo.findLatestForDraft(DID, 't1', 'd1')?.jobId).toBe('job-2'); // exactly one job
  });

  it('FULL-FORM (no chat draft) re-submit after failure supersedes the stale failed job by (did, rkey)', async () => {
    const repo = new InMemoryReviewPublishRepository();
    // First full-form attempt (no thread/draft) fails permanently → failed job-1.
    const first = await submitReviewPublish(
      baseInput({
        repo,
        rkey: 'mob-1',
        newJobId: () => 'job-1',
        publishToPDS: async () => {
          throw new PDSPublisherError('bad', 400);
        },
      }),
    );
    expect(first.kind).toBe('error');
    expect(repo.getById('job-1')?.status).toBe('failed');
    // Corrected re-submit with the SAME rkey, transient failure → queued job-2
    // RETAINED. job-1 must be superseded, not left to publish a duplicate.
    const second = await submitReviewPublish(
      baseInput({
        repo,
        rkey: 'mob-1',
        newJobId: () => 'job-2',
        publishToPDS: async () => {
          throw new PDSPublisherError('network', null);
        },
      }),
    );
    expect(second).toEqual({ kind: 'queued', jobId: 'job-2' });
    expect(repo.getById('job-1')).toBeNull(); // stale failed superseded
    expect(repo.findLatestForRkey(DID, 'mob-1')?.jobId).toBe('job-2'); // exactly one job
  });

  it('FULL-FORM re-submit while a job is in flight reuses it (no duplicate) via (did, rkey)', async () => {
    const repo = new InMemoryReviewPublishRepository();
    const first = await submitReviewPublish(
      baseInput({
        repo,
        rkey: 'mob-1',
        newJobId: () => 'job-1',
        publishToPDS: async () => {
          throw new PDSPublisherError('network', null);
        },
      }),
    );
    expect(first).toEqual({ kind: 'queued', jobId: 'job-1' });
    const second = await submitReviewPublish(
      baseInput({ repo, rkey: 'mob-1', newJobId: () => 'job-2' }),
    );
    expect(second).toEqual({ kind: 'queued', jobId: 'job-1' }); // reused, not duplicated
    expect(repo.getById('job-2')).toBeNull();
  });

  it('an EDIT (no chat draft) reusing a retained chat-receipt rkey REPUBLISHES (does not short-circuit)', async () => {
    const repo = new InMemoryReviewPublishRepository();
    // A review originally published FROM an inline chat draft → retained published
    // job carrying BOTH the (thread,draft) back-reference AND rkey 'mob-1'.
    repo.create({
      jobId: 'chat-1',
      ownerDid: DID,
      rkey: 'mob-1',
      recordJSON: '{}',
      draftJSON: '{}',
      threadId: 't1',
      draftId: 'd1',
      createdAt: 1,
    });
    repo.claim('chat-1', 1, 60_000);
    repo.complete('chat-1', 'at://orig', 'cidorig', 2, 1); // published, RETAINED (chat receipt)

    // Reviewer EDIT flow: re-submit with the SAME rkey, NO thread/draft, new
    // content. findLatestForRkey finds the retained chat receipt — but the
    // published short-circuit must NOT fire (that would drop the edit).
    const publishToPDS = jest.fn(async () => ({ uri: 'at://edited', cid: 'cidedited' }));
    const out = await submitReviewPublish(
      baseInput({ repo, rkey: 'mob-1', newJobId: () => 'edit-1', publishToPDS }),
    );

    expect(publishToPDS).toHaveBeenCalledTimes(1); // the edit actually re-published
    expect(out).toEqual({ kind: 'published', uri: 'at://edited', cid: 'cidedited' });
    expect(repo.getById('chat-1')?.status).toBe('published'); // original receipt untouched
  });

  it('an EDIT of a FULL-FORM review (same rkey) prunes the stale receipt + republishes', async () => {
    const repo = new InMemoryReviewPublishRepository();
    // Original full-form publish (no thread/draft), rkey 'mob-2' → retained receipt.
    const first = await submitReviewPublish(
      baseInput({ repo, rkey: 'mob-2', newJobId: () => 'orig' }),
    );
    expect(first.kind).toBe('published');
    expect(repo.getById('orig')?.status).toBe('published');
    // Edit: same rkey, no thread/draft → supersedes the stale FULL-FORM receipt
    // (unlike a chat receipt, which survives) and republishes as a new receipt.
    const publishToPDS = jest.fn(async () => ({ uri: 'at://edited', cid: 'cidedited' }));
    const out = await submitReviewPublish(
      baseInput({ repo, rkey: 'mob-2', newJobId: () => 'edit', publishToPDS }),
    );
    expect(out.kind).toBe('published');
    expect(repo.getById('orig')).toBeNull(); // stale full-form receipt pruned
    expect(repo.getById('edit')?.status).toBe('published'); // new receipt retained
  });

  it('a throwing create during supersede preserves the existing failed job (atomic discard+create)', async () => {
    const repo = new InMemoryReviewPublishRepository();
    // Seed a failed job for (t1,d1) — the user's only retry/dismiss handle.
    repo.create({
      jobId: 'f1',
      ownerDid: DID,
      rkey: 'r',
      recordJSON: '{}',
      draftJSON: '{}',
      threadId: 't1',
      draftId: 'd1',
      createdAt: 1,
    });
    repo.claim('f1', 1, 60_000);
    repo.fail('f1', { class: 'permanent', code: 'bad_request', message: 'x' }, 2, 1);
    // Make the REPLACEMENT create throw (e.g. the SQLite insert fails). The
    // discard of f1 happens in the same transaction, so it must roll back.
    const realCreate = repo.create.bind(repo);
    let calls = 0;
    jest.spyOn(repo, 'create').mockImplementation((j) => {
      if (++calls === 1) throw new Error('insert boom');
      realCreate(j);
    });

    await expect(
      submitReviewPublish(baseInput({ repo, threadId: 't1', draftId: 'd1', newJobId: () => 'f2' })),
    ).rejects.toThrow('insert boom');

    // No window with neither job: f1 survives (discard rolled back), no f2 leaked.
    expect(repo.getById('f1')?.status).toBe('failed');
    expect(repo.getById('f2')).toBeNull();
  });

  it('a re-submit after publish returns the existing receipt (idempotent, no republish)', async () => {
    const repo = new InMemoryReviewPublishRepository();
    await submitReviewPublish(
      baseInput({ repo, threadId: 't1', draftId: 'd1', newJobId: () => 'job-1' }),
    );
    const second = await submitReviewPublish(
      baseInput({ repo, threadId: 't1', draftId: 'd1', newJobId: () => 'job-2' }),
    );
    expect(second).toEqual({ kind: 'published', uri: 'at://x', cid: 'cid1' });
    expect(repo.getById('job-2')).toBeNull(); // no second job minted
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
