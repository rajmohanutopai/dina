/**
 * Tests for InlineComparisonCard — the chat-thread renderer for a
 * `commerce_comparison` lifecycle message: the money-free where-to-buy card from
 * the product-research loop (RESEARCHER_KERNEL_ARCHITECTURE.md §5.A4/A5).
 *
 * The brain posts a validated CardSpec; the renderer re-validates it as
 * UNTRUSTED at the boundary and draws it with SafeCardRenderer, so a where-to-buy
 * link rides the generic https-only `link` block and a stray trust badge is
 * stripped.
 */

import { render, screen } from '@testing-library/react-native';
import React from 'react';

import { addLifecycleMessage, resetThreads, getThread, type ChatMessage } from '@dina/brain/chat';

import { InlineComparisonCard } from '../../src/components/InlineComparisonCard';

const THREAD = 'test-thread';

function lastMessage(): ChatMessage {
  const thread = getThread(THREAD);
  const last = thread[thread.length - 1];
  if (last === undefined) throw new Error('thread is empty');
  return last;
}

function post(cardSpec: unknown): void {
  addLifecycleMessage(THREAD, '', {
    kind: 'commerce_comparison',
    status: 'ready',
    cardId: 'card-1',
    cardSpec: cardSpec as Record<string, unknown>,
  });
}

describe('InlineComparisonCard', () => {
  beforeEach(() => {
    resetThreads();
  });

  it('renders the where-to-buy card (title + recommendation)', () => {
    post({
      version: 1,
      blocks: [
        { kind: 'title', text: 'Where to buy' },
        { kind: 'keyValue', label: 'Recommended', value: 'Acme Timber' },
      ],
    });

    render(<InlineComparisonCard message={lastMessage()} />);

    expect(screen.getByTestId('chat-card-commerce-response')).toBeTruthy();
    expect(screen.getByText('Where to buy')).toBeTruthy();
    expect(screen.getByText('Acme Timber')).toBeTruthy();
  });

  it('renders a tappable where-to-buy link for an https source', () => {
    post({
      version: 1,
      blocks: [
        { kind: 'title', text: 'Where to buy' },
        { kind: 'link', label: 'Acme Timber', url: 'https://shop.example.com/x', action: 'open_url' },
      ],
    });

    render(<InlineComparisonCard message={lastMessage()} />);

    expect(screen.getByTestId('safe-card-renderer-link')).toBeTruthy();
    expect(screen.getByText('Acme Timber')).toBeTruthy();
  });

  it('renders nothing when the persisted card is corrupt (boundary re-validation)', () => {
    post({ version: 99, blocks: 'not-an-array' });

    const { toJSON } = render(<InlineComparisonCard message={lastMessage()} />);

    expect(toJSON()).toBeNull();
  });

  it('strips a stray provider trust badge at the render boundary', () => {
    post({
      version: 1,
      blocks: [
        { kind: 'title', text: 'Where to buy' },
        { kind: 'badge', text: 'VERIFIED SELLER', tone: 'positive' },
      ],
    });

    render(<InlineComparisonCard message={lastMessage()} />);

    expect(screen.getByText('Where to buy')).toBeTruthy();
    expect(screen.queryByText('VERIFIED SELLER')).toBeFalsy();
  });
});
