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

import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import {
  SubjectCardView,
  buildA11yLabel,
} from '../../src/trust/components/subject_card_view';

import type { SubjectCardDisplay } from '../../src/trust/subject_card';

function makeDisplay(overrides: Partial<SubjectCardDisplay> = {}): SubjectCardDisplay {
  return {
    title: 'Aeron chair',
    subtitle: 'Office furniture',
    host: null,
    language: null,
    location: null,
    priceTier: null,
    recency: null,
    regionPill: null,
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

describe('SubjectCardView — context chips (TN-V2-P1-001 + 002 + 003 + RANK-013)', () => {
  // The chip row sits between the subtitle and the score row. Its
  // visibility contract is: hide the entire row when ALL chips are
  // null (so unenriched cards don't gain a blank gap), show one chip
  // when only one signal exists, show many side-by-side when more do.
  // The data-layer tests pin normalisation; these tests pin the
  // visual contract.
  it('hides the chip row entirely when ALL six chips are null', () => {
    const { queryByTestId } = render(
      <SubjectCardView
        subjectId="sub-1"
        display={makeDisplay({
          host: null,
          language: null,
          location: null,
          priceTier: null,
          recency: null,
          regionPill: null,
        })}
      />,
    );
    expect(queryByTestId('subject-card-context-sub-1')).toBeNull();
    expect(queryByTestId('subject-card-host-sub-1')).toBeNull();
    expect(queryByTestId('subject-card-language-sub-1')).toBeNull();
    expect(queryByTestId('subject-card-recency-sub-1')).toBeNull();
    expect(queryByTestId('subject-card-region-sub-1')).toBeNull();
    expect(queryByTestId('subject-card-location-sub-1')).toBeNull();
    expect(queryByTestId('subject-card-price-sub-1')).toBeNull();
  });

  it('renders only the host chip when language and location are null', () => {
    const { getByTestId, queryByTestId, getByText } = render(
      <SubjectCardView
        subjectId="sub-1"
        display={makeDisplay({ host: 'jumia.ug', language: null, location: null })}
      />,
    );
    expect(getByTestId('subject-card-context-sub-1')).toBeTruthy();
    expect(getByTestId('subject-card-host-sub-1')).toBeTruthy();
    expect(queryByTestId('subject-card-language-sub-1')).toBeNull();
    expect(queryByTestId('subject-card-location-sub-1')).toBeNull();
    expect(getByText('jumia.ug')).toBeTruthy();
  });

  it('renders only the language chip when host and location are null', () => {
    const { getByTestId, queryByTestId, getByText } = render(
      <SubjectCardView
        subjectId="sub-1"
        display={makeDisplay({ host: null, language: 'EN', location: null })}
      />,
    );
    expect(getByTestId('subject-card-context-sub-1')).toBeTruthy();
    expect(queryByTestId('subject-card-host-sub-1')).toBeNull();
    expect(getByTestId('subject-card-language-sub-1')).toBeTruthy();
    expect(queryByTestId('subject-card-location-sub-1')).toBeNull();
    expect(getByText('EN')).toBeTruthy();
  });

  it('renders only the location chip when host and language are null (typical place subject)', () => {
    // Place subjects rarely carry host (places aren't usually URLs);
    // the location chip stands in as the geographic anchor.
    const { getByTestId, queryByTestId, getByText } = render(
      <SubjectCardView
        subjectId="sub-1"
        display={makeDisplay({
          host: null,
          language: null,
          location: '37.77°N, 122.42°W',
        })}
      />,
    );
    expect(getByTestId('subject-card-context-sub-1')).toBeTruthy();
    expect(queryByTestId('subject-card-host-sub-1')).toBeNull();
    expect(queryByTestId('subject-card-language-sub-1')).toBeNull();
    expect(getByTestId('subject-card-location-sub-1')).toBeTruthy();
    expect(getByText('37.77°N, 122.42°W')).toBeTruthy();
  });

  it('renders host + language side-by-side when both signals present', () => {
    const { getByTestId, getByText } = render(
      <SubjectCardView
        subjectId="sub-1"
        display={makeDisplay({ host: 'amazon.de', language: 'DE' })}
      />,
    );
    expect(getByTestId('subject-card-host-sub-1')).toBeTruthy();
    expect(getByTestId('subject-card-language-sub-1')).toBeTruthy();
    expect(getByText('amazon.de')).toBeTruthy();
    expect(getByText('DE')).toBeTruthy();
  });

  it('renders all three chips when all signals present', () => {
    // Edge case: a place subject that also has a host (e.g., a
    // venue with a website) and detected language. All three render.
    const { getByTestId, getByText } = render(
      <SubjectCardView
        subjectId="sub-1"
        display={makeDisplay({
          host: 'sfmoma.org',
          language: 'EN',
          location: '37.79°N, 122.40°W',
        })}
      />,
    );
    expect(getByTestId('subject-card-host-sub-1')).toBeTruthy();
    expect(getByTestId('subject-card-language-sub-1')).toBeTruthy();
    expect(getByTestId('subject-card-location-sub-1')).toBeTruthy();
    expect(getByText('sfmoma.org')).toBeTruthy();
    expect(getByText('EN')).toBeTruthy();
    expect(getByText('37.79°N, 122.40°W')).toBeTruthy();
  });

  // TN-V2-RANK-013 — price tier chip.
  // Adds the fourth context chip in the row. Pinned: rendering for
  // each of the three valid tiers, hiding when null, and that the
  // chip row stays visible when price is the SOLE signal (typical of
  // a rated product whose host/language/location aren't carried).
  it('renders only the price chip when host, language and location are null', () => {
    const { getByTestId, queryByTestId, getByText } = render(
      <SubjectCardView
        subjectId="sub-1"
        display={makeDisplay({
          host: null,
          language: null,
          location: null,
          priceTier: '$$',
        })}
      />,
    );
    expect(getByTestId('subject-card-context-sub-1')).toBeTruthy();
    expect(queryByTestId('subject-card-host-sub-1')).toBeNull();
    expect(queryByTestId('subject-card-language-sub-1')).toBeNull();
    expect(queryByTestId('subject-card-location-sub-1')).toBeNull();
    expect(getByTestId('subject-card-price-sub-1')).toBeTruthy();
    expect(getByText('$$')).toBeTruthy();
  });

  it.each(['$', '$$', '$$$'] as const)(
    'renders the price chip text verbatim for tier %s',
    (tier) => {
      const { getByTestId, getByText } = render(
        <SubjectCardView
          subjectId="sub-1"
          display={makeDisplay({ priceTier: tier })}
        />,
      );
      expect(getByTestId('subject-card-price-sub-1')).toBeTruthy();
      expect(getByText(tier)).toBeTruthy();
    },
  );

  it('hides the price chip when priceTier is null even if other chips render', () => {
    const { queryByTestId, getByTestId } = render(
      <SubjectCardView
        subjectId="sub-1"
        display={makeDisplay({
          host: 'amazon.de',
          language: 'DE',
          location: null,
          priceTier: null,
        })}
      />,
    );
    expect(getByTestId('subject-card-host-sub-1')).toBeTruthy();
    expect(getByTestId('subject-card-language-sub-1')).toBeTruthy();
    expect(queryByTestId('subject-card-price-sub-1')).toBeNull();
  });

  it('renders all four chips side-by-side when host + language + location + price present', () => {
    const { getByTestId, getByText } = render(
      <SubjectCardView
        subjectId="sub-1"
        display={makeDisplay({
          host: 'sfmoma.org',
          language: 'EN',
          location: '37.79°N, 122.40°W',
          priceTier: '$$',
        })}
      />,
    );
    expect(getByTestId('subject-card-host-sub-1')).toBeTruthy();
    expect(getByTestId('subject-card-language-sub-1')).toBeTruthy();
    expect(getByTestId('subject-card-location-sub-1')).toBeTruthy();
    expect(getByTestId('subject-card-price-sub-1')).toBeTruthy();
    expect(getByText('sfmoma.org')).toBeTruthy();
    expect(getByText('EN')).toBeTruthy();
    expect(getByText('37.79°N, 122.40°W')).toBeTruthy();
    expect(getByText('$$')).toBeTruthy();
  });

  // TN-V2-RANK-011 — recency chip on view
  it('renders the recency chip when display.recency is set', () => {
    const { getByTestId, getByText } = render(
      <SubjectCardView
        subjectId="sub-1"
        display={makeDisplay({ recency: '3 years old' })}
      />,
    );
    expect(getByTestId('subject-card-context-sub-1')).toBeTruthy();
    expect(getByTestId('subject-card-recency-sub-1')).toBeTruthy();
    expect(getByText('3 years old')).toBeTruthy();
  });

  it('hides the recency chip when display.recency is null even with other chips', () => {
    const { queryByTestId, getByTestId } = render(
      <SubjectCardView
        subjectId="sub-1"
        display={makeDisplay({ host: 'amazon.de', recency: null })}
      />,
    );
    expect(getByTestId('subject-card-host-sub-1')).toBeTruthy();
    expect(queryByTestId('subject-card-recency-sub-1')).toBeNull();
  });

  // TN-V2-RANK-012 — region pill on view
  it('renders the region pill when display.regionPill is set', () => {
    const { getByTestId, getByText } = render(
      <SubjectCardView
        subjectId="sub-1"
        display={makeDisplay({ regionPill: '📍 UK only' })}
      />,
    );
    expect(getByTestId('subject-card-context-sub-1')).toBeTruthy();
    expect(getByTestId('subject-card-region-sub-1')).toBeTruthy();
    expect(getByText('📍 UK only')).toBeTruthy();
  });

  it('hides the region pill when display.regionPill is null even with other chips', () => {
    const { queryByTestId, getByTestId } = render(
      <SubjectCardView
        subjectId="sub-1"
        display={makeDisplay({ language: 'EN', regionPill: null })}
      />,
    );
    expect(getByTestId('subject-card-language-sub-1')).toBeTruthy();
    expect(queryByTestId('subject-card-region-sub-1')).toBeNull();
  });

  // TN-V2-RANK-011 + RANK-012 — chip-row order: warnings (region,
  // recency) before descriptors (host, language, location, price).
  // Pinned via the children ordering of the chip-row container so a
  // future "alphabetise the chip order" change fails loudly here.
  it('renders all six chips when all signals present (warnings before descriptors)', () => {
    const { getByTestId } = render(
      <SubjectCardView
        subjectId="sub-1"
        display={makeDisplay({
          regionPill: '📍 UK only',
          recency: '3 years old',
          host: 'amazon.de',
          language: 'DE',
          location: '37.79°N, 122.40°W',
          priceTier: '$$',
        })}
      />,
    );
    const row = getByTestId('subject-card-context-sub-1');
    const childTestIds = (row.children as readonly { props: { testID?: string } }[])
      .map((c) => c.props?.testID)
      .filter((id): id is string => typeof id === 'string');
    expect(childTestIds).toEqual([
      'subject-card-region-sub-1',
      'subject-card-recency-sub-1',
      'subject-card-host-sub-1',
      'subject-card-language-sub-1',
      'subject-card-location-sub-1',
      'subject-card-price-sub-1',
    ]);
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

  it('shows a maturity-fallback badge instead of the score band when the subject is unrated', () => {
    // Search results today don't carry subject scores. Rather than
    // showing a card with no glanceable trust signal at all, the
    // fallback renders a maturity tier (NEW / SOME / ESTABLISHED)
    // derived from the review count. The score band stays hidden.
    const { queryByTestId, getByTestId, getByText } = render(
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
          reviewCount: 3,
        })}
      />,
    );
    expect(queryByTestId('subject-card-band-sub-1')).toBeNull();
    expect(getByTestId('subject-card-maturity-sub-1')).toBeTruthy();
    expect(getByText('SOME')).toBeTruthy();
  });

  it('maturity fallback labels: 0/1 → NEW, 2-5 → SOME, 6+ → ESTABLISHED', () => {
    const make = (reviewCount: number) =>
      render(
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
            reviewCount,
          })}
        />,
      );
    expect(make(0).getByText('NEW')).toBeTruthy();
    expect(make(1).getByText('NEW')).toBeTruthy();
    expect(make(2).getByText('SOME')).toBeTruthy();
    expect(make(5).getByText('SOME')).toBeTruthy();
    expect(make(6).getByText('ESTABLISHED')).toBeTruthy();
    expect(make(50).getByText('ESTABLISHED')).toBeTruthy();
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

  // TN-V2-P1: VoiceOver users must hear the same actionability signal
  // (where it's sold + what language) that sighted users see in the
  // chip row. Otherwise screen-reader users tap a result thinking it's
  // locally available and discover otherwise on the detail page.
  it('includes host between subtitle and trust band when present', () => {
    const label = buildA11yLabel(makeDisplay({ host: 'jumia.ug' }));
    expect(label).toBe(
      'Aeron chair, Office furniture, jumia.ug, trust HIGH, 14 reviews, 2 friends',
    );
  });

  it('includes language between subtitle and trust band when present', () => {
    const label = buildA11yLabel(makeDisplay({ language: 'EN' }));
    expect(label).toBe(
      'Aeron chair, Office furniture, EN, trust HIGH, 14 reviews, 2 friends',
    );
  });

  it('includes host then language when both present', () => {
    const label = buildA11yLabel(makeDisplay({ host: 'amazon.de', language: 'DE' }));
    expect(label).toBe(
      'Aeron chair, Office furniture, amazon.de, DE, trust HIGH, 14 reviews, 2 friends',
    );
  });

  it('omits both host and language when null (default state)', () => {
    const label = buildA11yLabel(makeDisplay());
    expect(label).not.toContain('jumia');
    expect(label).not.toContain(', EN,');
    expect(label).toBe('Aeron chair, Office furniture, trust HIGH, 14 reviews, 2 friends');
  });

  // TN-V2-P1-003: VoiceOver users hear the location chip too,
  // matching the chip-row visual order (host → language → location).
  it('includes location after host + language when present', () => {
    const label = buildA11yLabel(
      makeDisplay({ host: 'sfmoma.org', language: 'EN', location: '37.79°N, 122.40°W' }),
    );
    expect(label).toBe(
      'Aeron chair, Office furniture, sfmoma.org, EN, 37.79°N, 122.40°W, trust HIGH, 14 reviews, 2 friends',
    );
  });

  it('includes location alone for a typical place subject', () => {
    const label = buildA11yLabel(makeDisplay({ location: '37.77°N, 122.42°W' }));
    expect(label).toBe(
      'Aeron chair, Office furniture, 37.77°N, 122.42°W, trust HIGH, 14 reviews, 2 friends',
    );
  });

  // TN-V2-RANK-013 — price tier in a11y. Sighted users see the chip;
  // VoiceOver users hear it in the same chip-row order (host →
  // language → location → price). The bare tier symbol "$$" reads as
  // "dollar dollar", which is correct — VoiceOver speaks symbols
  // verbatim and that matches what sighted users see.
  it('includes price tier after location when present', () => {
    const label = buildA11yLabel(makeDisplay({ priceTier: '$$' }));
    expect(label).toBe(
      'Aeron chair, Office furniture, $$, trust HIGH, 14 reviews, 2 friends',
    );
  });

  it('includes price tier last in the chip-row order when all four chips set', () => {
    const label = buildA11yLabel(
      makeDisplay({
        host: 'sfmoma.org',
        language: 'EN',
        location: '37.79°N, 122.40°W',
        priceTier: '$$$',
      }),
    );
    expect(label).toBe(
      'Aeron chair, Office furniture, sfmoma.org, EN, 37.79°N, 122.40°W, $$$, trust HIGH, 14 reviews, 2 friends',
    );
  });

  it('omits price tier when null (default state)', () => {
    const label = buildA11yLabel(makeDisplay());
    expect(label).not.toContain('$');
  });

  // TN-V2-RANK-011 — recency in a11y. Sighted users see the chip;
  // VoiceOver users hear it before the descriptors so they get the
  // "this might be stale" cue early in the read.
  it('includes recency before host/language/location/price when present', () => {
    const label = buildA11yLabel(
      makeDisplay({
        recency: '3 years old',
        host: 'amazon.de',
      }),
    );
    expect(label).toBe(
      'Aeron chair, Office furniture, 3 years old, amazon.de, trust HIGH, 14 reviews, 2 friends',
    );
  });

  it('omits recency when null (default state)', () => {
    const label = buildA11yLabel(makeDisplay());
    expect(label).not.toContain('old');
  });

  // TN-V2-RANK-012 — region pill in a11y. Comes FIRST among the
  // chip-row entries since it's the strongest exclusion signal —
  // VoiceOver users decide to stop listening early if the subject
  // isn't sold in their region.
  it('includes region pill first in chip-row order when present', () => {
    const label = buildA11yLabel(
      makeDisplay({ regionPill: '📍 UK only', host: 'amazon.de' }),
    );
    expect(label).toBe(
      'Aeron chair, Office furniture, 📍 UK only, amazon.de, trust HIGH, 14 reviews, 2 friends',
    );
  });

  it('renders all six chips in the expected a11y order (warnings then descriptors)', () => {
    const label = buildA11yLabel(
      makeDisplay({
        regionPill: '📍 UK only',
        recency: '3 years old',
        host: 'amazon.de',
        language: 'DE',
        location: '52.52°N, 13.41°E',
        priceTier: '$$',
      }),
    );
    expect(label).toBe(
      'Aeron chair, Office furniture, 📍 UK only, 3 years old, amazon.de, DE, 52.52°N, 13.41°E, $$, trust HIGH, 14 reviews, 2 friends',
    );
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
