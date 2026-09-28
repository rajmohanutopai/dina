/**
 * The drafted request for quotes in chat (ASK_FOR_QUOTES_PLAN §2): it shows
 * what would be asked and opens the Ask for quotes screen with the draft;
 * nothing is sent from the card. A malformed draft renders no card.
 */

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { InlineQuoteRequestDraftCard } from '../../src/components/InlineQuoteRequestDraftCard';

import type { ChatMessage } from '@dina/brain/chat';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const DRAFT = {
  lines: [{ text: 'Floral celebration cake, 20 servings', quantity: '1', unit_code: 'each' }],
  supplier_query: 'cakes',
  limits: { target_minor: '250000', ceiling_minor: '300000' },
};

function message(lifecycle: Record<string, unknown>): ChatMessage {
  return {
    id: 'm1',
    threadId: 'main',
    type: 'dina',
    content: '',
    timestamp: 1,
    metadata: { lifecycle },
  };
}

it('shows the draft and opens the screen with it', () => {
  const screen = render(
    <InlineQuoteRequestDraftCard
      message={message({
        kind: 'quote_request_draft',
        status: 'ready',
        draftId: 'qd_1',
        draft: DRAFT,
      })}
    />,
  );
  expect(screen.getByText('1 each · Floral celebration cake, 20 servings')).toBeTruthy();
  expect(screen.getByText('Suppliers who sell: cakes')).toBeTruthy();
  expect(screen.getByText('target 2500, up to 3000')).toBeTruthy();
  fireEvent.press(screen.getByTestId('quote-draft-open-qd_1'));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/ask-quotes',
    // `from` makes the screen's back chevron return to the chat.
    params: { draft: JSON.stringify(DRAFT), from: '/' },
  });
});

it('a malformed draft is no card', () => {
  const screen = render(
    <InlineQuoteRequestDraftCard
      message={message({
        kind: 'quote_request_draft',
        status: 'ready',
        draftId: 'qd_2',
        draft: { lines: [{ text: '' }] },
      })}
    />,
  );
  expect(screen.toJSON()).toBeNull();
});
