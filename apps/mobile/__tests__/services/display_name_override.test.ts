/**
 * Tests for the display-name override service.
 *
 * The override is the local "rename your id" feature exposed in the
 * admin page. It must:
 *   - normalize input (trim, length-cap)
 *   - persist round-trip through the keychain
 *   - notify subscribers exactly when the snapshot changes
 *   - clear cleanly on the wipe path
 */

import {
  hydrateDisplayNameOverride,
  setDisplayNameOverride,
  clearDisplayNameOverride,
  getDisplayNameOverride,
  subscribeDisplayNameOverride,
  resetDisplayNameOverrideForTest,
} from '../../src/services/display_name_override';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';
import * as Keychain from 'react-native-keychain';

beforeEach(() => {
  resetKeychainMock();
  resetDisplayNameOverrideForTest();
});

describe('display_name_override', () => {
  describe('hydrate', () => {
    it('starts as null when nothing is stored', async () => {
      await hydrateDisplayNameOverride();
      expect(getDisplayNameOverride()).toBeNull();
    });

    it('loads a previously-stored override', async () => {
      await Keychain.setGenericPassword('x', 'Sancho', {
        service: 'dina.display_name_override',
      });
      await hydrateDisplayNameOverride();
      expect(getDisplayNameOverride()).toBe('Sancho');
    });

    it('is idempotent — second call is a no-op', async () => {
      await Keychain.setGenericPassword('x', 'Sancho', {
        service: 'dina.display_name_override',
      });
      await hydrateDisplayNameOverride();
      // Mutate the keychain after first hydrate; subsequent hydrate
      // calls must not re-read or overwrite the in-memory snapshot.
      await Keychain.setGenericPassword('x', 'Different', {
        service: 'dina.display_name_override',
      });
      await hydrateDisplayNameOverride();
      expect(getDisplayNameOverride()).toBe('Sancho');
    });
  });

  describe('set', () => {
    it('persists a value and reflects it in the snapshot', async () => {
      const written = await setDisplayNameOverride('Don Alonso');
      expect(written).toBe('Don Alonso');
      expect(getDisplayNameOverride()).toBe('Don Alonso');
      const row = await Keychain.getGenericPassword({
        service: 'dina.display_name_override',
      });
      expect(row && row.password).toBe('Don Alonso');
    });

    it('trims surrounding whitespace before persisting', async () => {
      const written = await setDisplayNameOverride('  Sancho  ');
      expect(written).toBe('Sancho');
      expect(getDisplayNameOverride()).toBe('Sancho');
    });

    it('treats empty string as a clear', async () => {
      await setDisplayNameOverride('Sancho');
      const written = await setDisplayNameOverride('');
      expect(written).toBeNull();
      expect(getDisplayNameOverride()).toBeNull();
      const row = await Keychain.getGenericPassword({
        service: 'dina.display_name_override',
      });
      expect(row).toBe(false);
    });

    it('treats whitespace-only as a clear', async () => {
      await setDisplayNameOverride('Sancho');
      const written = await setDisplayNameOverride('   \t  ');
      expect(written).toBeNull();
      expect(getDisplayNameOverride()).toBeNull();
    });

    it('truncates values longer than 64 chars', async () => {
      const long = 'A'.repeat(80);
      const written = await setDisplayNameOverride(long);
      expect(written).not.toBeNull();
      expect(written!.length).toBe(64);
      expect(getDisplayNameOverride()).toBe('A'.repeat(64));
    });
  });

  describe('clear', () => {
    it('removes the stored row and resets the snapshot', async () => {
      await setDisplayNameOverride('Sancho');
      await clearDisplayNameOverride();
      expect(getDisplayNameOverride()).toBeNull();
      const row = await Keychain.getGenericPassword({
        service: 'dina.display_name_override',
      });
      expect(row).toBe(false);
    });

    it('is a no-op when nothing was stored', async () => {
      await expect(clearDisplayNameOverride()).resolves.toBeUndefined();
      expect(getDisplayNameOverride()).toBeNull();
    });
  });

  describe('subscribe', () => {
    it('notifies on set', async () => {
      const calls: number[] = [];
      const unsub = subscribeDisplayNameOverride(() => calls.push(1));
      await setDisplayNameOverride('Sancho');
      expect(calls.length).toBe(1);
      unsub();
    });

    it('notifies on clear', async () => {
      await setDisplayNameOverride('Sancho');
      const calls: number[] = [];
      const unsub = subscribeDisplayNameOverride(() => calls.push(1));
      await clearDisplayNameOverride();
      expect(calls.length).toBe(1);
      unsub();
    });

    it('does not notify when set is a no-op (same value)', async () => {
      await setDisplayNameOverride('Sancho');
      const calls: number[] = [];
      const unsub = subscribeDisplayNameOverride(() => calls.push(1));
      // Same normalized value — snapshot didn't change. Notifying here
      // would force every useSyncExternalStore consumer to re-render
      // for nothing.
      await setDisplayNameOverride('Sancho');
      expect(calls.length).toBe(0);
      unsub();
    });

    it('stops notifying after unsubscribe', async () => {
      const calls: number[] = [];
      const unsub = subscribeDisplayNameOverride(() => calls.push(1));
      unsub();
      await setDisplayNameOverride('Sancho');
      expect(calls.length).toBe(0);
    });
  });
});
