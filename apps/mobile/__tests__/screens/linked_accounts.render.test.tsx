/**
 * Linked accounts (UCP plan §3.17), and the screen a merchant's callback
 * lands on. The screens decide nothing: Core lists the links, starts and
 * ends them, and says what a callback did. These pin what the owner reads
 * and that each button asks Core once.
 */

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Linking, Platform } from 'react-native';

import LinkedAccounts from '../../app/linked-accounts';
import CallbackScreen from '../../app/ucp/oauth/callback';

import type { UcpLinkOwnerView, UcpLinksOwnerView } from '@dina/core';

const mockReplace = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  return {
    router: { replace: (...a: unknown[]) => mockReplace(...a) },
    useLocalSearchParams: () => mockParams,
    useFocusEffect: (effect: () => void) => ReactLib.useEffect(effect, [effect]),
    Stack: { Screen: () => null },
  };
});
const mockUcp = {
  links: jest.fn(),
  settings: jest.fn(),
  startLink: jest.fn(),
  unlink: jest.fn(),
  linkCallback: jest.fn(),
  dismissUnrevoked: jest.fn(),
};
const listed = (
  links: UcpLinkOwnerView[],
  more: Partial<UcpLinksOwnerView> = {},
): UcpLinksOwnerView => ({
  links,
  wanted: [],
  unrevoked: [],
  failed: [],
  ...more,
});
/** False while the app is still unlocking: no owner client yet. */
let mockReady = true;
jest.mock('../../src/services/owner_ucp_client', () => ({
  getOwnerUcpClient: () => (mockReady ? mockUcp : null),
}));

const SHOP = 'https://tea.example';
const link = (over: Partial<UcpLinkOwnerView> = {}): UcpLinkOwnerView => ({
  merchant_origin: SHOP,
  merchant_host: 'tea.example',
  scopes: ['dev.ucp.shopping.checkout:manage', 'dev.ucp.shopping.order:read'],
  state: 'active',
  linked_at: 1,
  updated_at: 2,
  ...over,
});

beforeEach(() => {
  mockReplace.mockReset();
  mockParams = {};
  mockReady = true;
  for (const m of Object.values(mockUcp)) m.mockReset();
  mockUcp.links.mockResolvedValue(listed([link()]));
  mockUcp.settings.mockResolvedValue({
    merchants: [SHOP, 'https://rice.example'],
    context: {},
    searching: true,
  });
  mockUcp.unlink.mockResolvedValue(true);
});

