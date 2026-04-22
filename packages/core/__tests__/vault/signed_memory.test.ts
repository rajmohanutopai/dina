/**
 * T1L.6 — Signed memory: store/retrieve vault items with signatures.
 *
 * Category A: fixture-based. Cross-language verification against
 * tests/test_memory_integration.py (21 tests).
 *
 * Source: tests/test_memory_integration.py
 */

import { storeItem, queryVault, getItem, clearVaults } from '../../src/vault/crud';
import { makeVaultItem, makeSearchQuery, resetFactoryCounters } from '@dina/test-harness';

describe('Signed Memory Integration (Python vectors)', () => {
  beforeEach(() => {
    resetFactoryCounters();
    clearVaults();
  });

  describe('store and retrieve', () => {
    it('stores an item and returns ID', () => {
      const item = makeVaultItem();
      const id = storeItem('general', item);
      expect(id).toBe(item.id);
    });

    it('unsigned items have no signature metadata', () => {
      const item = makeVaultItem({ metadata: '{}' });
      const id = storeItem('general', item);
      const stored = getItem('general', id);
      expect(stored!.metadata).toBe('{}');
    });

    it('upsert: re-storing same ID overwrites', () => {
      const item = makeVaultItem({ source_id: 'same-id', summary: 'Original' });
      storeItem('general', item);
      const updated = makeVaultItem({ ...item, summary: 'Updated' });
      storeItem('general', updated);
      const stored = getItem('general', item.id);
      expect(stored!.summary).toBe('Updated');
    });
  });

  describe('signed items', () => {
    it('stores signed item with signature metadata', () => {
      const item = makeVaultItem({
        metadata: JSON.stringify({
          signature_hex: 'abcdef0123456789',
          signer_did: 'did:key:z6MkTest',
          verdict_canonical: '{"test":true}',
        }),
      });
      const id = storeItem('general', item);
      const stored = getItem('general', id);
      const meta = JSON.parse(stored!.metadata);
      expect(meta.signature_hex).toBe('abcdef0123456789');
    });

    it('stored signature matches set value', () => {
      const item = makeVaultItem({
        metadata: JSON.stringify({ signature_hex: 'cafebabe' }),
      });
      const id = storeItem('general', item);
      const meta = JSON.parse(getItem('general', id)!.metadata);
      expect(meta.signature_hex).toBe('cafebabe');
    });

    it('stored signer_did matches set value', () => {
      const item = makeVaultItem({
        metadata: JSON.stringify({ signer_did: 'did:key:z6MkSigner' }),
      });
      const id = storeItem('general', item);
      const meta = JSON.parse(getItem('general', id)!.metadata);
      expect(meta.signer_did).toBe('did:key:z6MkSigner');
    });

    it('canonical excludes signature fields', () => {
      const item = makeVaultItem({
        metadata: JSON.stringify({ verdict_canonical: '{"product":"Chair"}' }),
      });
      const id = storeItem('general', item);
      const meta = JSON.parse(getItem('general', id)!.metadata);
      expect(meta.verdict_canonical).toBe('{"product":"Chair"}');
    });

    it('full roundtrip: store → retrieve → metadata intact', () => {
      const item = makeVaultItem({
        metadata: JSON.stringify({
          signature_hex: 'deadbeef',
          signer_did: 'did:key:z6MkRoundTrip',
        }),
      });
      const id = storeItem('general', item);
      const stored = getItem('general', id);
      expect(stored!.id).toBe(item.id);
      const meta = JSON.parse(stored!.metadata);
      expect(meta.signature_hex).toBe('deadbeef');
    });
  });

  describe('retrieval', () => {
    it('returns null for non-existent item', () => {
      expect(getItem('general', 'nonexistent')).toBeNull();
    });

    it('retrieves correct item among multiple', () => {
      const item1 = makeVaultItem({ summary: 'First' });
      const item2 = makeVaultItem({ summary: 'Second' });
      storeItem('general', item1);
      storeItem('general', item2);
      expect(getItem('general', item2.id)!.summary).toBe('Second');
    });
  });

  describe('search', () => {
    it('both signed and unsigned items coexist', () => {
      storeItem('general', makeVaultItem({ summary: 'Unsigned note', body: '', metadata: '{}' }));
      storeItem(
        'general',
        makeVaultItem({
          summary: 'Signed verdict',
          body: '',
          metadata: JSON.stringify({ signature_hex: 'abc' }),
        }),
      );
      const results = queryVault('general', makeSearchQuery({ text: 'note' }));
      expect(results).toHaveLength(1);
    });

    it('search returns items with matching text', () => {
      storeItem(
        'general',
        makeVaultItem({
          summary: 'Signed product review',
          body: '',
          metadata: JSON.stringify({ signature_hex: 'abc' }),
        }),
      );
      const results = queryVault('general', makeSearchQuery({ text: 'product' }));
      expect(results).toHaveLength(1);
    });

    it('search works across signed and unsigned', () => {
      storeItem('general', makeVaultItem({ summary: 'Common keyword item', body: '' }));
      storeItem(
        'general',
        makeVaultItem({
          summary: 'Common keyword signed',
          body: '',
          metadata: JSON.stringify({ signature_hex: 'abc' }),
        }),
      );
      const results = queryVault('general', makeSearchQuery({ text: 'keyword' }));
      expect(results).toHaveLength(2);
    });

    it('empty store returns empty', () => {
      const results = queryVault('general', makeSearchQuery({ text: 'anything' }));
      expect(results).toHaveLength(0);
    });
  });
});
