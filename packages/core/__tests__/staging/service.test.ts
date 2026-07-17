/**
 * T2.41–2.47 — Staging service: ingest, claim, resolve, fail, sweep, drain.
 *
 * Source: ARCHITECTURE.md Tasks 2.41–2.47
 */

import { InMemoryStagingRepository, setStagingRepository } from '../../src/staging/repository';
import { InMemoryWorkflowRepository, setWorkflowRepository } from '../../src/workflow/repository';
import {
  WorkflowService,
  getWorkflowService,
  setWorkflowService,
} from '../../src/workflow/service';
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
  hydrateStagingFromRepository,
  drainForApproval,
  denyApproval,
  type StagingItem,
  clearOnDrainCallback,
} from '../../src/staging/service';
import { getItem as getVaultItem, listRecentItems, clearVaults } from '../../src/vault/crud';
import { currentDataScope, resetDataScope, setCurrentDataScope } from '../../src/scope/data_scope';
import { createPersona, openPersona, resetPersonaState } from '../../src/persona/service';

describe('Staging Service', () => {
  beforeEach(() => {
    resetStagingState();
    setStagingRepository(null);
    resetDataScope();
    const workflowRepo = new InMemoryWorkflowRepository();
    setWorkflowRepository(workflowRepo);
    setWorkflowService(new WorkflowService({ repository: workflowRepo }));
    clearVaults();
  });

  afterEach(() => {
    resetStagingState();
    setStagingRepository(null);
    resetDataScope();
    setWorkflowService(null);
    setWorkflowRepository(null);
  });

  describe('data-scope isolation (guided demo)', () => {
    it('ingest stamps the current data scope', () => {
      const { id: userId } = ingest({ source: 'user_remember', source_id: 'u1' });
      expect(getItem(userId)!.data_scope).toBe('user');

      setCurrentDataScope('guided_demo:run1');
      const { id: demoId } = ingest({ source: 'user_remember', source_id: 'd1' });
      expect(getItem(demoId)!.data_scope).toBe('guided_demo:run1');
      expect(currentDataScope()).toBe('guided_demo:run1');
    });

    it.each([
      ['in-memory', false],
      ['sqlite-repo', true],
    ])(
      'dedup is per-scope: SAME (producer,source,source_id) in user+demo → TWO rows (%s)',
      (_label, useRepo) => {
        if (useRepo) setStagingRepository(new InMemoryStagingRepository());

        // Identical dedup tuple, different scopes — must NOT collide.
        const u = ingest({ source: 'connector', source_id: 'stable-id', producer_id: 'p' });
        expect(u.duplicate).toBe(false);

        setCurrentDataScope('guided_demo:run1');
        const d = ingest({ source: 'connector', source_id: 'stable-id', producer_id: 'p' });
        expect(d.duplicate).toBe(false); // a distinct row in the demo scope
        expect(d.id).not.toBe(u.id);
        expect(getItem(d.id)!.data_scope).toBe('guided_demo:run1');

        // Re-ingesting the SAME tuple within the demo scope IS a duplicate.
        const d2 = ingest({ source: 'connector', source_id: 'stable-id', producer_id: 'p' });
        expect(d2).toEqual({ id: d.id, duplicate: true });
      },
    );

    it.each([
      ['in-memory', false],
      ['sqlite-repo', true],
    ])('claim only returns items in the CURRENT scope (%s)', (_label, useRepo) => {
      if (useRepo) setStagingRepository(new InMemoryStagingRepository());

      // One user item, one demo item.
      ingest({ source: 'user_remember', source_id: 'u1' });
      setCurrentDataScope('guided_demo:run1');
      ingest({ source: 'user_remember', source_id: 'd1' });

      // On the user scope the drain must NOT pick up the demo row (u1 is now
      // leased → 'classifying'; d1 stays 'received' but in the demo scope).
      setCurrentDataScope('user');
      const userClaim = claim(10);
      expect(userClaim.map((i) => i.source_id)).toEqual(['u1']);

      // On the demo scope it claims only the demo row.
      setCurrentDataScope('guided_demo:run1');
      const demoClaim = claim(10);
      expect(demoClaim.map((i) => i.source_id)).toEqual(['d1']);
    });

    it('exact-ID mutations reject an item from a DIFFERENT scope', () => {
      // Claim a demo item (status → classifying) in the demo scope…
      setCurrentDataScope('guided_demo:run1');
      const { id } = ingest({ source: 'user_remember', source_id: 'd1' });
      const [claimed] = claim(1);
      expect(claimed?.id).toBe(id);

      // …then a by-id mutation while the runtime flipped to the user scope must
      // refuse to touch the demo-scoped row (defense-in-depth for the scope model).
      setCurrentDataScope('user');
      expect(() => resolve(id, 'general', true, { summary: 'x' })).toThrow(/not the current scope/);
      expect(() => fail(id)).toThrow(/not the current scope/);
      expect(() => extendLease(id, 60)).toThrow(/not the current scope/);

      // Back in the demo scope, the same mutation is allowed.
      setCurrentDataScope('guided_demo:run1');
      expect(() => extendLease(id, 60)).not.toThrow();
    });

    it('crash/restart: a leftover demo row is never claimed back on the user scope', () => {
      setStagingRepository(new InMemoryStagingRepository());
      // A demo /remember leaves a 'received' row (it never drained inline).
      setCurrentDataScope('guided_demo:run1');
      ingest({ source: 'user_remember', source_id: 'leftover' });

      // Simulate a restart: drop the in-memory cache, keep the persisted rows,
      // and return to the user scope (the demo has ended).
      resetStagingState({ preserveRepositoryRows: true });
      setCurrentDataScope('user');
      hydrateStagingFromRepository();

      // The interval drain on the user scope finds nothing to claim.
      expect(claim(10)).toEqual([]);
      // The row still exists (cleanup deletes it by scope; here we only assert
      // the drain can't resolve it into the user vault).
      expect(inboxSize()).toBe(1);
    });
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

  describe('repository authority', () => {
    beforeEach(() => {
      setStagingRepository(new InMemoryStagingRepository());
    });

    it('dedup reads from the repository after the in-memory cache is reset', () => {
      const first = ingest({ source: 'gmail', source_id: 'repo-dedup', producer_id: 'brain' });

      resetStagingState({ preserveRepositoryRows: true });

      const second = ingest({ source: 'gmail', source_id: 'repo-dedup', producer_id: 'brain' });
      expect(second).toEqual({ id: first.id, duplicate: true });
      expect(inboxSize()).toBe(1);
    });

    it('ingest -> restart -> claim -> resolve survives on the repository authority', () => {
      const { id } = ingest({
        source: 'chat',
        source_id: 'repo-restart',
        data: { body: 'Remember this after restart', summary: 'Restart memory' },
      });

      resetStagingState({ preserveRepositoryRows: true });
      expect(getItem(id)).not.toBeNull();

      const claimed = claim(1);
      expect(claimed.map((item) => item.id)).toEqual([id]);
      expect(claimed[0]?.status).toBe('classifying');

      const classified = { id: 'repo-vault-1', type: 'note', summary: 'Restart memory' };
      resolve(id, 'general', true, classified);

      resetStagingState({ preserveRepositoryRows: true });
      const stored = getItem(id);
      expect(stored?.status).toBe('stored');
      expect(stored?.persona).toBe('general');
      expect(stored?.data.body).toBe('');
      expect(stored?.classified_item).toEqual(classified);
      // PLG-29 #3: the vault primary key is Core-owned (`stg-<stagingId>`), NOT
      // the classifier-supplied `id: 'repo-vault-1'` (which can no longer dictate
      // the storage key + overwrite an unrelated row).
      expect(getVaultItem('general', `stg-${id}`)).not.toBeNull();
    });

    it('hydrates the in-memory cache from repository rows explicitly', () => {
      const one = ingest({ source: 'gmail', source_id: 'hydrate-1' });
      const two = ingest({ source: 'gmail', source_id: 'hydrate-2' });

      resetStagingState({ preserveRepositoryRows: true });
      const hydrated = hydrateStagingFromRepository();

      expect(hydrated).toBe(2);
      expect(getItem(one.id)?.status).toBe('received');
      expect(getItem(two.id)?.status).toBe('received');
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
    it('does not bypass approval-backed pending_unlock rows on persona unlock', () => {
      const { id: id1 } = ingest({ source: 'gmail', source_id: 'a' });
      const { id: id2 } = ingest({ source: 'gmail', source_id: 'b' });
      claim(10);
      resolve(id1, 'health', false); // pending_unlock
      resolve(id2, 'health', false); // pending_unlock
      const drained = drainForPersona('health');
      expect(drained).toBe(0);
      expect(getItem(id1)!.status).toBe('pending_unlock');
      expect(getItem(id2)!.status).toBe('pending_unlock');
    });

    it('does not drain items for different persona', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      claim(10);
      resolve(id, 'health', false);
      expect(drainForPersona('general')).toBe(0);
    });
  });

  describe('approval-backed pending_unlock', () => {
    it('creates a durable workflow approval for a locked target', () => {
      const { id } = ingest({
        source: 'chat',
        source_id: 'approval-1',
        data: { body: 'remember my blood type is O positive' },
      });
      claim(10);
      resolve(id, 'health', false, {
        id: 'approval-v1',
        type: 'note',
        summary: 'Blood type',
      });

      const item = getItem(id)!;
      expect(item.status).toBe('pending_unlock');
      expect(item.approval_id).toMatch(/^approval-staging-/);

      const task = getWorkflowService()!.store().getById(item.approval_id!);
      expect(task).toMatchObject({
        kind: 'approval',
        status: 'pending_approval',
        priority: 'user_blocking',
      });
      expect(JSON.parse(task!.payload)).toMatchObject({
        type: 'staging_persona_access',
        staging_id: id,
        persona: 'health',
        preview: 'Blood type',
      });
    });

    it('approval resume stores the staged item after a cache reset', () => {
      setStagingRepository(new InMemoryStagingRepository());
      const { id } = ingest({
        source: 'chat',
        source_id: 'approval-restart',
        data: { body: 'remember cardiologist appointment' },
      });
      claim(10);
      resolve(id, 'health', false, {
        id: 'approval-v2',
        type: 'note',
        summary: 'Cardiologist appointment',
      });
      const approvalId = getItem(id)!.approval_id!;

      resetStagingState({ preserveRepositoryRows: true });
      hydrateStagingFromRepository();

      const result = drainForApproval(approvalId);
      expect(result).toMatchObject({ matched: 1, drained: 1, alreadyStored: 0 });
      expect(getItem(id)!.status).toBe('stored');
      expect(getVaultItem('health', `stg-${id}`)).not.toBeNull(); // PLG-29 #3: Core-owned id
    });

    it('PLG-27 #6: an id-less classified item is stored under a DETERMINISTIC stg-<id> (so a recovery re-drive upserts, never duplicates)', () => {
      setStagingRepository(new InMemoryStagingRepository());
      const { id } = ingest({
        source: 'chat',
        source_id: 'approval-nodup',
        data: { body: 'remember allergy penicillin' },
      });
      claim(10);
      // classified_item with NO id. Previously storeItem minted a fresh RANDOM id
      // per drain, so a recovery re-drive after a crash (vault write landed but
      // the staging status did not persist) inserted a DUPLICATE vault row. The
      // fix pins a stable id derived from the staging id, so storeItem's
      // INSERT-OR-REPLACE makes any re-drive an idempotent upsert on the same row.
      resolve(id, 'health', false, { type: 'note', summary: 'Allergy' });
      const approvalId = getItem(id)!.approval_id!;

      expect(drainForApproval(approvalId)).toMatchObject({ drained: 1 });
      // The vault item lives at a DETERMINISTIC id derived from the staging id,
      // NOT a random one. Because the id is a pure function of the staging id, a
      // recovery re-drive (which reloads the id-less classified item from the
      // repo) recomputes the SAME id, so storeItem's INSERT-OR-REPLACE upserts the
      // same row instead of inserting a duplicate. A revert to a random id would
      // make this lookup null.
      const stableId = `stg-${id}`;
      expect(getVaultItem('health', stableId)).not.toBeNull();
      expect(listRecentItems('health', 100)).toHaveLength(1);
    });

    it('approval denial fails the staged item without storing or retrying', () => {
      const { id } = ingest({
        source: 'chat',
        source_id: 'approval-deny',
        data: { body: 'remember private diagnosis' },
      });
      claim(10);
      resolve(id, 'health', false, {
        id: 'approval-v3',
        type: 'note',
        summary: 'Private diagnosis',
      });
      const approvalId = getItem(id)!.approval_id!;

      const result = denyApproval(approvalId, 'denied_by_operator');
      expect(result).toMatchObject({ matched: 1, denied: 1 });
      expect(getItem(id)).toMatchObject({
        status: 'failed',
        error: 'denied_by_operator',
        retry_count: 4,
      });
      expect(sweep().requeued).toBe(0);
      expect(getVaultItem('health', 'approval-v3')).toBeNull();
    });

    it('user_remember source skips approval gate for closed persona (owner writes own vault)', () => {
      // The owner types /remember on mobile — no approval needed.
      // The item should park as pending_unlock without an approval task.
      const { id } = ingest({
        source: 'user_remember',
        source_id: 'remember-health-1',
        data: { body: 'my blood pressure is 120/80' },
      });
      claim(10);
      resolve(id, 'health', false, {
        id: 'remember-v1',
        type: 'note',
        summary: 'Blood pressure reading',
      });

      const item = getItem(id)!;
      expect(item.status).toBe('pending_unlock');
      // No approval task — owner does not need to approve their own vault writes.
      expect(item.approval_id).toBeUndefined();

      // Verify no task was created by constructing the expected approval ID and
      // confirming it doesn't exist in the workflow store.
      const expectedApprovalId = `approval-staging-${id}-health`;
      expect(getWorkflowService()!.store().getById(expectedApprovalId)).toBeNull();
    });

    it('external source still creates approval gate for closed persona', () => {
      // An agent or connector writing to a closed persona must go through approval.
      const { id } = ingest({
        source: 'gmail',
        source_id: 'external-health-1',
        data: { body: 'lab results from clinic' },
      });
      claim(10);
      resolve(id, 'health', false, {
        id: 'external-v1',
        type: 'note',
        summary: 'Lab results',
      });

      const item = getItem(id)!;
      expect(item.status).toBe('pending_unlock');
      expect(item.approval_id).toMatch(/^approval-staging-/);
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

    it('classified_item is undefined when not provided', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'b' });
      claim(10);
      resolve(id, 'general', true);
      expect(getItem(id)!.classified_item).toBeUndefined();
    });

    it('classified_item persists through pending_unlock → approval drain', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'c' });
      claim(10);
      const classifiedData = { summary: 'Health data', enrichment_status: 'ready' };
      resolve(id, 'health', false, classifiedData);
      expect(getItem(id)!.status).toBe('pending_unlock');
      expect(getItem(id)!.classified_item).toEqual(classifiedData);

      drainForApproval(getItem(id)!.approval_id!);
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

    it('error is undefined when not provided', () => {
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

      // Item should now exist in the vault under the Core-owned id (PLG-29 #3),
      // not the classifier-supplied `id: 'vault-item-1'`.
      const vaultItem = getVaultItem('general', `stg-${id}`);
      expect(vaultItem).not.toBeNull();
      expect(vaultItem!.summary).toBe('Test email');
    });

    it('PLG-29 #3: a classifier-supplied id CANNOT overwrite another item’s vault row', () => {
      // Victim: a normal remember stored under its Core-owned id.
      const { id: victimId } = ingest({ source: 'chat', source_id: 'victim' });
      claim(10);
      resolve(victimId, 'general', true, { type: 'note', summary: 'victim data' });
      const victimVaultId = `stg-${victimId}`;
      expect(getVaultItem('general', victimVaultId)!.summary).toBe('victim data');

      // Attacker: a second remember whose classifier output tries to REUSE the
      // victim's vault id (INSERT-OR-REPLACE would otherwise overwrite it).
      const { id: attackerId } = ingest({ source: 'chat', source_id: 'attacker' });
      claim(10);
      resolve(attackerId, 'general', true, {
        id: victimVaultId,
        type: 'note',
        summary: 'HIJACKED',
      });

      // The supplied id is IGNORED — the victim row is untouched, and the
      // attacker's item lands under ITS OWN Core-owned id.
      expect(getVaultItem('general', victimVaultId)!.summary).toBe('victim data');
      expect(getVaultItem('general', `stg-${attackerId}`)!.summary).toBe('HIJACKED');
    });

    it('does NOT write to vault when persona is locked (pending_unlock)', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'vw-2' });
      claim(10);
      const classified = { id: 'vault-item-2', summary: 'Health data', type: 'note' };
      resolve(id, 'health', false, classified);

      // Should NOT be in vault yet — persona is locked
      expect(getVaultItem('health', 'vault-item-2')).toBeNull();
    });

    it('writes to vault on approval drain', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'vw-3' });
      claim(10);
      const classified = { id: 'vault-item-3', summary: 'Pending data', type: 'note' };
      resolve(id, 'health', false, classified);

      // Not in vault yet
      expect(getVaultItem('health', 'vault-item-3')).toBeNull();

      drainForApproval(getItem(id)!.approval_id!);
      const vaultItem = getVaultItem('health', `stg-${id}`); // PLG-29 #3: Core-owned id
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

    it('fires on drainForApproval for each drained item', () => {
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
      drainForApproval(getItem(id1)!.approval_id!);
      drainForApproval(getItem(id2)!.approval_id!);
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
      // PLG-29 #3: Core-owned id — the SAME `stg-<stagingId>` in each open
      // persona's separate DB file (harmless; keys are per-persona).
      expect(getVaultItem('health', `stg-${id}`)).not.toBeNull();
      expect(getVaultItem('financial', `stg-${id}`)).not.toBeNull();
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

    it('throws when a locked-secondary copy cannot be persisted (PLG-31 #12)', () => {
      // A repo whose ingest REJECTS the financial secondary copy AND has no row
      // at that id — the INSERT-OR-IGNORE fired on the dedup key under a
      // different id, or storage failed. resolveMulti must NOT fall through and
      // cache the un-persisted phantom (it would back an approval that vanishes
      // on restart); it fails the whole resolve so the caller retries cleanly.
      class RejectSecondaryRepo extends InMemoryStagingRepository {
        constructor(private readonly rejectPersona: string) {
          super();
        }
        override ingest(item: StagingItem): boolean {
          if (item.persona === this.rejectPersona) return false;
          return super.ingest(item);
        }
        override get(id: string): StagingItem | null {
          if (id.endsWith(`-${this.rejectPersona}`)) return null;
          return super.get(id);
        }
      }
      setStagingRepository(new RejectSecondaryRepo('financial'));
      const { id } = ingest({ source: 'g', source_id: 'rm-phantom' });
      claim(10);

      expect(() =>
        resolveMulti(
          id,
          [
            { persona: 'health', personaOpen: false }, // primary (tracks on original)
            { persona: 'financial', personaOpen: false }, // secondary copy → rejected
          ],
          { id: 'multi-phantom', type: 'note' },
        ),
      ).toThrow(/could not be persisted/);

      // The phantom id was never cached as a live target.
      expect(getItem(`${id}-financial`)).toBeNull();
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
      expect(getVaultItem('health', `stg-${id}`)).not.toBeNull(); // PLG-29 #3: Core-owned id
    });
  });
});

