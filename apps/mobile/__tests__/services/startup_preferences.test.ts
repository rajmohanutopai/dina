/**
 * Tests for startup-mode + auto-passphrase persistence. The hook drives
 * UnlockGate's "skip the prompt on launch" behavior — without this
 * persistence the StartupMode picker in onboarding is dead UI.
 */

import {
  clearAutoPassphrase,
  loadAutoPassphrase,
  loadStartupMode,
  persistStartupChoice,
  saveAutoPassphrase,
  saveStartupMode,
} from '../../src/services/startup_preferences';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';

beforeEach(() => {
  resetKeychainMock();
});

describe('startup_preferences', () => {
  it('returns null when nothing has been persisted', async () => {
    expect(await loadStartupMode()).toBeNull();
    expect(await loadAutoPassphrase()).toBeNull();
  });

  it('round-trips the startup mode', async () => {
    await saveStartupMode('auto');
    expect(await loadStartupMode()).toBe('auto');
    await saveStartupMode('manual');
    expect(await loadStartupMode()).toBe('manual');
  });

  it('round-trips the cached passphrase', async () => {
    await saveAutoPassphrase('hunter2-but-actually-long');
    expect(await loadAutoPassphrase()).toBe('hunter2-but-actually-long');
  });

  it('rejects an empty passphrase', async () => {
    await expect(saveAutoPassphrase('')).rejects.toThrow(/empty passphrase/);
  });

  it('clears the cached passphrase', async () => {
    await saveAutoPassphrase('temp');
    await clearAutoPassphrase();
    expect(await loadAutoPassphrase()).toBeNull();
  });

  describe('persistStartupChoice', () => {
    it('caches the passphrase when mode is auto', async () => {
      await persistStartupChoice('auto', 'mypass-12345');
      expect(await loadStartupMode()).toBe('auto');
      expect(await loadAutoPassphrase()).toBe('mypass-12345');
    });

    it('clears any prior cached passphrase when mode is manual', async () => {
      await saveAutoPassphrase('old-cached-pass');
      await persistStartupChoice('manual', 'new-pass');
      expect(await loadStartupMode()).toBe('manual');
      // Manual mode MUST NOT cache — anyone with device access could
      // recover the passphrase from keychain otherwise.
      expect(await loadAutoPassphrase()).toBeNull();
    });
  });
});
