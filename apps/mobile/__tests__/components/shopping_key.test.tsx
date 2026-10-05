/**
 * Shopping profile and key (UCP plan §3.5, §4.8; U7): the status and key ring
 * in words, only the actions that make sense, presence asked for where Core
 * asks, and a second tap before the key is retired for good.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { OwnerUcpHttpError, type UcpPublicationView } from '@dina/core';

import { ShoppingKey } from '../../src/components/ShoppingKey';
import {
  publicationActions,
  publicationDetailText,
  publicationSettling,
  publicationStatusText,
  shoppingKeyText,
} from '../../src/services/ucp_publication_words';

const view = (over: Partial<UcpPublicationView> = {}): UcpPublicationView => ({
  status: 'served',
  role: 'active',
  enabled: true,
  compromise_pending: false,
  pending_control: null,
  detail: null,
  key: { generation: 0, next: null, retiring: [] },
  rotation_requested: false,
  ...over,
});

const mockClient = {
  publication: jest.fn(),
  publicationAction: jest.fn(),
};
jest.mock('../../src/services/owner_ucp_client', () => ({
  getOwnerUcpClient: () => mockClient,
}));
const mockProve = jest.fn(async (_: string) => undefined);
jest.mock('../../src/services/owner_commerce_client', () => ({
  getOwnerCommerceClient: () => ({ provePresence: mockProve }),
}));

beforeEach(() => jest.clearAllMocks());

describe('words', () => {
  it('says the status, and a compromise still being carried out', () => {
    expect(publicationStatusText(view())).toMatch(/can find your shopping profile/);
    expect(publicationStatusText(view({ status: 'stood_down', role: 'stood_down' }))).toMatch(
      /Another of your devices/,
    );
    expect(publicationStatusText(view({ status: 'stopping', compromise_pending: true }))).toMatch(
      /Replacing your shopping key/,
    );
  });

  it('says the ring: the key in use, a rotation waiting on the host or on its time, old keys listed', () => {
    expect(shoppingKeyText(view())).toEqual(['Key in use: number 0.']);
    expect(
      shoppingKeyText(
        view({ key: { generation: 0, next: { generation: 1, signs_from: null }, retiring: [] } }),
      )[1],
    ).toMatch(/checking the host serves it/);
    const at = Date.UTC(2026, 9, 5, 12);
    const lines = shoppingKeyText(
      view({
        key: {
          generation: 2,
          next: { generation: 3, signs_from: at },
          retiring: [{ generation: 1, until: at }],
        },
      }),
    );
    expect(lines[1]).toContain(new Date(at).toLocaleString());
    expect(lines[2]).toMatch(/Old key 1 stays listed until/);
    expect(shoppingKeyText(view({ key: null }))).toEqual([
      'No shopping key yet: one is set up when your profile is first published.',
    ]);
    expect(shoppingKeyText(view({ key: null, rotation_requested: true }))).toEqual([
      'A new key will be set up on the next update.',
    ]);
  });

  it('offers only what makes sense', () => {
    expect(publicationActions(view())).toEqual({
      activate: false,
      turnOff: true,
      rotate: true,
      compromised: true,
    });
    // Another device holds shopping: take it back, never rotate from here.
    expect(publicationActions(view({ role: 'stood_down', status: 'stood_down' }))).toMatchObject({
      activate: true,
      rotate: false,
    });
    // Off: turn it on; a rotation waits.
    expect(publicationActions(view({ enabled: false, status: 'off' }))).toMatchObject({
      activate: true,
      turnOff: false,
      rotate: false,
    });
    // One rotation at a time.
    expect(
      publicationActions(
        view({ key: { generation: 0, next: { generation: 1, signs_from: null }, retiring: [] } }),
      ).rotate,
    ).toBe(false);
    expect(publicationActions(view({ compromise_pending: true })).compromised).toBe(false);
  });
});

describe('a refusal (gap sweep)', () => {
  it('is said as a refusal with its reason, and the refused control is offered again', () => {
    const refusedOff = view({
      status: 'refused',
      enabled: false,
      pending_control: 'pause',
      detail: 'invalid',
    });
    expect(publicationStatusText(refusedOff)).toMatch(
      /refused to turn shopping off: your profile is still served/,
    );
    expect(publicationDetailText(refusedOff)).toMatch(/signature/);
    expect(publicationActions(refusedOff).turnOff).toBe(true);
    const refusedRetire = view({
      status: 'refused',
      compromise_pending: true,
      pending_control: 'retire',
      detail: 'label_owned',
    });
    expect(publicationStatusText(refusedRetire)).toMatch(/refused to retire your key/);
    expect(publicationStatusText(refusedRetire)).not.toMatch(/keeps trying/);
    expect(publicationActions(refusedRetire).compromised).toBe(true);
    expect(publicationDetailText(view({ detail: 'something_new' }))).toBeNull();
    expect(publicationDetailText(view({ detail: 'superseded' }))).toMatch(
      /Another device took shopping after you pressed this/,
    );
  });

  it('"use this device" waiting for the host is said, and not offered twice', () => {
    const pending = view({
      status: 'unreachable',
      role: 'stood_down',
      pending_control: 'activate',
    });
    expect(publicationStatusText(pending)).toMatch(/once the profile host answers/);
    expect(publicationActions(pending).activate).toBe(false);
  });

  it('while a replacement is pending, shopping can still be turned off', () => {
    expect(
      publicationActions(
        view({ status: 'stopping', compromise_pending: true, pending_control: 'retire' }),
      ).turnOff,
    ).toBe(true);
    expect(
      publicationActions(view({ status: 'stopping', enabled: false, pending_control: 'pause' }))
        .turnOff,
    ).toBe(false);
  });

  it('only a moving state is read again', () => {
    expect(publicationSettling(view())).toBe(false);
    expect(publicationSettling(view({ status: 'stopping' }))).toBe(true);
    expect(
      publicationSettling(
        view({ key: { generation: 0, next: { generation: 1, signs_from: 5 }, retiring: [] } }),
      ),
    ).toBe(true);
    expect(publicationSettling(view({ status: 'refused' }))).toBe(false);
  });
});

describe('the section', () => {
  it('reads again after every action, and a failed read keeps what was shown', async () => {
    mockClient.publication.mockResolvedValueOnce(view()).mockRejectedValueOnce(new Error('down'));
    mockClient.publicationAction.mockResolvedValue(view({ status: 'off', enabled: false }));
    const r = render(<ShoppingKey />);
    await waitFor(() => r.getByTestId('shopping-key-turn_off'));
    fireEvent.press(r.getByTestId('shopping-key-turn_off'));
    await waitFor(() => expect(mockClient.publication).toHaveBeenCalledTimes(2));
    // The read after the action failed: the action's own answer stays on screen.
    expect(r.getByTestId('shopping-key-status').props.children).toMatch(/Shopping is off/);
  });

  it('stays hidden on a node that does not run UCP', async () => {
    mockClient.publication.mockResolvedValue(null);
    const r = render(<ShoppingKey />);
    await waitFor(() => expect(mockClient.publication).toHaveBeenCalled());
    expect(r.queryByTestId('shopping-key')).toBeNull();
  });

  it('rotates, and shows the ring Core returns', async () => {
    const rotating = view({
      key: { generation: 0, next: { generation: 1, signs_from: null }, retiring: [] },
    });
    mockClient.publication.mockResolvedValueOnce(view()).mockResolvedValue(rotating);
    mockClient.publicationAction.mockResolvedValue(rotating);
    const r = render(<ShoppingKey />);
    await waitFor(() => r.getByTestId('shopping-key-rotate'));
    fireEvent.press(r.getByTestId('shopping-key-rotate'));
    await waitFor(() => expect(mockClient.publicationAction).toHaveBeenCalledWith('rotate'));
    await waitFor(() => expect(r.queryByTestId('shopping-key-rotate')).toBeNull());
    expect(r.getByText(/New key 1 is listed/)).toBeTruthy();
  });

  it('"my key may be compromised" takes a second tap, then asks the owner to confirm it is them, then runs', async () => {
    const replaced = view({ key: { generation: 1, next: null, retiring: [] } });
    // Core's state: the old key until the action runs, the new one after.
    let current = view();
    mockClient.publication.mockImplementation(async () => current);
    mockClient.publicationAction
      .mockRejectedValueOnce(
        new OwnerUcpHttpError('ucp publication action: HTTP 403', 403, 'no_user_presence', null),
      )
      .mockImplementationOnce(async () => {
        current = replaced;
        return replaced;
      });
    const r = render(<ShoppingKey />);
    await waitFor(() => r.getByTestId('shopping-key-compromised'));
    fireEvent.press(r.getByTestId('shopping-key-compromised'));
    expect(mockClient.publicationAction).not.toHaveBeenCalled();
    expect(r.getByTestId('shopping-key-confirm')).toBeTruthy();
    fireEvent.press(r.getByTestId('shopping-key-compromised'));
    await waitFor(() => expect(mockClient.publicationAction).toHaveBeenCalledTimes(1));
    // The presence sheet: the owner proves it, and the same action runs again.
    const input = await waitFor(() => r.getByTestId('presence-passphrase'));
    fireEvent.changeText(input, 'secret');
    fireEvent.press(r.getByTestId('presence-submit'));
    await waitFor(() => expect(mockProve).toHaveBeenCalledWith('secret'));
    await waitFor(() => expect(mockClient.publicationAction).toHaveBeenCalledTimes(2));
    expect(mockClient.publicationAction).toHaveBeenLastCalledWith('compromised');
    await waitFor(() => expect(r.getByText('Key in use: number 1.')).toBeTruthy());
  });
});