describe('Linked accounts', () => {
  it('shows each link with what it lets Dina do, and offers the owner’s other shops', async () => {
    const screen = render(<LinkedAccounts />);
    await waitFor(() => expect(screen.getByTestId('linked-accounts-tea.example')).toBeTruthy());
    expect(screen.getByTestId('linked-accounts-tea.example-state').props.children).toBe('Linked');
    expect(screen.getByTestId('linked-accounts-tea.example-scopes')).toHaveTextContent(
      'Dina may prepare checkouts, read your orders.',
    );
    expect(screen.getByTestId('linked-accounts-link-rice.example')).toBeTruthy();
    expect(screen.queryByTestId('linked-accounts-link-tea.example')).toBeNull();
  });

  it('Link opens the shop’s page Core started; a refusal is said in words', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    mockUcp.startLink.mockResolvedValueOnce({
      started: true,
      opens: 'here',
      url: 'https://rice.example/auth?x=1',
      scopes: [],
      expires_at: 9,
    });
    const screen = render(<LinkedAccounts />);
    await waitFor(() => screen.getByTestId('linked-accounts-link-rice.example'));
    await act(async () => fireEvent.press(screen.getByTestId('linked-accounts-link-rice.example')));
    expect(mockUcp.startLink).toHaveBeenCalledWith('https://rice.example', []);
    expect(open).toHaveBeenCalledWith('https://rice.example/auth?x=1');
    mockUcp.startLink.mockResolvedValueOnce({ started: false, reason: 'no_public_client' });
    await act(async () => fireEvent.press(screen.getByTestId('linked-accounts-link-rice.example')));
    expect(screen.getByTestId('linked-accounts-note')).toHaveTextContent(
      'rice.example’s sign-in lacks what Dina needs to link safely.',
    );
    expect(open).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });

  it('Unlink asks first; Keep changes nothing; a link that needs linking again offers that', async () => {
    mockUcp.links.mockResolvedValue(listed([link({ state: 'needs_relink' })]));
    const screen = render(<LinkedAccounts />);
    await waitFor(() => screen.getByTestId('linked-accounts-tea.example'));
    expect(screen.getByTestId('linked-accounts-tea.example-state').props.children).toBe(
      'Needs linking again',
    );
    expect(screen.getByTestId('linked-accounts-tea.example-relink')).toBeTruthy();
    fireEvent.press(screen.getByTestId('linked-accounts-tea.example-unlink'));
    fireEvent.press(screen.getByTestId('linked-accounts-tea.example-unlink-no'));
    expect(mockUcp.unlink).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('linked-accounts-tea.example-unlink'));
    await act(async () =>
      fireEvent.press(screen.getByTestId('linked-accounts-tea.example-unlink-yes')),
    );
    expect(mockUcp.unlink).toHaveBeenCalledWith(SHOP);
    expect(mockUcp.links).toHaveBeenCalledTimes(2);
  });

  it('a shop that asked for a link is offered with the scopes it named; access Dina could not take back says so; failed attempts say why', async () => {
    mockUcp.links.mockResolvedValue(
      listed([], {
        wanted: [
          {
            merchant_origin: 'https://rice.example',
            merchant_host: 'rice.example',
            scopes: ['dev.ucp.shopping.checkout:manage'],
            at: 1,
          },
        ],
        unrevoked: [
          { merchant_origin: 'https://old.example', merchant_host: 'old.example', since: 1 },
        ],
        failed: [
          {
            merchant_origin: SHOP,
            merchant_host: 'tea.example',
            outcome: 'token_unreachable',
            at: 1,
          },
        ],
      }),
    );
    mockUcp.startLink.mockResolvedValue({
      started: true,
      opens: 'phone',
      card_id: 'c',
      scopes: [],
      expires_at: 1,
    });
    mockUcp.dismissUnrevoked.mockResolvedValue(true);
    const screen = render(<LinkedAccounts />);
    await waitFor(() => screen.getByTestId('linked-accounts-asks-rice.example'));
    expect(screen.getByTestId('linked-accounts-unrevoked-old.example')).toHaveTextContent(
      'Dina could not cancel its access at old.example',
      { exact: false },
    );
    expect(screen.getByTestId('linked-accounts-failed-tea.example')).toHaveTextContent(
      'Linking at tea.example did not finish: Dina could not reach the shop. Try again.',
    );
    await act(async () => fireEvent.press(screen.getByTestId('linked-accounts-link-rice.example')));
    expect(mockUcp.startLink).toHaveBeenCalledWith('https://rice.example', [
      'dev.ucp.shopping.checkout:manage',
    ]);
    // A server behind NAT sent the sign-in to the phone.
    expect(screen.getByTestId('linked-accounts-note')).toHaveTextContent(
      'Sent to your phone: approve the card there to sign in at rice.example.',
    );
    await act(async () =>
      fireEvent.press(screen.getByTestId('linked-accounts-unrevoked-old.example-done')),
    );
    expect(mockUcp.dismissUnrevoked).toHaveBeenCalledWith('https://old.example');
  });

  it('on the web app the sign-in is a link the owner taps, never a page opened after the request', async () => {
    const platform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    try {
      mockUcp.startLink.mockResolvedValue({
        started: true,
        opens: 'here',
        url: 'https://rice.example/auth?x=1',
        scopes: [],
        expires_at: 9,
      });
      const screen = render(<LinkedAccounts />);
      await waitFor(() => screen.getByTestId('linked-accounts-link-rice.example'));
      await act(async () =>
        fireEvent.press(screen.getByTestId('linked-accounts-link-rice.example')),
      );
      expect(open).not.toHaveBeenCalled();
      fireEvent.press(screen.getByTestId('linked-accounts-sign-in'));
      expect(open).toHaveBeenCalledWith('https://rice.example/auth?x=1');
    } finally {
      Object.defineProperty(Platform, 'OS', { value: platform, configurable: true });
      open.mockRestore();
    }
  });

  it('a node that does not run UCP says how to start', async () => {
    mockUcp.links.mockResolvedValue(null);
    const screen = render(<LinkedAccounts />);
    await waitFor(() => expect(screen.getByTestId('linked-accounts-off')).toBeTruthy());
  });
});

describe('the callback screen', () => {
  it('hands Core the four parameters once and says what happened', async () => {
    mockParams = { code: 'c', state: 's', iss: 'https://tea.example/auth', extra: 'dropped' };
    mockUcp.linkCallback.mockResolvedValue({ linked: true, merchant_host: 'tea.example' });
    const screen = render(<CallbackScreen />);
    await waitFor(() =>
      expect(screen.getByTestId('ucp-link-callback-text')).toHaveTextContent(
        'Your account at tea.example is linked.',
      ),
    );
    expect(mockUcp.linkCallback).toHaveBeenCalledTimes(1);
    expect(mockUcp.linkCallback).toHaveBeenCalledWith({
      code: 'c',
      state: 's',
      iss: 'https://tea.example/auth',
    });
    fireEvent.press(screen.getByTestId('ucp-link-callback-done'));
    expect(mockReplace).toHaveBeenCalledWith('/linked-accounts');
  });

  it.each([
    [{ linked: false, held: true }, 'Your Dina server finishes this link.'],
    [{ linked: false, reason: 'denied' }, 'You said no at the shop, so nothing was linked.'],
    [{ linked: false, reason: 'unknown_state' }, 'This sign-in was already used or has expired.'],
  ])('%j reads as words', async (out, words) => {
    mockParams = { state: 's' };
    mockUcp.linkCallback.mockResolvedValue(out);
    const screen = render(<CallbackScreen />);
    await waitFor(() =>
      expect(screen.getByTestId('ucp-link-callback-text')).toHaveTextContent(words, {
        exact: false,
      }),
    );
  });

  it('waits for Core while the app unlocks, then hands it in', async () => {
    jest.useFakeTimers();
    try {
      mockReady = false;
      mockParams = { code: 'c', state: 's' };
      mockUcp.linkCallback.mockResolvedValue({ linked: true, merchant_host: 'tea.example' });
      const screen = render(<CallbackScreen />);
      expect(screen.getByTestId('ucp-link-callback-text')).toHaveTextContent('Finishing the link…');
      await act(async () => jest.advanceTimersByTime(1_500));
      expect(mockUcp.linkCallback).not.toHaveBeenCalled();
      mockReady = true;
      await act(async () => jest.advanceTimersByTime(600));
      jest.useRealTimers();
      await waitFor(() => expect(mockUcp.linkCallback).toHaveBeenCalledTimes(1));
    } finally {
      jest.useRealTimers();
    }
  });
});
