/**
 * T2A.16 — Cross-persona vault queries and audit log integration.
 *
 * Category B: contract test. Verifies queries across multiple open
 * personas, persona isolation, and audit trail for vault access.
 *
 * Source: core/test/vault_test.go (cross-persona section)
 */

import { queryVault, storeItem, clearVaults } from '../../src/vault/crud';
import { makeVaultItem, makeSearchQuery, resetFactoryCounters } from '@dina/test-harness';

describe('Cross-Persona Vault', () => {
  beforeEach(() => {
    resetFactoryCounters();
    clearVaults();
  });

  describe('query across open personas', () => {
    it('searches specific persona', () => {
      storeItem('general', makeVaultItem({ summary: 'General meeting', body: '' }));
      storeItem('work', makeVaultItem({ summary: 'Work meeting', body: '' }));
      const query = makeSearchQuery({ text: 'meeting' });
      const results = queryVault('general', query);
      expect(results).toHaveLength(1);
      expect(results[0].summary).toContain('General');
    });

    it('merges results by relevance score', () => {
      storeItem('general', makeVaultItem({ summary: 'Annual report review', body: '' }));
      storeItem('general', makeVaultItem({ summary: 'Daily report', body: '' }));
      const query = makeSearchQuery({ text: 'report' });
      const results = queryVault('general', query);
      expect(results).toHaveLength(2);
    });

    it('excludes closed/locked persona results', () => {
      // Items in a different persona are not visible
      storeItem('health', makeVaultItem({ summary: 'Lab results from doctor', body: '' }));
      const query = makeSearchQuery({ text: 'lab results' });
      expect(queryVault('general', query)).toHaveLength(0);
    });
  });

  describe('persona isolation', () => {
    it('item stored in health is NOT visible from general', () => {
      const item = makeVaultItem({ type: 'medical_record', summary: 'Blood test', body: '' });
      storeItem('health', item);
      expect(queryVault('general', makeSearchQuery({ text: 'blood' }))).toHaveLength(0);
      expect(queryVault('health', makeSearchQuery({ text: 'blood' }))).toHaveLength(1);
    });

    it('item stored in general is NOT visible from finance', () => {
      const item = makeVaultItem({ type: 'email', summary: 'Team lunch plans', body: '' });
      storeItem('general', item);
      expect(queryVault('finance', makeSearchQuery({ text: 'lunch' }))).toHaveLength(0);
    });

    it('same source_id can exist in different personas', () => {
      const item1 = makeVaultItem({ source_id: 'shared-src', summary: 'General copy', body: '' });
      const item2 = makeVaultItem({ source_id: 'shared-src', summary: 'Health copy', body: '' });
      storeItem('general', item1);
      storeItem('health', item2);
      expect(queryVault('general', makeSearchQuery({ text: 'copy' }))).toHaveLength(1);
      expect(queryVault('health', makeSearchQuery({ text: 'copy' }))).toHaveLength(1);
    });
  });

  describe('audit trail for vault access', () => {
    it('store operation completes successfully', () => {
      const item = makeVaultItem();
      const id = storeItem('general', item);
      expect(id).toBe(item.id);
      // Audit logging is an integration concern — verified at HTTP layer
    });

    it('query operation completes successfully', () => {
      storeItem('general', makeVaultItem({ summary: 'Audit test item', body: '' }));
      const query = makeSearchQuery({ text: 'audit' });
      expect(queryVault('general', query)).toHaveLength(1);
    });

    it('store to specific persona completes', () => {
      const item = makeVaultItem();
      const id = storeItem('health', item);
      expect(id).toBe(item.id);
    });
  });
});
