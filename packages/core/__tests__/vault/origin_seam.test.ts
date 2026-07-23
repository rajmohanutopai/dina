/**
 * Item 5b — typed-origin enforcement at the vault storage seam.
 *
 * The matrix (5a) is now enforced inside `storeItem`/`deleteItem`, so the
 * invariant holds on EVERY path — including the mobile in-process path where
 * there is no HTTP authz. A read/search origin can never write; only the owner
 * deletes. Existing callers default to `owner_request` (unchanged).
 */

import { makeVaultItem } from '@dina/test-harness';

import { clearVaults, storeItem, deleteItem, getItem } from '../../src/vault/crud';

describe('storeItem — origin write gate', () => {
  beforeEach(() => clearVaults());

  it('owner_request (default) may write', () => {
    const id = storeItem('general', makeVaultItem({ summary: 'owner note' }));
    expect(getItem('general', id)).not.toBeNull();
  });

  it('staging_item may write (ingest)', () => {
    const id = storeItem('general', makeVaultItem({ summary: 'ingested' }), 'staging_item');
    expect(getItem('general', id)).not.toBeNull();
  });

  it('agent_ask may NOT write', () => {
    expect(() => storeItem('general', makeVaultItem({ summary: 'x' }), 'agent_ask')).toThrow(
      /origin 'agent_ask' may not write/,
    );
  });

  it('service_task may NOT write', () => {
    expect(() => storeItem('general', makeVaultItem({ summary: 'x' }), 'service_task')).toThrow(
      /may not write/,
    );
  });
});

describe('deleteItem — origin delete gate', () => {
  beforeEach(() => clearVaults());

  it('owner_request (default) may delete', () => {
    const id = storeItem('general', makeVaultItem({ summary: 'to delete' }));
    expect(deleteItem('general', id)).toBe(true);
  });

  it('only the owner deletes — agent/service/staging may NOT', () => {
    const id = storeItem('general', makeVaultItem({ summary: 'protected' }));
    for (const origin of ['agent_ask', 'service_task', 'staging_item'] as const) {
      expect(() => deleteItem('general', id, origin)).toThrow(/may not delete/);
    }
    // the item survived every denied delete
    expect(getItem('general', id)).not.toBeNull();
  });
});
