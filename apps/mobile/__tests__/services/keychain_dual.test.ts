/**
 * Dual-mode parity test for the keychain shim.
 *
 * Exercises the same scenarios against:
 *   - `keychain.ts`    — the native re-export of `react-native-keychain`,
 *     intercepted by `__mocks__/react-native-keychain.ts` under Jest.
 *   - `keychain.web.ts` — the IndexedDB-backed peer the web build uses,
 *     running here against `fake-indexeddb` so node-Jest can drive it
 *     without a browser.
 *
 * The shared scenario block (`scenarios(name, kit)`) is what makes the
 * file genuinely dual-mode — both implementations MUST satisfy the
 * same external contract or the test fails. That's the protection
 * against future drift: anyone changing one peer has to satisfy the
 * other or they break parity.
 *
 * Source: docs/HOME_NODE_LITE_WEB_UI_TASKS.md Phase 2 "Storage shim".
 */

/* eslint-disable @typescript-eslint/no-require-imports */

import 'fake-indexeddb/auto';
// Node 22's `globalThis.crypto` already implements `crypto.subtle`,
// so we don't need to inject one here. The web shim calls it
// directly and gets a real WebCrypto AES-GCM implementation under
// Jest — exercising the same code path browsers will run.

import { resetKeychainMock } from '../../__mocks__/react-native-keychain';

interface KeychainKit {
  setGenericPassword: (
    username: string,
    password: string,
    options?: { service?: string },
  ) => Promise<unknown>;
  getGenericPassword: (options?: {
    service?: string;
  }) => Promise<false | { username: string; password: string; service?: string }>;
  resetGenericPassword: (options?: { service?: string }) => Promise<boolean>;
  resetAll: () => Promise<void>;
}

function nativeKit(): KeychainKit {
  // Require lazily so the jest mock registers before the import runs.
  const k = require('../../src/services/keychain') as typeof import('../../src/services/keychain');
  return {
    setGenericPassword: k.setGenericPassword,
    getGenericPassword: k.getGenericPassword,
    resetGenericPassword: k.resetGenericPassword,
    resetAll: async () => {
      resetKeychainMock();
    },
  };
}

function webKit(): KeychainKit {
  const k =
    require('../../src/services/keychain.web') as typeof import('../../src/services/keychain.web');
  return {
    setGenericPassword: k.setGenericPassword,
    getGenericPassword: k.getGenericPassword,
    resetGenericPassword: k.resetGenericPassword,
    resetAll: () => k.__dangerouslyResetForTests(),
  };
}

