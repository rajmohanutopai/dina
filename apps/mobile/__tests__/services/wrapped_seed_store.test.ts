/**
 * Tests for wrapped_seed_store — Keychain-backed persistence of the
 * Argon2id-wrapped master seed. Covers round-trip, corrupt-row handling,
 * and the first-run empty case.
 */

import {
  loadWrappedSeed,
  saveWrappedSeed,
  hasWrappedSeed,
  clearWrappedSeed,
} from '../../src/services/wrapped_seed_store';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';
import type { WrappedSeed } from '../../../core/src/crypto/aesgcm';
import * as Keychain from 'react-native-keychain';

function makeSeed(): WrappedSeed {
  return {
    salt: new Uint8Array(16).fill(0x11),
    wrapped: new Uint8Array(60).map((_, i) => (i * 7) & 0xff),
    params: { memory: 131072, iterations: 3, parallelism: 4 },
  };
}

beforeEach(() => {
  resetKeychainMock();
});

describe('wrapped_seed_store', () => {
  it('returns null when nothing has been saved', async () => {
    expect(await loadWrappedSeed()).toBeNull();
    expect(await hasWrappedSeed()).toBe(false);
  });

  it('round-trips a WrappedSeed byte-for-byte', async () => {
    const original = makeSeed();
    await saveWrappedSeed(original);
    expect(await hasWrappedSeed()).toBe(true);
    const loaded = await loadWrappedSeed();
    expect(loaded).not.toBeNull();
    expect(Array.from(loaded!.salt)).toEqual(Array.from(original.salt));
    expect(Array.from(loaded!.wrapped)).toEqual(Array.from(original.wrapped));
    expect(loaded!.params).toEqual(original.params);
  });

  it('clear removes the row', async () => {
    await saveWrappedSeed(makeSeed());
    expect(await hasWrappedSeed()).toBe(true);
    await clearWrappedSeed();
    expect(await hasWrappedSeed()).toBe(false);
    expect(await loadWrappedSeed()).toBeNull();
  });

  it('overwrites on resave', async () => {
    const a = makeSeed();
    const b: WrappedSeed = {
      salt: new Uint8Array(16).fill(0x22),
      wrapped: new Uint8Array(60).fill(0x33),
      params: { memory: 65536, iterations: 2, parallelism: 2 },
    };
    await saveWrappedSeed(a);
    await saveWrappedSeed(b);
    const loaded = await loadWrappedSeed();
    expect(Array.from(loaded!.salt)).toEqual(Array.from(b.salt));
    expect(loaded!.params.memory).toBe(65536);
  });

  it('returns null on non-JSON payload (corrupt row)', async () => {
    await Keychain.setGenericPassword('x', 'not json {', {
      service: 'dina.vault.wrapped_seed',
    });
    expect(await loadWrappedSeed()).toBeNull();
  });

  it('returns null on wrong schema version', async () => {
    await Keychain.setGenericPassword(
      'x',
      JSON.stringify({
        v: 2,
        saltHex: '00'.repeat(16),
        wrappedHex: '00'.repeat(60),
        params: { memory: 1, iterations: 1, parallelism: 1 },
      }),
      { service: 'dina.vault.wrapped_seed' },
    );
    expect(await loadWrappedSeed()).toBeNull();
  });

  it('returns null on wrong-length salt', async () => {
    await Keychain.setGenericPassword(
      'x',
      JSON.stringify({
        v: 1,
        saltHex: '00'.repeat(8),
        wrappedHex: '00'.repeat(60),
        params: { memory: 1, iterations: 1, parallelism: 1 },
      }),
      { service: 'dina.vault.wrapped_seed' },
    );
    expect(await loadWrappedSeed()).toBeNull();
  });

  it('returns null when wrapped blob is too short to hold nonce+tag', async () => {
    await Keychain.setGenericPassword(
      'x',
      JSON.stringify({
        v: 1,
        saltHex: '00'.repeat(16),
        wrappedHex: '00'.repeat(12),
        params: { memory: 1, iterations: 1, parallelism: 1 },
      }),
      { service: 'dina.vault.wrapped_seed' },
    );
    expect(await loadWrappedSeed()).toBeNull();
  });

  it('returns null on missing params', async () => {
    await Keychain.setGenericPassword(
      'x',
      JSON.stringify({
        v: 1,
        saltHex: '00'.repeat(16),
        wrappedHex: '00'.repeat(60),
      }),
      { service: 'dina.vault.wrapped_seed' },
    );
    expect(await loadWrappedSeed()).toBeNull();
  });

  it('returns null on malformed hex', async () => {
    await Keychain.setGenericPassword(
      'x',
      JSON.stringify({
        v: 1,
        saltHex: 'zzzz' + '00'.repeat(14),
        wrappedHex: '00'.repeat(60),
        params: { memory: 1, iterations: 1, parallelism: 1 },
      }),
      { service: 'dina.vault.wrapped_seed' },
    );
    expect(await loadWrappedSeed()).toBeNull();
  });
});
