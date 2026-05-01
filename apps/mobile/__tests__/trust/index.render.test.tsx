/**
 * Render tests for the trust feed landing screen (TN-MOB-011).
 *
 * Pins: search bar wiring, facet bar composition, three body states
 * (loading / empty / feed), the contextual "Search '<q>'" CTA in the
 * empty state, and the deep-link wiring for card taps.
 */

import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import TrustFeedScreen from '../../app/trust/index';
import type { FeedItem } from '../../app/trust/index';

import type { FacetBar } from '../../src/trust/facets';
import type { SubjectCardDisplay } from '../../src/trust/subject_card';

function makeDisplay(title: string): SubjectCardDisplay {
  return {
    title,
    subtitle: null,
    score: {
      score: 60,
      label: '60',
      bandName: 'Moderate',
      band: 'moderate',
      colorToken: 'moderate',
    },
    showNumericScore: true,
    reviewCount: 4,
    friendsPill: null,
    topReviewer: null,
  };
}

function makeFeed(n: number): FeedItem[] {
  return Array.from({ length: n }, (_, i) => ({
    subjectId: `sub-${i}`,
    display: makeDisplay(`Subject ${i}`),
  }));
}

const EMPTY_FACETS: FacetBar = { primary: [], overflow: [] };
const SOME_FACETS: FacetBar = {
  primary: [{ value: 'Furniture', count: 5 }],
  overflow: [],
};

describe('TrustFeedScreen — render states', () => {
  it('renders the search input always (even when feed empty)', () => {
    const { getByTestId } = render(
      <TrustFeedScreen feed={[]} facets={EMPTY_FACETS} />,
    );
    expect(getByTestId('trust-search-input')).toBeTruthy();
  });

  it('renders loading state when isLoading + no feed', () => {
    const { getByTestId, queryByTestId } = render(
      <TrustFeedScreen feed={[]} facets={EMPTY_FACETS} isLoading />,
    );
    expect(getByTestId('trust-feed-loading')).toBeTruthy();
    expect(queryByTestId('trust-feed-empty')).toBeNull();
    expect(queryByTestId('trust-feed-list')).toBeNull();
  });

  it('renders empty state with friendly copy when feed is empty', () => {
    const { getByTestId, getByText } = render(
      <TrustFeedScreen feed={[]} facets={EMPTY_FACETS} />,
    );
    expect(getByTestId('trust-feed-empty')).toBeTruthy();
    expect(getByText(/Your network is quiet/)).toBeTruthy();
  });

  it('renders contextual "Search <q>" CTA in empty state when q is non-empty', () => {
    const { getByTestId, getByText } = render(
      <TrustFeedScreen
        feed={[]}
        facets={EMPTY_FACETS}
        q="aeron"
        onSubmitSearch={() => undefined}
      />,
    );
    expect(getByTestId('trust-feed-search-cta')).toBeTruthy();
    expect(getByText(/Search “aeron”/)).toBeTruthy();
  });

  it('does NOT render Search CTA when q is whitespace', () => {
    const { queryByTestId } = render(
      <TrustFeedScreen
        feed={[]}
        facets={EMPTY_FACETS}
        q="   "
        onSubmitSearch={() => undefined}
      />,
    );
    expect(queryByTestId('trust-feed-search-cta')).toBeNull();
  });

  it('renders Search CTA when onSubmitSearch is omitted (router fallback)', () => {
    // The screen now provides a router-based navigation fallback when
    // no `onSubmitSearch` callback is supplied — production users get
    // a working "Search <q>" button on the empty state without a runner
    // having to wire it. Tests that need the CTA hidden can pass
    // `onSubmitSearch={undefined}` explicitly via a sentinel — but
    // omission no longer hides the CTA.
    const { getByTestId } = render(
      <TrustFeedScreen feed={[]} facets={EMPTY_FACETS} q="aeron" />,
    );
    expect(getByTestId('trust-feed-search-cta')).toBeTruthy();
  });

  it('renders feed cards when feed is non-empty', () => {
    const { getByTestId, getAllByTestId } = render(
      <TrustFeedScreen feed={makeFeed(3)} facets={SOME_FACETS} />,
    );
    expect(getByTestId('trust-feed-list')).toBeTruthy();
    expect(getAllByTestId(/^subject-card-sub-\d+$/)).toHaveLength(3);
  });

  it('renders facet bar when facets non-empty', () => {
    const { getByTestId } = render(
      <TrustFeedScreen feed={makeFeed(2)} facets={SOME_FACETS} />,
    );
    expect(getByTestId('facet-bar')).toBeTruthy();
  });

  it('omits facet bar when facets empty', () => {
    const { queryByTestId } = render(
      <TrustFeedScreen feed={makeFeed(2)} facets={EMPTY_FACETS} />,
    );
    expect(queryByTestId('facet-bar')).toBeNull();
  });
});

