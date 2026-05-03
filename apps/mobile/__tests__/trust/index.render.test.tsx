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
    host: null,
    language: null,
    location: null,
    priceTier: null,
    recency: null,
    regionPill: null,
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

  it('does NOT render an unconditional Write CTA in the empty state', () => {
    // Regression guard: a prior shape of the empty state shipped a
    // "Write a review" button that jumped straight to
    // `/trust/write?createKind=product` without searching first. That
    // let users mint duplicate subjects for things already in the
    // network — they never saw existing matches. The single entry
    // path to writing is now: search-first (the bar above) → if
    // results, tap an existing subject and write from its detail; if
    // no results, the search empty state offers "Review '<q>'" with
    // the typed term pre-filled. Pinning the absence here so the CTA
    // can't reappear silently.
    const { queryByTestId } = render(
      <TrustFeedScreen feed={[]} facets={EMPTY_FACETS} q="" />,
    );
    expect(queryByTestId('trust-feed-write-cta')).toBeNull();
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

describe('TrustFeedScreen — search clear button', () => {
  it('clear button is hidden when q is empty', () => {
    const { queryByTestId } = render(
      <TrustFeedScreen feed={[]} facets={EMPTY_FACETS} q="" />,
    );
    expect(queryByTestId('trust-search-clear')).toBeNull();
  });

  it('clear button renders when q has content', () => {
    const { getByTestId } = render(
      <TrustFeedScreen feed={[]} facets={EMPTY_FACETS} q="aeron" />,
    );
    expect(getByTestId('trust-search-clear')).toBeTruthy();
  });

  it('tapping clear fires onQChange("")', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(
      <TrustFeedScreen
        feed={[]}
        facets={EMPTY_FACETS}
        q="aeron chair"
        onQChange={onChange}
      />,
    );
    fireEvent.press(getByTestId('trust-search-clear'));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('uncontrolled: tapping clear empties the local search state', () => {
    // No q/onQChange supplied → screen owns local state. Type something,
    // verify clear button appears, tap it, verify the input clears.
    const { getByTestId, queryByTestId } = render(
      <TrustFeedScreen feed={[]} facets={EMPTY_FACETS} />,
    );
    fireEvent.changeText(getByTestId('trust-search-input'), 'aeron');
    expect(getByTestId('trust-search-input').props.value).toBe('aeron');
    expect(getByTestId('trust-search-clear')).toBeTruthy();
    fireEvent.press(getByTestId('trust-search-clear'));
    expect(getByTestId('trust-search-input').props.value).toBe('');
    expect(queryByTestId('trust-search-clear')).toBeNull();
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

describe('TrustFeedScreen — self-profile card', () => {
  it('does NOT render the self card when selfDisplay is null (pre-boot / unknown)', () => {
    const { queryByTestId } = render(
      <TrustFeedScreen feed={[]} facets={EMPTY_FACETS} selfDisplay={null} />,
    );
    expect(queryByTestId('trust-feed-self-card')).toBeNull();
  });

  it('renders Reddit-style neutral counts (score, reviews, vouches, endorsements)', () => {
    // Pin the visual: each stat appears as `<value>` over `<label>`.
    // Critically there is NO band-coloured pill / "VERY LOW" copy —
    // the self-card shows neutral counts only.
    const { getByTestId, getByText } = render(
      <TrustFeedScreen
        feed={[]}
        facets={EMPTY_FACETS}
        selfDisplay={{
          handle: 'alice.pds.dinakernel.com',
          scoreDisplay: 82,
          reviewsWritten: 14,
          vouchCount: 3,
          endorsementCount: 5,
        }}
      />,
    );
    expect(getByTestId('trust-feed-self-card')).toBeTruthy();
    // Header shortens the resolved handle to the first DNS label
    // (`alice.pds.dinakernel.com` → `alice`) — same `shortHandle`
    // convention used on every other reviewer surface so the trust
    // tab doesn't read like an email-address page. Falls back to
    // "Your trust profile" when the handle is null.
    expect(getByText('alice')).toBeTruthy();
    // Each stat value renders as a plain string in its own cell.
    expect(getByTestId('trust-feed-self-stat-score')).toBeTruthy();
    expect(getByTestId('trust-feed-self-stat-reviews')).toBeTruthy();
    expect(getByTestId('trust-feed-self-stat-vouches')).toBeTruthy();
    expect(getByTestId('trust-feed-self-stat-endorsements')).toBeTruthy();
    expect(getByText('82')).toBeTruthy();
    expect(getByText('14')).toBeTruthy();
    expect(getByText('3')).toBeTruthy();
    expect(getByText('5')).toBeTruthy();
    // Plural labels at >1.
    expect(getByText('Reviews')).toBeTruthy();
    expect(getByText('Vouches')).toBeTruthy();
    expect(getByText('Endorsements')).toBeTruthy();
  });

  it('uses singular labels when count is exactly 1', () => {
    const { getByText } = render(
      <TrustFeedScreen
        feed={[]}
        facets={EMPTY_FACETS}
        selfDisplay={{
          handle: null,
          scoreDisplay: null,
          reviewsWritten: 1,
          vouchCount: 1,
          endorsementCount: 1,
        }}
      />,
    );
    expect(getByText('Review')).toBeTruthy();
    expect(getByText('Vouch')).toBeTruthy();
    expect(getByText('Endorsement')).toBeTruthy();
  });

  it('renders em-dash for trust score when scoreDisplay is null (no band shaming)', () => {
    // The pre-N=3 cold-start state must NOT label the user "VERY
    // LOW" / red. Em-dash is the agreed neutral placeholder.
    const { getByText, queryByText } = render(
      <TrustFeedScreen
        feed={[]}
        facets={EMPTY_FACETS}
        selfDisplay={{
          handle: null,
          scoreDisplay: null,
          reviewsWritten: 1,
          vouchCount: 0,
          endorsementCount: 0,
        }}
      />,
    );
    expect(getByText('—')).toBeTruthy();
    expect(queryByText('VERY LOW')).toBeNull();
    expect(queryByText('LOW')).toBeNull();
  });

  it('falls back to "Your trust profile" header when handle is null', () => {
    const { getByText } = render(
      <TrustFeedScreen
        feed={[]}
        facets={EMPTY_FACETS}
        selfDisplay={{
          handle: null,
          scoreDisplay: 42,
          reviewsWritten: 2,
          vouchCount: 0,
          endorsementCount: 0,
        }}
      />,
    );
    expect(getByText('Your trust profile')).toBeTruthy();
  });

  it('tap on the self card fires onOpenMyProfile', () => {
    const onOpen = jest.fn();
    const { getByTestId } = render(
      <TrustFeedScreen
        feed={[]}
        facets={EMPTY_FACETS}
        selfDisplay={{
          handle: null,
          scoreDisplay: 60,
          reviewsWritten: 5,
          vouchCount: 0,
          endorsementCount: 0,
        }}
        onOpenMyProfile={onOpen}
      />,
    );
    fireEvent.press(getByTestId('trust-feed-self-card'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('TrustFeedScreen — footer links (F7 fix)', () => {
  // Pre-fix: `/trust/outbox` and `/trust/namespace` had no surfacing
  // anywhere in the app — the global hamburger menu lists Vault /
  // Reminders / Settings / Help (none of which would be the right
  // home for a trust-specific affordance), and no other drill-down
  // exposed them. The Trust home now renders a small footer with
  // muted-text links so the routes are reachable without polluting
  // the global menu.
  it('renders the footer row with Outbox + Namespaces links', () => {
    const { getByTestId, getByText } = render(
      <TrustFeedScreen feed={[]} facets={EMPTY_FACETS} />,
    );
    expect(getByTestId('trust-feed-footer')).toBeTruthy();
    expect(getByTestId('trust-feed-footer-outbox')).toBeTruthy();
    expect(getByTestId('trust-feed-footer-namespaces')).toBeTruthy();
    expect(getByText('Outbox')).toBeTruthy();
    expect(getByText('Namespaces')).toBeTruthy();
  });

  it('Outbox tap fires onOpenOutbox', () => {
    const onOpenOutbox = jest.fn();
    const { getByTestId } = render(
      <TrustFeedScreen
        feed={[]}
        facets={EMPTY_FACETS}
        onOpenOutbox={onOpenOutbox}
      />,
    );
    fireEvent.press(getByTestId('trust-feed-footer-outbox'));
    expect(onOpenOutbox).toHaveBeenCalledTimes(1);
  });

  it('Namespaces tap fires onOpenNamespaces', () => {
    const onOpenNamespaces = jest.fn();
    const { getByTestId } = render(
      <TrustFeedScreen
        feed={[]}
        facets={EMPTY_FACETS}
        onOpenNamespaces={onOpenNamespaces}
      />,
    );
    fireEvent.press(getByTestId('trust-feed-footer-namespaces'));
    expect(onOpenNamespaces).toHaveBeenCalledTimes(1);
  });
});
