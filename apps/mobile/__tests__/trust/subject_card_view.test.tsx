/**
 * Render tests for the shared `SubjectCardView` component
 * (TN-MOB-016 + TN-MOB-011 / Plan §8.3).
 *
 * The component renders a `SubjectCardDisplay` from the data layer
 * (`src/trust/subject_card.ts`) into the search-result card layout.
 * It's used by BOTH the search screen and the feed landing — pinning
 * the per-card invariants here lets each screen test focus on
 * screen-level concerns (state machine, list composition).
 *
 * Coverage:
 *   - Title + subtitle rendering, including conditional subtitle
 *     hide when `display.subtitle === null`.
 *   - Score badge: numeric label (when `showNumericScore=true`) vs.
 *     band label (when false) + colour-coded by band.
 *   - Review count singular/plural.
 *   - Friends pill: hidden when null; singular/plural; strangers-
 *     suffix conditional on count > 0.
 *   - Top-reviewer line: hidden when null; quoted headline + ring +
 *     band label.
 *   - Tap handler with subjectId.
 *   - a11y label composition (title + score band + review count +
 *     friends count).
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import {
  SubjectCardView,
  buildA11yLabel,
} from '../../src/trust/components/subject_card_view';
import type { SubjectCardDisplay } from '../../src/trust/subject_card';

function makeDisplay(overrides: Partial<SubjectCardDisplay> = {}): SubjectCardDisplay {
  return {
    title: 'Aeron chair',
    subtitle: 'Office furniture',
    score: {
      score: 82,
      label: '82',
      bandName: 'High trust',
      band: 'high',
      colorToken: 'high',
    },
    showNumericScore: true,
    reviewCount: 14,
    friendsPill: { friendsCount: 2, strangersCount: 12 },
    topReviewer: {
      headline: 'Worth every penny for the back',
      reviewerName: 'Sancho',
      ring: 'contact',
      band: 'high',
    },
    ...overrides,
  };
}

describe('SubjectCardView — render', () => {
  it('renders title + subtitle + score + review count', () => {
    const { getByText } = render(
      <SubjectCardView subjectId="sub-1" display={makeDisplay()} />,
    );
    expect(getByText('Aeron chair')).toBeTruthy();
    expect(getByText('Office furniture')).toBeTruthy();
    expect(getByText('82')).toBeTruthy();
    expect(getByText(/14 reviews/)).toBeTruthy();
  });

  it('renders band label (not numeric) when showNumericScore=false', () => {
    const { getByText, queryByText } = render(
      <SubjectCardView
        subjectId="sub-1"
        display={makeDisplay({ showNumericScore: false })}
      />,
    );
    expect(getByText('HIGH')).toBeTruthy();
    // The numeric label "82" must NOT appear when showNumericScore is false.
    expect(queryByText('82')).toBeNull();
  });

  it('hides subtitle when display.subtitle is null', () => {
    const { queryByText } = render(
      <SubjectCardView subjectId="sub-1" display={makeDisplay({ subtitle: null })} />,
    );
    expect(queryByText('Office furniture')).toBeNull();
  });

  it('renders "1 review" (singular) for reviewCount=1', () => {
    const { getByText } = render(
      <SubjectCardView subjectId="sub-1" display={makeDisplay({ reviewCount: 1 })} />,
    );
    expect(getByText(/^1 review$/)).toBeTruthy();
  });

  it('hides friends pill when display.friendsPill is null', () => {
    const { queryByTestId } = render(
      <SubjectCardView subjectId="sub-1" display={makeDisplay({ friendsPill: null })} />,
    );
    expect(queryByTestId('subject-card-friends-sub-1')).toBeNull();
  });

  it('renders friends pill with singular "friend" + omits strangers when count=0', () => {
    const { getByText, queryByText } = render(
      <SubjectCardView
        subjectId="sub-1"
        display={makeDisplay({
          friendsPill: { friendsCount: 1, strangersCount: 0 },
        })}
      />,
    );
    expect(getByText(/1 friend/)).toBeTruthy();
    expect(queryByText(/stranger/)).toBeNull();
  });

  it('renders friends pill with strangers suffix when strangers > 0', () => {
    const { getByText } = render(
      <SubjectCardView subjectId="sub-1" display={makeDisplay()} />,
    );
    expect(getByText(/2 friends/)).toBeTruthy();
    expect(getByText(/12 strangers/)).toBeTruthy();
  });

  it('hides top-reviewer line when display.topReviewer is null', () => {
    const { queryByTestId } = render(
      <SubjectCardView subjectId="sub-1" display={makeDisplay({ topReviewer: null })} />,
    );
    expect(queryByTestId('subject-card-reviewer-sub-1')).toBeNull();
  });

  it('renders top-reviewer line with quoted headline + attribution', () => {
    const { getByText } = render(
      <SubjectCardView subjectId="sub-1" display={makeDisplay()} />,
    );
    // Quotes are smart quotes around the headline.
    expect(getByText(/Worth every penny for the back/)).toBeTruthy();
    // Attribution line includes name + ring + band.
    expect(getByText(/Sancho · contact · trust HIGH/)).toBeTruthy();
  });
});

describe('SubjectCardView — tap behaviour', () => {
  it('fires onPress with the subjectId', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <SubjectCardView subjectId="sub-42" display={makeDisplay()} onPress={onPress} />,
    );
    fireEvent.press(getByTestId('subject-card-sub-42'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith('sub-42');
  });

  it('does nothing when onPress is omitted', () => {
    // Smoke check — render without onPress; tap shouldn't throw.
    const { getByTestId } = render(
      <SubjectCardView subjectId="sub-42" display={makeDisplay()} />,
    );
    expect(() => fireEvent.press(getByTestId('subject-card-sub-42'))).not.toThrow();
  });
});

describe('SubjectCardView — band colour', () => {
  // The badge is rendered for every RATED band — `unrated` is the
  // signal "we don't know yet" and showing a meaningless "—" badge
  // alongside the review count was confusing on search results
  // (where the wire response doesn't carry subject scores). Test
  // each rated band gets its testID, then a separate case for
  // `unrated` asserts the badge is hidden.
  it.each(['high', 'moderate', 'low', 'very-low'] as const)(
    'attaches a per-band testID for band %s',
    (band) => {
      const { getByTestId } = render(
        <SubjectCardView
          subjectId="sub-1"
          display={makeDisplay({
            score: {
              score: null,
              label: '—',
              bandName: 'x',
              band,
              colorToken: band as 'high', // not actually used by the test
            },
            showNumericScore: false,
          })}
        />,
      );
      expect(getByTestId('subject-card-band-sub-1')).toBeTruthy();
    },
  );

  it('hides the band badge entirely when the subject is unrated', () => {
    const { queryByTestId } = render(
      <SubjectCardView
        subjectId="sub-1"
        display={makeDisplay({
          score: {
            score: null,
            label: '—',
            bandName: 'x',
            band: 'unrated',
            colorToken: 'unrated' as 'high',
          },
          showNumericScore: false,
        })}
      />,
    );
    expect(queryByTestId('subject-card-band-sub-1')).toBeNull();
  });
});

describe('buildA11yLabel', () => {
  it('composes title + subtitle + band + review count + friends', () => {
    const label = buildA11yLabel(makeDisplay());
    expect(label).toBe('Aeron chair, Office furniture, trust HIGH, 14 reviews, 2 friends');
  });

  it('omits subtitle when null', () => {
    const label = buildA11yLabel(makeDisplay({ subtitle: null }));
    expect(label).toBe('Aeron chair, trust HIGH, 14 reviews, 2 friends');
  });

  it('omits friends when no contact-network signal', () => {
    const label = buildA11yLabel(makeDisplay({ friendsPill: null }));
    expect(label).toBe('Aeron chair, Office furniture, trust HIGH, 14 reviews');
  });

  it('uses singular "review" for reviewCount=1', () => {
    const label = buildA11yLabel(
      makeDisplay({ reviewCount: 1, friendsPill: null }),
    );
    expect(label).toContain('1 review');
  });

  it('uses singular "friend" for friendsCount=1', () => {
    const label = buildA11yLabel(
      makeDisplay({
        friendsPill: { friendsCount: 1, strangersCount: 0 },
      }),
    );
    expect(label).toContain('1 friend');
  });
});

describe('SubjectCardView — accessibility (TN-TEST-061 surface)', () => {
  it('the card itself has accessibilityRole="button"', () => {
    const { getByTestId } = render(
      <SubjectCardView subjectId="sub-1" display={makeDisplay()} onPress={() => undefined} />,
    );
    const card = getByTestId('subject-card-sub-1');
    expect(card.props.accessibilityRole).toBe('button');
  });

  it('the card has a non-empty composed accessibilityLabel', () => {
    const { getByTestId } = render(
      <SubjectCardView subjectId="sub-1" display={makeDisplay()} />,
    );
    const card = getByTestId('subject-card-sub-1');
    expect(typeof card.props.accessibilityLabel).toBe('string');
    expect((card.props.accessibilityLabel as string).length).toBeGreaterThan(0);
  });
});
