/**
 * Retrieval policy filtering tests — quarantined and briefing_only items
 * excluded from default search results.
 *
 * Source: GAP_ANALYSIS.md §A35 — Go VaultService post-filters by retrieval_policy.
 */

import { storeItem, queryVault, clearVaults } from '../../src/vault/crud';

describe('Vault Retrieval Policy Filtering', () => {
  beforeEach(() => clearVaults());

  it('includes normal items in FTS search', () => {
    storeItem('general', { summary: 'visible note', retrieval_policy: 'normal' });
    const results = queryVault('general', { mode: 'fts5', text: 'visible', limit: 10 });
    expect(results).toHaveLength(1);
  });

  it('includes caveated items in FTS search', () => {
    storeItem('general', { summary: 'caveated note', retrieval_policy: 'caveated' });
    const results = queryVault('general', { mode: 'fts5', text: 'caveated', limit: 10 });
    expect(results).toHaveLength(1);
  });

  it('includes items with empty retrieval_policy in FTS search', () => {
    storeItem('general', { summary: 'default note', retrieval_policy: '' });
    const results = queryVault('general', { mode: 'fts5', text: 'default', limit: 10 });
    expect(results).toHaveLength(1);
  });

  it('excludes quarantined items from FTS search', () => {
    storeItem('general', { summary: 'quarantined note', retrieval_policy: 'quarantine' });
    const results = queryVault('general', { mode: 'fts5', text: 'quarantined', limit: 10 });
    expect(results).toHaveLength(0);
  });

  it('excludes briefing_only items from FTS search', () => {
    storeItem('general', { summary: 'briefing note', retrieval_policy: 'briefing_only' });
    const results = queryVault('general', { mode: 'fts5', text: 'briefing', limit: 10 });
    expect(results).toHaveLength(0);
  });

  it('mixed policies: only normal + caveated returned', () => {
    storeItem('general', { summary: 'alpha normal', retrieval_policy: 'normal' });
    storeItem('general', { summary: 'alpha caveated', retrieval_policy: 'caveated' });
    storeItem('general', { summary: 'alpha quarantined', retrieval_policy: 'quarantine' });
    storeItem('general', { summary: 'alpha briefing', retrieval_policy: 'briefing_only' });

    const results = queryVault('general', { mode: 'fts5', text: 'alpha', limit: 10 });
    expect(results).toHaveLength(2);
    expect(
      results.every((r) => r.retrieval_policy === 'normal' || r.retrieval_policy === 'caveated'),
    ).toBe(true);
  });

  it('excludes quarantined items from hybrid search', () => {
    storeItem('general', { summary: 'hybrid test visible', retrieval_policy: 'normal' });
    storeItem('general', { summary: 'hybrid test hidden', retrieval_policy: 'quarantine' });

    const results = queryVault('general', { mode: 'hybrid', text: 'hybrid test', limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0].retrieval_policy).toBe('normal');
  });
});
