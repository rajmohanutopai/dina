/**
 * Integration test for the chat-driven review draft → edit → publish
 * flow. Drives the InlineReviewDraftCard with a synthesized lifecycle
 * message, edits the headline, taps Publish, and asserts that
 * `injectAttestation` receives the edited record.
 *
 * The lifecycle states this test covers:
 *   - `ready` → renders editable inputs + Publish button
 *   - `publishing` → no card-level assertions (fast path: we mock
 *     injectAttestation to resolve immediately, lifecycle flips
 *     directly to `published`)
 *   - `published` → card collapses to a receipt
 *
 * Drafting + failed states are pinned by the unit tests in
 * `review_draft.test.ts` — this file pins the user-visible publish
 * round-trip end-to-end.
 */

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('../../src/trust/appview_runtime', () => ({
  __esModule: true,
  injectAttestation: jest.fn().mockResolvedValue({ uri: 'at://x', cid: 'bafytest' }),
  isTestPublishConfigured: jest.fn().mockReturnValue(true),
}));
jest.mock('../../src/hooks/useNodeBootstrap', () => ({
  __esModule: true,
  getBootedNode: jest.fn().mockReturnValue({ did: 'did:plc:test-author' }),
}));
jest.mock('expo-router', () => ({
  __esModule: true,
  useRouter: () => ({ push: jest.fn() }),
}));

import * as appview from '../../src/trust/appview_runtime';
import { InlineReviewDraftCard } from '../../src/components/InlineReviewDraftCard';
import {
  addLifecycleMessage,
  getThread,
  readLifecycle,
  resetThreads,
  type ChatMessage,
  type ReviewDraftLifecycle,
} from '@dina/brain/src/chat/thread';
import { emptyWriteFormState } from '../../src/trust/write_form_data';

const injectMock = appview.injectAttestation as jest.MockedFunction<
  typeof appview.injectAttestation
>;

const THREAD = 'main';
const DRAFT_ID = 'draft-test-1';

beforeEach(() => {
  resetThreads();
  injectMock.mockClear();
});

afterEach(() => {
  resetThreads();
});

