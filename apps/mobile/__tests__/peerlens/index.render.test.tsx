/**
 * Render tests for the Network home — now a launchpad menu (the feed + search
 * moved to `browse.tsx`; the publishing controls moved onto the self-profile).
 * Pins: the Services card, the Reviews → Browse row, and the Your-review-activity
 * row (with its review-count subtitle), plus each row's navigation seam.
 */

import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import TrustFeedScreen from '../../app/peerlens/index';

describe('Network home (launchpad) — structure', () => {
  it('renders the Services card with Find + Publish rows', () => {
    const { getByTestId } = render(<TrustFeedScreen reviewsWritten={2} />);
    expect(getByTestId('trust-feed-screen')).toBeTruthy();
    expect(getByTestId('network-services-card')).toBeTruthy();
    expect(getByTestId('network-services-find')).toBeTruthy();
    expect(getByTestId('network-services-publish')).toBeTruthy();
  });

  it('renders the Reviews → Browse row and the Your-review-activity row', () => {
    const { getByTestId, getByText } = render(<TrustFeedScreen reviewsWritten={2} />);
    expect(getByText('Reviews')).toBeTruthy(); // section heading
    expect(getByTestId('network-row-browse')).toBeTruthy();
    expect(getByTestId('network-row-activity')).toBeTruthy();
    expect(getByText('Browse reviews')).toBeTruthy();
    expect(getByText('Your review activity')).toBeTruthy();
  });

  it('does NOT render the old feed / search / footer on the home', () => {
    const { queryByTestId } = render(<TrustFeedScreen reviewsWritten={0} />);
    expect(queryByTestId('trust-search-input')).toBeNull();
    expect(queryByTestId('trust-feed-list')).toBeNull();
    expect(queryByTestId('trust-feed-footer')).toBeNull();
    expect(queryByTestId('trust-feed-self-card')).toBeNull();
  });
});

describe('Network home — review-count subtitle', () => {
  it('pluralises the count: N reviews written', () => {
    const { getByText } = render(<TrustFeedScreen reviewsWritten={3} />);
    expect(getByText('3 reviews written')).toBeTruthy();
  });

  it('singular at 1: "1 review written"', () => {
    const { getByText } = render(<TrustFeedScreen reviewsWritten={1} />);
    expect(getByText('1 review written')).toBeTruthy();
  });

  it('0 reviews → a non-count prompt, not "0 reviews written"', () => {
    const { getByText, queryByText } = render(<TrustFeedScreen reviewsWritten={0} />);
    expect(queryByText('0 reviews written')).toBeNull();
    expect(getByText("Reviews you’ve written")).toBeTruthy();
  });
});

describe('Network home — first-run overlay', () => {
  it('renders the overlay ALONGSIDE the menu (sibling of the scroll view), not instead of it', () => {
    const { getByTestId } = render(<TrustFeedScreen reviewsWritten={2} firstRunVisible />);
    // The absolute backdrop is a sibling of the ScrollView so it covers the
    // viewport — and the menu rows still mount underneath it.
    expect(getByTestId('first-run-modal-backdrop')).toBeTruthy();
    expect(getByTestId('network-row-browse')).toBeTruthy();
    expect(getByTestId('trust-feed-screen')).toBeTruthy();
  });

  it('omits the overlay when firstRunVisible is false', () => {
    const { queryByTestId } = render(<TrustFeedScreen reviewsWritten={2} />);
    expect(queryByTestId('first-run-modal-backdrop')).toBeNull();
  });
});

describe('Network home — navigation seams', () => {
  it('Browse row fires onBrowseReviews', () => {
    const onBrowseReviews = jest.fn();
    const { getByTestId } = render(
      <TrustFeedScreen reviewsWritten={2} onBrowseReviews={onBrowseReviews} />,
    );
    fireEvent.press(getByTestId('network-row-browse'));
    expect(onBrowseReviews).toHaveBeenCalledTimes(1);
  });

  it('Activity row fires onOpenActivity', () => {
    const onOpenActivity = jest.fn();
    const { getByTestId } = render(
      <TrustFeedScreen reviewsWritten={2} onOpenActivity={onOpenActivity} />,
    );
    fireEvent.press(getByTestId('network-row-activity'));
    expect(onOpenActivity).toHaveBeenCalledTimes(1);
  });

  it('Find / Publish service rows fire their handlers', () => {
    const onFindService = jest.fn();
    const onPublishOrManage = jest.fn();
    const { getByTestId } = render(
      <TrustFeedScreen
        reviewsWritten={2}
        onFindService={onFindService}
        onPublishOrManage={onPublishOrManage}
      />,
    );
    fireEvent.press(getByTestId('network-services-find'));
    fireEvent.press(getByTestId('network-services-publish'));
    expect(onFindService).toHaveBeenCalledTimes(1);
    expect(onPublishOrManage).toHaveBeenCalledTimes(1);
  });
});