function scenarios(name: string, build: () => KeychainKit): void {
  describe(name, () => {
    let kit: KeychainKit;

    beforeEach(async () => {
      kit = build();
      await kit.resetAll();
    });

    it('round-trips a stored credential through the public API', async () => {
      await kit.setGenericPassword('alice', 's3cret', { service: 'dina-test' });
      const cred = await kit.getGenericPassword({ service: 'dina-test' });
      expect(cred).not.toBe(false);
      expect(cred).toMatchObject({ username: 'alice', password: 's3cret' });
    });

    it('returns false when no entry exists for the requested service', async () => {
      await expect(kit.getGenericPassword({ service: 'never-set' })).resolves.toBe(false);
    });

    it('overwrites an existing entry rather than appending', async () => {
      await kit.setGenericPassword('alice', 'first', { service: 'svc' });
      await kit.setGenericPassword('alice', 'second', { service: 'svc' });
      const cred = await kit.getGenericPassword({ service: 'svc' });
      expect(cred).toMatchObject({ username: 'alice', password: 'second' });
    });

    it('isolates entries per service', async () => {
      await kit.setGenericPassword('alice', 'apple', { service: 'svc-a' });
      await kit.setGenericPassword('bob', 'banana', { service: 'svc-b' });
      const a = await kit.getGenericPassword({ service: 'svc-a' });
      const b = await kit.getGenericPassword({ service: 'svc-b' });
      expect(a).toMatchObject({ username: 'alice', password: 'apple' });
      expect(b).toMatchObject({ username: 'bob', password: 'banana' });
    });

    it('resetGenericPassword removes the entry', async () => {
      await kit.setGenericPassword('alice', 'forget-me', { service: 'svc' });
      await expect(kit.resetGenericPassword({ service: 'svc' })).resolves.toBe(true);
      await expect(kit.getGenericPassword({ service: 'svc' })).resolves.toBe(false);
    });

    it('handles non-ASCII passphrases (UTF-8 byte order, emoji)', async () => {
      const pw = '混ぜご飯🍱 + AES-GCM = ✅';
      await kit.setGenericPassword('alice', pw, { service: 'utf8' });
      const cred = await kit.getGenericPassword({ service: 'utf8' });
      expect(cred).not.toBe(false);
      expect((cred as { password: string }).password).toBe(pw);
    });

    it('handles long payloads (4 KiB stays correct)', async () => {
      const pw = 'x'.repeat(4 * 1024);
      await kit.setGenericPassword('alice', pw, { service: 'big' });
      const cred = await kit.getGenericPassword({ service: 'big' });
      expect(cred).not.toBe(false);
      expect((cred as { password: string }).password).toBe(pw);
    });

    it('concurrent writes preserve every value (wrap-key race regression)', async () => {
      // Regression: `infra_setup.tsx`'s Continue handler fires
      // `Promise.all([savePdsUrl, saveAppViewURL])` on the FIRST run
      // (before any wrap key exists). Without single-flighting the
      // bootstrap, both saves used to generate different CryptoKeys
      // and one row's ciphertext became permanently undecryptable.
      // Caught only when the user reloaded the page and the
      // unlock-gate's `loadInfraPreferences` returned partial state.
      const pairs = Array.from({ length: 8 }, (_, i) => [
        `svc-${i}`,
        `value-${i}-${'pad'.repeat(20)}`,
      ] as const);
      await Promise.all(
        pairs.map(([s, v]) => kit.setGenericPassword(`user-${s}`, v, { service: s })),
      );
      for (const [s, v] of pairs) {
        const cred = await kit.getGenericPassword({ service: s });
        expect(cred).not.toBe(false);
        expect((cred as { password: string }).password).toBe(v);
      }
    });
  });
}

scenarios('keychain (native — react-native-keychain mock)', nativeKit);
scenarios('keychain.web (IndexedDB + WebCrypto)', webKit);

describe('keychain.web — encryption-at-rest', () => {
  it('stores ciphertext, not plaintext, in the underlying IndexedDB row', async () => {
    const k =
      require('../../src/services/keychain.web') as typeof import('../../src/services/keychain.web');
    await k.__dangerouslyResetForTests();
    const secret = 'plaintext-canary-not-on-disk';
    await k.setGenericPassword('alice', secret, { service: 'inspect' });

    // Read the raw row via fake-indexeddb directly to prove the
    // payload bytes don't match the plaintext.
    const raw = await new Promise<{ iv: Uint8Array; ct: Uint8Array; username: string } | undefined>(
      (resolve, reject) => {
        const open = indexedDB.open('dina-keychain', 1);
        open.onsuccess = () => {
          const tx = open.result.transaction('entries', 'readonly');
          const req = tx.objectStore('entries').get('inspect');
          req.onsuccess = () =>
            resolve(req.result as { iv: Uint8Array; ct: Uint8Array; username: string } | undefined);
          req.onerror = () => reject(req.error);
        };
        open.onerror = () => reject(open.error);
      },
    );

    if (raw === undefined) {
      throw new Error('inspect row not written by setGenericPassword');
    }
    expect(raw.username).toBe('alice');
    // GCM ciphertext: at least len(plaintext) + 16 byte auth tag.
    expect(raw.ct.byteLength).toBeGreaterThanOrEqual(secret.length + 16);
    // No occurrence of the plaintext canary anywhere in the stored
    // bytes — neither iv nor ct should contain it.
    const utf8 = new TextEncoder().encode(secret);
    expect(indexOf(raw.ct, utf8)).toBe(-1);
    expect(indexOf(raw.iv, utf8)).toBe(-1);
  });
});

/** Naive subarray search — exists because Uint8Array has no built-in `indexOf` for a
 *  multi-byte needle. O(n*m) is fine for test-sized inputs. */
function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
