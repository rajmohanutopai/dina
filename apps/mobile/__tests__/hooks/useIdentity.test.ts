/**
 * T4.14 — Settings identity: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 4.14
 */

import {
  initIdentity,
  getIdentityInfo,
  requestMnemonicBackup,
  isMnemonicVisible,
  clearMnemonicBackup,
  getShortDID,
  hasIdentity,
  resetIdentityHook,
} from '../../src/hooks/useIdentity';
import { TEST_ED25519_SEED } from '@dina/test-harness';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('Identity Settings Hook (4.14)', () => {
  beforeEach(() => resetIdentityHook());

  describe('initIdentity + getIdentityInfo', () => {
    it('returns null before initialization', () => {
      expect(getIdentityInfo()).toBeNull();
      expect(hasIdentity()).toBe(false);
    });

    it('returns identity info after initialization', () => {
      initIdentity(TEST_ED25519_SEED, TEST_MNEMONIC);

      const info = getIdentityInfo();
      expect(info).not.toBeNull();
      expect(info!.did).toMatch(/^did:key:z6Mk/);
      expect(info!.publicKeyMultibase).toMatch(/^z6Mk/);
      expect(info!.documentValid).toBe(true);
      expect(info!.validationErrors).toHaveLength(0);
      expect(hasIdentity()).toBe(true);
    });

    it('DID document has correct structure', () => {
      initIdentity(TEST_ED25519_SEED, TEST_MNEMONIC);
      const info = getIdentityInfo()!;

      expect(info.didDocument['@context']).toContain('https://www.w3.org/ns/did/v1');
      expect(info.didDocument.id).toBe(info.did);
      expect(info.didDocument.verificationMethod).toHaveLength(1);
      expect(info.didDocument.verificationMethod[0].type).toBe('Multikey');
    });

    it('includes messaging endpoint when provided', () => {
      initIdentity(TEST_ED25519_SEED, TEST_MNEMONIC);
      const info = getIdentityInfo('wss://mailbox.dinakernel.com/ws')!;

      expect(info.messagingEndpoint).toBe('wss://mailbox.dinakernel.com/ws');
    });

    it('messaging endpoint is null without configuration', () => {
      initIdentity(TEST_ED25519_SEED, TEST_MNEMONIC);
      expect(getIdentityInfo()!.messagingEndpoint).toBeNull();
    });

    it('tracks creation timestamp', () => {
      const ts = 1700000000000;
      initIdentity(TEST_ED25519_SEED, TEST_MNEMONIC, ts);

      expect(getIdentityInfo()!.createdAt).toBe(ts);
    });
  });

  describe('mnemonic backup', () => {
    beforeEach(() => initIdentity(TEST_ED25519_SEED, TEST_MNEMONIC));

    it('requires passphrase confirmation', () => {
      const result = requestMnemonicBackup(false);
      expect(result).toBeNull();
    });

    it('returns words array on confirmation', () => {
      const result = requestMnemonicBackup(true);
      expect(result).not.toBeNull();
      expect(result!.words).toHaveLength(12);
      expect(result!.words[0]).toBe('abandon');
      expect(result!.confirmed).toBe(true);
    });

    it('is visible after request', () => {
      requestMnemonicBackup(true);
      expect(isMnemonicVisible()).toBe(true);
    });

    it('clears on explicit dismiss', () => {
      requestMnemonicBackup(true);
      clearMnemonicBackup();
      expect(isMnemonicVisible()).toBe(false);
    });

    it('returns null when no mnemonic stored', () => {
      resetIdentityHook();
      expect(requestMnemonicBackup(true)).toBeNull();
    });

    it('has expiry timestamp (60 seconds)', () => {
      const before = Date.now();
      const result = requestMnemonicBackup(true);
      expect(result!.expiresAt).toBeGreaterThan(before + 50_000);
      expect(result!.expiresAt).toBeLessThanOrEqual(before + 61_000);
    });
  });

  describe('getShortDID', () => {
    it('returns null before initialization', () => {
      expect(getShortDID()).toBeNull();
    });

    it('returns truncated DID', () => {
      initIdentity(TEST_ED25519_SEED, TEST_MNEMONIC);
      const short = getShortDID();
      expect(short).not.toBeNull();
      expect(short).toContain('did:key:z6Mk');
      expect(short).toContain('...');
      expect(short!.length).toBeLessThan(getIdentityInfo()!.did.length);
    });
  });
});
