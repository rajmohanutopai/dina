/**
 * MessageActionMenu — the deep-press chat-bubble action menu.
 *
 * Pins: closed when there's no anchor, renders one row per action with the
 * right testIDs, fires onPress for an action, and dismisses on a backdrop tap.
 */

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { MessageActionMenu, type MessageAction } from '../../src/components/MessageActionMenu';

const copyAction = (onPress: () => void): MessageAction => ({
  key: 'copy',
  label: 'Copy',
  icon: 'copy-outline',
  onPress,
});

describe('MessageActionMenu', () => {
  it('renders nothing when there is no anchor', () => {
    const { queryByTestId } = render(
      <MessageActionMenu anchor={null} actions={[copyAction(() => undefined)]} onDismiss={() => undefined} />,
    );
    expect(queryByTestId('message-action-menu')).toBeNull();
  });

  it('renders nothing when there are no actions (even with an anchor)', () => {
    const { queryByTestId } = render(
      <MessageActionMenu anchor={{ x: 100, y: 300 }} actions={[]} onDismiss={() => undefined} />,
    );
    expect(queryByTestId('message-action-menu')).toBeNull();
  });

  it('renders a row per action and fires onPress', () => {
    const onCopy = jest.fn();
    const { getByTestId } = render(
      <MessageActionMenu
        anchor={{ x: 100, y: 300 }}
        actions={[copyAction(onCopy)]}
        onDismiss={() => undefined}
      />,
    );
    expect(getByTestId('message-action-menu')).toBeTruthy();
    fireEvent.press(getByTestId('message-action-copy'));
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it('dismisses on a backdrop tap', () => {
    const onDismiss = jest.fn();
    const { getByTestId } = render(
      <MessageActionMenu
        anchor={{ x: 100, y: 300 }}
        actions={[copyAction(() => undefined)]}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.press(getByTestId('message-action-backdrop'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
