/**
 * Tests for `local_data_wipe.ts` — Tier 1 (sign out) + Tier 2 (erase
 * everything).
 *
 * The helpers compose four module-level singletons, so we mock each one
 * and pin the call ORDER + the failure-tolerance contract:
 *   - signOutLocal: clears wrapped seed + identity keys + persisted DID
 *     + resets the unlock state. All four must run.
 *   - eraseEverythingLocal: closes SQLCipher, deletes only `.sqlite*`
 *     artifacts (NOT other files), then runs signOutLocal LAST. Both
 *     shutdown failure AND list-directory failure are tolerated — the
 *     wipe must still finish (otherwise a partial-state device gets
 *     stuck mid-erase).
 */

import {
  __setEntries,
  __getEntries,
  __getDeletedEntries,
  __setExists,
  __throwOnList,
  __throwOnDelete,
  __resetFileSystemMock,
} from 'expo-file-system';

// Hoisted mocks for every module the helper composes. Each one records
// call order so we can assert on the strict sequence (keys-last so a
// crash mid-wipe still leaves the device in a clean re-onboardable
// state).
const callLog: string[] = [];

jest.mock('../../src/services/wrapped_seed_store', () => ({
  clearWrappedSeed: jest.fn(async () => {
    callLog.push('clearWrappedSeed');
  }),
}));

jest.mock('../../src/services/identity_store', () => ({
  clearIdentitySeeds: jest.fn(async () => {
    callLog.push('clearIdentitySeeds');
  }),
}));

jest.mock('../../src/services/identity_record', () => ({
  clearPersistedDid: jest.fn(async () => {
    callLog.push('clearPersistedDid');
  }),
}));

jest.mock('../../src/services/display_name_override', () => ({
  clearDisplayNameOverride: jest.fn(async () => {
    callLog.push('clearDisplayNameOverride');
  }),
}));

jest.mock('../../src/services/startup_preferences', () => ({
  clearAutoPassphrase: jest.fn(async () => {
    callLog.push('clearAutoPassphrase');
  }),
}));

jest.mock('../../src/services/install_marker', () => ({
  clearOrphanKeychainState: jest.fn(async () => {
    callLog.push('clearOrphanKeychainState');
  }),
  deleteInstallMarker: jest.fn(() => {
    callLog.push('deleteInstallMarker');
  }),
}));

jest.mock('expo-notifications', () => ({
  cancelAllScheduledNotificationsAsync: jest.fn(async () => {
    callLog.push('cancelAllScheduledNotificationsAsync');
  }),
}));

jest.mock('../../src/hooks/useUnlock', () => ({
  resetUnlockState: jest.fn(() => {
    callLog.push('resetUnlockState');
  }),
}));

jest.mock('../../src/storage/init', () => ({
  shutdownAllPersistence: jest.fn(async () => {
    callLog.push('shutdownAllPersistence');
  }),
}));

import * as Notifications from 'expo-notifications';

import { resetUnlockState } from '../../src/hooks/useUnlock';
import { clearDisplayNameOverride } from '../../src/services/display_name_override';
import { clearPersistedDid } from '../../src/services/identity_record';
import { clearIdentitySeeds } from '../../src/services/identity_store';
import {
  clearOrphanKeychainState,
  deleteInstallMarker,
} from '../../src/services/install_marker';
import { signOutLocal, eraseEverythingLocal } from '../../src/services/local_data_wipe';
import { clearAutoPassphrase } from '../../src/services/startup_preferences';
import { clearWrappedSeed } from '../../src/services/wrapped_seed_store';
import { shutdownAllPersistence } from '../../src/storage/init';

