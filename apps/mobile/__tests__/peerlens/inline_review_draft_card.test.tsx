/**
 * The chat-driven review draft → edit → publish flow, on the durable
 * publish-job model. The inline card owns only the PRE-submit phase
 * (drafting/ready/discarded); every post-submit state (queued/publishing/
 * failed/published) is projected from the durable job via the back-reference.
 *
 *   - `ready`      → editable inputs + Publish; tap creates a job + inline attempt
 *   - `published`  → JobState reads the receipt off the job row
 *   - `failed`     → JobState reads the error code off the job row
 *   - `discarded`  → pre-submit terminal (lifecycle-owned)
 */

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('../../src/peerlens/appview_runtime', () => ({
  __esModule: true,
  injectAttestation: jest.fn().mockResolvedValue({ uri: 'at://x', cid: 'bafytest' }),
  isTestPublishConfigured: jest.fn().mockReturnValue(true),
}));
jest.mock('../../src/hooks/useNodeBootstrap', () => ({
  __esModule: true,
  // A publisher must be present (non-undefined) or submit returns no_credentials;
  // the inject path ignores it but the credential gate checks it.
  getBootedNode: jest.fn().mockReturnValue({ did: 'did:plc:test-author', pdsPublisher: {} }),
  subscribeBootedNode: jest.fn(() => () => undefined),
}));
jest.mock('expo-router', () => ({
  __esModule: true,
  useRouter: () => ({ push: jest.fn() }),
}));

import {
  addLifecycleMessage,
  getThread,
  readLifecycle,
  resetThreads,
  type ChatMessage,
  type ReviewDraftLifecycle,
} from '@dina/brain/chat';
import {
  InMemoryReviewPublishRepository,
  getReviewPublishRepository,
  setReviewPublishRepository,
} from '@dina/core';

import { InlineReviewDraftCard } from '../../src/components/InlineReviewDraftCard';
import * as appview from '../../src/peerlens/appview_runtime';
import { emptyWriteFormState } from '../../src/peerlens/write_form_data';

const injectMock = appview.injectAttestation as jest.MockedFunction<typeof appview.injectAttestation>;

const THREAD = 'main';
const DRAFT_ID = 'draft-test-1';
const DID = 'did:plc:test-author';

beforeEach(() => {
  resetThreads();
  injectMock.mockClear();
  setReviewPublishRepository(new InMemoryReviewPublishRepository());
});

afterEach(() => {
  resetThreads();
  setReviewPublishRepository(null);
});

function postReadyDraft(
  extras: Partial<{
    sentiment: 'positive' | 'neutral' | 'negative';
    headline: string;
    body: string;
    useCases: readonly string[];
  }> = {},
): ChatMessage {
  const values = {
    ...emptyWriteFormState(),
    subject: { kind: 'product' as const, name: 'Aeron Chair', did: '', uri: '', identifier: '' },
    sentiment: extras.sentiment ?? ('positive' as const),
    headline: extras.headline ?? 'Comfortable for daily work',
    body: extras.body ?? 'I sit in this for 8 hours every day.',
    useCases: extras.useCases ?? ['professional'],
  };
  const lc: ReviewDraftLifecycle = {
    kind: 'review_draft',
    status: 'ready',
    draftId: DRAFT_ID,
    subject: values.subject as unknown as Record<string, unknown>,
    values: values as unknown as Record<string, unknown>,
  };
  return addLifecycleMessage(THREAD, 'Drafted a review of Aeron Chair.', lc);
}

function requireRepo() {
  const repo = getReviewPublishRepository();
  if (repo === null) throw new Error('repo not wired');
  return repo;
}

function requireCall() {
  const first = injectMock.mock.calls[0];
  if (first === undefined) throw new Error('injectAttestation was not called');
  return first[0];
}

/** Seed a durable job for the card's (thread, draft) at a given status. */
function seedJob(status: 'queued' | 'publishing' | 'published' | 'failed', code = 'unauthorized'): void {
  const repo = requireRepo();
  repo.create({
    jobId: 'j1',
    ownerDid: DID,
    rkey: 'rk',
    recordJSON: '{}',
    draftJSON: '{}',
    threadId: THREAD,
    draftId: DRAFT_ID,
    createdAt: 1,
  });
  if (status === 'queued') return;
  repo.claim('j1', 1, 60_000);
  if (status === 'publishing') return;
  if (status === 'published') repo.complete('j1', 'at://x', 'bafytest', 2, 1);
  if (status === 'failed')
    repo.fail('j1', { class: 'permanent', code: code as 'unauthorized', message: 'boom' }, 2, 1);
}

