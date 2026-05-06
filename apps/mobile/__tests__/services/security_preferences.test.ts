/**
 * Tests for the security-preferences keychain module (MT-40-I3).
 *
 * The auto-lock background timeout has to survive a cold launch —
 * without persistence every restart resets to the 5-minute default
 * and the user's pick silently reverts.
 */

import {
  clearBackgroundTimeoutPreference,
  loadBackgroundTimeoutPreference,
  saveBackgroundTimeoutPreference,
} from '../../src/services/security_preferences';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';

beforeEach(() => {
  resetKeychainMock();
});

describe('security_preferences', () => {
  it('returns null when nothing has been persisted', async () => {
    expect(await loadBackgroundTimeoutPreference()).toBeNull();
  });

  it('round-trips the timeout value', async () => {
    await saveBackgroundTimeoutPreference(60);
    expect(await loadBackgroundTimeoutPreference()).toBe(60);
    await saveBackgroundTimeoutPreference(1800);
    expect(await loadBackgroundTimeoutPreference()).toBe(1800);
  });

  it('accepts zero (lock-immediately)', async () => {
    await saveBackgroundTimeoutPreference(0);
    expect(await loadBackgroundTimeoutPreference()).toBe(0);
  });

  it('rejects negative values', async () => {
    await expect(saveBackgroundTimeoutPreference(-1)).rejects.toThrow(/non-negative/);
  });

  it('rejects non-finite values', async () => {
    await expect(saveBackgroundTimeoutPreference(Number.NaN)).rejects.toThrow(/non-negative/);
    await expect(saveBackgroundTimeoutPreference(Number.POSITIVE_INFINITY)).rejects.toThrow(
      /non-negative/,
    );
  });

  it('floors fractional values to a whole number of seconds', async () => {
    // The picker only exposes integer presets, but a future caller
    // (e.g. a programmatic API) might pass 60.7. Keep the on-disk
    // representation tidy.
    await saveBackgroundTimeoutPreference(60.7);
    expect(await loadBackgroundTimeoutPreference()).toBe(60);
  });

  it('returns null when the persisted value is corrupt', async () => {
    // Simulate a corrupted keychain row (manual setItem with a
    // non-numeric string). The loader must not surface NaN /
    // negatives — fall back to "not set" so the caller picks the
    // safe default.
    const Keychain = await import('react-native-keychain');
    await Keychain.setGenericPassword(
      'dina.security.background_timeout_s',
      'not-a-number',
      { service: 'dina.security.background_timeout_s' },
    );
    expect(await loadBackgroundTimeoutPreference()).toBeNull();
  });

  it('clears the persisted preference', async () => {
    await saveBackgroundTimeoutPreference(60);
    await clearBackgroundTimeoutPreference();
    expect(await loadBackgroundTimeoutPreference()).toBeNull();
  });
});
