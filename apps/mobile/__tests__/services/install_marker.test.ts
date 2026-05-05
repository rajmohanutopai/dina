/**
 * Tests for the install marker — the MT-27 orphan-keychain detector.
 *
 * The marker file lives in app-data (wiped on uninstall). Keychain
 * entries persist across uninstalls. The boot path uses presence/
 * absence of the marker to decide whether the keychain belongs to
 * THIS install or a prior one.
 */

import * as Keychain from 'react-native-keychain';
import {
  __getDeletedEntries,
  __getEntries,
  __getFileContents,
  __hasFile,
  __resetFileSystemMock,
  __setEntries,
  __setExists,
  __setFileContents,
  __throwOnDelete,
  __throwOnFileExists,
  __throwOnFileWrite,
  __throwOnList,
} from 'expo-file-system';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';
import {
  clearOrphanKeychainState,
  installMarkerExists,
  wipeOrphanVaultFiles,
  writeInstallMarker,
} from '../../src/services/install_marker';

const MARKER = '.dina_install';

beforeEach(() => {
  __resetFileSystemMock();
  resetKeychainMock();
});

describe('installMarkerExists', () => {
  it('returns false on a fresh install (no marker file)', () => {
    expect(installMarkerExists()).toBe(false);
  });

  it('returns true once the marker has been written', () => {
    writeInstallMarker(1_700_000_000_000);
    expect(installMarkerExists()).toBe(true);
  });

  it('treats a thrown exists check as "marker missing" so the boot flow re-provisions', () => {
    __throwOnFileExists(true);
    expect(installMarkerExists()).toBe(false);
  });
});

describe('writeInstallMarker', () => {
  it('creates the marker file with a JSON body containing version + timestamp', () => {
    writeInstallMarker(1_700_000_000_000);
    const body = __getFileContents(MARKER);
    expect(body).toBeDefined();
    const parsed = JSON.parse(body!);
    expect(parsed).toEqual({ version: 1, installedAt: 1_700_000_000_000 });
  });

  it('is idempotent — calling twice does not overwrite the original install timestamp', () => {
    writeInstallMarker(1_700_000_000_000);
    writeInstallMarker(1_800_000_000_000);
    const parsed = JSON.parse(__getFileContents(MARKER)!);
    // First call's timestamp wins; the second is a no-op.
    expect(parsed.installedAt).toBe(1_700_000_000_000);
  });

  it('swallows write failures so a flaky filesystem does not crash the boot path', () => {
    __throwOnFileWrite(MARKER);
    expect(() => writeInstallMarker(1_700_000_000_000)).not.toThrow();
  });
});

describe('clearOrphanKeychainState', () => {
  it('wipes the wrapped seed', async () => {
    await Keychain.setGenericPassword('user', 'wrapped-seed-bytes', {
      service: 'dina.vault.wrapped_seed',
    });
    await clearOrphanKeychainState();
    const after = await Keychain.getGenericPassword({ service: 'dina.vault.wrapped_seed' });
    expect(after).toBeFalsy();
  });

  it('wipes the auto-passphrase + startup mode so auto-unlock cannot fire against an orphan seed', async () => {
    await Keychain.setGenericPassword('user', 'auto', { service: 'dina.startup.mode' });
    await Keychain.setGenericPassword('user', 'p4ss', { service: 'dina.startup.passphrase' });
    await clearOrphanKeychainState();
    expect(await Keychain.getGenericPassword({ service: 'dina.startup.mode' })).toBeFalsy();
    expect(await Keychain.getGenericPassword({ service: 'dina.startup.passphrase' })).toBeFalsy();
  });

  it('wipes infra preferences so the next install does not inherit a stale PDS handle', async () => {
    await Keychain.setGenericPassword('user', 'alice.test-pds', {
      service: 'dina.infra.pds_handle',
    });
    await Keychain.setGenericPassword('user', 'https://test-pds', {
      service: 'dina.infra.pds_url',
    });
    await clearOrphanKeychainState();
    expect(await Keychain.getGenericPassword({ service: 'dina.infra.pds_handle' })).toBeFalsy();
    expect(await Keychain.getGenericPassword({ service: 'dina.infra.pds_url' })).toBeFalsy();
  });

  it('wipes per-provider LLM keys so they do not leak across installs', async () => {
    await Keychain.setGenericPassword('user', 'sk-prior-install', {
      service: 'dina.llm.openai',
    });
    await clearOrphanKeychainState();
    expect(await Keychain.getGenericPassword({ service: 'dina.llm.openai' })).toBeFalsy();
  });

  it('wipes the deferred-verification flag so a reinstall does not inherit "pending"', async () => {
    // If the flag survived a reinstall, a fresh user would land on
    // chat home with a confirm-banner referencing a phrase they
    // never saw — produced by the prior install's onboarding.
    await Keychain.setGenericPassword('user', 'pending', {
      service: 'dina.verification_status',
    });
    await clearOrphanKeychainState();
    expect(
      await Keychain.getGenericPassword({ service: 'dina.verification_status' }),
    ).toBeFalsy();
  });

  it('does not throw when individual services are missing', async () => {
    await expect(clearOrphanKeychainState()).resolves.toBeUndefined();
  });
});

