/**
 * The Network home's "Your review activity" count comes from the authored-rows
 * runner (`useAuthoredAttestations`) — the displayable count, not an API summary.
 * This is the structural successor to the old F9 self-card fix: the home now
 * reads `rows.length` directly, so it can't diverge from the reviewer profile's
 * "Reviews you wrote" list. Mocked at the runner boundary so we exercise the real
 * projection in `app/peerlens/index.tsx` without a network / keystore.
 */

import { render, act } from '@testing-library/react-native';
import React from 'react';

jest.mock('../../src/hooks/useNodeBootstrap', () => ({
  __esModule: true,
  getBootedNode: () => ({ did: 'did:plc:viewer-self' }),
  useNodeBootstrap: () => ({ status: 'paired' }),
  subscribeBootedNode: jest.fn(() => () => undefined),
}));

jest.mock('../../src/peerlens/runners/use_authored_attestations', () => ({
  __esModule: true,
  useAuthoredAttestations: jest.fn(),
}));

import TrustFeedScreen from '../../app/peerlens/index';
import { useAuthoredAttestations } from '../../src/peerlens/runners/use_authored_attestations';

const authoredMock = useAuthoredAttestations as jest.MockedFunction<typeof useAuthoredAttestations>;

beforeEach(() => authoredMock.mockReset());

function makeRow(id: string) {
  return {
    uri: `at://x/${id}`,
    subjectId: `sub-${id}`,
    subjectKind: 'product' as const,
    subjectUri: null,
    subjectDid: null,
    subjectTitle: 'Subject',
    category: null,
    sentiment: 'positive' as const,
    headline: 'h',
    body: '',
    confidence: null,
    createdAtMs: 0,
  };
}

describe('Network home — review-activity count from the authored runner', () => {
  it('shows the displayable authored-rows count (5 reviews written)', async () => {
    authoredMock.mockReturnValue({
      rows: ['a', 'b', 'c', 'd', 'e'].map(makeRow),
      isLoading: false,
      error: null,
    });
    const { getByText } = render(<TrustFeedScreen />);
    await act(async () => {});
    expect(getByText('5 reviews written')).toBeTruthy();
  });

  it('0 authored rows → the non-count prompt (not "0 reviews written")', async () => {
    authoredMock.mockReturnValue({ rows: [], isLoading: false, error: null });
    const { getByText, queryByText } = render(<TrustFeedScreen />);
    await act(async () => {});
    expect(queryByText('0 reviews written')).toBeNull();
    expect(getByText("Reviews you’ve written")).toBeTruthy();
  });
});
