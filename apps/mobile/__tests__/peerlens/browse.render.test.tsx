/**
 * Render tests for the Browse reviews screen (the network feed). These moved off
 * the old Network home when it became a launchpad: search-bar wiring, facet bar,
 * the three body states (loading / empty / feed), the contextual "Search '<q>'"
 * CTA, and the deep-link wiring for card taps. The feed testIDs are unchanged
 * (`trust-search-input` / `trust-feed-list` / …) — only the host screen moved.
 */

import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import BrowseScreen from '../../app/peerlens/browse';

import type { FeedItem } from '../../app/peerlens/browse';
import type { FacetBar } from '../../src/peerlens/facets';
import type { SubjectCardDisplay } from '../../src/peerlens/subject_card';

function makeDisplay(title: string): SubjectCardDisplay {
  return {
    title,
    subtitle: null,
    host: null,
    language: null,
    location: null,
    priceTier: null,
    recency: null,
    regionPill: null,
    score: { score: 60, label: '60', bandName: 'Moderate', band: 'moderate', colorToken: 'moderate' },
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
const SOME_FACETS: FacetBar = { primary: [{ value: 'Furniture', count: 5 }], overflow: [] };

describe('BrowseScreen — body states', () => {
  it('renders the search input always (even when feed empty)', () => {
    const { getByTestId } = render(<BrowseScreen feed={[]} facets={EMPTY_FACETS} />);
    expect(getByTestId('browse-screen')).toBeTruthy();
    expect(getByTestId('trust-search-input')).toBeTruthy();
  });

  it('renders loading state when isLoading + no feed', () => {
    const { getByTestId, queryByTestId } = render(
      <BrowseScreen feed={[]} facets={EMPTY_FACETS} isLoading />,
    );
    expect(getByTestId('trust-feed-loading')).toBeTruthy();
    expect(queryByTestId('trust-feed-empty')).toBeNull();
    expect(queryByTestId('trust-feed-list')).toBeNull();
  });

  it('renders empty state when feed is empty (no loading)', () => {
    const { getByTestId, queryByTestId } = render(<BrowseScreen feed={[]} facets={EMPTY_FACETS} />);
    expect(getByTestId('trust-feed-empty')).toBeTruthy();
    expect(queryByTestId('trust-feed-list')).toBeNull();
  });

  it('renders the feed list when feed has items', () => {
    const { getByTestId, queryByTestId } = render(
      <BrowseScreen feed={makeFeed(3)} facets={SOME_FACETS} />,
    );
    expect(getByTestId('trust-feed-list')).toBeTruthy();
    expect(queryByTestId('trust-feed-empty')).toBeNull();
  });
});

describe('BrowseScreen — interactions', () => {
  it('shows the "Search <q>" CTA in the empty state only when text is typed', () => {
    const onSubmitSearch = jest.fn();
    const { getByTestId } = render(
      <BrowseScreen feed={[]} facets={EMPTY_FACETS} q="chairs" onSubmitSearch={onSubmitSearch} />,
    );
    fireEvent.press(getByTestId('trust-feed-search-cta'));
    expect(onSubmitSearch).toHaveBeenCalledWith('chairs');
  });

  it('hides the search CTA when the query is blank', () => {
    const { queryByTestId } = render(
      <BrowseScreen feed={[]} facets={EMPTY_FACETS} q="" onSubmitSearch={jest.fn()} />,
    );
    expect(queryByTestId('trust-feed-search-cta')).toBeNull();
  });

  it('submitting the search input fires onSubmitSearch with the typed text', () => {
    const onSubmitSearch = jest.fn();
    const { getByTestId } = render(
      <BrowseScreen feed={[]} facets={EMPTY_FACETS} q="desks" onSubmitSearch={onSubmitSearch} />,
    );
    fireEvent(getByTestId('trust-search-input'), 'submitEditing', {
      nativeEvent: { text: 'desks' },
    });
    expect(onSubmitSearch).toHaveBeenCalledWith('desks');
  });

  it('tapping a feed card fires onSelectSubject with its subjectId', () => {
    const onSelectSubject = jest.fn();
    const feed = makeFeed(2);
    const { getByText } = render(
      <BrowseScreen feed={feed} facets={SOME_FACETS} onSelectSubject={onSelectSubject} />,
    );
    fireEvent.press(getByText('Subject 0'));
    expect(onSelectSubject).toHaveBeenCalledWith('sub-0');
  });
});