describe('wipeOrphanVaultFiles', () => {
  it('deletes every .sqlite, .sqlite-wal, .sqlite-shm, and .sqlite-journal entry', () => {
    __setEntries([
      'identity.sqlite',
      'identity.sqlite-wal',
      'identity.sqlite-shm',
      'general.sqlite',
      'general.sqlite-journal',
    ]);
    wipeOrphanVaultFiles();
    expect(__getDeletedEntries().sort()).toEqual(
      [
        'general.sqlite',
        'general.sqlite-journal',
        'identity.sqlite',
        'identity.sqlite-shm',
        'identity.sqlite-wal',
      ].sort(),
    );
    expect(__getEntries()).toEqual([]);
  });

  it("leaves non-SQLite files alone (Expo cache, fonts, install marker)", () => {
    __setEntries([
      'identity.sqlite',
      'fonts.ttf',
      'cache.dat',
      '.dina_install',
      'README.md',
    ]);
    wipeOrphanVaultFiles();
    expect(__getDeletedEntries()).toEqual(['identity.sqlite']);
    // The other four should still be present.
    expect(__getEntries().sort()).toEqual(
      ['.dina_install', 'README.md', 'cache.dat', 'fonts.ttf'].sort(),
    );
  });

  it('is a no-op when the documents directory does not exist', () => {
    __setExists(false);
    expect(() => wipeOrphanVaultFiles()).not.toThrow();
    expect(__getDeletedEntries()).toEqual([]);
  });

  it('survives a per-file delete failure and continues with the rest', () => {
    __setEntries(['a.sqlite', 'b.sqlite', 'c.sqlite']);
    __throwOnDelete('b.sqlite');
    wipeOrphanVaultFiles();
    // a + c deleted; b remained because its delete threw.
    expect(__getDeletedEntries().sort()).toEqual(['a.sqlite', 'c.sqlite']);
    expect(__getEntries()).toEqual(['b.sqlite']);
  });

  it('survives a directory-listing failure', () => {
    __throwOnList(true);
    expect(() => wipeOrphanVaultFiles()).not.toThrow();
    expect(__getDeletedEntries()).toEqual([]);
  });
});

describe('boot orchestration scenarios', () => {
  it('fresh install: no marker, no seed → write marker, no clear needed', async () => {
    expect(installMarkerExists()).toBe(false);
    expect(
      await Keychain.getGenericPassword({ service: 'dina.vault.wrapped_seed' }),
    ).toBeFalsy();
    writeInstallMarker();
    expect(__hasFile(MARKER)).toBe(true);
  });

  it('returning user: marker present + seed present → no clear, normal boot', async () => {
    writeInstallMarker(1_700_000_000_000);
    await Keychain.setGenericPassword('user', 'sealed', {
      service: 'dina.vault.wrapped_seed',
    });
    expect(installMarkerExists()).toBe(true);
    const seed = await Keychain.getGenericPassword({ service: 'dina.vault.wrapped_seed' });
    expect(seed).toBeTruthy();
  });

  it('reinstall over orphan keychain: no marker + seed present → clear, then write marker', async () => {
    // Simulate the orphaned post-uninstall state: keychain still has
    // entries from the prior install, but the data dir is empty.
    await Keychain.setGenericPassword('user', 'sealed', {
      service: 'dina.vault.wrapped_seed',
    });
    await Keychain.setGenericPassword('user', 'auto', { service: 'dina.startup.mode' });
    await Keychain.setGenericPassword('user', 'p4ss', {
      service: 'dina.startup.passphrase',
    });
    expect(installMarkerExists()).toBe(false);

    // Boot logic: marker missing + seed present → orphan path.
    if (!installMarkerExists()) {
      const stale = await Keychain.getGenericPassword({
        service: 'dina.vault.wrapped_seed',
      });
      if (stale) await clearOrphanKeychainState();
      writeInstallMarker(1_700_000_000_000);
    }

    expect(
      await Keychain.getGenericPassword({ service: 'dina.vault.wrapped_seed' }),
    ).toBeFalsy();
    expect(
      await Keychain.getGenericPassword({ service: 'dina.startup.mode' }),
    ).toBeFalsy();
    expect(
      await Keychain.getGenericPassword({ service: 'dina.startup.passphrase' }),
    ).toBeFalsy();
    expect(installMarkerExists()).toBe(true);
  });
});
