/**
 * Tests for the first-party missing-capability card. This card is shown when
 * service discovery returns zero live providers for a requested capability.
 */

import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { Linking } from 'react-native';

import {
  InlineMissingCapabilityCard,
  DINA_SERVICES_GUIDE_URL,
} from '../../src/components/InlineMissingCapabilityCard';
import { addLifecycleMessage, getThread, resetThreads, type ChatMessage } from '@dina/brain/chat';

const THREAD = 'test-thread';

function lastMessage(): ChatMessage {
  const thread = getThread(THREAD);
  return thread[thread.length - 1]!;
}

describe('InlineMissingCapabilityCard', () => {
  beforeEach(() => {
    resetThreads();
    jest.restoreAllMocks();
  });

  it('renders the missing capability and developer actions', () => {
    addLifecycleMessage(THREAD, 'No provider', {
      kind: 'missing_capability',
      status: 'ready',
      noticeId: 'missing-1',
      capability: 'com.acme.widget_price',
    });

    render(<InlineMissingCapabilityCard message={lastMessage()} />);

    expect(screen.getByText('SERVICE GAP')).toBeTruthy();
    expect(screen.getByText('Provider not found')).toBeTruthy();
    expect(screen.getByText('com.acme.widget_price')).toBeTruthy();
    expect(screen.getByText('Read the provider guide')).toBeTruthy();
    expect(screen.getByText('Open Provider Guide')).toBeTruthy();
  });

  it('opens the Dina Services provider guide', () => {
    const openSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    addLifecycleMessage(THREAD, 'No provider', {
      kind: 'missing_capability',
      status: 'ready',
      noticeId: 'missing-2',
      capability: 'com.acme.widget_price',
    });

    render(<InlineMissingCapabilityCard message={lastMessage()} />);
    fireEvent.press(screen.getByTestId('missing-capability-provider-guide'));

    expect(openSpy).toHaveBeenCalledWith(DINA_SERVICES_GUIDE_URL);
  });
});
