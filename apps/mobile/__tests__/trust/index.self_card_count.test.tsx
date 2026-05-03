/**
 * Pinning test for F9 — self-card "Reviews" count agrees with the
 * displayable rows count, not the unfiltered API summary.
 *
 * Pre-fix: `useReviewerProfile` returned `reviewerStats.totalAttestationsBy = 6`
 * directly into the self-card, but `deriveAuthoredAttestationRows`
 * silently drops hits with missing `subjectId`s, leaving the reviewer
 * profile listing 5 rows. The user saw "6 Reviews" on the Trust home
 * but only 5 on their own profile — confusing and wrong.
 *
 * Post-fix: the screen also runs `useAuthoredAttestations` and prefers
 * its loaded length when available, falling back to the API summary
 * during initial load (so the stat doesn't flash "0").
 *
 * Mocked at the runner-module boundary so we exercise the actual
 * projection logic in `app/trust/index.tsx` without standing up a
 * real network or keystore.
 */

import React from 'react';
import { render, act, within } from '@testing-library/react-native';

jest.mock('../../src/hooks/useNodeBootstrap', () => ({
  __esModule: true,
  getBootedNode: () => ({ did: 'did:plc:viewer-self' }),
  useNodeBootstrap: () => ({ status: 'paired' }),
}));

jest.mock('../../src/trust/runners/use_network_feed', () => ({
  __esModule: true,
  useNetworkFeed: () => ({ feed: [], isLoading: false, error: null }),
}));

jest.mock('../../src/trust/runners/use_reviewer_profile', () => ({
  __esModule: true,
  useReviewerProfile: jest.fn(),
}));

jest.mock('../../src/trust/runners/use_authored_attestations', () => ({
  __esModule: true,
  useAuthoredAttestations: jest.fn(),
}));

import { useReviewerProfile } from '../../src/trust/runners/use_reviewer_profile';
import { useAuthoredAttestations } from '../../src/trust/runners/use_authored_attestations';
import TrustFeedScreen from '../../app/trust/index';

const profileMock = useReviewerProfile as jest.MockedFunction<typeof useReviewerProfile>;
const authoredMock = useAuthoredAttestations as jest.MockedFunction<typeof useAuthoredAttestations>;

beforeEach(() => {
  profileMock.mockReset();
  authoredMock.mockReset();
});

function makeProfile(overrides: { totalAttestationsBy?: number; handle?: string | null } = {}) {
  // Minimal shape the projection reads. `as never` because TrustProfile has
  // many more fields than the screen actually consumes; the projection is
  // tolerant of nulls everywhere we don't override.
  return {
    profile: {
      did: 'did:plc:viewer-self',
      handle: overrides.handle ?? 'viewer.test',
      overallTrustScore: null,
      attestationSummary: { positive: 0, neutral: 0, negative: 0, total: 0 },
      reviewerStats: {
        totalAttestationsBy: overrides.totalAttestationsBy ?? 6,
        corroborationRate: 0,
        evidenceRate: 0,
        helpfulRatio: 0,
      },
      vouchCount: 0,
      endorsementCount: 0,
      activeDomains: [],
      helpfulRatioDisplay: null,
      corroborationRateDisplay: null,
      lastActiveMs: null,
    },
    isLoading: false,
    error: null,
  } as never;
}

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

describe('TrustFeedScreen — F9 self-card count consistency', () => {
  it('uses authored-rows length when loaded (5) instead of API summary (6)', async () => {
    profileMock.mockReturnValue(makeProfile({ totalAttestationsBy: 6 }));
    authoredMock.mockReturnValue({
      rows: [makeRow('a'), makeRow('b'), makeRow('c'), makeRow('d'), makeRow('e')],
      isLoading: false,
      error: null,
    });
    const { getByTestId, queryByText } = render(<TrustFeedScreen />);
    await act(async () => {});
    // Scope to the Reviews stat cell so we don't match other "5"s on
    // the screen (e.g. sentiment chips on the reviewer profile, etc.).
    const cell = getByTestId('trust-feed-self-stat-reviews');
    expect(within(cell).getByText('5')).toBeTruthy();
    // The "6" from the API summary must NOT appear anywhere on the screen
    // for this profile (Vouches=0, Endorsements=0, Score=null → no "6"
    // would render naturally elsewhere).
    expect(queryByText('6')).toBeNull();
  });

  it('falls back to API summary while authored rows are still loading (rows.length === 0)', async () => {
    profileMock.mockReturnValue(makeProfile({ totalAttestationsBy: 7 }));
    authoredMock.mockReturnValue({
      rows: [],
      isLoading: true,
      error: null,
    });
    const { getByTestId } = render(<TrustFeedScreen />);
    await act(async () => {});
    const cell = getByTestId('trust-feed-self-stat-reviews');
    // While loading, the API count surfaces so the stat doesn't flash 0.
    expect(within(cell).getByText('7')).toBeTruthy();
  });

  it('falls back to API summary (0) when both summary and rows are zero', async () => {
    profileMock.mockReturnValue(makeProfile({ totalAttestationsBy: 0 }));
    authoredMock.mockReturnValue({
      rows: [],
      isLoading: false,
      error: null,
    });
    const { getByTestId } = render(<TrustFeedScreen />);
    await act(async () => {});
    const cell = getByTestId('trust-feed-self-stat-reviews');
    expect(within(cell).getByText('0')).toBeTruthy();
  });
});