describe('signOutLocal', () => {
  beforeEach(() => {
    callLog.length = 0;
    jest.clearAllMocks();
  });

  it('clears wrapped seed + identity keys + persisted DID + display-name override + auto-passphrase cache + resets unlock state', async () => {
    await signOutLocal();
    expect(clearWrappedSeed).toHaveBeenCalledTimes(1);
    expect(clearIdentitySeeds).toHaveBeenCalledTimes(1);
    expect(clearPersistedDid).toHaveBeenCalledTimes(1);
    expect(clearDisplayNameOverride).toHaveBeenCalledTimes(1);
    // The auto-unlock keychain row must go too — without this, a
    // post-sign-out boot would still find the cached passphrase.
    // The startup MODE preference (auto vs manual) is left intact so
    // re-onboard with the same recovery phrase resumes the chosen
    // behaviour.
    expect(clearAutoPassphrase).toHaveBeenCalledTimes(1);
    expect(resetUnlockState).toHaveBeenCalledTimes(1);
  });

  it('runs the clears in deterministic order', async () => {
    await signOutLocal();
    expect(callLog).toEqual([
      'clearWrappedSeed',
      'clearIdentitySeeds',
      'clearPersistedDid',
      'clearDisplayNameOverride',
      'clearAutoPassphrase',
      'resetUnlockState',
    ]);
  });

  it('propagates errors so the UI alert can render the message', async () => {
    const boom = new Error('keychain locked');
    (clearWrappedSeed as jest.Mock).mockRejectedValueOnce(boom);
    await expect(signOutLocal()).rejects.toThrow('keychain locked');
  });
});

