/**
 * The restore flow's handle step ("What's your Dina handle?"). Reported
 * stuck on the simulator: Continue did not move forward. Two ways it could:
 * a directory that never answers left "Verifying…" up for good (the lookups
 * had no timeout), and anything thrown before the lookups dropped silently
 * (the screen had no catch), so the button came back with no word. Pinned:
 * a silent PDS ends as a readable "unreachable" after the timeout, and a
 * throw reads on the screen.
 */

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { generateMnemonic } from '@dina/core';

import { RecoveryHandle } from '../../src/components/onboarding/recovery_handle';
import { RESOLVE_TIMEOUT_MS, resolveAndVerifyDidPlc } from '../../src/hooks/useOnboarding';

jest.mock('../../src/services/infra_preferences', () => ({
  loadInfraPreferences: async () => ({}),
}));

// A fresh valid phrase. (The all-"abandon" test vector has all-zero entropy,
// which key derivation rightly refuses by throwing.)
const PHRASE = generateMnemonic().split(' ');

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('resolveAndVerifyDidPlc', () => {
  it('a PDS that never answers ends as "unreachable" after the timeout, not a spinner for good', async () => {
    jest.useFakeTimers();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const pending = resolveAndVerifyDidPlc('alonso77.test-pds.dinakernel.com', PHRASE);
    // The key derivation runs first; the clock starts at the lookup.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await act(async () => {
      jest.advanceTimersByTime(RESOLVE_TIMEOUT_MS + 1);
    });
    await expect(pending).resolves.toEqual({
      kind: 'unreachable',
      message: `Could not reach PDS: no answer within ${String(RESOLVE_TIMEOUT_MS / 1000)} seconds`,
    });
  });
});

describe('the handle step', () => {
  it('a throw before the lookups reads on the screen, and Continue comes back', async () => {
    const onboarding = jest.requireActual<typeof import('../../src/hooks/useOnboarding')>(
      '../../src/hooks/useOnboarding',
    );
    jest
      .spyOn(onboarding, 'resolveAndVerifyDidPlc')
      .mockRejectedValue(new Error('keychain locked'));
    const onContinue = jest.fn();
    const view = render(
      <RecoveryHandle mnemonic={PHRASE} onContinue={onContinue} onBack={() => undefined} />,
    );
    fireEvent.changeText(
      view.getByTestId('recovery-handle-input'),
      'alonso77.test-pds.dinakernel.com',
    );
    fireEvent.press(view.getByText('Continue'));
    await waitFor(() =>
      expect(view.getByTestId('recovery-handle-error').props.children).toBe(
        "Couldn't check that handle: keychain locked. Try again.",
      ),
    );
    expect(view.getByText('Continue')).toBeTruthy();
    expect(onContinue).not.toHaveBeenCalled();
  });
});

describe('RecoveryHandle with a vault already on this phone (PH-04)', () => {
  const PHRASE_LOCAL = generateMnemonic().split(' ');
  const cloudBackup = jest.requireActual('../../src/services/cloud_backup');
  const installMarker = jest.requireActual('../../src/services/install_marker');
  const onboarding = jest.requireActual('../../src/hooks/useOnboarding');

  function foundCopy(): void {
    jest.spyOn(cloudBackup, 'findBackupForPhrase').mockResolvedValue({
      found: { meta: { created_at: 1, item_count: 3, handle: 'a.test' } },
    } as never);
    jest
      .spyOn(onboarding, 'resolveAndVerifyDidPlc')
      .mockResolvedValue({ kind: 'ok', did: 'did:plc:aaaa' } as never);
  }

  it('starts with restore off, warns, and asks to replace only when switched on', async () => {
    foundCopy();
    jest.spyOn(installMarker, 'localVaultExists').mockResolvedValue(true);
    const onContinue = jest.fn();
    const view = render(
      <RecoveryHandle mnemonic={PHRASE_LOCAL} onContinue={onContinue} onBack={() => undefined} />,
    );
    await waitFor(() => expect(view.getByTestId('recovery-backup-replaces')).toBeTruthy());
    expect(view.getByTestId('recovery-backup-restore').props.value).toBe(false);
    fireEvent.press(view.getByText('Continue'));
    await waitFor(() => expect(onContinue).toHaveBeenCalled());
    expect(onContinue).toHaveBeenLastCalledWith('a.test', 'did:plc:aaaa', false, false);

    fireEvent(view.getByTestId('recovery-backup-restore'), 'valueChange', true);
    fireEvent.press(view.getByText('Continue'));
    await waitFor(() =>
      expect(onContinue).toHaveBeenLastCalledWith('a.test', 'did:plc:aaaa', true, true),
    );
  });

  it('a new phone starts with restore on, and nothing to replace', async () => {
    foundCopy();
    jest.spyOn(installMarker, 'localVaultExists').mockResolvedValue(false);
    const onContinue = jest.fn();
    const view = render(
      <RecoveryHandle mnemonic={PHRASE_LOCAL} onContinue={onContinue} onBack={() => undefined} />,
    );
    await waitFor(() => expect(view.getByTestId('recovery-backup-found')).toBeTruthy());
    expect(view.queryByTestId('recovery-backup-replaces')).toBeNull();
    fireEvent.press(view.getByText('Continue'));
    await waitFor(() =>
      expect(onContinue).toHaveBeenLastCalledWith('a.test', 'did:plc:aaaa', true, false),
    );
  });
});
