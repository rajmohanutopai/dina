/**
 * OutboxScreen render + interactions, on the durable publish-job model. The
 * screen is a projection: it renders the jobs it's given (controlled `jobs`
 * prop) and its Cancel / Try again / Dismiss buttons drive the SAME repo the
 * inline card does.
 */

import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

jest.mock('../../src/hooks/useNodeBootstrap', () => ({
  __esModule: true,
  // null node → the live hook returns [] and drainReviewPublishNow no-ops, so
  // the controlled `jobs` prop is the only data + actions only touch the repo.
  getBootedNode: jest.fn().mockReturnValue(null),
}));

import { InMemoryReviewPublishRepository, setReviewPublishRepository, type PublishJob } from '@dina/core';

import OutboxScreen from '../../app/peerlens/outbox';

const DID = 'did:plc:owner';

function job(over: Partial<PublishJob> = {}): PublishJob {
  return {
    jobId: 'j1',
    ownerDid: DID,
    rkey: 'rk',
    recordJSON: '{}',
    draftJSON: JSON.stringify({ headline: 'A solid review' }),
    status: 'queued',
    attempts: 0,
    lastErrorCode: null,
    lastErrorMessage: null,
    nextAttemptAt: null,
    claimedAt: null,
    claimExpiresAt: null,
    threadId: null,
    draftId: null,
    publishedUri: null,
    publishedCid: null,
    dataScope: 'user',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

afterEach(() => setReviewPublishRepository(null));

describe('OutboxScreen — render states', () => {
  it('empty: friendly empty state, no banner', () => {
    const { getByTestId, queryByTestId } = render(<OutboxScreen jobs={[]} />);
    expect(getByTestId('outbox-empty')).toBeTruthy();
    expect(queryByTestId('outbox-inflight-banner')).toBeNull();
    expect(queryByTestId('outbox-no-failures')).toBeNull();
  });

  it('in-flight only: banner + all-caught-up, no empty', () => {
    const { getByTestId, queryByTestId } = render(
      <OutboxScreen jobs={[job({ jobId: 'a', status: 'queued' }), job({ jobId: 'b', status: 'publishing' })]} />,
    );
    expect(getByTestId('outbox-inflight-banner')).toBeTruthy();
    expect(getByTestId('outbox-no-failures')).toBeTruthy();
    expect(queryByTestId('outbox-empty')).toBeNull();
    expect(getByTestId('outbox-row-queued')).toBeTruthy();
    expect(getByTestId('outbox-row-publishing')).toBeTruthy();
  });

  it('failures: renders the failed row with a friendly error + actions', () => {
    const { getByTestId, getByText } = render(
      <OutboxScreen jobs={[job({ jobId: 'f1', status: 'failed', lastErrorCode: 'unauthorized' })]} />,
    );
    expect(getByTestId('outbox-row-failed')).toBeTruthy();
    expect(getByText(/credentials|infrastructure|re-onboard/i)).toBeTruthy();
    expect(getByTestId('outbox-retry-f1')).toBeTruthy();
    expect(getByTestId('outbox-dismiss-f1')).toBeTruthy();
  });

  it('shows the draft headline parsed from the job', () => {
    const { getByText } = render(
      <OutboxScreen jobs={[job({ draftJSON: JSON.stringify({ headline: 'Sturdy + quiet' }) })]} />,
    );
    expect(getByText('Sturdy + quiet')).toBeTruthy();
  });

  it('publishing rows have no Cancel button (write is on the wire)', () => {
    const { queryByTestId } = render(
      <OutboxScreen jobs={[job({ jobId: 'p', status: 'publishing' })]} />,
    );
    expect(queryByTestId('outbox-cancel-p')).toBeNull();
  });
});

describe('OutboxScreen — interactions (drive the repo)', () => {
  it('Dismiss deletes the failed job', () => {
    const repo = new InMemoryReviewPublishRepository();
    setReviewPublishRepository(repo);
    repo.create({ jobId: 'f1', ownerDid: DID, rkey: 'rk', recordJSON: '{}', draftJSON: '{}', createdAt: 1 });
    repo.claim('f1', 1, 60_000);
    repo.fail('f1', { class: 'permanent', code: 'bad_request', message: 'x' }, 2);

    const { getByTestId } = render(
      <OutboxScreen jobs={[job({ jobId: 'f1', status: 'failed', lastErrorCode: 'bad_request' })]} />,
    );
    fireEvent.press(getByTestId('outbox-dismiss-f1'));
    expect(repo.getById('f1')).toBeNull();
  });

  it('Cancel deletes a queued job', () => {
    const repo = new InMemoryReviewPublishRepository();
    setReviewPublishRepository(repo);
    repo.create({ jobId: 'q1', ownerDid: DID, rkey: 'rk', recordJSON: '{}', draftJSON: '{}', createdAt: 1 });

    const { getByTestId } = render(<OutboxScreen jobs={[job({ jobId: 'q1', status: 'queued' })]} />);
    fireEvent.press(getByTestId('outbox-cancel-q1'));
    expect(repo.getById('q1')).toBeNull();
  });

  it('Try again resets a failed job back to queued', async () => {
    const repo = new InMemoryReviewPublishRepository();
    setReviewPublishRepository(repo);
    repo.create({ jobId: 'f1', ownerDid: DID, rkey: 'rk', recordJSON: '{}', draftJSON: '{}', createdAt: 1 });
    repo.claim('f1', 1, 60_000);
    repo.fail('f1', { class: 'permanent', code: 'bad_request', message: 'x' }, 2);

    const { getByTestId } = render(
      <OutboxScreen jobs={[job({ jobId: 'f1', status: 'failed', lastErrorCode: 'bad_request' })]} />,
    );
    fireEvent.press(getByTestId('outbox-retry-f1'));
    await Promise.resolve(); // retry is async (resets then drains; drain no-ops with a null node)
    expect(repo.getById('f1')?.status).toBe('queued');
    expect(repo.getById('f1')?.attempts).toBe(0);
  });
});