describe('Staging Service PLG-32 hardening', () => {
  beforeEach(() => {
    resetStagingState();
    setStagingRepository(null);
    resetDataScope();
    resetPersonaState();
    const workflowRepo = new InMemoryWorkflowRepository();
    setWorkflowRepository(workflowRepo);
    setWorkflowService(new WorkflowService({ repository: workflowRepo }));
    clearVaults();
  });
  afterEach(() => {
    resetStagingState();
    setStagingRepository(null);
    resetDataScope();
    resetPersonaState();
    setWorkflowService(null);
    setWorkflowRepository(null);
    clearOnDrainCallback();
  });

  describe('#1: Core derives persona-open, never trusts the caller upward', () => {
    it('OVERRIDES a caller claiming open=true for a persona Core knows is CLOSED', () => {
      createPersona('health', 'sensitive'); // exists, isOpen=false (sealed)
      const { id } = ingest({ source: 'g', source_id: 'derive-1' });
      claim(10);
      // The caller LIES: persona_open=true for a persona Core knows is sealed.
      resolve(id, 'health', true, { id: 'v1', type: 'note', summary: 'x' });
      // Core forced the approval gate: pending_unlock, NOT a silent open store.
      expect(getItem(id)?.status).toBe('pending_unlock');
      expect(getVaultItem('health', `stg-${id}`)).toBeNull();
    });

    it('HONORS open=true for a persona Core confirms is OPEN', () => {
      createPersona('general', 'standard');
      openPersona('general');
      const { id } = ingest({ source: 'g', source_id: 'derive-2' });
      claim(10);
      resolve(id, 'general', true, { id: 'v2', type: 'note', summary: 'x' });
      expect(getItem(id)?.status).toBe('stored');
      expect(getVaultItem('general', `stg-${id}`)).not.toBeNull();
    });

    it('falls back to the caller claim when Core has no record of the persona', () => {
      const { id } = ingest({ source: 'g', source_id: 'derive-3' });
      claim(10);
      // Empty registry → no positive knowledge → existing behavior preserved.
      resolve(id, 'general', true, { id: 'v3', type: 'note', summary: 'x' });
      expect(getItem(id)?.status).toBe('stored');
    });
  });

  it('#25: an OnDrain hook that THROWS does not fail a committed store', () => {
    createPersona('general', 'standard');
    openPersona('general');
    setOnDrainCallback(() => {
      throw new Error('post-publication hook boom');
    });
    const { id } = ingest({ source: 'g', source_id: 'cb-1' });
    claim(10);
    expect(() =>
      resolve(id, 'general', true, { id: 'vcb', type: 'note', summary: 'x' }),
    ).not.toThrow();
    expect(getItem(id)?.status).toBe('stored');
    expect(getVaultItem('general', `stg-${id}`)).not.toBeNull();
  });

  it('#8: a secondary-copy persistence failure CANCELS the approvals it created (no orphans)', () => {
    class RejectSecondaryRepo extends InMemoryStagingRepository {
      constructor(private readonly rejectPersona: string) {
        super();
      }
      override ingest(item: StagingItem): boolean {
        if (item.persona === this.rejectPersona) return false;
        return super.ingest(item);
      }
      override get(id: string): StagingItem | null {
        if (id.endsWith(`-${this.rejectPersona}`)) return null;
        return super.get(id);
      }
    }
    setStagingRepository(new RejectSecondaryRepo('financial'));
    const { id } = ingest({ source: 'g', source_id: 'orphan-1' });
    claim(10);
    expect(() =>
      resolveMulti(
        id,
        [
          { persona: 'health', personaOpen: false }, // primary
          { persona: 'financial', personaOpen: false }, // secondary → ingest rejected
        ],
        { id: 'vorphan', type: 'note' },
      ),
    ).toThrow(/could not be persisted/);
    // The approval created for the primary is rolled back — no orphan card guards
    // a staging row that was never written.
    const store = getWorkflowService()?.store();
    if (!store) throw new Error('setup: workflow service missing');
    expect(store.getById(`approval-staging-${id}-health`)?.status).toBe('cancelled');
    const fin = store.getById(`approval-staging-${id}-financial`);
    if (fin) expect(fin.status).toBe('cancelled');
  });
});
