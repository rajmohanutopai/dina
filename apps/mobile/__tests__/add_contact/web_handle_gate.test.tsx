/**
 * Add-Contact — web thin-client gate (design §9).
 *
 * Handle→DID resolution is node logic (ATProto `.well-known/atproto-did` +
 * `com.atproto.identity.resolveHandle` + PLC lookups). On the web thin client
 * the browser must NOT run it (it would duplicate identity resolution and
 * CORS-fail on arbitrary handle domains), so a bare handle is rejected with a
 * DID-first message and NO network call. A bare DID still proceeds. Native is
 * unchanged and covered elsewhere.
 */

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Platform } from 'react-native';

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));

// On the web bare-handle path the screen returns before touching the node, but
// the module still imports this — give it a benign stub.
jest.mock('../../src/hooks/useNodeBootstrap', () => ({
  getBootedNode: () => null,
}));

import AddContactScreen from '../../app/add-contact';

const originalOS = Platform.OS;

afterEach(() => {
  // Restore so we never leak a web Platform into sibling suites.
  Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
  jest.restoreAllMocks();
});

function forceWeb(): void {
  Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
}

describe('AddContactScreen — web handle gate', () => {
  it('rejects a bare handle on web with a DID-first message and makes NO network call', () => {
    forceWeb();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('fetch must not be called on the web handle path');
    }) as unknown as typeof globalThis.fetch);

    const { getByTestId, getByText } = render(<AddContactScreen />);
    fireEvent.changeText(getByTestId('add-contact-handle-input'), 'alice.test.example');
    fireEvent.press(getByTestId('add-contact-save'));

    // DID-first guidance shown; handle resolution (which uses fetch) never ran.
    expect(getByText(/add a contact by their DID/i)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