function postReadyDraft(extras: Partial<{
  sentiment: 'positive' | 'neutral' | 'negative';
  headline: string;
  body: string;
  useCases: readonly string[];
}> = {}): ChatMessage {
  const values = {
    ...emptyWriteFormState(),
    subject: {
      kind: 'product' as const,
      name: 'Aeron Chair',
      did: '',
      uri: '',
      identifier: '',
    },
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

describe('InlineReviewDraftCard — ready state', () => {
  it('renders editable sentiment / headline / body + Publish button', () => {
    const msg = postReadyDraft();
    const { getByTestId } = render(<InlineReviewDraftCard message={msg} />);
    expect(getByTestId('review-draft-card-ready')).toBeTruthy();
    expect(getByTestId('review-draft-headline').props.value).toBe(
      'Comfortable for daily work',
    );
    expect(getByTestId('review-draft-body').props.value).toContain(
      'I sit in this',
    );
    expect(getByTestId('review-draft-publish')).toBeTruthy();
    expect(getByTestId('review-draft-discard')).toBeTruthy();
    expect(getByTestId('review-draft-edit-in-form')).toBeTruthy();
  });

  it('publish carries the EDITED headline through to injectAttestation', async () => {
    const msg = postReadyDraft();
    const { getByTestId } = render(<InlineReviewDraftCard message={msg} />);

    // Edit the headline before publishing.
    fireEvent.changeText(getByTestId('review-draft-headline'), 'Edited headline');
    fireEvent.press(getByTestId('review-draft-publish'));

    // Flush microtasks so the async publish settles.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(injectMock).toHaveBeenCalledTimes(1);
    const call = injectMock.mock.calls[0]![0];
    expect(call.record.subject).toEqual({
      type: 'product',
      name: 'Aeron Chair',
    });
    expect(call.record.text).toContain('Edited headline');
    expect(call.record.text).toContain('I sit in this');
    expect(call.record.sentiment).toBe('positive');
    // V2 extras should still flow through — the LLM drafted use_cases.
    expect(call.record.useCases).toEqual(['professional']);
  });

  it('publish flips the lifecycle to "published" with the attestation ref', async () => {
    const msg = postReadyDraft();
    const { getByTestId } = render(<InlineReviewDraftCard message={msg} />);
    fireEvent.press(getByTestId('review-draft-publish'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const messages = getThread(THREAD);
    const card = messages.find((m) => readLifecycle(m)?.kind === 'review_draft')!;
    const lc = readLifecycle(card) as ReviewDraftLifecycle;
    expect(lc.status).toBe('published');
    expect(lc.attestation).toEqual({ uri: 'at://x', cid: 'bafytest' });
  });

  it('publish disabled when sentiment cleared', () => {
    const msg = postReadyDraft();
    // Synthesize a draft with NO sentiment so the publish button starts
    // disabled — equivalent to the LLM omitting sentiment because the
    // vault content was mixed.
    resetThreads();
    const noSentimentValues = {
      ...emptyWriteFormState(),
      subject: {
        kind: 'product' as const,
        name: 'Aeron Chair',
        did: '',
        uri: '',
        identifier: '',
      },
      sentiment: null,
      headline: 'Comfortable',
      body: '',
    };
    const lc: ReviewDraftLifecycle = {
      kind: 'review_draft',
      status: 'ready',
      draftId: DRAFT_ID,
      subject: noSentimentValues.subject as unknown as Record<string, unknown>,
      values: noSentimentValues as unknown as Record<string, unknown>,
    };
    const newMsg = addLifecycleMessage(THREAD, 'Drafting…', lc);
    void msg;
    const { getByTestId } = render(<InlineReviewDraftCard message={newMsg} />);
    // Pressable mirrors `disabled` either onto props.disabled OR
    // accessibilityState.disabled depending on RN version. Accept
    // either — the contract is "tap is a no-op".
    const btn = getByTestId('review-draft-publish');
    const isDisabled =
      btn.props.disabled === true ||
      btn.props.accessibilityState?.disabled === true;
    expect(isDisabled).toBe(true);
    // And tapping it must not fire injectAttestation.
    fireEvent.press(btn);
    expect(injectMock).not.toHaveBeenCalled();
  });

  it('discard flips the lifecycle to "discarded"', () => {
    const msg = postReadyDraft();
    const { getByTestId } = render(<InlineReviewDraftCard message={msg} />);
    fireEvent.press(getByTestId('review-draft-discard'));
    const messages = getThread(THREAD);
    const card = messages.find((m) => readLifecycle(m)?.kind === 'review_draft')!;
    const lc = readLifecycle(card) as ReviewDraftLifecycle;
    expect(lc.status).toBe('discarded');
  });
});

describe('InlineReviewDraftCard — terminal states', () => {
  it('renders the published receipt', () => {
    const lc: ReviewDraftLifecycle = {
      kind: 'review_draft',
      status: 'published',
      draftId: DRAFT_ID,
      subject: { kind: 'product', name: 'Aeron Chair' },
      values: null,
      attestation: { uri: 'at://x', cid: 'bafytest' },
    };
    const msg = addLifecycleMessage(THREAD, 'Published your review of Aeron Chair.', lc);
    const { getByTestId } = render(<InlineReviewDraftCard message={msg} />);
    expect(getByTestId('review-draft-card-published')).toBeTruthy();
  });

  it('renders the failed state with the inferer error', () => {
    const lc: ReviewDraftLifecycle = {
      kind: 'review_draft',
      status: 'failed',
      draftId: DRAFT_ID,
      subject: { kind: 'product', name: 'Aeron Chair' },
      values: null,
      error: 'Draft inference failed.',
    };
    const msg = addLifecycleMessage(THREAD, 'Couldn’t draft.', lc);
    const { getByTestId, getByText } = render(<InlineReviewDraftCard message={msg} />);
    expect(getByTestId('review-draft-card-failed')).toBeTruthy();
    expect(getByText(/Draft inference failed/)).toBeTruthy();
  });

  it('renders the discarded state', () => {
    const lc: ReviewDraftLifecycle = {
      kind: 'review_draft',
      status: 'discarded',
      draftId: DRAFT_ID,
      subject: { kind: 'product', name: 'Aeron Chair' },
      values: null,
    };
    const msg = addLifecycleMessage(THREAD, 'Discarded.', lc);
    const { getByTestId } = render(<InlineReviewDraftCard message={msg} />);
    expect(getByTestId('review-draft-card-discarded')).toBeTruthy();
  });
});
