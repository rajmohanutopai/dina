/**
 * T2D.1 — Chat integration: DID document, signed verdict verification,
 * vault history, command routing.
 *
 * Wired to real modules from @dina/core and @dina/brain.
 *
 * Source: tests/test_chat_integration.py
 */

import { buildDIDDocument, validateDIDDocument } from '../../../core/src/identity/did_document';
import { deriveDIDKey, publicKeyToMultibase } from '../../../core/src/identity/did';
import { getPublicKey } from '../../../core/src/crypto/ed25519';
import { signCanonical, verifyCanonical, canonicalize } from '../../../core/src/identity/signing';
import { storeItem, queryVault, clearVaults } from '../../../core/src/vault/crud';
import { parseCommand, getAvailableCommands } from '../../../brain/src/chat/command_parser';
import { TEST_ED25519_SEED, resetFactoryCounters } from '@dina/test-harness';

const pubKey = getPublicKey(TEST_ED25519_SEED);
const did = deriveDIDKey(pubKey);
const pubKeyMultibase = publicKeyToMultibase(pubKey);

describe('Chat Integration', () => {
  beforeEach(() => {
    resetFactoryCounters();
    clearVaults();
  });

  describe('/identity command', () => {
    it('prints valid W3C DID Document', () => {
      const doc = buildDIDDocument(did, pubKeyMultibase);
      expect(validateDIDDocument(doc)).toEqual([]); // empty = no errors
      expect(doc['@context']).toContain('https://www.w3.org/ns/did/v1');
    });

    it('DID Document id matches identity DID', () => {
      const doc = buildDIDDocument(did, pubKeyMultibase);
      expect(doc.id).toBe(did);
    });

    it('verification method type is Multikey', () => {
      const doc = buildDIDDocument(did, pubKeyMultibase);
      expect(doc.verificationMethod[0].type).toBe('Multikey');
    });
  });

  describe('/verify command', () => {
    it('VERIFIED for valid signed content', () => {
      const content = { product: 'Chair', rating: 85 };
      const canonical = canonicalize(content);
      const sig = signCanonical(canonical, TEST_ED25519_SEED);
      expect(verifyCanonical(canonical, sig, pubKey)).toBe(true);
    });

    it('error for unsigned content (empty signature)', () => {
      const canonical = canonicalize({ test: true });
      expect(verifyCanonical(canonical, '', pubKey)).toBe(false);
    });

    it('INVALID for tampered signature', () => {
      const canonical = canonicalize({ product: 'Chair' });
      const sig = signCanonical(canonical, TEST_ED25519_SEED);
      const tampered = canonicalize({ product: 'Table' });
      expect(verifyCanonical(tampered, sig, pubKey)).toBe(false);
    });

    it('INVALID with wrong identity key', () => {
      const canonical = canonicalize({ test: true });
      const sig = signCanonical(canonical, TEST_ED25519_SEED);
      const wrongPub = getPublicKey(new Uint8Array(32).fill(0x99));
      expect(verifyCanonical(canonical, sig, wrongPub)).toBe(false);
    });
  });

  describe('vault history', () => {
    it('empty store returns no results', () => {
      const results = queryVault('general', { mode: 'fts5', text: 'anything', limit: 10 });
      expect(results).toHaveLength(0);
    });

    it('signed items have signature in metadata', () => {
      const sig = signCanonical('{"test":true}', TEST_ED25519_SEED);
      storeItem('general', {
        summary: 'Signed verdict',
        type: 'note',
        metadata: JSON.stringify({ signature_hex: sig, signer_did: did }),
      });
      const item = queryVault('general', { mode: 'fts5', text: 'signed', limit: 1 })[0];
      const meta = JSON.parse(item.metadata);
      expect(meta.signature_hex).toBeTruthy();
    });

    it('unsigned items have no signature metadata', () => {
      storeItem('general', { summary: 'Plain note', type: 'note', metadata: '{}' });
      const item = queryVault('general', { mode: 'fts5', text: 'plain note', limit: 1 })[0];
      const meta = JSON.parse(item.metadata);
      expect(meta.signature_hex).toBeUndefined();
    });
  });

  describe('command routing', () => {
    it('/help routes to help intent', () => {
      expect(parseCommand('/help').intent).toBe('help');
    });

    it('/search routes to search intent', () => {
      expect(parseCommand('/search query').intent).toBe('search');
    });

    it('/remember routes to remember intent', () => {
      expect(parseCommand('/remember fact').intent).toBe('remember');
    });

    it('unknown command → chat', () => {
      expect(parseCommand('/unknown').intent).toBe('chat');
    });
  });

  describe('signature workflow', () => {
    it('sign → store → retrieve → verify roundtrip', () => {
      const content = { product: 'Aeron', recommendation: 'BUY' };
      const canonical = canonicalize(content);
      const sig = signCanonical(canonical, TEST_ED25519_SEED);

      storeItem('general', {
        summary: 'Product verdict',
        type: 'note',
        metadata: JSON.stringify({ signature_hex: sig, verdict_canonical: canonical }),
      });

      const stored = queryVault('general', { mode: 'fts5', text: 'product', limit: 1 })[0];
      const meta = JSON.parse(stored.metadata);
      expect(verifyCanonical(meta.verdict_canonical, meta.signature_hex, pubKey)).toBe(true);
    });

    it('signature fields excluded from canonical JSON', () => {
      const obj = { name: 'test', signature_hex: 'abc', signer_did: 'did:x' };
      const canonical = canonicalize(obj, ['signature_hex', 'signer_did']);
      expect(canonical).not.toContain('signature_hex');
      expect(canonical).toContain('name');
    });
  });

  describe('banner', () => {
    it('available commands include /help', () => {
      const cmds = getAvailableCommands();
      expect(cmds.some((c) => c.command.includes('/help'))).toBe(true);
    });

    it('mentions /remember and /ask', () => {
      const cmds = getAvailableCommands();
      expect(cmds.some((c) => c.command.includes('/remember'))).toBe(true);
      expect(cmds.some((c) => c.command.includes('/ask'))).toBe(true);
    });
  });
});
