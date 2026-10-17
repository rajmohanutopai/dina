/**
 * Who bargains for you (COMMITMENT_KERNEL §11, §15 step 11): the fixed rules
 * or Brain per kind of deal. A change shows Core's words on what Brain will
 * see before it is saved; the values switch shows only where values apply;
 * a goods seller picks the share of a saving, or leaves it to Brain.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { OwnerCommerceHttpError } from '@dina/core';

import BargainingScreen, { BARGAINING_KINDS } from '../../app/bargaining';

jest.mock('expo-router', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (effect: () => void) => ReactLib.useEffect(effect, [effect]),
    Stack: { Screen: () => null },
  };
});

const WITH = 'Brain will see what parts are worth to you.';
const WITHOUT = 'Brain will see the deal, but not what parts are worth to you.';

interface View {
  kind: string;
  strategy: 'fixed' | 'brain';
  values_on: boolean;
  values_apply: boolean;
  disclosure: string;
  disclosures: { with_values: string; without_values: string };
  saving_share?: unknown;
}

let stored: Record<string, View>;

const mockClient = {
  strategySetting: jest.fn(async (kind: string) => stored[kind]),
  setStrategy: jest.fn(async () => ({ ok: true, disclosure: '' })),
  setSavingShare: jest.fn(async () => ({ ok: true })),
  provePresence: jest.fn(),
};
jest.mock('../../src/services/owner_commerce_client', () => ({
  getOwnerCommerceClient: () => mockClient,
}));

beforeEach(() => {
  jest.clearAllMocks();
  stored = Object.fromEntries(
    BARGAINING_KINDS.map(({ kind }) => {
      const applies = kind !== 'shelf_space.host' && kind !== 'group.organizer';
      return [
        kind,
        {
          kind,
          strategy: 'fixed',
          values_on: true,
          values_apply: applies,
          disclosure: applies ? WITH : WITHOUT,
          disclosures: { with_values: applies ? WITH : WITHOUT, without_values: WITHOUT },
          ...(kind === 'goods.seller'
            ? { saving_share: { set_by: 'default', option: 'half' } }
            : {}),
        },
      ];
    }),
  );
});

it('lists every kind with the fixed rules chosen, and saves nothing until the owner says yes', async () => {
  const view = render(<BargainingScreen />);
  await waitFor(() => expect(view.getByTestId('bargaining-screen')).toBeTruthy());
  for (const { kind } of BARGAINING_KINDS) {
    expect(view.getByTestId(`bargaining-${kind}-fixed`).props.accessibilityState).toEqual({
      selected: true,
    });
  }
  fireEvent.press(view.getByTestId('bargaining-goods.buyer-brain'));
  // Core's words on what Brain will see come before the save.
  expect(view.getByTestId('bargaining-goods.buyer-disclosure').props.children).toBe(WITH);
  fireEvent(view.getByTestId('bargaining-goods.buyer-values'), 'valueChange', false);
  expect(view.getByTestId('bargaining-goods.buyer-disclosure').props.children).toBe(WITHOUT);
  expect(mockClient.setStrategy).not.toHaveBeenCalled();

  fireEvent.press(view.getByTestId('bargaining-goods.buyer-save'));
  await waitFor(() =>
    expect(mockClient.setStrategy).toHaveBeenCalledWith('goods.buyer', {
      strategy: 'brain',
      valuesOn: false,
    }),
  );
  await waitFor(() => expect(view.getByTestId('bargaining-saved')).toBeTruthy());
});

it('a kind that takes no values has no values switch; cancel drops the change', async () => {
  const view = render(<BargainingScreen />);
  await waitFor(() => expect(view.getByTestId('bargaining-screen')).toBeTruthy());
  fireEvent.press(view.getByTestId('bargaining-shelf_space.host-brain'));
  expect(view.queryByTestId('bargaining-shelf_space.host-values')).toBeNull();
  expect(view.getByTestId('bargaining-shelf_space.host-disclosure').props.children).toBe(WITHOUT);
  fireEvent.press(view.getByTestId('bargaining-shelf_space.host-cancel'));
  expect(view.queryByTestId('bargaining-shelf_space.host-confirm')).toBeNull();
  expect(mockClient.setStrategy).not.toHaveBeenCalled();
});

it('a goods seller picks the share of a saving; with Brain chosen they may leave it to Brain', async () => {
  const view = render(<BargainingScreen />);
  await waitFor(() => expect(view.getByTestId('bargaining-share-in-use')).toBeTruthy());
  expect(view.getByTestId('bargaining-share-in-use').props.children).toBe(
    'Half of the saving, the starting point until you choose.',
  );
  expect(view.queryByTestId('bargaining-share-brain')).toBeNull();
  stored['goods.seller'] = {
    ...(stored['goods.seller'] as View),
    saving_share: { set_by: 'owner', option: 'third' },
  };
  fireEvent.press(view.getByTestId('bargaining-share-third'));
  await waitFor(() => expect(mockClient.setSavingShare).toHaveBeenCalledWith('third'));
  await waitFor(() =>
    expect(view.getByTestId('bargaining-share-in-use').props.children).toBe(
      'A third of the saving, as you chose.',
    ),
  );

  stored['goods.seller'] = {
    ...(stored['goods.seller'] as View),
    strategy: 'brain',
    saving_share: { set_by: 'owner', option: 'third' },
  };
  const again = render(<BargainingScreen />);
  await waitFor(() => expect(again.getByTestId('bargaining-share-brain')).toBeTruthy());
  fireEvent.press(again.getByTestId('bargaining-share-brain'));
  await waitFor(() => expect(mockClient.setSavingShare).toHaveBeenCalledWith(null));
  await waitFor(() =>
    expect(again.getByTestId('bargaining-saved').props.children).toBe(
      'Saved. Dina passes on half until Brain sets a share.',
    ),
  );
});

it('Brain’s own share is said as a percent of the saving', async () => {
  stored['goods.seller'] = {
    ...(stored['goods.seller'] as View),
    strategy: 'brain',
    saving_share: { set_by: 'brain', share_bps: 4000 },
  };
  const view = render(<BargainingScreen />);
  await waitFor(() =>
    expect(view.getByTestId('bargaining-share-in-use').props.children).toBe(
      'Brain passes on 40% of the saving.',
    ),
  );
});

it('with Brain chosen and no share set, the half in use lasts until Brain sets one', async () => {
  stored['goods.seller'] = { ...(stored['goods.seller'] as View), strategy: 'brain' };
  const view = render(<BargainingScreen />);
  await waitFor(() =>
    expect(view.getByTestId('bargaining-share-in-use').props.children).toBe(
      'Half of the saving, until Brain sets a share.',
    ),
  );
});

it('selling rules in a closed persona, or unreadable, are said, never a share', async () => {
  stored['goods.seller'] = {
    ...(stored['goods.seller'] as View),
    saving_share: { set_by: 'closed', personas: ['health'] },
  };
  const view = render(<BargainingScreen />);
  await waitFor(() =>
    expect(view.getByTestId('bargaining-share-in-use').props.children).toBe(
      'Some of your selling rules are in /health, which is closed now. Dina sends no quotes until you open it.',
    ),
  );
  stored['goods.seller'] = {
    ...(stored['goods.seller'] as View),
    saving_share: { set_by: 'unreadable' },
  };
  const again = render(<BargainingScreen />);
  await waitFor(() =>
    expect(again.getByTestId('bargaining-share-in-use').props.children).toMatch(/cannot read/),
  );
  stored['goods.seller'] = {
    ...(stored['goods.seller'] as View),
    saving_share: { set_by: 'closed', personas: ['health', 'work'] },
  };
  const both = render(<BargainingScreen />);
  await waitFor(() =>
    expect(both.getByTestId('bargaining-share-in-use').props.children).toBe(
      'Some of your selling rules are in /health, /work, which are closed now. Dina sends no quotes until you open them.',
    ),
  );
});

it('saving waits for a person: the sheet asks, then the same change is saved', async () => {
  mockClient.setStrategy.mockRejectedValueOnce(
    new OwnerCommerceHttpError('403', 403, 'no_user_presence'),
  );
  const view = render(<BargainingScreen />);
  await waitFor(() => expect(view.getByTestId('bargaining-screen')).toBeTruthy());
  fireEvent.press(view.getByTestId('bargaining-delivery.shipper-brain'));
  fireEvent.press(view.getByTestId('bargaining-delivery.shipper-save'));
  await waitFor(() => expect(view.getByTestId('presence-sheet')).toBeTruthy());
  fireEvent.changeText(view.getByTestId('presence-passphrase'), 'correct horse');
  fireEvent.press(view.getByTestId('presence-submit'));
  await waitFor(() => expect(mockClient.setStrategy).toHaveBeenCalledTimes(2));
  expect(mockClient.provePresence).toHaveBeenCalledWith('correct horse');
  expect(mockClient.setStrategy.mock.calls[1]).toEqual([
    'delivery.shipper',
    { strategy: 'brain', valuesOn: true },
  ]);
});

it('cancelling the presence check saves nothing and frees the screen', async () => {
  mockClient.setStrategy.mockRejectedValueOnce(
    new OwnerCommerceHttpError('403', 403, 'no_user_presence'),
  );
  const view = render(<BargainingScreen />);
  await waitFor(() => expect(view.getByTestId('bargaining-screen')).toBeTruthy());
  fireEvent.press(view.getByTestId('bargaining-goods.buyer-brain'));
  fireEvent.press(view.getByTestId('bargaining-goods.buyer-save'));
  await waitFor(() => expect(view.getByTestId('presence-sheet')).toBeTruthy());
  fireEvent.press(view.getByTestId('presence-cancel'));
  await waitFor(() =>
    expect(
      view.getByTestId('bargaining-goods.buyer-save').props.accessibilityState?.disabled ?? false,
    ).toBe(false),
  );
  expect(mockClient.setStrategy).toHaveBeenCalledTimes(1);
  expect(view.queryByTestId('bargaining-saved')).toBeNull();
});

it('while a save is under way every control waits, so a second change cannot overtake it', async () => {
  let finish: () => void = () => undefined;
  mockClient.setStrategy.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ ok: true, disclosure: '' });
      }),
  );
  const view = render(<BargainingScreen />);
  await waitFor(() => expect(view.getByTestId('bargaining-screen')).toBeTruthy());
  fireEvent.press(view.getByTestId('bargaining-goods.buyer-brain'));
  fireEvent.press(view.getByTestId('bargaining-goods.buyer-save'));
  await waitFor(() =>
    expect(view.getByTestId('bargaining-goods.buyer-values').props.disabled).toBe(true),
  );
  fireEvent.press(view.getByTestId('bargaining-goods.buyer-save'));
  fireEvent.press(view.getByTestId('bargaining-share-most'));
  expect(mockClient.setStrategy).toHaveBeenCalledTimes(1);
  expect(mockClient.setSavingShare).not.toHaveBeenCalled();
  finish();
  await waitFor(() => expect(view.getByTestId('bargaining-saved')).toBeTruthy());
});

it('a kind that cannot be read shows its own error and retry; the others stay usable', async () => {
  mockClient.strategySetting.mockImplementation(async (kind: string) => {
    if (kind === 'goods.seller') throw new OwnerCommerceHttpError('500', 500, 'error');
    return stored[kind] as View;
  });
  const view = render(<BargainingScreen />);
  await waitFor(() => expect(view.getByTestId('bargaining-goods.seller-error')).toBeTruthy());
  expect(view.getByTestId('bargaining-goods.buyer-fixed')).toBeTruthy();
  mockClient.strategySetting.mockImplementation(async (kind: string) => stored[kind] as View);
  fireEvent.press(view.getByTestId('bargaining-goods.seller-retry'));
  await waitFor(() => expect(view.getByTestId('bargaining-share-in-use')).toBeTruthy());
});

it('a failed save is said, and the change stays open to try again', async () => {
  mockClient.setStrategy.mockRejectedValueOnce(new OwnerCommerceHttpError('500', 500, 'error'));
  const view = render(<BargainingScreen />);
  await waitFor(() => expect(view.getByTestId('bargaining-screen')).toBeTruthy());
  fireEvent.press(view.getByTestId('bargaining-group.organizer-brain'));
  fireEvent.press(view.getByTestId('bargaining-group.organizer-save'));
  await waitFor(() => expect(view.getByTestId('bargaining-error')).toBeTruthy());
  expect(view.getByTestId('bargaining-group.organizer-confirm')).toBeTruthy();
});
