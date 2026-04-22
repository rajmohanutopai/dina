/**
 * T2D.11 — Device sync: checkpoint, realtime push, offline queue,
 * cache, corruption recovery, auth, pairing.
 *
 * Category B: integration/contract test.
 *
 * Source: tests/integration/test_client_sync.py
 */

import {
  syncFromCheckpoint,
  pushToClient,
  flushOfflineQueue,
  searchLocalCache,
  recoverCorruptedCache,
  isAuthenticated,
  resetSyncState,
  registerDevice,
  connectDevice,
  disconnectDevice,
  addSyncItem,
  corruptCache,
  validateSyncItemSize,
  validateSyncBatch,
  SYNC_PAGE_SIZE,
  MAX_BATCH_ITEMS,
  MAX_ITEM_SIZE_BYTES,
} from '../../src/sync/client';
import type { SyncItem } from '../../src/sync/client';
import { completePairing, setNodeDID } from '../../src/pairing/ceremony';

describe('Device Sync Integration', () => {
  beforeEach(() => resetSyncState());

  describe('initial sync', () => {
    it('syncs from checkpoint 0 (fresh device)', async () => {
      addSyncItem({ id: 'a', type: 'vault_update', data: { text: 'hello' }, checkpoint: 1 });
      addSyncItem({ id: 'b', type: 'vault_update', data: { text: 'world' }, checkpoint: 2 });
      const result = await syncFromCheckpoint(0);
      expect(result.items).toHaveLength(2);
      expect(result.newCheckpoint).toBe(2);
    });

    it('returns items since checkpoint', async () => {
      addSyncItem({ id: 'a', type: 'vault_update', data: {}, checkpoint: 100 });
      addSyncItem({ id: 'b', type: 'vault_update', data: {}, checkpoint: 200 });
      addSyncItem({ id: 'c', type: 'vault_update', data: {}, checkpoint: 300 });
      const result = await syncFromCheckpoint(100);
      expect(result.items).toHaveLength(2);
      expect(result.newCheckpoint).toBe(300);
    });

    it('returns empty when no new items', async () => {
      const result = await syncFromCheckpoint(999);
      expect(result.items).toHaveLength(0);
      expect(result.newCheckpoint).toBe(999);
    });
  });

  describe('realtime push', () => {
    it('pushes new data to connected rich client', async () => {
      registerDevice('dev-001');
      connectDevice('dev-001');
      const result = await pushToClient('dev-001', { type: 'vault_update' });
      expect(result).toBe(true);
    });

    it('returns false when device not connected', async () => {
      registerDevice('dev-offline');
      // Not connected
      const result = await pushToClient('dev-offline', { type: 'test' });
      expect(result).toBe(false);
    });

    it('returns false for unauthenticated device', async () => {
      const result = await pushToClient('dev-unknown', { type: 'test' });
      expect(result).toBe(false);
    });

    it('queues data for offline device', async () => {
      registerDevice('dev-offline');
      await pushToClient('dev-offline', { type: 'update1' });
      await pushToClient('dev-offline', { type: 'update2' });
      const flushed = await flushOfflineQueue('dev-offline');
      expect(flushed).toBe(2);
    });
  });

  describe('offline queue', () => {
    it('queues offline, flushes on reconnect', async () => {
      registerDevice('dev-001');
      await pushToClient('dev-001', { type: 'a' });
      await pushToClient('dev-001', { type: 'b' });
      await pushToClient('dev-001', { type: 'c' });
      const count = await flushOfflineQueue('dev-001');
      expect(count).toBe(3);
    });

    it('returns 0 when nothing queued', async () => {
      const count = await flushOfflineQueue('dev-001');
      expect(count).toBe(0);
    });

    it('queue is cleared after flush', async () => {
      registerDevice('dev-001');
      await pushToClient('dev-001', { type: 'a' });
      await flushOfflineQueue('dev-001');
      const count = await flushOfflineQueue('dev-001');
      expect(count).toBe(0);
    });
  });

  describe('local cache', () => {
    it('rich client searches local cache', () => {
      addSyncItem({
        id: 'a',
        type: 'email',
        data: { summary: 'Meeting with Alice' },
        checkpoint: 1,
      });
      const results = searchLocalCache('meeting');
      expect(results.length).toBeGreaterThan(0);
    });

    it('returns empty for no matches', () => {
      addSyncItem({ id: 'a', type: 'email', data: { summary: 'Hello world' }, checkpoint: 1 });
      expect(searchLocalCache('nonexistent')).toHaveLength(0);
    });

    it('returns empty for empty query', () => {
      expect(searchLocalCache('')).toHaveLength(0);
    });
  });

  describe('corruption recovery', () => {
    it('detects corrupt cache and requests re-sync', async () => {
      addSyncItem({ id: 'a', type: 'test', data: {}, checkpoint: 1 });
      corruptCache();
      const recovered = await recoverCorruptedCache();
      expect(recovered).toBe(true);
    });

    it('healthy cache returns false', async () => {
      const recovered = await recoverCorruptedCache();
      expect(recovered).toBe(false);
    });

    it('corrupted cache returns empty search', () => {
      addSyncItem({ id: 'a', type: 'test', data: { text: 'findme' }, checkpoint: 1 });
      corruptCache();
      expect(searchLocalCache('findme')).toHaveLength(0);
    });
  });

  describe('authentication', () => {
    it('authenticated device returns true', () => {
      registerDevice('dev-paired');
      expect(isAuthenticated('dev-paired')).toBe(true);
    });

    it('unauthenticated device returns false', () => {
      expect(isAuthenticated('dev-unknown')).toBe(false);
    });

    it('QR code pairing: invalid code rejected', () => {
      setNodeDID('did:key:z6MkTestNode');
      const { publicKeyToMultibase } = require('../../src/identity/did');
      const { getPublicKey } = require('../../src/crypto/ed25519');
      const mb = publicKeyToMultibase(getPublicKey(new Uint8Array(32).fill(0x99)));
      expect(() => completePairing('123456', 'Phone', mb)).toThrow('invalid');
    });

    it('device key is unique per device', () => {
      registerDevice('dev-A');
      registerDevice('dev-B');
      expect(isAuthenticated('dev-A')).toBe(true);
      expect(isAuthenticated('dev-B')).toBe(true);
      expect(isAuthenticated('dev-C')).toBe(false);
    });
  });

  describe('pagination', () => {
    it('returns hasMore: false when all items fit in one page', async () => {
      addSyncItem({ id: 'a', type: 'note', data: {}, checkpoint: 1 });
      addSyncItem({ id: 'b', type: 'note', data: {}, checkpoint: 2 });
      const result = await syncFromCheckpoint(0);
      expect(result.items).toHaveLength(2);
      expect(result.hasMore).toBe(false);
    });

    it('returns hasMore: true when more items than page size', async () => {
      // Add more items than SYNC_PAGE_SIZE
      for (let i = 1; i <= SYNC_PAGE_SIZE + 5; i++) {
        addSyncItem({ id: `item-${i}`, type: 'note', data: {}, checkpoint: i });
      }
      const result = await syncFromCheckpoint(0);
      expect(result.items).toHaveLength(SYNC_PAGE_SIZE);
      expect(result.hasMore).toBe(true);
    });

    it('second page returns remaining items', async () => {
      for (let i = 1; i <= SYNC_PAGE_SIZE + 5; i++) {
        addSyncItem({ id: `item-${i}`, type: 'note', data: {}, checkpoint: i });
      }
      const page1 = await syncFromCheckpoint(0);
      expect(page1.hasMore).toBe(true);

      const page2 = await syncFromCheckpoint(page1.newCheckpoint);
      expect(page2.items).toHaveLength(5);
      expect(page2.hasMore).toBe(false);
    });

    it('respects custom page size', async () => {
      for (let i = 1; i <= 10; i++) {
        addSyncItem({ id: `item-${i}`, type: 'note', data: {}, checkpoint: i });
      }
      const result = await syncFromCheckpoint(0, 3);
      expect(result.items).toHaveLength(3);
      expect(result.hasMore).toBe(true);
    });

    it('SYNC_PAGE_SIZE is 100 (matching Go)', () => {
      expect(SYNC_PAGE_SIZE).toBe(100);
    });

    it('returns items sorted by checkpoint ascending', async () => {
      addSyncItem({ id: 'c', type: 'note', data: {}, checkpoint: 30 });
      addSyncItem({ id: 'a', type: 'note', data: {}, checkpoint: 10 });
      addSyncItem({ id: 'b', type: 'note', data: {}, checkpoint: 20 });
      const result = (await syncFromCheckpoint(0)) as { items: SyncItem[] };
      expect(result.items[0].checkpoint).toBe(10);
      expect(result.items[1].checkpoint).toBe(20);
      expect(result.items[2].checkpoint).toBe(30);
    });
  });

  describe('MCP payload validation', () => {
    it('accepts item within size limit', () => {
      const item: SyncItem = { id: 'small', type: 'note', data: { body: 'Hello' }, checkpoint: 1 };
      expect(validateSyncItemSize(item)).toBeNull();
    });

    it('rejects item exceeding 256KB', () => {
      const largeData = { body: 'x'.repeat(300 * 1024) }; // 300KB
      const item: SyncItem = { id: 'big', type: 'note', data: largeData, checkpoint: 1 };
      expect(validateSyncItemSize(item)).toContain('exceeds max size');
    });

    it('accepts batch within limits', () => {
      const items: SyncItem[] = Array.from({ length: 10 }, (_, i) => ({
        id: `item-${i}`,
        type: 'note',
        data: { n: i },
        checkpoint: i,
      }));
      expect(validateSyncBatch(items)).toBeNull();
    });

    it('rejects batch exceeding 1000 items', () => {
      const items: SyncItem[] = Array.from({ length: 1001 }, (_, i) => ({
        id: `item-${i}`,
        type: 'note',
        data: {},
        checkpoint: i,
      }));
      expect(validateSyncBatch(items)).toContain('Batch too large');
    });

    it('rejects batch containing oversized item', () => {
      const items: SyncItem[] = [
        { id: 'ok', type: 'note', data: {}, checkpoint: 1 },
        { id: 'big', type: 'note', data: { body: 'x'.repeat(300 * 1024) }, checkpoint: 2 },
      ];
      expect(validateSyncBatch(items)).toContain('exceeds max size');
    });

    it('constants match Python MCP limits', () => {
      expect(MAX_BATCH_ITEMS).toBe(1000);
      expect(MAX_ITEM_SIZE_BYTES).toBe(256 * 1024);
    });
  });
});
