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

import { render, fireEvent, within } from '@testing-library/react-native';
import React from 'react';

// Mock the booted-node singleton: tests pin a known DID so the
// reviewer screen's `isSelf` branch (which gates the Edit affordance
// on authored rows) is reachable. Real production keeps the singleton
// `null` until onboarding completes; in tests we want both branches.
const MOCK_BOOTED_DID = 'did:plc:bootedaaaaaaaaaaaaaaaa';
jest.mock('../../src/hooks/useNodeBootstrap', () => ({
  getBootedNode: jest.fn(() => ({ did: MOCK_BOOTED_DID })),
  getBootDegradations: jest.fn(() => []),
  subscribeBootedNode: jest.fn(() => () => undefined),
}));

import ReviewerProfileScreen from '../../app/peerlens/reviewer/[did]';

import type { PeerlensProfile } from '@dina/core';

const NOW = 1_700_000_000_000;

function makeProfile(overrides: Partial<PeerlensProfile> = {}): PeerlensProfile {
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

  // notFound is the EMPTY state (no attestations yet) — must NOT render as an
  // error with a dead Retry. Regression: a new user opening "Your review
  // activity" hit "Couldn't load this profile" + Retry.
  it('renders the EMPTY state (not the error panel) when notFound', () => {
    const { getByTestId, queryByTestId } = render(
      <ReviewerProfileScreen profile={null} notFound />,
    );
    expect(getByTestId('reviewer-profile-empty')).toBeTruthy();
    expect(queryByTestId('reviewer-profile-error')).toBeNull();
    expect(queryByTestId('reviewer-profile-loading')).toBeNull();
    expect(queryByTestId('reviewer-profile-retry')).toBeNull();
  });

  it('own empty profile offers a "Write a review" CTA that fires onWriteReview', () => {
    const onWriteReview = jest.fn();
    const { getByTestId } = render(
      <ReviewerProfileScreen profile={null} notFound isSelf onWriteReview={onWriteReview} />,
    );
    fireEvent.press(getByTestId('reviewer-profile-write-cta'));
    expect(onWriteReview).toHaveBeenCalledTimes(1);
  });

  it('another person’s empty profile has NO write CTA (neutral, not self)', () => {
    const { getByTestId, queryByTestId } = render(
      <ReviewerProfileScreen profile={null} notFound isSelf={false} />,
    );
    expect(getByTestId('reviewer-profile-empty')).toBeTruthy();
    expect(queryByTestId('reviewer-profile-write-cta')).toBeNull();
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

  // F1 fix: when authoredRows is loaded with data the reviews-written
  // count reflects the displayable row count, not the API's
  // unfiltered `totalAttestationsBy`. Pre-fix the API said "6" while
  // `deriveAuthoredAttestationRows` had silently dropped a hit with a
  // missing subjectId, leaving the user staring at 5 rows under a
  // "6 Reviews written" stat. Same fall-back pattern as the sentiment
  // chips: use the API summary while the list is still loading, swap
  // to the displayable length once it's ready.
  it('reviews-written count tracks the loaded authoredRows length, not API summary', () => {
    const profile = makeProfile({
      reviewerStats: {
        totalAttestationsBy: 99, // API claims 99
        corroborationRate: 0,
        evidenceRate: 0,
        helpfulRatio: 0,
      },
    });
    const ROW = {
      uri: 'at://x/1',
      subjectId: 'sub-1',
      subjectKind: 'product' as const,
      subjectUri: null,
      subjectDid: null,
      subjectTitle: 'A subject',
      category: null,
      sentiment: 'positive' as const,
      headline: 'h',
      body: '',
      confidence: null,
      createdAtMs: NOW - 60_000,
    };
    const { getByTestId, queryByText } = render(
      <ReviewerProfileScreen
        profile={profile}
        nowMs={NOW}
        authoredRows={[ROW, { ...ROW, uri: 'at://x/2', subjectId: 'sub-2' }]}
      />,
    );
    // Two displayable rows → "2", not the API's "99". Use `within`
    // to scope the search to the stat cell (multiple "2"s elsewhere
    // on the screen — e.g. sentiment chip counts).
    const cell = getByTestId('reviewer-stat-attestations');
    expect(within(cell).getByText('2')).toBeTruthy();
    expect(queryByText('99')).toBeNull();
  });

  it('reviews-written count falls back to API summary while authoredRows is loading (null)', () => {
    const profile = makeProfile({
      reviewerStats: {
        totalAttestationsBy: 7,
        corroborationRate: 0,
        evidenceRate: 0,
        helpfulRatio: 0,
      },
    });
    const { getByTestId } = render(
      <ReviewerProfileScreen profile={profile} nowMs={NOW} authoredRows={null} />,
    );
    // Loading state → use API summary so the stat doesn't flash 0.
    const cell = getByTestId('reviewer-stat-attestations');
    expect(within(cell).getByText('7')).toBeTruthy();
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
    subjectKind: 'product' as const,
    subjectUri: null,
    subjectDid: null,
    subjectTitle: 'Aeron Chair',
    category: 'office_furniture/chair',
    sentiment: 'positive' as const,
    headline: 'Worth every penny',
    body: 'Best chair I have owned.',
    confidence: 'high' as const,
    createdAtMs: NOW - 2 * 60 * 60_000, // 2 hours ago
  };
  const ROW_B = {
    uri: 'at://x/2',
    subjectId: 'sub-cafe',
    subjectKind: 'place' as const,
    subjectUri: null,
    subjectDid: null,
    subjectTitle: 'Bluestone Cafe',
    category: null,
    sentiment: 'neutral' as const,
    headline: '',
    body: '',
    confidence: null,
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

describe('ReviewerProfileScreen — Edit affordance on own reviews', () => {
  const ROW = {
    uri: 'at://did:plc:owner/com.dinakernel.peerlens.attestation/1',
    subjectId: 'sub-aeron',
    subjectKind: 'product' as const,
    subjectUri: null,
    subjectDid: null,
    subjectTitle: 'Aeron Chair',
    category: 'office_furniture/chair',
    sentiment: 'positive' as const,
    headline: 'Worth every penny',
    body: 'Best chair I have owned.',
    confidence: 'high' as const,
    createdAtMs: NOW - 60_000,
  };

  // The reviewer screen pulls `isSelf` from `getBootedNode()` —
  // mocked at the top of this file to return a known DID. When the
  // profile's DID matches the booted DID, `isSelf` is true and the
  // Edit pill should appear on every authored row.
  const SELF_DID = MOCK_BOOTED_DID;

  it('renders the Edit pill on every authored row when viewing your own profile', () => {
    const { getByTestId } = render(
      <ReviewerProfileScreen
        profile={makeProfile({ did: SELF_DID })}
        nowMs={NOW}
        authoredRows={[ROW]}
      />,
    );
    expect(getByTestId(`reviewer-authored-edit-${ROW.uri}`)).toBeTruthy();
  });

  it('hides the Edit pill on other reviewers profiles', () => {
    const { queryByTestId } = render(
      <ReviewerProfileScreen
        profile={makeProfile({ did: 'did:plc:somebody-else' })}
        nowMs={NOW}
        authoredRows={[ROW]}
      />,
    );
    expect(queryByTestId(`reviewer-authored-edit-${ROW.uri}`)).toBeNull();
  });

  it('Edit pill exposes a descriptive accessibilityLabel including subject + sentiment', () => {
    const { getByLabelText } = render(
      <ReviewerProfileScreen
        profile={makeProfile({ did: SELF_DID })}
        nowMs={NOW}
        authoredRows={[ROW]}
      />,
    );
    expect(
      getByLabelText('Edit your positive review of Aeron Chair'),
    ).toBeTruthy();
  });

  it('tapping the Edit pill fires onEditAuthored with the full row payload', () => {
    const onEdit = jest.fn();
    const { getByTestId } = render(
      <ReviewerProfileScreen
        profile={makeProfile({ did: SELF_DID })}
        nowMs={NOW}
        authoredRows={[ROW]}
        onEditAuthored={onEdit}
      />,
    );
    fireEvent.press(getByTestId(`reviewer-authored-edit-${ROW.uri}`));
    expect(onEdit).toHaveBeenCalledWith(ROW);
  });
});

describe('ReviewerProfileScreen — authored list truncation (latest 5 + View all)', () => {
  function authoredRow(n: number) {
    return {
      uri: `at://x/${n}`,
      subjectId: `sub-${n}`,
      subjectKind: 'product' as const,
      subjectUri: null,
      subjectDid: null,
      subjectTitle: `Subject ${n}`,
      category: null,
      sentiment: 'positive' as const,
      headline: `h${n}`,
      body: '',
      confidence: null,
      createdAtMs: n,
    };
  }
  const sevenRows = Array.from({ length: 7 }, (_, i) => authoredRow(i));

  it('shows only the latest 5 + a "View all reviews (N)" expander when > 5', () => {
    const { getByTestId, queryByTestId, getByText } = render(
      <ReviewerProfileScreen profile={makeProfile()} authoredRows={sevenRows} nowMs={NOW} />,
    );
    expect(getByTestId('reviewer-authored-row-at://x/0')).toBeTruthy();
    expect(getByTestId('reviewer-authored-row-at://x/4')).toBeTruthy();
    expect(queryByTestId('reviewer-authored-row-at://x/5')).toBeNull(); // 6th hidden
    expect(getByTestId('reviewer-authored-view-all')).toBeTruthy();
    expect(getByText('View all reviews (7)')).toBeTruthy();
  });

  it('tapping "View all" reveals the rest and removes the expander', () => {
    const { getByTestId, queryByTestId } = render(
      <ReviewerProfileScreen profile={makeProfile()} authoredRows={sevenRows} nowMs={NOW} />,
    );
    fireEvent.press(getByTestId('reviewer-authored-view-all'));
    expect(getByTestId('reviewer-authored-row-at://x/5')).toBeTruthy();
    expect(getByTestId('reviewer-authored-row-at://x/6')).toBeTruthy();
    expect(queryByTestId('reviewer-authored-view-all')).toBeNull();
  });

  it('shows all rows with no expander when ≤ 5', () => {
    const fourRows = sevenRows.slice(0, 4);
    const { getByTestId, queryByTestId } = render(
      <ReviewerProfileScreen profile={makeProfile()} authoredRows={fourRows} nowMs={NOW} />,
    );
    expect(getByTestId('reviewer-authored-row-at://x/3')).toBeTruthy();
    expect(queryByTestId('reviewer-authored-view-all')).toBeNull();
  });
});

describe('ReviewerProfileScreen — self-only Publishing + About', () => {
  it('renders Publishing + About sections (with their rows) for the owner (self)', () => {
    const { getByTestId } = render(
      <ReviewerProfileScreen
        profile={makeProfile({ did: MOCK_BOOTED_DID })}
        authoredRows={[]}
        nowMs={NOW}
      />,
    );
    expect(getByTestId('reviewer-publishing-section')).toBeTruthy();
    expect(getByTestId('reviewer-row-pending-reviews')).toBeTruthy();
    expect(getByTestId('reviewer-row-publish-as')).toBeTruthy();
    expect(getByTestId('reviewer-row-review-preferences')).toBeTruthy();
    expect(getByTestId('reviewer-about-section')).toBeTruthy();
    expect(getByTestId('reviewer-row-about')).toBeTruthy();
  });

  it('hides Publishing + About on a PEER profile (read-only)', () => {
    const { queryByTestId } = render(
      <ReviewerProfileScreen profile={makeProfile()} authoredRows={[]} nowMs={NOW} />,
    );
    expect(queryByTestId('reviewer-publishing-section')).toBeNull();
    expect(queryByTestId('reviewer-about-section')).toBeNull();
  });
});
