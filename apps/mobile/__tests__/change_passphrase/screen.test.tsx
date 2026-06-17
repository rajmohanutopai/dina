/**
 * Change-passphrase screen — form wiring + state machine.
 *
 * The durable re-wrap is covered in services/change_passphrase.test.ts;
 * here we mock the service and pin the SCREEN behavior:
 *   - three distinct passphrase fields render (testID override works);
 *   - a new/confirm mismatch is caught client-side BEFORE the service;
 *   - success swaps to the confirmation state and Done returns to Settings;
 *   - a service error renders inline and keeps the form up.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('../../src/services/change_passphrase', () => ({
  changeVaultPassphrase: jest.fn(),
}));

const replaceCalls: string[] = [];
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: (path: string) => void replaceCalls.push(path) }),
}));

import ChangePassphraseScreen from '../../app/change-passphrase';
import { changeVaultPassphrase } from '../../src/services/change_passphrase';

const changeMock = changeVaultPassphrase as jest.MockedFunction<typeof changeVaultPassphrase>;

beforeEach(() => {
  jest.clearAllMocks();
  replaceCalls.length = 0;
});

describe('ChangePassphraseScreen', () => {
  it('renders the three passphrase fields and the submit button', () => {
    const { getByTestId } = render(<ChangePassphraseScreen />);
    expect(getByTestId('change-pass-current')).toBeTruthy();
    expect(getByTestId('change-pass-new')).toBeTruthy();
    expect(getByTestId('change-pass-confirm')).toBeTruthy();
    expect(getByTestId('change-passphrase-submit')).toBeTruthy();
  });

  it('blocks submit and shows an error when new and confirm differ — service not called', async () => {
    const { getByTestId, findByText } = render(<ChangePassphraseScreen />);
    fireEvent.changeText(getByTestId('change-pass-current'), 'OldPass123');
    fireEvent.changeText(getByTestId('change-pass-new'), 'NewPass456');
    fireEvent.changeText(getByTestId('change-pass-confirm'), 'Mismatch789');
    fireEvent.press(getByTestId('change-passphrase-submit'));
    expect(await findByText(/don't match/i)).toBeTruthy();
    expect(changeMock).not.toHaveBeenCalled();
  });

  it('blocks submit with an empty current passphrase', async () => {
    const { getByTestId, findByText } = render(<ChangePassphraseScreen />);
    fireEvent.changeText(getByTestId('change-pass-new'), 'NewPass456');
    fireEvent.changeText(getByTestId('change-pass-confirm'), 'NewPass456');
    fireEvent.press(getByTestId('change-passphrase-submit'));
    expect(await findByText('Enter your current passphrase.')).toBeTruthy();
    expect(changeMock).not.toHaveBeenCalled();
  });

  it('calls the service with current + new and shows the success state on ok', async () => {
    changeMock.mockResolvedValue({ ok: true });
    const { getByTestId, findByTestId } = render(<ChangePassphraseScreen />);
    fireEvent.changeText(getByTestId('change-pass-current'), 'OldPass123');
    fireEvent.changeText(getByTestId('change-pass-new'), 'NewPass456');
    fireEvent.changeText(getByTestId('change-pass-confirm'), 'NewPass456');
    fireEvent.press(getByTestId('change-passphrase-submit'));

    const done = await findByTestId('change-passphrase-done');
    expect(changeMock).toHaveBeenCalledWith('OldPass123', 'NewPass456');
    fireEvent.press(done);
    expect(replaceCalls).toEqual(['/settings']);
  });

  it('renders the service error inline and stays on the form', async () => {
    changeMock.mockResolvedValue({ ok: false, error: 'That current passphrase is incorrect.' });
    const { getByTestId, findByText, queryByTestId } = render(<ChangePassphraseScreen />);
    fireEvent.changeText(getByTestId('change-pass-current'), 'WrongPass1');
    fireEvent.changeText(getByTestId('change-pass-new'), 'NewPass456');
    fireEvent.changeText(getByTestId('change-pass-confirm'), 'NewPass456');
    fireEvent.press(getByTestId('change-passphrase-submit'));

    expect(await findByText('That current passphrase is incorrect.')).toBeTruthy();
    await waitFor(() => expect(queryByTestId('change-passphrase-done')).toBeNull());
    expect(getByTestId('change-passphrase-submit')).toBeTruthy();
  });
});
