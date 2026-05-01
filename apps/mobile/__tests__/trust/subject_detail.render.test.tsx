/**
 * Render tests for the subject detail screen (TN-MOB-012).
 *
 * Pins the screen-state machine + composition over the data-layer
 * derivation (`subject_detail_data.ts`). Three render states +
 * grouped review sections + interactions.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import SubjectDetailScreen from '../../app/trust/[subjectId]';
import type { SubjectDetailInput } from '../../src/trust/subject_detail_data';
import type { SubjectReview } from '../../src/trust/subject_card';

function makeReview(overrides: Partial<SubjectReview> = {}): SubjectReview {
  return {
    ring: 'contact',
    reviewerDid: 'did:plc:sancho',
    reviewerTrustScore: 0.7,
    reviewerName: 'Sancho',
    headline: 'Great chair',
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function makeInput(overrides: Partial<SubjectDetailInput> = {}): SubjectDetailInput {
  return {
    title: 'Aeron chair',
    category: 'office_furniture/chair',
    subjectTrustScore: 0.82,
    reviewCount: 5,
    reviews: [],
    ...overrides,
  };
}

describe('SubjectDetailScreen — render states', () => {
  it('renders error panel when error is set', () => {
    const { getByTestId, getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={null}
        error="Network unreachable"
        onRetry={() => undefined}
      />,
    );
    expect(getByTestId('subject-detail-error')).toBeTruthy();
    expect(getByText('Network unreachable')).toBeTruthy();
    expect(getByTestId('subject-detail-retry')).toBeTruthy();
  });

  it('renders Retry CTA when onRetry is omitted (auto-timeout reset)', () => {
    // The screen now provides a router-aware default for `onRetry` — it
    // resets the auto-timeout state so the user can re-trigger the
    // load. Callers that genuinely want a no-Retry error panel pass
    // `onRetry={undefined}` is no longer a way to hide it; the CTA is
    // always available in production paths.
    const { getByTestId } = render(
      <SubjectDetailScreen subjectId="sub-1" data={null} error="boom" />,
    );
    expect(getByTestId('subject-detail-retry')).toBeTruthy();
  });

  it('renders loading state when data is null AND no error', () => {
    const { getByTestId, queryByTestId } = render(
      <SubjectDetailScreen subjectId="sub-1" data={null} />,
    );
    expect(getByTestId('subject-detail-loading')).toBeTruthy();
    expect(queryByTestId('subject-detail-screen')).toBeNull();
    expect(queryByTestId('subject-detail-error')).toBeNull();
  });

  it('renders loaded state with header + ring summary when data is provided', () => {
    const { getByTestId, getByText } = render(
      <SubjectDetailScreen subjectId="sub-1" data={makeInput()} />,
    );
    expect(getByTestId('subject-detail-screen')).toBeTruthy();
    expect(getByText('Aeron chair')).toBeTruthy();
    expect(getByText('Office furniture')).toBeTruthy();
    expect(getByTestId('subject-detail-ring-summary')).toBeTruthy();
  });
});

describe('SubjectDetailScreen — header', () => {
  it('renders numeric score badge when showNumericScore=true', () => {
    const { getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({ subjectTrustScore: 0.82, reviewCount: 5 })}
      />,
    );
    expect(getByText('82')).toBeTruthy();
  });

  it('renders band label when showNumericScore=false (N<3)', () => {
    const { getByText, queryByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({ subjectTrustScore: 0.95, reviewCount: 1 })}
      />,
    );
    // 0.95 → band high; with N=1 (<3) the screen shows "HIGH" not the digit.
    expect(getByText('HIGH')).toBeTruthy();
    expect(queryByText('95')).toBeNull();
  });

  it('renders correct review count singular', () => {
    const { getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({ reviewCount: 1 })}
      />,
    );
    expect(getByText(/^1 review$/)).toBeTruthy();
  });

  it('renders Write CTA when onWriteReview is provided', () => {
    const { getByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput()}
        onWriteReview={() => undefined}
      />,
    );
    expect(getByTestId('subject-detail-write-cta')).toBeTruthy();
  });

  it('renders Write CTA when onWriteReview is omitted (router fallback)', () => {
    // Screens now expose a router-based navigation fallback so the
    // Write CTA is always present in production. Callers that genuinely
    // need to suppress it (read-only contexts, e.g. a quoted preview)
    // pass an explicit no-op handler instead of relying on omission.
    const { getByTestId } = render(
      <SubjectDetailScreen subjectId="sub-1" data={makeInput()} />,
    );
    expect(getByTestId('subject-detail-write-cta')).toBeTruthy();
  });
});

describe('SubjectDetailScreen — review sections', () => {
  it('renders one section per non-empty ring group', () => {
    const { getByTestId, queryByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({ ring: 'contact', reviewerName: 'A' }),
            makeReview({ ring: 'fof', reviewerName: 'B' }),
          ],
        })}
      />,
    );
    expect(getByTestId('subject-detail-section-friends')).toBeTruthy();
    expect(getByTestId('subject-detail-section-fof')).toBeTruthy();
    // Strangers section omitted because it's empty AND there are
    // other sections (no global "no reviews" hint needed).
    expect(queryByTestId('subject-detail-section-strangers')).toBeNull();
  });

  it('renders an empty hint in strangers section when ALL groups are empty', () => {
    const { getByTestId, getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({ reviews: [], reviewCount: 0 })}
      />,
    );
    // Only the strangers section renders, with the global empty hint.
    expect(getByTestId('subject-detail-section-strangers')).toBeTruthy();
    expect(getByText(/be the first/i)).toBeTruthy();
  });

  it('renders one row per review in the section', () => {
    const { getAllByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({ ring: 'contact', reviewerName: 'A' }),
            makeReview({ ring: 'contact', reviewerName: 'B' }),
            makeReview({ ring: 'contact', reviewerName: 'C' }),
          ],
        })}
      />,
    );
    expect(getAllByTestId(/^subject-detail-review-friends-\d+$/)).toHaveLength(3);
  });

  it('shows the section count badge when reviews present', () => {
    const { getAllByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [makeReview(), makeReview({ reviewerName: 'B' })],
        })}
      />,
    );
    // The count "2" appears as the section count badge.
    expect(getAllByText('2').length).toBeGreaterThan(0);
  });
});

describe('SubjectDetailScreen — interactions', () => {
  it('tap on Write CTA fires onWriteReview with subjectId', () => {
    const onWrite = jest.fn();
    const { getByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-99"
        data={makeInput()}
        onWriteReview={onWrite}
      />,
    );
    fireEvent.press(getByTestId('subject-detail-write-cta'));
    expect(onWrite).toHaveBeenCalledWith('sub-99');
  });

  it('tap on a review row fires onSelectReviewer with reviewer DID', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({ reviewerName: 'Sancho', reviewerDid: 'did:plc:sancho' }),
          ],
        })}
        onSelectReviewer={onSelect}
      />,
    );
    fireEvent.press(getByTestId('subject-detail-review-friends-0'));
    expect(onSelect).toHaveBeenCalledWith('did:plc:sancho');
  });

  it('tap on Retry fires onRetry', () => {
    const onRetry = jest.fn();
    const { getByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={null}
        error="boom"
        onRetry={onRetry}
      />,
    );
    fireEvent.press(getByTestId('subject-detail-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('SubjectDetailScreen — accessibility (TN-TEST-061 surface)', () => {
  it('review row has descriptive accessibilityLabel', () => {
    const { getByLabelText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({
              reviewerName: 'Sancho',
              reviewerTrustScore: 0.85,
            }),
          ],
        })}
        onSelectReviewer={() => undefined}
      />,
    );
    expect(getByLabelText(/Review by Sancho, trust HIGH/)).toBeTruthy();
  });

  it('Write CTA has accessibilityLabel="Write a review"', () => {
    const { getByLabelText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput()}
        onWriteReview={() => undefined}
      />,
    );
    expect(getByLabelText('Write a review')).toBeTruthy();
  });
});

describe('SubjectDetailScreen — self-review band suppression', () => {
  // AppView's `subjectGet` is supposed to bucket the viewer's own
  // review into `reviewers.self`. When the viewerDid handshake
  // misses (observed in production via idb on 2026-05-01), the
  // review lands in `strangers` instead — and the row would surface
  // the user's own trust band (e.g. "VERY LOW" red badge) against
  // their own name, exactly the shame mechanic we suppressed on the
  // self-card. The mobile-side fix detects self by DID match
  // regardless of the bucket the wire chose.
  it('renders "Your review" + no band badge when row.reviewerDid matches viewerDid (even with ring=stranger)', () => {
    const { getByText, queryByText, getByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({
              ring: 'stranger',
              reviewerDid: 'did:plc:rajmohanddc9',
              reviewerName: 'rajmohanddc9',
              reviewerTrustScore: 0.05, // would render VERY LOW
              headline: 'Comfortable',
            }),
          ],
        })}
        viewerDid="did:plc:rajmohanddc9"
      />,
    );
    // Row reads "Your review" — name is suppressed.
    expect(getByText('Your review')).toBeTruthy();
    expect(queryByText('rajmohanddc9')).toBeNull();
    // Band badge ("VERY LOW") is suppressed too.
    expect(queryByText('VERY LOW')).toBeNull();
    // Row is rendered in the expected section (strangers since wire said so).
    expect(getByTestId('subject-detail-section-strangers')).toBeTruthy();
  });

  it('does NOT suppress the band when viewerDid is empty (degraded pre-boot path)', () => {
    // Defensive: an empty `viewerDid` (no booted node) must not
    // accidentally match against another reviewer's empty DID. The
    // band stays visible in this case.
    const { getByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({
              ring: 'stranger',
              reviewerDid: 'did:plc:somebody',
              reviewerName: 'Somebody',
              reviewerTrustScore: 0.05,
            }),
          ],
        })}
        viewerDid=""
      />,
    );
    expect(getByText('VERY LOW')).toBeTruthy();
    expect(getByText('Somebody')).toBeTruthy();
  });

  it('still respects ring=self when wire correctly buckets the viewer (regression guard)', () => {
    // Belt-and-braces: even when the wire correctly puts the user
    // in `reviewers.self`, the row should suppress the band.
    const { getByText, queryByText } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [
            makeReview({
              ring: 'self',
              reviewerDid: null,
              reviewerName: 'You',
              reviewerTrustScore: 0.05,
            }),
          ],
        })}
        // Intentionally NOT passing viewerDid — ring='self' alone
        // should already trigger the suppression.
      />,
    );
    expect(getByText('Your review')).toBeTruthy();
    expect(queryByText('VERY LOW')).toBeNull();
  });
});