describe('TrustFeedScreen — search input wiring', () => {
  it('shows the current q value in the input', () => {
    const { getByTestId } = render(
      <TrustFeedScreen feed={[]} facets={EMPTY_FACETS} q="aeron chair" />,
    );
    expect(getByTestId('trust-search-input').props.value).toBe('aeron chair');
  });

  it('text changes fire onQChange', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(
      <TrustFeedScreen feed={[]} facets={EMPTY_FACETS} onQChange={onChange} />,
    );
    fireEvent.changeText(getByTestId('trust-search-input'), 'aer');
    expect(onChange).toHaveBeenCalledWith('aer');
  });

  it('submit fires onSubmitSearch with the typed value', () => {
    const onSubmit = jest.fn();
    const { getByTestId } = render(
      <TrustFeedScreen
        feed={[]}
        facets={EMPTY_FACETS}
        onSubmitSearch={onSubmit}
      />,
    );
    fireEvent(getByTestId('trust-search-input'), 'submitEditing', {
      nativeEvent: { text: 'aeron' },
    });
    expect(onSubmit).toHaveBeenCalledWith('aeron');
  });

  it('Search CTA in empty state fires onSubmitSearch with trimmed q', () => {
    const onSubmit = jest.fn();
    const { getByTestId } = render(
      <TrustFeedScreen
        feed={[]}
        facets={EMPTY_FACETS}
        q="  aeron  "
        onSubmitSearch={onSubmit}
      />,
    );
    fireEvent.press(getByTestId('trust-feed-search-cta'));
    expect(onSubmit).toHaveBeenCalledWith('aeron');
  });
});

describe('TrustFeedScreen — interactions', () => {
  it('tap on a feed card fires onSelectSubject', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(
      <TrustFeedScreen
        feed={makeFeed(2)}
        facets={SOME_FACETS}
        onSelectSubject={onSelect}
      />,
    );
    fireEvent.press(getByTestId('subject-card-sub-0'));
    expect(onSelect).toHaveBeenCalledWith('sub-0');
  });

  it('tap on facet chip fires onTapFacet', () => {
    const onTap = jest.fn();
    const { getByTestId } = render(
      <TrustFeedScreen
        feed={makeFeed(1)}
        facets={SOME_FACETS}
        onTapFacet={onTap}
      />,
    );
    fireEvent.press(getByTestId('facet-chip-Furniture'));
    expect(onTap).toHaveBeenCalledWith('Furniture');
  });
});

describe('TrustFeedScreen — accessibility (TN-TEST-061 surface)', () => {
  it('search input has accessibilityLabel', () => {
    const { getByLabelText } = render(
      <TrustFeedScreen feed={[]} facets={EMPTY_FACETS} />,
    );
    expect(getByLabelText('Search the trust network')).toBeTruthy();
  });

  it('Search CTA in empty state has descriptive label', () => {
    const { getByLabelText } = render(
      <TrustFeedScreen
        feed={[]}
        facets={EMPTY_FACETS}
        q="aeron"
        onSubmitSearch={() => undefined}
      />,
    );
    expect(getByLabelText(/Search for aeron/)).toBeTruthy();
  });
});

describe('TrustFeedScreen — first-run modal (TN-MOB-022 / TN-MOB-027)', () => {
  it('does NOT render the first-run modal by default (firstRunVisible omitted)', () => {
    const { queryByTestId } = render(
      <TrustFeedScreen feed={[]} facets={EMPTY_FACETS} />,
    );
    expect(queryByTestId('first-run-modal')).toBeNull();
    expect(queryByTestId('first-run-modal-backdrop')).toBeNull();
  });

  it('does NOT render the first-run modal when firstRunVisible=false', () => {
    const { queryByTestId } = render(
      <TrustFeedScreen
        feed={[]}
        facets={EMPTY_FACETS}
        firstRunVisible={false}
      />,
    );
    expect(queryByTestId('first-run-modal')).toBeNull();
  });

  it('renders the first-run modal when firstRunVisible=true', () => {
    const { getByTestId } = render(
      <TrustFeedScreen
        feed={[]}
        facets={EMPTY_FACETS}
        firstRunVisible
      />,
    );
    expect(getByTestId('first-run-modal-backdrop')).toBeTruthy();
    expect(getByTestId('first-run-modal')).toBeTruthy();
  });

  it('first-run modal stays mounted alongside feed when both render', () => {
    const { getByTestId } = render(
      <TrustFeedScreen
        feed={makeFeed(2)}
        facets={SOME_FACETS}
        firstRunVisible
      />,
    );
    expect(getByTestId('trust-feed-list')).toBeTruthy();
    expect(getByTestId('first-run-modal')).toBeTruthy();
  });

  it('dismiss CTA fires onDismissFirstRun', () => {
    const onDismiss = jest.fn();
    const { getByTestId } = render(
      <TrustFeedScreen
        feed={[]}
        facets={EMPTY_FACETS}
        firstRunVisible
        onDismissFirstRun={onDismiss}
      />,
    );
    fireEvent.press(getByTestId('first-run-modal-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismiss tap is a no-op when onDismissFirstRun is omitted', () => {
    const { getByTestId } = render(
      <TrustFeedScreen feed={[]} facets={EMPTY_FACETS} firstRunVisible />,
    );
    expect(() =>
      fireEvent.press(getByTestId('first-run-modal-dismiss')),
    ).not.toThrow();
  });
});