describe('eraseEverythingLocal', () => {
  beforeEach(() => {
    callLog.length = 0;
    jest.clearAllMocks();
    __resetFileSystemMock();
  });

  it('closes persistence, deletes every .sqlite-family file, cancels notifications, sweeps keychain, drops marker, then runs signOutLocal', async () => {
    __setEntries([
      'identity.sqlite',
      'identity.sqlite-wal',
      'identity.sqlite-shm',
      'identity.sqlite-journal',
      'general.sqlite',
      'general.sqlite-wal',
    ]);

    await eraseEverythingLocal();

    // Every SQLite artifact deleted, none left behind.
    expect(__getDeletedEntries().sort()).toEqual(
      [
        'identity.sqlite',
        'identity.sqlite-wal',
        'identity.sqlite-shm',
        'identity.sqlite-journal',
        'general.sqlite',
        'general.sqlite-wal',
      ].sort(),
    );
    expect(__getEntries()).toEqual([]);

    // Order: shutdown FIRST (release file locks), file delete next,
    // notifications cancelled, broad keychain sweep, install-marker
    // drop, THEN signOutLocal at the end (keys last so a crash mid-
    // wipe leaves the device cleanly re-onboardable).
    expect(callLog).toEqual([
      'shutdownAllPersistence',
      'cancelAllScheduledNotificationsAsync',
      'clearOrphanKeychainState',
      'deleteInstallMarker',
      'clearWrappedSeed',
      'clearIdentitySeeds',
      'clearPersistedDid',
      'clearDisplayNameOverride',
      'clearAutoPassphrase',
      'resetUnlockState',
    ]);
  });

  it('cancels every scheduled local notification (P0 — wiped device must not ping the user)', async () => {
    await eraseEverythingLocal();
    expect(Notifications.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(1);
  });

  it('sweeps every keychain service the app owns (LLM keys, infra prefs, role, etc.)', async () => {
    // The narrow signOutLocal only clears identity-related rows. For
    // Tier 2 ("Erase everything"), the user expects NOTHING to
    // survive — so the broad sweep MUST run.
    await eraseEverythingLocal();
    expect(clearOrphanKeychainState).toHaveBeenCalledTimes(1);
  });

  it('deletes the install marker so the next boot is treated as a true fresh install', async () => {
    await eraseEverythingLocal();
    expect(deleteInstallMarker).toHaveBeenCalledTimes(1);
  });

  it('still finishes the keychain sweep when notifications cancellation throws', async () => {
    (Notifications.cancelAllScheduledNotificationsAsync as jest.Mock)
      .mockRejectedValueOnce(new Error('expo-notifications init failed'));
    await eraseEverythingLocal();
    expect(clearOrphanKeychainState).toHaveBeenCalled();
    expect(deleteInstallMarker).toHaveBeenCalled();
    expect(resetUnlockState).toHaveBeenCalled();
  });

  it('still completes the wipe when clearOrphanKeychainState throws', async () => {
    (clearOrphanKeychainState as jest.Mock).mockRejectedValueOnce(new Error('keychain offline'));
    await eraseEverythingLocal();
    // The narrow signOutLocal still runs so the user can at least re-
    // onboard, even if the broader keychain sweep didn't fully complete.
    expect(clearWrappedSeed).toHaveBeenCalled();
    expect(resetUnlockState).toHaveBeenCalled();
  });

  it('does NOT delete non-sqlite files in the document directory', async () => {
    __setEntries([
      'identity.sqlite',
      'fonts.cache',
      'image-cache.png',
      'expo-config.json',
    ]);

    await eraseEverythingLocal();

    expect(__getDeletedEntries()).toEqual(['identity.sqlite']);
    expect(__getEntries().sort()).toEqual(['expo-config.json', 'fonts.cache', 'image-cache.png']);
  });

  it('still runs signOutLocal when shutdownAllPersistence throws', async () => {
    (shutdownAllPersistence as jest.Mock).mockRejectedValueOnce(new Error('op-sqlite hung'));
    __setEntries(['identity.sqlite']);

    await eraseEverythingLocal();

    // shutdown threw — we recovered, deleted the file anyway, then
    // cleared keys.
    expect(__getDeletedEntries()).toEqual(['identity.sqlite']);
    expect(clearWrappedSeed).toHaveBeenCalled();
    expect(clearIdentitySeeds).toHaveBeenCalled();
    expect(clearPersistedDid).toHaveBeenCalled();
    expect(resetUnlockState).toHaveBeenCalled();
  });

  it('still runs signOutLocal when directory listing throws', async () => {
    __throwOnList(true);

    await eraseEverythingLocal();

    expect(__getDeletedEntries()).toEqual([]);
    // Even though we couldn't enumerate the dir, identity must still
    // be cleared so the user can re-onboard.
    expect(clearWrappedSeed).toHaveBeenCalled();
    expect(clearIdentitySeeds).toHaveBeenCalled();
    expect(clearPersistedDid).toHaveBeenCalled();
    expect(resetUnlockState).toHaveBeenCalled();
  });

  it('one file failing to delete does not abort the rest of the wipe', async () => {
    __setEntries([
      'identity.sqlite',
      'general.sqlite',
      'health.sqlite',
    ]);
    __throwOnDelete('general.sqlite'); // simulate a stuck file lock on one

    await eraseEverythingLocal();

    // Other files still got deleted.
    expect(__getDeletedEntries().sort()).toEqual(['health.sqlite', 'identity.sqlite']);
    // identity was still cleared.
    expect(clearWrappedSeed).toHaveBeenCalled();
  });

  it('skips file walk gracefully when document directory does not exist', async () => {
    __setExists(false);

    await eraseEverythingLocal();

    expect(__getDeletedEntries()).toEqual([]);
    // Identity-clear path still ran.
    expect(clearWrappedSeed).toHaveBeenCalled();
    expect(clearIdentitySeeds).toHaveBeenCalled();
    expect(clearPersistedDid).toHaveBeenCalled();
    expect(resetUnlockState).toHaveBeenCalled();
  });

  it('runs cleanly with an empty document directory', async () => {
    __setEntries([]);

    await eraseEverythingLocal();

    expect(__getDeletedEntries()).toEqual([]);
    expect(callLog).toEqual([
      'shutdownAllPersistence',
      'cancelAllScheduledNotificationsAsync',
      'clearOrphanKeychainState',
      'deleteInstallMarker',
      'clearWrappedSeed',
      'clearIdentitySeeds',
      'clearPersistedDid',
      'clearDisplayNameOverride',
      'clearAutoPassphrase',
      'resetUnlockState',
    ]);
  });
});
