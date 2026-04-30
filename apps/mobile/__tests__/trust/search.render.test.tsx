/**
 * Render tests for the search results screen (TN-MOB-016).
 *
 * Pins the screen-state machine + composition over the
 * `SubjectCardView` and `FacetBarView` components (each tested
 * independently in their own files).
 *
 * States:
 *   1. **Error** (`error !== null`) — error panel + Retry CTA.
 *   2. **Loading + empty results** — loading state; facet bar absent
 *      because facets are empty when results are empty.
 *   3. **Empty** (no results, not loading) — empty copy contextualises
 *      the user's query.
 *   4. **Results** — facet bar + result cards.
 *   5. **Pagination loading** — results visible + bottom spinner when
 *      `isLoading=true` AND `results.length > 0`.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import SearchScreen, { type SearchResult } from '../../app/trust/search';
import type { SubjectCardDisplay } from '../../src/trust/subject_card';
import type { FacetBar } from '../../src/trust/facets';

function makeDisplay(title: string): SubjectCardDisplay {
  return {
    title,
    subtitle: 'Office furniture',
    score: { score: 80, label: '80', bandName: 'High', band: 'high', colorToken: 'high' },
    showNumericScore: true,
    reviewCount: 5,
    friendsPill: { friendsCount: 1, strangersCount: 4 },
    topReviewer: null,
  };
}

function makeResults(n: number): SearchResult[] {
  return Array.from({ length: n }, (_, i) => ({
    subjectId: `sub-${i}`,
    display: makeDisplay(`Subject ${i}`),
  }));
}

const EMPTY_FACETS: FacetBar = { primary: [], overflow: [] };
const SOME_FACETS: FacetBar = {
  primary: [{ value: 'Furniture', count: 3 }],
  overflow: [],
};

describe('SearchScreen — render states', () => {
  it('renders error panel when error is set', () => {
    const { getByTestId, getByText } = render(
      <SearchScreen
        results={[]}
        facets={EMPTY_FACETS}
        error="Network unreachable"
        onRetry={() => undefined}
      />,
    );
    expect(getByTestId('search-error')).toBeTruthy();
    expect(getByText('Network unreachable')).toBeTruthy();
    expect(getByTestId('search-retry')).toBeTruthy();
  });

  it('hides Retry CTA when onRetry is omitted', () => {
    const { queryByTestId } = render(
      <SearchScreen results={[]} facets={EMPTY_FACETS} error="boom" />,
    );
    expect(queryByTestId('search-retry')).toBeNull();
  });

  it('renders loading state when isLoading + no results', () => {
    const { getByTestId, queryByTestId } = render(
      <SearchScreen results={[]} facets={EMPTY_FACETS} isLoading />,
    );
    expect(getByTestId('search-loading')).toBeTruthy();
    expect(queryByTestId('search-empty')).toBeNull();
    expect(queryByTestId('search-results')).toBeNull();
  });

  it('renders generic empty state when no results + no q', () => {
    const { getByTestId, getByText } = render(
      <SearchScreen results={[]} facets={EMPTY_FACETS} />,
    );
    expect(getByTestId('search-empty')).toBeTruthy();
    expect(getByText(/Try a search above/)).toBeTruthy();
  });

  it('renders contextualised empty state when no results + q provided', () => {
    const { getByText } = render(
      <SearchScreen results={[]} facets={EMPTY_FACETS} q="aeron" />,
    );
    expect(getByText(/Nothing found for “aeron”/)).toBeTruthy();
  });

  it('renders facet bar + result cards when results present', () => {
    const { getByTestId, getAllByTestId } = render(
      <SearchScreen results={makeResults(3)} facets={SOME_FACETS} />,
    );
    expect(getByTestId('facet-bar')).toBeTruthy();
    expect(getByTestId('search-results')).toBeTruthy();
    expect(getAllByTestId(/^subject-card-sub-\d+$/)).toHaveLength(3);
  });

  it('renders pagination spinner when isLoading + results present', () => {
    const { getByTestId } = render(
      <SearchScreen results={makeResults(3)} facets={SOME_FACETS} isLoading />,
    );
    expect(getByTestId('search-pagination-loading')).toBeTruthy();
    // Result cards still rendered.
    expect(getByTestId('search-results')).toBeTruthy();
  });

  it('does NOT render facet bar when facets empty AND no results', () => {
    const { queryByTestId } = render(
      <SearchScreen results={[]} facets={EMPTY_FACETS} />,
    );
    expect(queryByTestId('facet-bar')).toBeNull();
  });
});

describe('SearchScreen — interactions', () => {
  it('tap on a result card fires onSelectSubject', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(
      <SearchScreen
        results={makeResults(2)}
        facets={SOME_FACETS}
        onSelectSubject={onSelect}
      />,
    );
    fireEvent.press(getByTestId('subject-card-sub-1'));
    expect(onSelect).toHaveBeenCalledWith('sub-1');
  });

  it('tap on facet chip fires onTapFacet with value', () => {
    const onTap = jest.fn();
    const { getByTestId } = render(
      <SearchScreen
        results={makeResults(1)}
        facets={SOME_FACETS}
        onTapFacet={onTap}
      />,
    );
    fireEvent.press(getByTestId('facet-chip-Furniture'));
    expect(onTap).toHaveBeenCalledWith('Furniture');
  });

  it('tap on Retry fires onRetry', () => {
    const onRetry = jest.fn();
    const { getByTestId } = render(
      <SearchScreen
        results={[]}
        facets={EMPTY_FACETS}
        error="boom"
        onRetry={onRetry}
      />,
    );
    fireEvent.press(getByTestId('search-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
