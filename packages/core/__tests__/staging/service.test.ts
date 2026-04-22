/**
 * T2.41–2.47 — Staging service: ingest, claim, resolve, fail, sweep, drain.
 *
 * Source: ARCHITECTURE.md Tasks 2.41–2.47
 */

import {
  ingest,
  claim,
  resolve,
  resolveMulti,
  fail,
  extendLease,
  sweep,
  drainForPersona,
  getItem,
  inboxSize,
  resetStagingState,
  computeSourceHash,
  setOnDrainCallback,
  listByStatus,
  getStatusForOwner,
  markPendingApproval,
  resumeAfterApprovalGranted,
} from '../../src/staging/service';
import { getItem as getVaultItem, clearVaults } from '../../src/vault/crud';

describe('Staging Service', () => {
  beforeEach(() => {
    resetStagingState();
    clearVaults();
  });

  describe('ingest (2.41)', () => {
    it('ingests an item with generated ID', () => {
      const { id, duplicate } = ingest({ source: 'gmail', source_id: 'msg-001' });
      expect(id).toMatch(/^stg-[0-9a-f]{16}$/);
      expect(duplicate).toBe(false);
      expect(getItem(id)!.status).toBe('received');
    });

    it('dedup rejects same (producer_id, source, source_id)', () => {
      const r1 = ingest({ source: 'gmail', source_id: 'msg-001' });
      const r2 = ingest({ source: 'gmail', source_id: 'msg-001' });
      expect(r2.duplicate).toBe(true);
      expect(r2.id).toBe(r1.id);
      expect(inboxSize()).toBe(1);
    });

    it('different producer_id is NOT a duplicate (3-part key)', () => {
      const r1 = ingest({ source: 'gmail', source_id: 'msg-001', producer_id: 'brain-1' });
      const r2 = ingest({ source: 'gmail', source_id: 'msg-001', producer_id: 'brain-2' });
      expect(r2.duplicate).toBe(false);
      expect(r2.id).not.toBe(r1.id);
      expect(inboxSize()).toBe(2);
    });

    it('same producer_id + source + source_id is a duplicate', () => {
      const r1 = ingest({ source: 'gmail', source_id: 'msg-001', producer_id: 'brain-1' });
      const r2 = ingest({ source: 'gmail', source_id: 'msg-001', producer_id: 'brain-1' });
      expect(r2.duplicate).toBe(true);
      expect(r2.id).toBe(r1.id);
    });

    it('different source_id is not a duplicate', () => {
      ingest({ source: 'gmail', source_id: 'msg-001' });
      const r2 = ingest({ source: 'gmail', source_id: 'msg-002' });
      expect(r2.duplicate).toBe(false);
      expect(inboxSize()).toBe(2);
    });

    it('sets expires_at 7 days from now', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'x' });
      const item = getItem(id)!;
      const sevenDays = 7 * 24 * 3600;
      expect(item.expires_at - item.created_at).toBe(sevenDays);
    });

    it('stores custom data payload', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'x', data: { subject: 'Hello' } });
      expect(getItem(id)!.data).toEqual({ subject: 'Hello' });
    });
  });

  describe('claim (2.42)', () => {
    it('claims received items → classifying', () => {
      ingest({ source: 'gmail', source_id: 'a' });
      ingest({ source: 'gmail', source_id: 'b' });
      const claimed = claim(10);
      expect(claimed).toHaveLength(2);
      expect(claimed[0].status).toBe('classifying');
      expect(claimed[0].lease_until).toBeGreaterThan(0);
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) ingest({ source: 'gmail', source_id: `m-${i}` });
      expect(claim(2)).toHaveLength(2);
    });

    it('re-claim returns empty (items already claimed)', () => {
      ingest({ source: 'gmail', source_id: 'a' });
      claim(10);
      expect(claim(10)).toHaveLength(0);
    });

    it('sets 15-minute lease by default', () => {
      ingest({ source: 'gmail', source_id: 'a' });
      const [item] = claim(1);
      const now = Math.floor(Date.now() / 1000);
      expect(item.lease_until - now).toBeCloseTo(15 * 60, -1);
    });

    it('accepts custom lease duration', () => {
      ingest({ source: 'gmail', source_id: 'custom-lease' });
      const [item] = claim(1, 300); // 5-minute lease
      const now = Math.floor(Date.now() / 1000);
      expect(item.lease_until - now).toBeCloseTo(300, -1);
    });
  });

  describe('resolve (2.43)', () => {
    it('resolves to open persona → stored', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      claim(10);
      resolve(id, 'general', true);
      expect(getItem(id)!.status).toBe('stored');
      expect(getItem(id)!.persona).toBe('general');
    });

    it('resolves to locked persona → pending_unlock', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      claim(10);
      resolve(id, 'health', false);
      expect(getItem(id)!.status).toBe('pending_unlock');
    });

    it('throws for unclaimed item', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      expect(() => resolve(id, 'general', true)).toThrow('cannot resolve');
    });

    it('clears raw body on resolve (privacy protection)', () => {
      const { id } = ingest({
        source: 'gmail',
        source_id: 'priv-1',
        data: { body: 'Sensitive raw email content', summary: 'Email subject' },
      });
      claim(10);
      resolve(id, 'general', true);
      // Body should be cleared after resolve
      expect(getItem(id)!.data.body).toBe('');
      // Other data fields preserved
      expect(getItem(id)!.data.summary).toBe('Email subject');
    });

    it('body clearing handles items without body field', () => {
      const { id } = ingest({
        source: 'gmail',
        source_id: 'priv-2',
        data: { summary: 'No body here' },
      });
      claim(10);
      resolve(id, 'general', true);
      // Should not crash when body is absent
      expect(getItem(id)!.data.summary).toBe('No body here');
      expect(getItem(id)!.data.body).toBeUndefined();
    });
  });

  describe('fail (2.44)', () => {
    it('increments retry_count', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      claim(10);
      fail(id);
      expect(getItem(id)!.retry_count).toBe(1);
      expect(getItem(id)!.status).toBe('failed');
    });

    it('throws for non-classifying item', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      expect(() => fail(id)).toThrow('cannot fail');
    });
  });

  describe('extendLease (2.45)', () => {
    it('extends lease by N seconds', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      claim(10);
      const before = getItem(id)!.lease_until;
      extendLease(id, 300);
      expect(getItem(id)!.lease_until).toBe(before + 300);
    });

    it('uses max(lease_until, now) as base (never shortens lease)', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      claim(10);
      const now = Math.floor(Date.now() / 1000);
      // Even if the lease is in the future, extending from max(lease, now) should work
      extendLease(id, 600);
      const leaseAfter = getItem(id)!.lease_until;
      // The lease should be at least now + 600
      expect(leaseAfter).toBeGreaterThanOrEqual(now + 600);
    });

    it('throws for non-classifying item', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      expect(() => extendLease(id, 300)).toThrow('cannot extend');
    });
  });

  describe('sweep (2.46)', () => {
    it('deletes expired items', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      const item = getItem(id)!;
      const futureNow = item.expires_at + 1;
      const result = sweep(futureNow);
      expect(result.expired).toBe(1);
      expect(inboxSize()).toBe(0);
    });

    it('reverts stale leases', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      claim(10);
      const item = getItem(id)!;
      const pastLease = item.lease_until + 1;
      const result = sweep(pastLease);
      expect(result.leaseReverted).toBe(1);
      expect(getItem(id)!.status).toBe('received');
    });

    it('requeues failed items (retry ≤ 3)', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      claim(10);
      fail(id); // retry_count = 1
      const result = sweep();
      expect(result.requeued).toBe(1);
      expect(getItem(id)!.status).toBe('received');
    });

    it('requeue resets lease_until to 0 (immediately re-claimable)', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'lease-reset' });
      claim(10);
      // Item has a non-zero lease_until after claim
      expect(getItem(id)!.lease_until).toBeGreaterThan(0);
      fail(id);
      sweep();
      // After requeue, lease_until should be 0
      expect(getItem(id)!.lease_until).toBe(0);
      expect(getItem(id)!.status).toBe('received');
    });

    it('dead-letters failed items (retry > 3)', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      // Simulate 4 failures
      for (let i = 0; i < 4; i++) {
        claim(10);
        fail(id);
        if (i < 3) sweep(); // requeue first 3 times
      }
      const result = sweep();
      expect(result.deadLettered).toBe(1);
      expect(getItem(id)!.status).toBe('failed'); // stays failed
    });
  });

  describe('drainForPersona (2.47)', () => {
    it('drains pending_unlock items when persona unlocked', () => {
      const { id: id1 } = ingest({ source: 'gmail', source_id: 'a' });
      const { id: id2 } = ingest({ source: 'gmail', source_id: 'b' });
      claim(10);
      resolve(id1, 'health', false); // pending_unlock
      resolve(id2, 'health', false); // pending_unlock
      const drained = drainForPersona('health');
      expect(drained).toBe(2);
      expect(getItem(id1)!.status).toBe('stored');
      expect(getItem(id2)!.status).toBe('stored');
    });

    it('does not drain items for different persona', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      claim(10);
      resolve(id, 'health', false);
      expect(drainForPersona('general')).toBe(0);
    });
  });

  describe('source_hash integrity', () => {
    it('computes SHA-256 hash on ingest', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a', data: { body: 'Hello world' } });
      const item = getItem(id)!;
      expect(item.source_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('same data produces same hash (deterministic)', () => {
      const data = { body: 'Test content', sender: 'alice@example.com' };
      const hash1 = computeSourceHash(data);
      const hash2 = computeSourceHash(data);
      expect(hash1).toBe(hash2);
    });

    it('different data produces different hash', () => {
      const hash1 = computeSourceHash({ body: 'Hello' });
      const hash2 = computeSourceHash({ body: 'World' });
      expect(hash1).not.toBe(hash2);
    });

    it('empty data produces valid hash', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'b' });
      expect(getItem(id)!.source_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('hash can verify integrity after storage', () => {
      const data = { body: 'Important content', type: 'email' };
      const { id } = ingest({ source: 'gmail', source_id: 'c', data });
      const stored = getItem(id)!;
      // Verify: recompute hash matches stored hash
      expect(computeSourceHash(stored.data)).toBe(stored.source_hash);
    });
  });

  describe('classified_item on resolve', () => {
    it('stores classified_item when provided', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      claim(10);
      const classifiedData = {
        summary: 'Lab results',
        content_l0: 'Email from hospital on 2026-04-13',
        enrichment_status: 'ready',
      };
      resolve(id, 'health', true, classifiedData);
      expect(getItem(id)!.classified_item).toEqual(classifiedData);
    });

    it('classified_item is undefined when not provided (backward compatible)', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'b' });
      claim(10);
      resolve(id, 'general', true);
      expect(getItem(id)!.classified_item).toBeUndefined();
    });

    it('classified_item persists through pending_unlock → drain', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'c' });
      claim(10);
      const classifiedData = { summary: 'Health data', enrichment_status: 'ready' };
      resolve(id, 'health', false, classifiedData);
      expect(getItem(id)!.status).toBe('pending_unlock');
      expect(getItem(id)!.classified_item).toEqual(classifiedData);

      // After drain, classified_item should still be present
      drainForPersona('health');
      expect(getItem(id)!.status).toBe('stored');
      expect(getItem(id)!.classified_item).toEqual(classifiedData);
    });
  });

  describe('error message on fail', () => {
    it('stores error message when provided', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      claim(10);
      fail(id, 'Classification failed: LLM timeout');
      expect(getItem(id)!.error).toBe('Classification failed: LLM timeout');
    });

    it('error is undefined when not provided (backward compatible)', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'b' });
      claim(10);
      fail(id);
      expect(getItem(id)!.error).toBeUndefined();
    });

    it('error message updated on subsequent failures', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'c' });
      claim(10);
      fail(id, 'First error');
      expect(getItem(id)!.error).toBe('First error');

      // Requeue via sweep, claim again, fail again
      sweep();
      claim(10);
      fail(id, 'Second error');
      expect(getItem(id)!.error).toBe('Second error');
      expect(getItem(id)!.retry_count).toBe(2);
    });
  });

  describe('ingest expires_at override', () => {
    it('uses default 7-day TTL when expires_at not provided', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'ttl-default' });
      const now = Math.floor(Date.now() / 1000);
      const sevenDays = 7 * 24 * 60 * 60;
      expect(getItem(id)!.expires_at - now).toBeCloseTo(sevenDays, -1);
    });

    it('uses caller-provided expires_at when given', () => {
      const customExpiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour
      const { id } = ingest({ source: 'gmail', source_id: 'ttl-custom', expires_at: customExpiry });
      expect(getItem(id)!.expires_at).toBe(customExpiry);
    });
  });

  describe('vault write on resolve', () => {
    it('writes classifiedItem to vault when persona is open', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'vw-1' });
      claim(10);
      const classified = { id: 'vault-item-1', summary: 'Test email', type: 'email' };
      resolve(id, 'general', true, classified);

      // Item should now exist in the vault
      const vaultItem = getVaultItem('general', 'vault-item-1');
      expect(vaultItem).not.toBeNull();
      expect(vaultItem!.summary).toBe('Test email');
    });

    it('does NOT write to vault when persona is locked (pending_unlock)', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'vw-2' });
      claim(10);
      const classified = { id: 'vault-item-2', summary: 'Health data', type: 'note' };
      resolve(id, 'health', false, classified);

      // Should NOT be in vault yet — persona is locked
      expect(getVaultItem('health', 'vault-item-2')).toBeNull();
    });

    it('writes to vault on drain after persona unlocks', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'vw-3' });
      claim(10);
      const classified = { id: 'vault-item-3', summary: 'Pending data', type: 'note' };
      resolve(id, 'health', false, classified);

      // Not in vault yet
      expect(getVaultItem('health', 'vault-item-3')).toBeNull();

      // Drain after persona unlock → should write to vault
      drainForPersona('health');
      const vaultItem = getVaultItem('health', 'vault-item-3');
      expect(vaultItem).not.toBeNull();
      expect(vaultItem!.summary).toBe('Pending data');
    });

    it('resolve without classifiedItem does not write to vault', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'vw-4' });
      claim(10);
      resolve(id, 'general', true); // no classifiedItem
      // Nothing should be written — no classified data to write
      expect(getItem(id)!.status).toBe('stored');
    });
  });

  describe('OnDrain callback', () => {
    it('fires on resolve when persona is open + classifiedItem provided', () => {
      const drained: Array<{ id: string; persona: string }> = [];
      setOnDrainCallback((item, persona) => {
        drained.push({ id: item.id, persona });
      });

      const { id } = ingest({ source: 'gmail', source_id: 'drain-cb-1' });
      claim(10);
      resolve(id, 'general', true, { id: 'v1', summary: 'Test', type: 'note' });

      expect(drained).toHaveLength(1);
      expect(drained[0].persona).toBe('general');
    });

    it('fires on drainForPersona for each drained item', () => {
      const drained: string[] = [];
      setOnDrainCallback((item) => {
        drained.push(item.id);
      });

      const { id: id1 } = ingest({ source: 'g', source_id: 'drain-cb-2' });
      const { id: id2 } = ingest({ source: 'g', source_id: 'drain-cb-3' });
      claim(10);
      resolve(id1, 'health', false, { id: 'v2', type: 'note' });
      resolve(id2, 'health', false, { id: 'v3', type: 'note' });

      // Reset to only track drain events
      drained.length = 0;
      drainForPersona('health');
      expect(drained).toHaveLength(2);
    });

    it('does NOT fire when no classifiedItem on resolve', () => {
      const drained: string[] = [];
      setOnDrainCallback((item) => {
        drained.push(item.id);
      });

      const { id } = ingest({ source: 'g', source_id: 'drain-cb-4' });
      claim(10);
      resolve(id, 'general', true); // no classifiedItem → no vault write → no callback
      expect(drained).toHaveLength(0);
    });
  });

  describe('listByStatus', () => {
    it('returns items with matching status', () => {
      ingest({ source: 'g', source_id: 'ls-1' });
      ingest({ source: 'g', source_id: 'ls-2' });
      const { id } = ingest({ source: 'g', source_id: 'ls-3' });
      claim(1); // claims first item → classifying

      const received = listByStatus('received');
      expect(received).toHaveLength(2);

      const classifying = listByStatus('classifying');
      expect(classifying).toHaveLength(1);
    });

    it('returns empty for status with no items', () => {
      ingest({ source: 'g', source_id: 'ls-4' });
      expect(listByStatus('failed')).toHaveLength(0);
    });
  });

  describe('getStatusForOwner', () => {
    it('returns status when ownership matches', () => {
      const { id } = ingest({ source: 'g', source_id: 'own-1', producer_id: 'brain-1' });
      const result = getStatusForOwner(id, 'brain-1');
      expect(result).not.toBeNull();
      expect(result!.status).toBe('received');
    });

    it('returns null when ownership does NOT match', () => {
      const { id } = ingest({ source: 'g', source_id: 'own-2', producer_id: 'brain-1' });
      expect(getStatusForOwner(id, 'brain-2')).toBeNull();
    });

    it('returns null for unknown ID', () => {
      expect(getStatusForOwner('stg-unknown', 'brain-1')).toBeNull();
    });

    it('includes persona after resolve', () => {
      const { id } = ingest({ source: 'g', source_id: 'own-3', producer_id: 'brain-x' });
      claim(10);
      resolve(id, 'health', true);
      const result = getStatusForOwner(id, 'brain-x');
      expect(result!.status).toBe('stored');
      expect(result!.persona).toBe('health');
    });
  });

  describe('resolveMulti (multi-persona)', () => {
    it('writes to multiple open persona vaults', () => {
      const { id } = ingest({ source: 'g', source_id: 'rm-1' });
      claim(10);
      const classified = { id: 'multi-v1', summary: 'Medical bill', type: 'note' };
      const count = resolveMulti(
        id,
        [
          { persona: 'health', personaOpen: true },
          { persona: 'financial', personaOpen: true },
        ],
        classified,
      );

      expect(count).toBe(2);
      expect(getVaultItem('health', 'multi-v1')).not.toBeNull();
      expect(getVaultItem('financial', 'multi-v1')).not.toBeNull();
    });

    it('marks stored when any target is open', () => {
      const { id } = ingest({ source: 'g', source_id: 'rm-2' });
      claim(10);
      resolveMulti(
        id,
        [
          { persona: 'general', personaOpen: true },
          { persona: 'health', personaOpen: false },
        ],
        { id: 'multi-v2', type: 'note' },
      );

      expect(getItem(id)!.status).toBe('stored');
    });

    it('marks pending_unlock when all targets are locked', () => {
      const { id } = ingest({ source: 'g', source_id: 'rm-3' });
      claim(10);
      resolveMulti(
        id,
        [
          { persona: 'health', personaOpen: false },
          { persona: 'financial', personaOpen: false },
        ],
        { id: 'multi-v3', type: 'note' },
      );

      expect(getItem(id)!.status).toBe('pending_unlock');
    });

    it('throws for empty targets', () => {
      const { id } = ingest({ source: 'g', source_id: 'rm-4' });
      claim(10);
      expect(() => resolveMulti(id, [])).toThrow('at least one target');
    });

    it('clears body after resolve', () => {
      const { id } = ingest({ source: 'g', source_id: 'rm-5', data: { body: 'secret' } });
      claim(10);
      resolveMulti(id, [{ persona: 'general', personaOpen: true }], { id: 'v5', type: 'note' });
      expect(getItem(id)!.data.body).toBe('');
    });
  });

  describe('markPendingApproval', () => {
    it('transitions classifying → pending_approval with approval ID', () => {
      const { id } = ingest({ source: 'g', source_id: 'pa-1' });
      claim(10);
      markPendingApproval(id, 'apr-001');
      expect(getItem(id)!.status).toBe('pending_approval');
      expect(getItem(id)!.approval_id).toBe('apr-001');
    });

    it('throws for non-classifying item', () => {
      const { id } = ingest({ source: 'g', source_id: 'pa-2' });
      expect(() => markPendingApproval(id, 'apr-002')).toThrow('cannot mark');
    });

    it('resumeAfterApprovalGranted transitions back to classifying', () => {
      const { id } = ingest({ source: 'g', source_id: 'pa-3' });
      claim(10);
      markPendingApproval(id, 'apr-003');
      expect(getItem(id)!.status).toBe('pending_approval');

      resumeAfterApprovalGranted(id);
      expect(getItem(id)!.status).toBe('classifying');
      // Should have a fresh lease
      expect(getItem(id)!.lease_until).toBeGreaterThan(0);
    });

    it('resumed item can then be resolved normally', () => {
      const { id } = ingest({ source: 'g', source_id: 'pa-4' });
      claim(10);
      markPendingApproval(id, 'apr-004');
      resumeAfterApprovalGranted(id);
      // Now resolve as normal
      resolve(id, 'health', true, { id: 'v-pa', type: 'note', summary: 'Approved' });
      expect(getItem(id)!.status).toBe('stored');
      expect(getVaultItem('health', 'v-pa')).not.toBeNull();
    });
  });
});
