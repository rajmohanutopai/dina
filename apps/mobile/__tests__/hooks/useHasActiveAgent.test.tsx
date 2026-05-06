/**
 * `useHasActiveAgent` — bottom-bar Approvals tab + chat /task chip
 * gate. Drives off the in-process device registry's subscribe API.
 *
 * Test strategy: a tiny probe component that calls the hook and
 * renders its boolean as text. We mutate the registry through its
 * public API and assert the hook re-renders to the new value. No
 * polling, no fake timers — the contract is "subscribe fires →
 * snapshot re-reads → component sees the new value".
 */

import { act, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import {
  registerDevice,
  resetDeviceRegistry,
  revokeDevice,
} from '../../../../packages/core/src/devices/registry';
import { useHasActiveAgent } from '../../src/hooks/useHasActiveAgent';

function Probe(): React.ReactElement {
  const present = useHasActiveAgent();
  return <Text testID="probe">{present ? 'yes' : 'no'}</Text>;
}

describe('useHasActiveAgent', () => {
  beforeEach(() => resetDeviceRegistry());

  it('returns false on initial mount with no devices', () => {
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').props.children).toBe('no');
  });

  it('flips to true when an agent is paired after mount', () => {
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').props.children).toBe('no');
    act(() => {
      registerDevice('OpenClaw', 'z6MkAgentKey1', 'agent');
    });
    expect(getByTestId('probe').props.children).toBe('yes');
  });

  it('flips to false when the only active agent is revoked', () => {
    const d = registerDevice('OpenClaw', 'z6MkAgentKey2', 'agent');
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').props.children).toBe('yes');
    act(() => {
      revokeDevice(d.deviceId);
    });
    expect(getByTestId('probe').props.children).toBe('no');
  });

  it('ignores non-agent roles — a paired phone is not a delegation claimer', () => {
    registerDevice('iPhone 15', 'z6MkRichKey', 'rich');
    registerDevice('Old laptop', 'z6MkCliKey', 'cli');
    registerDevice('Watch', 'z6MkThinKey', 'thin');
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').props.children).toBe('no');
  });

  it('stays true when one agent revokes but another is still active', () => {
    const d1 = registerDevice('OpenClaw 1', 'z6MkAgentKey3', 'agent');
    registerDevice('OpenClaw 2', 'z6MkAgentKey4', 'agent');
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').props.children).toBe('yes');
    act(() => {
      revokeDevice(d1.deviceId);
    });
    expect(getByTestId('probe').props.children).toBe('yes');
  });

  it('unsubscribes on unmount — no leak across remounts', () => {
    const { unmount } = render(<Probe />);
    unmount();
    // No assertion needed beyond "doesn't throw" — the previous probe
    // is gone, so a registry mutation shouldn't try to setState on
    // an unmounted component. If unsubscribe didn't fire, jest would
    // print the "can't perform a React state update" warning.
    registerDevice('OpenClaw', 'z6MkAgentKey5', 'agent');
  });
});
