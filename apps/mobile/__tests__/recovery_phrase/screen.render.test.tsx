/**
 * Recovery-phrase screen render + reveal behavior.
 *
 * Covers the gate → reveal → wipe lifecycle without going through a
 * real Argon2id KDF (which would push the test into the 60s budget
 * the aesgcm suite uses). We mock `@dina/core`'s `unwrapSeed` so the
 * test runs in milliseconds while the production composition is
 * still exercised — `entropyToMnemonic` runs for real, the screen
 * state machine runs for real, and only the heavy crypto step is
 * stubbed.
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import { AppState } from 'react-native';

// Prevent the screen from importing the real keychain at boot.
jest.mock('../../src/services/wrapped_seed_store', () => ({
  loadWrappedSeed: jest.fn(),
}));

// Stub the heavy crypto. `unwrapSeed` returns the test entropy; the
// screen still calls `entropyToMnemonic` for real to convert it to
// the 24 words.
jest.mock('@dina/core', () => {
  const actual = jest.requireActual('@dina/core');
  return {
    ...actual,
    unwrapSeed: jest.fn(),
  };
});

const backCalls: number[] = [];
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: () => void backCalls.push(Date.now()) }),
}));

import RecoveryPhraseScreen from '../../app/recovery-phrase';
import { loadWrappedSeed } from '../../src/services/wrapped_seed_store';
import { unwrapSeed, mnemonicToEntropy, generateMnemonic } from '@dina/core';

const loadWrappedSeedMock = loadWrappedSeed as jest.MockedFunction<typeof loadWrappedSeed>;
const unwrapSeedMock = unwrapSeed as jest.MockedFunction<typeof unwrapSeed>;

// A deterministic 24-word fixture we'll use across tests. Generating
// once-per-test is overkill and slow; one fixed mnemonic exercises
// the same code paths.
const FIXTURE_MNEMONIC = generateMnemonic();
const FIXTURE_ENTROPY = mnemonicToEntropy(FIXTURE_MNEMONIC);

beforeEach(() => {
  loadWrappedSeedMock.mockReset();
  unwrapSeedMock.mockReset();
  backCalls.length = 0;
});

describe('recovery-phrase gate', () => {
  it('renders the passphrase prompt initially — no words on screen', () => {
    const { queryByText, getByLabelText } = render(<RecoveryPhraseScreen />);
    expect(queryByText('View recovery phrase')).toBeTruthy();
    expect(getByLabelText('Enter passphrase to view recovery phrase')).toBeTruthy();
    // None of the fixture words leak through the gate.
    for (const word of FIXTURE_MNEMONIC.split(' ')) {
      expect(queryByText(word)).toBeNull();
    }
  });

  it('blocks reveal when the passphrase field is empty', async () => {
    const { getByLabelText, findByText } = render(<RecoveryPhraseScreen />);
    fireEvent.press(getByLabelText('Reveal recovery phrase'));
    expect(await findByText(/Type your passphrase first/)).toBeTruthy();
    expect(unwrapSeedMock).not.toHaveBeenCalled();
  });

  it('shows a generic error and stays in the gate on a bad passphrase', async () => {
    loadWrappedSeedMock.mockResolvedValue({
      wrapped: new Uint8Array(48),
      salt: new Uint8Array(16),
      params: { iterations: 1, memorySize: 65536, parallelism: 1 },
    } as never);
    unwrapSeedMock.mockRejectedValue(new Error('aes tag mismatch'));

    const { getByLabelText, findByText, queryByText } = render(<RecoveryPhraseScreen />);
    fireEvent.changeText(getByLabelText('Enter passphrase to view recovery phrase'), 'wrong');
    fireEvent.press(getByLabelText('Reveal recovery phrase'));

    // Error message is the generic surface — no AES-internals leak.
    expect(await findByText(/passphrase didn’t unlock/)).toBeTruthy();
    expect(queryByText(/aes tag/)).toBeNull();
    // None of the fixture words appear.
    for (const word of FIXTURE_MNEMONIC.split(' ')) {
      expect(queryByText(word)).toBeNull();
    }
  });
});

describe('recovery-phrase reveal', () => {
  beforeEach(() => {
    loadWrappedSeedMock.mockResolvedValue({
      wrapped: new Uint8Array(48),
      salt: new Uint8Array(16),
      params: { iterations: 1, memorySize: 65536, parallelism: 1 },
    } as never);
    unwrapSeedMock.mockResolvedValue(FIXTURE_ENTROPY);
  });

  it('shows all 24 words after a successful unlock', async () => {
    const { getByLabelText, findByText } = render(<RecoveryPhraseScreen />);
    fireEvent.changeText(getByLabelText('Enter passphrase to view recovery phrase'), 'correct');
    fireEvent.press(getByLabelText('Reveal recovery phrase'));

    // First word should be on screen — wait for the reveal mode swap.
    const words = FIXTURE_MNEMONIC.split(' ');
    expect(await findByText(words[0])).toBeTruthy();
    // Spot-check a middle and the last word too.
    expect(await findByText(words[11])).toBeTruthy();
    expect(await findByText(words[23])).toBeTruthy();
  });

  it('wipes the words on AppState background — recents-thumbnail safety', async () => {
    const { getByLabelText, findByText, queryByText } = render(<RecoveryPhraseScreen />);
    fireEvent.changeText(getByLabelText('Enter passphrase to view recovery phrase'), 'correct');
    fireEvent.press(getByLabelText('Reveal recovery phrase'));
    const words = FIXTURE_MNEMONIC.split(' ');
    expect(await findByText(words[0])).toBeTruthy();

    // Simulate the OS handing us an `inactive` (iOS app-switcher swipe).
    act(() => {
      // The mock RN AppState exposes `addEventListener` returning a
      // subscription; firing manually mirrors what the OS does.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handlers: ((s: string) => void)[] = (AppState as any).__changeHandlers ?? [];
      handlers.forEach((h) => h('inactive'));
    });

    // Words should be gone, gate should be back.
    expect(queryByText(words[0])).toBeNull();
  });

  it('wipes the words after the idle timer expires', async () => {
    jest.useFakeTimers();
    try {
      const { getByLabelText, findByText, queryByText } = render(<RecoveryPhraseScreen />);
      fireEvent.changeText(
        getByLabelText('Enter passphrase to view recovery phrase'),
        'correct',
      );
      fireEvent.press(getByLabelText('Reveal recovery phrase'));
      const words = FIXTURE_MNEMONIC.split(' ');
      // findByText polls; under fake timers the polling has to be
      // driven manually. Run pending micro-tasks first.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(await findByText(words[0])).toBeTruthy();

      // Advance past the 60s idle window.
      act(() => {
        jest.advanceTimersByTime(61_000);
      });

      expect(queryByText(words[0])).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
