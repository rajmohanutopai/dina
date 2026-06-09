/**
 * Opening the full write form FROM a chat draft, then publishing, must persist
 * the FORM-edited values back onto that draft's lifecycle before navigating away
 * (round-7 P2). Otherwise, if the resulting queued/failed job is later cancelled,
 * the inline card reverts to ReadyState reading the stale pre-form (LLM) values
 * and silently loses the user's form edits.
 */

import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('../../src/peerlens/appview_runtime', () => ({
  __esModule: true,
  injectAttestation: jest.fn().mockResolvedValue({ uri: 'at://x', cid: 'bafytest' }),
  isTestPublishConfigured: jest.fn().mockReturnValue(true),
}));
jest.mock('../../src/hooks/useNodeBootstrap', () => ({
  __esModule: true,
  getBootedNode: jest.fn().mockReturnValue({ did: 'did:plc:test-author', pdsPublisher: {} }),
  subscribeBootedNode: jest.fn(() => () => undefined),
}));
// Override expo-router so the screen reads a chat-draft origin (draftId/threadId).
// `require` inside the (hoisted) factory + the void-union effect type mirror the
// global __mocks__/expo-router.ts idiom; disabled locally for the test mock.
jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLocal = require('react');
  return {
    __esModule: true,
    useLocalSearchParams: () => ({ draftId: 'd1', threadId: 't1' }),
    useRouter: () => ({
      navigate: () => undefined,
      push: () => undefined,
      replace: () => undefined,
      back: () => undefined,
      canGoBack: () => false,
    }),
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
    useFocusEffect: (effect: () => void | (() => void)) => {
      ReactLocal.useEffect(() => {
        const cleanup = effect();
        return typeof cleanup === 'function' ? cleanup : undefined;
      }, []);
    },
    useNavigation: () => ({ setOptions: () => undefined }),
    Stack: { Screen: () => null },
  };
});

import { PDSPublisherError } from '@dina/brain';
import {
  addLifecycleMessage,
  getThread,
  readLifecycle,
  resetThreads,
  type ReviewDraftLifecycle,
} from '@dina/brain/chat';
import { InMemoryReviewPublishRepository, setReviewPublishRepository } from '@dina/core';

import WriteScreen from '../../app/peerlens/write';
import * as appview from '../../src/peerlens/appview_runtime';
import { emptyWriteFormState, type WriteFormState } from '../../src/peerlens/write_form_data';

const injectMock = appview.injectAttestation as jest.MockedFunction<typeof appview.injectAttestation>;

function publishableInitial(): WriteFormState {
  return {
    ...emptyWriteFormState(),
    sentiment: 'positive',
    headline: 'Edited in the form',
    body: 'Tweaked here.',
    confidence: 'high',
    subject: { kind: 'product', name: 'Aeron Chair', did: '', uri: '', identifier: '' },
  };
}

beforeEach(() => {
  resetThreads();
  setReviewPublishRepository(new InMemoryReviewPublishRepository());
  // Seed the originating chat draft (thread 't1', draft 'd1') with the ORIGINAL
  // LLM values, so the persist has a row to patch and we can prove it changed.
  const lc: ReviewDraftLifecycle = {
    kind: 'review_draft',
    status: 'ready',
    draftId: 'd1',
    subject: { kind: 'product', name: 'Aeron Chair' },
    values: { headline: 'LLM original headline' } as Record<string, unknown>,
  };
  addLifecycleMessage('t1', 'Drafted a review.', lc);
});

afterEach(() => {
  resetThreads();
  setReviewPublishRepository(null);
});

it('persists the form-edited values onto the chat draft lifecycle on publish', async () => {
  const { getByTestId } = render(<WriteScreen initial={publishableInitial()} />);
  fireEvent.press(getByTestId('write-publish'));

  // The persist runs AFTER the (multi-await) submit chain resolves — waitFor
  // retries until the lifecycle reflects the FORM values, not the LLM draft, so a
  // later cancel of the queued/failed job reverts the inline card to these edits.
  await waitFor(() => {
    const card = getThread('t1').find((m) => readLifecycle(m)?.kind === 'review_draft');
    if (card === undefined) throw new Error('no review_draft message');
    const lc = readLifecycle(card) as ReviewDraftLifecycle;
    expect((lc.values as { headline?: string } | null)?.headline).toBe('Edited in the form');
  });
});

it('persists the form edits even when the publish FAILS permanently (failed-job outcome)', async () => {
  // Permanent PDS rejection → durable FAILED job + outcome.kind === 'error' (no
  // navigation). The persist must STILL run, so dismissing that failed job later
  // reverts the inline card to the form edits, not the stale pre-form values.
  injectMock.mockRejectedValueOnce(new PDSPublisherError('bad request', 400));
  const { getByTestId } = render(<WriteScreen initial={publishableInitial()} />);
  fireEvent.press(getByTestId('write-publish'));

  await waitFor(() => {
    const card = getThread('t1').find((m) => readLifecycle(m)?.kind === 'review_draft');
    if (card === undefined) throw new Error('no review_draft message');
    const lc = readLifecycle(card) as ReviewDraftLifecycle;
    expect((lc.values as { headline?: string } | null)?.headline).toBe('Edited in the form');
  });
});
