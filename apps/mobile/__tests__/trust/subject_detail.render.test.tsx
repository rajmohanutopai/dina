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

  it('hides Retry CTA when onRetry is omitted', () => {
    const { queryByTestId } = render(
      <SubjectDetailScreen subjectId="sub-1" data={null} error="boom" />,
    );
    expect(queryByTestId('subject-detail-retry')).toBeNull();
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

  it('hides Write CTA when onWriteReview is omitted', () => {
    const { queryByTestId } = render(
      <SubjectDetailScreen subjectId="sub-1" data={makeInput()} />,
    );
    expect(queryByTestId('subject-detail-write-cta')).toBeNull();
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

  it('tap on a review row fires onSelectReviewer with reviewer name', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(
      <SubjectDetailScreen
        subjectId="sub-1"
        data={makeInput({
          reviews: [makeReview({ reviewerName: 'Sancho' })],
        })}
        onSelectReviewer={onSelect}
      />,
    );
    fireEvent.press(getByTestId('subject-detail-review-friends-0'));
    expect(onSelect).toHaveBeenCalledWith('Sancho');
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
