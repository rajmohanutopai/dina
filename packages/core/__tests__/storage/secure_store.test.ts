/**
 * T1.51 — Keychain secure store abstraction.
 *
 * Tests the InMemorySecureStore backend. Same tests will run against
 * NativeSecureStore (react-native-keychain) once native build is ready.
 *
 * Source: ARCHITECTURE.md Task 1.51
 */

import {
  InMemorySecureStore,
  getSecureStore,
  resetSecureStore,
} from '../../src/storage/secure_store';

describe('InMemorySecureStore (1.51)', () => {
  let store: InMemorySecureStore;

  beforeEach(() => {
    store = new InMemorySecureStore();
  });

  describe('passphrase', () => {
    it('stores and retrieves a passphrase', async () => {
      await store.setPassphrase('MyPass1!', false);
      expect(await store.hasPassphrase()).toBe(true);
      expect(await store.getPassphrase()).toBe('MyPass1!');
    });

    it('throws on empty passphrase', async () => {
      await expect(store.setPassphrase('', false)).rejects.toThrow('empty');
    });

    it('throws when no passphrase stored', async () => {
      await expect(store.getPassphrase()).rejects.toThrow('no passphrase');
    });

    it('clears passphrase', async () => {
      await store.setPassphrase('MyPass1!', false);
      await store.clearPassphrase();

      expect(await store.hasPassphrase()).toBe(false);
      await expect(store.getPassphrase()).rejects.toThrow();
    });

    it('overwrites existing passphrase', async () => {
      await store.setPassphrase('OldPass1!', false);
      await store.setPassphrase('NewPass1!', false);

      expect(await store.getPassphrase()).toBe('NewPass1!');
    });
  });

  describe('wrapped seed', () => {
    it('stores and retrieves wrapped seed', async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      await store.setWrappedSeed(data);

      const retrieved = await store.getWrappedSeed();
      expect(retrieved).not.toBeNull();
      expect(retrieved!.length).toBe(5);
      expect(retrieved![0]).toBe(1);
    });

    it('returns null when no seed stored', async () => {
      expect(await store.getWrappedSeed()).toBeNull();
    });

    it('returns a copy (not reference)', async () => {
      const data = new Uint8Array([1, 2, 3]);
      await store.setWrappedSeed(data);

      const a = await store.getWrappedSeed();
      const b = await store.getWrappedSeed();
      expect(a).toEqual(b);
      a![0] = 99; // mutate copy
      const c = await store.getWrappedSeed();
      expect(c![0]).toBe(1); // original unchanged
    });

    it('clears wrapped seed (zeros data)', async () => {
      await store.setWrappedSeed(new Uint8Array([1, 2, 3]));
      await store.clearWrappedSeed();

      expect(await store.getWrappedSeed()).toBeNull();
    });
  });

  describe('biometric', () => {
    it('defaults to available', async () => {
      expect(await store.isBiometricAvailable()).toBe(true);
    });

    it('defaults to disabled', async () => {
      expect(await store.isBiometricEnabled()).toBe(false);
    });

    it('enables biometric with passphrase', async () => {
      await store.setPassphrase('MyPass1!', true);
      expect(await store.isBiometricEnabled()).toBe(true);
    });

    it('toggles biometric', async () => {
      await store.setBiometricEnabled(true);
      expect(await store.isBiometricEnabled()).toBe(true);

      await store.setBiometricEnabled(false);
      expect(await store.isBiometricEnabled()).toBe(false);
    });

    it('rejects biometric enable when not available', async () => {
      store.simulateBiometricAvailable(false);
      await expect(store.setBiometricEnabled(true)).rejects.toThrow('not available');
    });

    it('does not enable biometric when device lacks it', async () => {
      store.simulateBiometricAvailable(false);
      await store.setPassphrase('MyPass1!', true); // requests biometric

      // Biometric should NOT be enabled (device doesn't support it)
      expect(await store.isBiometricEnabled()).toBe(false);
    });

    it('auto-clears after 5 failed biometric attempts', async () => {
      await store.setBiometricEnabled(true);
      expect(await store.isBiometricEnabled()).toBe(true);

      for (let i = 0; i < 5; i++) {
        store.simulateBiometricFailure();
      }

      // After 5 failures, biometric is auto-disabled (security)
      expect(await store.isBiometricEnabled()).toBe(false);
    });

    it('successful getPassphrase resets failure counter', async () => {
      await store.setPassphrase('MyPass1!', true);

      store.simulateBiometricFailure();
      store.simulateBiometricFailure();

      await store.getPassphrase(); // success resets counter

      // Should still be enabled (only 2 failures before reset)
      expect(await store.isBiometricEnabled()).toBe(true);
    });
  });

  describe('clearAll', () => {
    it('clears passphrase + seed + biometric', async () => {
      await store.setPassphrase('MyPass1!', true);
      await store.setWrappedSeed(new Uint8Array([1, 2, 3]));

      await store.clearAll();

      expect(await store.hasPassphrase()).toBe(false);
      expect(await store.getWrappedSeed()).toBeNull();
      expect(await store.isBiometricEnabled()).toBe(false);
    });
  });
});

describe('SecureStore singleton', () => {
  beforeEach(() => resetSecureStore());

  it('returns InMemorySecureStore by default', async () => {
    const store = getSecureStore();
    await store.setPassphrase('Test1!', false);
    expect(await store.hasPassphrase()).toBe(true);
  });

  it('resetSecureStore creates fresh instance', async () => {
    const store = getSecureStore();
    await store.setPassphrase('Test1!', false);

    resetSecureStore();

    const fresh = getSecureStore();
    expect(await fresh.hasPassphrase()).toBe(false);
  });
});
