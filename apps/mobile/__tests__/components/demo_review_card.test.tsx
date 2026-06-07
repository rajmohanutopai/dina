/**
 * InlineDemoReviewCard — the guided demo's PeerLens review card. The Publish
 * button is INERT (flips to a local confirmation; no real publish path).
 */

import { render, screen, fireEvent } from '@testing-library/react-native';
import React from 'react';

import { InlineDemoReviewCard } from '../../src/components/InlineDemoReviewCard';

import type { ChatMessage } from '@dina/brain/chat';


function cardMessage(metadata: Record<string, unknown>): ChatMessage {
  return {
    id: 'm1',
    threadId: 'main',
    type: 'system',
    content: 'PeerLens review · ErgoFlex Study Chair · 5/5',
    metadata,
    timestamp: 1,
  } as ChatMessage;
}

const REVIEW_META = {
  kind: 'demo_review',
  product: 'ErgoFlex Study Chair',
  rating: 5,
  text: 'Solid lower-back support, worth it.',
};

describe('InlineDemoReviewCard', () => {
  it('renders nothing for a non-review message', () => {
    render(<InlineDemoReviewCard message={cardMessage({ kind: 'demo_approval' })} />);
    expect(screen.queryByTestId('demo-review-card')).toBeNull();
  });

  it('renders the product, stars, text, and an inert Publish button', () => {
    render(<InlineDemoReviewCard message={cardMessage(REVIEW_META)} />);
    expect(screen.getByText('ErgoFlex Study Chair')).toBeTruthy();
    expect(screen.getByText('★★★★★')).toBeTruthy();
    expect(screen.getByText('"Solid lower-back support, worth it."')).toBeTruthy();
    expect(screen.getByTestId('demo-review-publish')).toBeTruthy();
  });

  it('Publish flips to a local confirmation and does not re-show the button', () => {
    render(<InlineDemoReviewCard message={cardMessage(REVIEW_META)} />);
    fireEvent.press(screen.getByTestId('demo-review-publish'));
    expect(screen.getByTestId('demo-review-published')).toBeTruthy();
    expect(screen.queryByTestId('demo-review-publish')).toBeNull();
  });

  it('renders a partial star line for a lower rating', () => {
    render(<InlineDemoReviewCard message={cardMessage({ ...REVIEW_META, rating: 3 })} />);
    expect(screen.getByText('★★★☆☆')).toBeTruthy();
  });
});
