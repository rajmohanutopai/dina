/**
 * Render tests for the reviewer profile screen (TN-MOB-015).
 *
 * Three states pinned:
 *   1. **Loading** — `profile === null` and `error === null`. Spinner +
 *      "Loading reviewer profile…".
 *   2. **Error** — `error !== null`. Soft error panel with Retry CTA
 *      that fires `onRetry`.
 *   3. **Loaded** — header card + stats grid + sentiment row + active
 *      domains chip-row.
 *
 * The data-layer derivation (score-band, hasNumericScore threshold,
 * relative-time formatting) is covered exhaustively in
 * `reviewer_profile_data.test.ts`; this file pins only the screen-side
 * wiring between the projection and the rendered output.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import ReviewerProfileScreen from '../../app/trust/reviewer/[did]';

import type { TrustProfile } from '@dina/core';

const NOW = 1_700_000_000_000;

function makeProfile(overrides: Partial<TrustProfile> = {}): TrustProfile {
  return {
    did: 'did:plc:abcdefghijklmnopqrstuvwx',
    overallTrustScore: 0.85,
    attestationSummary: { total: 10, positive: 7, neutral: 2, negative: 1 },
    vouchCount: 3,
    endorsementCount: 5,
    reviewerStats: {
      totalAttestationsBy: 10,
      corroborationRate: 0.7,
      evidenceRate: 0.4,
      helpfulRatio: 0.92,
    },
    activeDomains: ['github.com', 'amazon.com'],
    lastActive: NOW - 2 * 60 * 60_000, // 2 hours ago
    ...overrides,
  };
}

describe('ReviewerProfileScreen — render states', () => {
  it('renders loading state when profile is null + no error', () => {
    const { getByTestId, queryByTestId } = render(
      <ReviewerProfileScreen profile={null} />,
    );
    expect(getByTestId('reviewer-profile-loading')).toBeTruthy();
    expect(queryByTestId('reviewer-profile-screen')).toBeNull();
    expect(queryByTestId('reviewer-profile-error')).toBeNull();
  });

  it('renders error state when error is set', () => {
    const { getByTestId, getByText, queryByTestId } = render(
      <ReviewerProfileScreen profile={null} error="Network unreachable" />,
    );
    expect(getByTestId('reviewer-profile-error')).toBeTruthy();
    expect(getByText('Network unreachable')).toBeTruthy();
    expect(queryByTestId('reviewer-profile-loading')).toBeNull();
  });

  it('error state has working Retry CTA when onRetry is provided', () => {
    const onRetry = jest.fn();
    const { getByTestId } = render(
      <ReviewerProfileScreen profile={null} error="Network unreachable" onRetry={onRetry} />,
    );
    fireEvent.press(getByTestId('reviewer-profile-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('error state renders Retry CTA when onRetry is omitted (auto-timeout reset)', () => {
    // The screen provides a default `onRetry` that resets the
    // auto-timeout state, so the CTA is always present in production.
    const { getByTestId } = render(
      <ReviewerProfileScreen profile={null} error="Network unreachable" />,
    );
    expect(getByTestId('reviewer-profile-retry')).toBeTruthy();
  });

  it('renders loaded state with all sections when profile is provided', () => {
    const { getByTestId } = render(
      <ReviewerProfileScreen profile={makeProfile()} nowMs={NOW} />,
    );
    expect(getByTestId('reviewer-profile-screen')).toBeTruthy();
    expect(getByTestId('reviewer-stats-grid')).toBeTruthy();
    expect(getByTestId('reviewer-sentiment-row')).toBeTruthy();
    expect(getByTestId('reviewer-domains-section')).toBeTruthy();
  });
});

describe('ReviewerProfileScreen — header card', () => {
  it('shows the band label as a colour-coded badge for hasNumericScore=false', () => {
    // Below the N=3 threshold — band still shows but score badge
    // displays the band name rather than the numeric score.
    const profile = makeProfile({
      overallTrustScore: 0.85,
      attestationSummary: { total: 2, positive: 2, neutral: 0, negative: 0 },
    });
    const { getByTestId, getByText } = render(
      <ReviewerProfileScreen profile={profile} nowMs={NOW} />,
    );
    expect(getByTestId('reviewer-band-high')).toBeTruthy();
    expect(getByText('HIGH')).toBeTruthy();
  });

  it('shows the numeric score for hasNumericScore=true', () => {
    const profile = makeProfile({
      overallTrustScore: 0.85,
      attestationSummary: { total: 10, positive: 7, neutral: 2, negative: 1 },
    });
    const { getByText } = render(<ReviewerProfileScreen profile={profile} nowMs={NOW} />);
    expect(getByText('85')).toBeTruthy();
  });

  it('renders the namespace fragment when provided', () => {
    const { getByTestId, getByText } = render(
      <ReviewerProfileScreen
        profile={makeProfile()}
        namespace="namespace_2"
        nowMs={NOW}
      />,
    );
    expect(getByTestId('reviewer-namespace')).toBeTruthy();
    expect(getByText('#namespace_2')).toBeTruthy();
  });

  it('omits namespace pill when namespace is null', () => {
    const { queryByTestId } = render(
      <ReviewerProfileScreen profile={makeProfile()} nowMs={NOW} />,
    );
    expect(queryByTestId('reviewer-namespace')).toBeNull();
  });

  it('shows last-active relative time', () => {
    // Profile's lastActive is NOW - 2h.
    const { getByText } = render(
      <ReviewerProfileScreen profile={makeProfile()} nowMs={NOW} />,
    );
    expect(getByText(/Last active 2h ago/)).toBeTruthy();
  });
});

describe('ReviewerProfileScreen — stats grid', () => {
  it('renders stat cells for each metric', () => {
    const { getByTestId } = render(
      <ReviewerProfileScreen profile={makeProfile()} nowMs={NOW} />,
    );
    expect(getByTestId('reviewer-stat-attestations')).toBeTruthy();
    expect(getByTestId('reviewer-stat-vouches')).toBeTruthy();
    expect(getByTestId('reviewer-stat-endorsements')).toBeTruthy();
    expect(getByTestId('reviewer-stat-helpful')).toBeTruthy();
    expect(getByTestId('reviewer-stat-corroborated')).toBeTruthy();
  });

  it('renders helpful + corroborated as percentages', () => {
    const profile = makeProfile({
      reviewerStats: {
        totalAttestationsBy: 10,
        corroborationRate: 0.7, // → 70%
        evidenceRate: 0,
        helpfulRatio: 0.92, // → 92%
      },
    });
    const { getByText } = render(<ReviewerProfileScreen profile={profile} nowMs={NOW} />);
    expect(getByText('92%')).toBeTruthy();
    expect(getByText('70%')).toBeTruthy();
  });

  it('renders em-dash for null helpful + corroborated rates', () => {
    const profile = makeProfile({
      reviewerStats: {
        totalAttestationsBy: 10,
        corroborationRate: NaN,
        evidenceRate: 0,
        helpfulRatio: NaN,
      },
    });
    const { getAllByText } = render(<ReviewerProfileScreen profile={profile} nowMs={NOW} />);
    // Both percent cells render '—'.
    expect(getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });
});

describe('ReviewerProfileScreen — active domains', () => {
  it('renders one chip per active domain', () => {
    const { getByText } = render(
      <ReviewerProfileScreen
        profile={makeProfile({ activeDomains: ['github.com', 'arxiv.org'] })}
        nowMs={NOW}
      />,
    );
    expect(getByText('github.com')).toBeTruthy();
    expect(getByText('arxiv.org')).toBeTruthy();
  });

  it('hides the Active-in section entirely when activeDomains is empty', () => {
    const { queryByTestId } = render(
      <ReviewerProfileScreen
        profile={makeProfile({ activeDomains: [] })}
        nowMs={NOW}
      />,
    );
    expect(queryByTestId('reviewer-domains-section')).toBeNull();
  });
});

describe('ReviewerProfileScreen — accessibility (TN-TEST-061 surface)', () => {
  it('DID has accessibilityLabel "Reviewer <did>"', () => {
    const { getByLabelText } = render(
      <ReviewerProfileScreen profile={makeProfile()} nowMs={NOW} />,
    );
    expect(getByLabelText(/^Reviewer did:plc:/)).toBeTruthy();
  });

  it('Retry button has accessibilityLabel="Retry"', () => {
    const { getByLabelText } = render(
      <ReviewerProfileScreen
        profile={null}
        error="boom"
        onRetry={() => undefined}
      />,
    );
    expect(getByLabelText('Retry')).toBeTruthy();
  });

  it('sentiment chips have descriptive accessibilityLabel ("<n> positive")', () => {
    const profile = makeProfile({
      attestationSummary: { total: 10, positive: 7, neutral: 2, negative: 1 },
    });
    const { getByLabelText } = render(
      <ReviewerProfileScreen profile={profile} nowMs={NOW} />,
    );
    expect(getByLabelText('7 positive')).toBeTruthy();
    expect(getByLabelText('2 neutral')).toBeTruthy();
    expect(getByLabelText('1 negative')).toBeTruthy();
  });
});

describe('ReviewerProfileScreen — Reviews written list', () => {
  const ROW_A = {
    uri: 'at://x/1',
    subjectId: 'sub-aeron',
    subjectTitle: 'Aeron Chair',
    category: 'office_furniture/chair',
    sentiment: 'positive' as const,
    headline: 'Worth every penny',
    createdAtMs: NOW - 2 * 60 * 60_000, // 2 hours ago
  };
  const ROW_B = {
    uri: 'at://x/2',
    subjectId: 'sub-cafe',
    subjectTitle: 'Bluestone Cafe',
    category: null,
    sentiment: 'neutral' as const,
    headline: '',
    createdAtMs: NOW - 3 * 24 * 60 * 60_000, // 3 days ago
  };

  it('hides the section while authoredRows is null (initial load)', () => {
    const { queryByTestId } = render(
      <ReviewerProfileScreen
        profile={makeProfile()}
        nowMs={NOW}
        authoredRows={null}
      />,
    );
    expect(queryByTestId('reviewer-authored-section')).toBeNull();
  });

  it('renders an empty-state line when authoredRows is []', () => {
    const { getByTestId, getByText } = render(
      <ReviewerProfileScreen
        profile={makeProfile()}
        nowMs={NOW}
        authoredRows={[]}
      />,
    );
    expect(getByTestId('reviewer-authored-section')).toBeTruthy();
    expect(getByTestId('reviewer-authored-empty')).toBeTruthy();
    expect(getByText('No reviews written yet.')).toBeTruthy();
  });

  it('renders one row per authored attestation', () => {
    const { getByTestId, getAllByTestId } = render(
      <ReviewerProfileScreen
        profile={makeProfile()}
        nowMs={NOW}
        authoredRows={[ROW_A, ROW_B]}
      />,
    );
    expect(getByTestId('reviewer-authored-section')).toBeTruthy();
    expect(getAllByTestId(/^reviewer-authored-row-/)).toHaveLength(2);
    expect(getByTestId(`reviewer-authored-row-${ROW_A.uri}`)).toBeTruthy();
    expect(getByTestId(`reviewer-authored-row-${ROW_B.uri}`)).toBeTruthy();
  });

  it('row carries subject title, sentiment chip, and relative-time label', () => {
    const { getByText, getByTestId } = render(
      <ReviewerProfileScreen
        profile={makeProfile()}
        nowMs={NOW}
        authoredRows={[ROW_A]}
      />,
    );
    expect(getByText('Aeron Chair')).toBeTruthy();
    expect(getByText('“Worth every penny”')).toBeTruthy();
    expect(getByText('office_furniture/chair')).toBeTruthy();
    expect(getByText('2h ago')).toBeTruthy();
    expect(getByTestId('reviewer-authored-sentiment-positive')).toBeTruthy();
  });

  it('omits the headline line when text is empty', () => {
    const { queryByText } = render(
      <ReviewerProfileScreen
        profile={makeProfile()}
        nowMs={NOW}
        authoredRows={[ROW_B]}
      />,
    );
    // No quoted line because headline === ''
    expect(queryByText(/“.*”/)).toBeNull();
  });

  it('omits the category slot when category is null', () => {
    // ROW_B has category=null. The relative-time label should still
    // render (3d ago). We assert the time label present and that no
    // text matches the category-style slash path.
    const { getByText, queryByText } = render(
      <ReviewerProfileScreen
        profile={makeProfile()}
        nowMs={NOW}
        authoredRows={[ROW_B]}
      />,
    );
    expect(getByText('3d ago')).toBeTruthy();
    expect(queryByText(/\//)).toBeNull(); // no `office_furniture/chair`-style category
  });

  it('tap on a row fires onSelectAuthoredSubject with subjectId', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(
      <ReviewerProfileScreen
        profile={makeProfile()}
        nowMs={NOW}
        authoredRows={[ROW_A]}
        onSelectAuthoredSubject={onSelect}
      />,
    );
    fireEvent.press(getByTestId(`reviewer-authored-row-${ROW_A.uri}`));
    expect(onSelect).toHaveBeenCalledWith('sub-aeron');
  });

  it('row exposes a descriptive accessibilityLabel', () => {
    const { getByLabelText } = render(
      <ReviewerProfileScreen
        profile={makeProfile()}
        nowMs={NOW}
        authoredRows={[ROW_A]}
      />,
    );
    expect(getByLabelText('Positive review of Aeron Chair')).toBeTruthy();
  });
});
