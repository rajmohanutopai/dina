/**
 * active_provider — the durable store that replaced the two-places
 * activeProvider state. Proves the round-trip, the cache contract the
 * synchronous `peekActiveProvider()` hangs on, and rejection of
 * unknown provider ids (review findings #5, #16).
 */

import {
  loadActiveProvider,
  saveActiveProvider,
  peekActiveProvider,
  resetActiveProviderCache,
} from '../../src/ai/active_provider';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';

beforeEach(() => {
  resetKeychainMock();
  resetActiveProviderCache();
});

describe('saveActiveProvider + loadActiveProvider — durable round-trip (#5)', () => {
  it('returns null when nothing has ever been saved', async () => {
    const got = await loadActiveProvider();
    expect(got).toBeNull();
    expect(peekActiveProvider()).toBeNull();
  });

  it('round-trips a persisted provider across a cache reset', async () => {
    await saveActiveProvider('openai');
    expect(peekActiveProvider()).toBe('openai');
    // Simulate a fresh app launch: cache drops, keychain survives.
    resetActiveProviderCache();
    expect(peekActiveProvider()).toBeNull();
    const reloaded = await loadActiveProvider();
    expect(reloaded).toBe('openai');
    expect(peekActiveProvider()).toBe('openai');
  });

  it('save(null) clears the persisted selection', async () => {
    await saveActiveProvider('gemini');
    await saveActiveProvider(null);
    expect(peekActiveProvider()).toBeNull();
    resetActiveProviderCache();
    expect(await loadActiveProvider()).toBeNull();
  });
});

describe('saveActiveProvider — input validation', () => {
  it('rejects provider ids that are not in PROVIDERS', async () => {
    await expect(saveActiveProvider('bogus' as 'openai')).rejects.toThrow(/invalid provider/i);
  });
});

describe('loadActiveProvider — ignores stale / corrupt keychain rows', () => {
  it('returns null when the stored value is not a known provider', async () => {
    // Poison the keychain directly with an unknown id — simulates a
    // downgrade or a partially-migrated install.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const keychain = require('../../__mocks__/react-native-keychain');
    await keychain.setGenericPassword('x', 'stale-row', { service: 'dina.active_provider' });
    const got = await loadActiveProvider();
    expect(got).toBeNull();
  });
});
