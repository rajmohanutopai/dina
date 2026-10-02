/**
 * Changing the passphrase must not change a single vault key.
 *
 * Found on the iPhone (30 Sep 2026): after Settings → Security → Change
 * passphrase, the next start could not open any database and the unlock
 * "self-heal" deleted them all — memories, chat, orders, contacts. Cause:
 * every vault key was derived from the passphrase-WRAP salt, and a re-wrap
 * picks a new random salt. The keys now come from a vault salt the record
 * keeps for good.
 *
 * "Sign out" then recovering with the same phrase on the same device broke
 * the same way (sign-out clears the wrapped seed; the recovery wrap picks a
 * new salt). The keys now come from the device's vault salt, kept apart.
 *
 * Runs the real path: the real Argon2id wrap and re-wrap, the real
 * keychain-backed stores, the real change-passphrase service, and the real
 * key derivation. `keysWith` derives exactly as unlock does.
 */

import { derivePersonaDEK, unwrapSeed, wrapSeed } from '@dina/core';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as Keychain from 'react-native-keychain';

import { resetKeychainMock } from '../../__mocks__/react-native-keychain';
import { changeVaultPassphrase } from '../../src/services/change_passphrase';
import { clearOrphanKeychainState } from '../../src/services/install_marker';
import { ensureVaultSalt, loadVaultSalt } from '../../src/services/vault_salt_store';
import {
  clearWrappedSeed,
  loadWrappedSeed,
  saveWrappedSeed,
} from '../../src/services/wrapped_seed_store';

jest.mock('../../src/services/startup_preferences', () => ({
  loadStartupMode: jest.fn(async () => 'manual'),
  saveAutoPassphrase: jest.fn(async () => undefined),
}));

const OLD = 'OldPass123';
const NEW = 'NewPass456';
const PERSONAS = ['identity', 'general', 'work', 'health', 'finance'];

function seed32(): Uint8Array {
  return new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);
}

/** The vault keys as unlock derives them: the vault salt, pinned on first use. */
async function keysWith(passphrase: string): Promise<Record<string, string>> {
  const wrapped = await loadWrappedSeed();
  if (wrapped === null) throw new Error('no record');
  const salt = await ensureVaultSalt(wrapped.salt);
  const seed = await unwrapSeed(passphrase, wrapped);
  return Object.fromEntries(PERSONAS.map((p) => [p, bytesToHex(derivePersonaDEK(seed, p, salt))]));
}

beforeEach(() => resetKeychainMock());

it('every vault key is the same before and after a passphrase change', async () => {
  await saveWrappedSeed(await wrapSeed(OLD, seed32()));
  const before = await keysWith(OLD);
  const wrapSaltBefore = (await loadWrappedSeed())?.salt;

  expect(await changeVaultPassphrase(OLD, NEW)).toEqual({ ok: true });

  // The re-wrap did pick a new wrap salt — the very thing that used to re-key.
  expect(bytesToHex((await loadWrappedSeed())?.salt ?? new Uint8Array())).not.toBe(
    bytesToHex(wrapSaltBefore ?? new Uint8Array()),
  );
  expect(await keysWith(NEW)).toEqual(before);
});

it('twice in a row: still the keys the vaults were made with', async () => {
  await saveWrappedSeed(await wrapSeed(OLD, seed32()));
  const before = await keysWith(OLD);
  await changeVaultPassphrase(OLD, NEW);
  await changeVaultPassphrase(NEW, 'Third789x');
  expect(await keysWith('Third789x')).toEqual(before);
});

it('a device set up before this fix keeps its keys through its first passphrase change', async () => {
  // A pre-fix record: no vault salt, so its vaults were made with its wrap salt.
  const wrapped = await wrapSeed(OLD, seed32());
  await Keychain.setGenericPassword(
    'dina_vault',
    JSON.stringify({
      v: 1,
      saltHex: bytesToHex(wrapped.salt),
      wrappedHex: bytesToHex(wrapped.wrapped),
      params: wrapped.params,
    }),
    { service: 'dina.vault.wrapped_seed' },
  );
  const madeWith = Object.fromEntries(
    PERSONAS.map((p) => [p, bytesToHex(derivePersonaDEK(seed32(), p, wrapped.salt))]),
  );
  expect(await keysWith(OLD)).toEqual(madeWith);

  expect(await changeVaultPassphrase(OLD, NEW)).toEqual({ ok: true });
  expect(await keysWith(NEW)).toEqual(madeWith);
});

it('sign out, then recover with the same phrase on this device: the same keys open the same vaults', async () => {
  await saveWrappedSeed(await wrapSeed(OLD, seed32()));
  const before = await keysWith(OLD);
  // Sign out clears the wrapped seed (and only that, of these two).
  await clearWrappedSeed();
  // Recovery re-wraps the same seed under a passphrase, with a new salt.
  await saveWrappedSeed(await wrapSeed('Recovered1x', seed32()));
  expect(await keysWith('Recovered1x')).toEqual(before);
});

it('erase / reinstall clean-up forgets the vault salt along with the databases', async () => {
  await saveWrappedSeed(await wrapSeed(OLD, seed32()));
  await keysWith(OLD);
  expect(await loadVaultSalt()).not.toBeNull();
  await clearOrphanKeychainState();
  expect(await loadVaultSalt()).toBeNull();
});