describe('InlineReviewDraftCard — ready / publish', () => {
  it('renders editable sentiment / headline / body + Publish', () => {
    const { getByTestId } = render(<InlineReviewDraftCard message={postReadyDraft()} />);
    expect(getByTestId('review-draft-card-ready')).toBeTruthy();
    expect(getByTestId('review-draft-headline').props.value).toBe('Comfortable for daily work');
    expect(getByTestId('review-draft-body').props.value).toContain('I sit in this');
    expect(getByTestId('review-draft-publish')).toBeTruthy();
    expect(getByTestId('review-draft-discard')).toBeTruthy();
    expect(getByTestId('review-draft-edit-in-form')).toBeTruthy();
  });

  it('publish carries the EDITED headline through to the publish path', async () => {
    const { getByTestId } = render(<InlineReviewDraftCard message={postReadyDraft()} />);
    fireEvent.changeText(getByTestId('review-draft-headline'), 'Edited headline');
    fireEvent.press(getByTestId('review-draft-publish'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(injectMock).toHaveBeenCalledTimes(1);
    const call = requireCall();
    expect(call.record.subject).toEqual({ type: 'product', name: 'Aeron Chair' });
    expect(call.record.text).toContain('Edited headline');
    expect(call.record.text).toContain('I sit in this');
    expect(call.record.sentiment).toBe('positive');
    expect(call.record.useCases).toEqual(['professional']);
  });

  it('persists the inline edits onto the lifecycle before handoff (so a later cancel keeps them)', async () => {
    const { getByTestId } = render(<InlineReviewDraftCard message={postReadyDraft()} />);
    fireEvent.changeText(getByTestId('review-draft-headline'), 'Edited headline');
    fireEvent.press(getByTestId('review-draft-publish'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // The draft lifecycle now carries the edited values — so if the resulting job
    // is cancelled/dismissed the card reverts to THESE edits, not the LLM draft.
    const card = getThread(THREAD).find((m) => readLifecycle(m)?.kind === 'review_draft');
    if (card === undefined) throw new Error('no review_draft message');
    const lc = readLifecycle(card) as ReviewDraftLifecycle;
    expect((lc.values as { headline?: string } | null)?.headline).toBe('Edited headline');
  });

  it('publish creates a durable job that completes to published', async () => {
    const { getByTestId } = render(<InlineReviewDraftCard message={postReadyDraft()} />);
    fireEvent.press(getByTestId('review-draft-publish'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const job = requireRepo().findLatestForDraft(DID, THREAD, DRAFT_ID);
    expect(job?.status).toBe('published');
    expect(job?.publishedUri).toBe('at://x');
    expect(job?.publishedCid).toBe('bafytest');
  });

  it('publish disabled when sentiment cleared (no job created)', () => {
    const noSentiment = {
      ...emptyWriteFormState(),
      subject: { kind: 'product' as const, name: 'Aeron Chair', did: '', uri: '', identifier: '' },
      sentiment: null,
      headline: 'Comfortable',
      body: '',
    };
    const lc: ReviewDraftLifecycle = {
      kind: 'review_draft',
      status: 'ready',
      draftId: DRAFT_ID,
      subject: noSentiment.subject as unknown as Record<string, unknown>,
      values: noSentiment as unknown as Record<string, unknown>,
    };
    const { getByTestId } = render(<InlineReviewDraftCard message={addLifecycleMessage(THREAD, 'd', lc)} />);
    const btn = getByTestId('review-draft-publish');
    const isDisabled =
      btn.props.disabled === true || btn.props.accessibilityState?.disabled === true;
    expect(isDisabled).toBe(true);
    fireEvent.press(btn);
    expect(injectMock).not.toHaveBeenCalled();
    expect(requireRepo().countActive(DID)).toBe(0);
  });

  it('discard flips the lifecycle to "discarded" (pre-submit, no job)', () => {
    const { getByTestId } = render(<InlineReviewDraftCard message={postReadyDraft()} />);
    fireEvent.press(getByTestId('review-draft-discard'));
    const card = getThread(THREAD).find((m) => readLifecycle(m)?.kind === 'review_draft');
    if (card === undefined) throw new Error('no review_draft message');
    expect((readLifecycle(card) as ReviewDraftLifecycle).status).toBe('discarded');
  });
});

describe('InlineReviewDraftCard — job projection', () => {
  it('renders the published receipt from a published job', () => {
    const msg = postReadyDraft();
    seedJob('published');
    expect(render(<InlineReviewDraftCard message={msg} />).getByTestId('review-draft-card-published')).toBeTruthy();
  });

  it('renders the publishing spinner from a publishing job', () => {
    const msg = postReadyDraft();
    seedJob('publishing');
    expect(render(<InlineReviewDraftCard message={msg} />).getByTestId('review-draft-card-publishing')).toBeTruthy();
  });

  it('renders the queued state with View pending reviews + Cancel', () => {
    const msg = postReadyDraft();
    seedJob('queued');
    const { getByTestId } = render(<InlineReviewDraftCard message={msg} />);
    expect(getByTestId('review-draft-card-queued')).toBeTruthy();
    expect(getByTestId('review-draft-view-outbox')).toBeTruthy();
    expect(getByTestId('review-draft-cancel')).toBeTruthy();
  });

  it('renders the failed state with a friendly error + retry/dismiss', () => {
    const msg = postReadyDraft();
    seedJob('failed', 'unauthorized');
    const { getByTestId, getByText } = render(<InlineReviewDraftCard message={msg} />);
    expect(getByTestId('review-draft-card-failed')).toBeTruthy();
    expect(getByText(/credentials|infrastructure|re-onboard/i)).toBeTruthy();
    expect(getByTestId('review-draft-retry')).toBeTruthy();
    expect(getByTestId('review-draft-dismiss')).toBeTruthy();
  });

  it('cancelling a queued job reverts the card to its editable draft', () => {
    const msg = postReadyDraft();
    seedJob('queued');
    const { getByTestId, queryByTestId } = render(<InlineReviewDraftCard message={msg} />);
    fireEvent.press(getByTestId('review-draft-cancel'));
    expect(queryByTestId('review-draft-card-queued')).toBeNull();
    expect(getByTestId('review-draft-card-ready')).toBeTruthy(); // back to editable
    expect(requireRepo().getById('j1')).toBeNull(); // job deleted
  });

  it('renders the discarded state (pre-submit terminal)', () => {
    const lc: ReviewDraftLifecycle = {
      kind: 'review_draft',
      status: 'discarded',
      draftId: DRAFT_ID,
      subject: { kind: 'product', name: 'Aeron Chair' },
      values: null,
    };
    const msg = addLifecycleMessage(THREAD, 'Discarded.', lc);
    expect(render(<InlineReviewDraftCard message={msg} />).getByTestId('review-draft-card-discarded')).toBeTruthy();
  });
});

describe('InlineReviewDraftCard — drafting failure (no job)', () => {
  it('renders the draft-failed card + lc.error + Write in form (not an empty ReadyState)', () => {
    const lc: ReviewDraftLifecycle = {
      kind: 'review_draft',
      status: 'failed',
      draftId: DRAFT_ID,
      subject: { kind: 'product', name: 'Aeron Chair' },
      values: null,
      error: 'Draft inference failed.',
    };
    const msg = addLifecycleMessage(THREAD, 'Could not draft.', lc);
    const { getByTestId, getByText, queryByTestId } = render(<InlineReviewDraftCard message={msg} />);
    expect(getByTestId('review-draft-card-draft-failed')).toBeTruthy();
    expect(getByText('Draft inference failed.')).toBeTruthy(); // surfaced, not dropped
    expect(getByTestId('review-draft-write-in-form')).toBeTruthy();
    expect(queryByTestId('review-draft-card-ready')).toBeNull(); // NOT the empty editable fallback
  });

  it('Discard moves a drafting-failure card to the discarded terminal (not stuck)', () => {
    const lc: ReviewDraftLifecycle = {
      kind: 'review_draft',
      status: 'failed',
      draftId: DRAFT_ID,
      subject: { kind: 'product', name: 'Aeron Chair' },
      values: null,
      error: 'Draft inference failed.',
    };
    const { getByTestId } = render(<InlineReviewDraftCard message={addLifecycleMessage(THREAD, 'x', lc)} />);
    fireEvent.press(getByTestId('review-draft-draft-failed-discard'));
    const card = getThread(THREAD).find((m) => readLifecycle(m)?.kind === 'review_draft');
    if (card === undefined) throw new Error('no review_draft message');
    expect((readLifecycle(card) as ReviewDraftLifecycle).status).toBe('discarded');
  });

  it('a publish JOB still wins over a stale failed lifecycle (JobState, not draft-failed)', () => {
    const lc: ReviewDraftLifecycle = {
      kind: 'review_draft',
      status: 'failed',
      draftId: DRAFT_ID,
      subject: { kind: 'product', name: 'Aeron Chair' },
      values: null,
      error: 'stale drafting error',
    };
    const msg = addLifecycleMessage(THREAD, 'x', lc);
    seedJob('failed', 'unauthorized'); // a real publish job exists for (thread, draft)
    const { getByTestId, queryByTestId } = render(<InlineReviewDraftCard message={msg} />);
    expect(getByTestId('review-draft-card-failed')).toBeTruthy(); // JobState wins (job checked first)
    expect(queryByTestId('review-draft-card-draft-failed')).toBeNull();
  });
});
