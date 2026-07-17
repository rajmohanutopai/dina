/**
 * Staging route contract tests.
 *
 * These use the real CoreRouter registration plus InProcessTransport so
 * the transport-level `/v1/staging/ingest` boundary is exercised without
 * importing staging service internals from the caller side.
 */

import { InProcessTransport } from '../../src/client/in-process-transport';
import { createCoreRouter } from '../../src/server/core_server';
import {
  getItem,
  hydrateStagingFromRepository,
  resetStagingState,
} from '../../src/staging/service';
import { InMemoryStagingRepository, setStagingRepository } from '../../src/staging/repository';
import { getItem as getVaultItem } from '../../src/vault/crud';
import { InMemoryWorkflowRepository, setWorkflowRepository } from '../../src/workflow/repository';
import {
  WorkflowService,
  getWorkflowService,
  setWorkflowService,
} from '../../src/workflow/service';

describe('staging routes', () => {
  beforeEach(() => {
    resetStagingState();
    const workflowRepo = new InMemoryWorkflowRepository();
    setWorkflowRepository(workflowRepo);
    setWorkflowService(new WorkflowService({ repository: workflowRepo }));
  });

  afterEach(() => {
    resetStagingState();
    setStagingRepository(null);
    setWorkflowService(null);
    setWorkflowRepository(null);
  });

  it('ingests through CoreClient and then claims the received item', async () => {
    const client = new InProcessTransport(createCoreRouter());

    const ingested = await client.stagingIngest({
      source: 'chat',
      sourceId: 'msg-1',
      producerId: 'did:plc:brain',
      data: { body: 'remember Emma likes dinosaurs' },
    });
    expect(ingested.duplicate).toBe(false);
    expect(ingested.status).toBe('received');
    expect(ingested.itemId).toMatch(/^stg-/);

    const claimed = await client.stagingClaim(1);
    expect(claimed.count).toBe(1);
    expect(claimed.items).toHaveLength(1);
    expect(claimed.items[0]).toMatchObject({
      id: ingested.itemId,
      source: 'chat',
      source_id: 'msg-1',
      producer_id: 'did:plc:brain',
      status: 'classifying',
      data: { body: 'remember Emma likes dinosaurs' },
    });
  });

  it('deduplicates by producer/source/source_id', async () => {
    const client = new InProcessTransport(createCoreRouter());
    const first = await client.stagingIngest({
      source: 'chat',
      sourceId: 'msg-1',
      producerId: 'did:plc:brain',
      data: { body: 'first' },
    });
    const second = await client.stagingIngest({
      source: 'chat',
      sourceId: 'msg-1',
      producerId: 'did:plc:brain',
      data: { body: 'second' },
    });

    expect(second).toEqual({
      itemId: first.itemId,
      duplicate: true,
      status: 'received',
    });
  });

  it('rejects missing source_id before creating a staging row', async () => {
    const client = new InProcessTransport(createCoreRouter());
    await expect(
      client.stagingIngest({
        source: 'chat',
        sourceId: '',
        data: { body: 'invalid' },
      }),
    ).rejects.toThrow(/source_id must be a non-empty string/);
  });

  it('requires an explicit persona_open boolean for single-persona resolve', async () => {
    const client = new InProcessTransport(createCoreRouter());
    const ingested = await client.stagingIngest({
      source: 'chat',
      sourceId: 'single-gate',
      data: { body: 'remember my dentist is Dr Carl' },
    });
    await client.stagingClaim(1);

    await expect(
      client.stagingResolve({
        itemId: ingested.itemId,
        persona: 'health',
        data: { id: 'single-gate-vault', type: 'note', summary: 'Dentist' },
      } as unknown as Parameters<typeof client.stagingResolve>[0]),
    ).rejects.toThrow(/persona_open must be a boolean/);
  });

  it('requires persona_access for every multi-persona target', async () => {
    const client = new InProcessTransport(createCoreRouter());
    const ingested = await client.stagingIngest({
      source: 'chat',
      sourceId: 'multi-gate-missing',
      data: { body: 'remember the clinic bill' },
    });
    await client.stagingClaim(1);

    await expect(
      client.stagingResolve({
        itemId: ingested.itemId,
        persona: ['health', 'financial'],
        data: { id: 'multi-gate-missing-vault', type: 'note', summary: 'Clinic bill' },
        personaAccess: { health: true },
      } as unknown as Parameters<typeof client.stagingResolve>[0]),
    ).rejects.toThrow(/persona_access\.financial must be a boolean/);
  });

  it('fans out only to explicitly open personas and parks locked targets', async () => {
    const client = new InProcessTransport(createCoreRouter());
    const ingested = await client.stagingIngest({
      source: 'chat',
      sourceId: 'multi-gate',
      data: { body: 'remember the clinic bill' },
    });
    await client.stagingClaim(1);

    const resolved = await client.stagingResolve({
      itemId: ingested.itemId,
      persona: ['general', 'health'],
      data: { id: 'multi-gate-vault', type: 'note', summary: 'Clinic bill' },
      personaAccess: { general: true, health: false },
    });

    expect(resolved).toEqual({
      itemId: ingested.itemId,
      status: 'stored',
      personas: ['general', 'health'],
    });
    // PLG-29 #3: Core-owned vault id (`stg-<stagingId>`), not the classifier `id`.
    expect(getVaultItem('general', `stg-${ingested.itemId}`)).not.toBeNull();
    expect(getVaultItem('health', `stg-${ingested.itemId}`)).toBeNull(); // locked → not stored
    expect(getItem(`${ingested.itemId}-health`)).toMatchObject({
      persona: 'health',
      status: 'pending_unlock',
    });
  });

  it('single-persona resolve passes classified data through to vault storage', async () => {
    const client = new InProcessTransport(createCoreRouter());
    const ingested = await client.stagingIngest({
      source: 'chat',
      sourceId: 'single-store',
      data: { body: 'remember Emma likes astronomy' },
    });
    await client.stagingClaim(1);

    const resolved = await client.stagingResolve({
      itemId: ingested.itemId,
      persona: 'general',
      personaOpen: true,
      data: { id: 'single-store-vault', type: 'note', summary: 'Emma likes astronomy' },
    });

    expect(resolved.status).toBe('stored');
    expect(getVaultItem('general', `stg-${ingested.itemId}`)).not.toBeNull(); // PLG-29 #3
  });

  it('approval stores a locked single-persona remember after cache reset', async () => {
    setStagingRepository(new InMemoryStagingRepository());
    const client = new InProcessTransport(createCoreRouter());
    const ingested = await client.stagingIngest({
      source: 'chat',
      sourceId: 'locked-approval',
      data: { body: 'remember my allergist is Dr Rao' },
    });
    await client.stagingClaim(1);

    await client.stagingResolve({
      itemId: ingested.itemId,
      persona: 'health',
      personaOpen: false,
      data: { id: 'locked-approval-vault', type: 'note', summary: 'Allergist is Dr Rao' },
    });
    const approvalId = getItem(ingested.itemId)!.approval_id!;
    expect(approvalId).toMatch(/^approval-staging-/);

    resetStagingState({ preserveRepositoryRows: true });
    hydrateStagingFromRepository();

    const task = await client.approveWorkflowTask(approvalId);
    expect(task.status).toBe('completed');
    expect(getItem(ingested.itemId)!.status).toBe('stored');
    expect(getVaultItem('health', `stg-${ingested.itemId}`)).not.toBeNull(); // PLG-29 #3
  });

  it('denial fails a locked remember without storing it', async () => {
    const client = new InProcessTransport(createCoreRouter());
    const ingested = await client.stagingIngest({
      source: 'chat',
      sourceId: 'locked-deny',
      data: { body: 'remember sensitive health note' },
    });
    await client.stagingClaim(1);
    await client.stagingResolve({
      itemId: ingested.itemId,
      persona: 'health',
      personaOpen: false,
      data: { id: 'locked-deny-vault', type: 'note', summary: 'Sensitive health note' },
    });
    const approvalId = getItem(ingested.itemId)!.approval_id!;

    const task = await client.cancelWorkflowTask(approvalId, 'denied_by_operator');
    expect(task.status).toBe('cancelled');
    expect(getItem(ingested.itemId)).toMatchObject({
      status: 'failed',
      error: 'denied_by_operator',
      retry_count: 4,
    });
    expect(getVaultItem('health', 'locked-deny-vault')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // PLG-32 approve-failure recovery — a drain failure or an empty/orphan approval
  // must terminalize the task honestly, never a stuck 'running' or false "stored".
  // ---------------------------------------------------------------------------
  describe('approve failure recovery (PLG-32)', () => {
    it('#9: approving a locked remember whose staged rows VANISHED fails (not false "stored")', async () => {
      setStagingRepository(new InMemoryStagingRepository());
      const client = new InProcessTransport(createCoreRouter());
      const ingested = await client.stagingIngest({
        source: 'chat',
        sourceId: 'gone-1',
        data: { body: 'x' },
      });
      await client.stagingClaim(1);
      await client.stagingResolve({
        itemId: ingested.itemId,
        persona: 'health',
        personaOpen: false,
        data: { id: 'gone-v', type: 'note', summary: 'x' },
      });
      const approvalId = getItem(ingested.itemId)?.approval_id ?? '';
      // The staged rows vanish (TTL sweep / corruption); the workflow task remains.
      resetStagingState();
      const task = await client.approveWorkflowTask(approvalId);
      // NOT a false "stored" success — nothing was written, so it fails.
      expect(task.status).toBe('failed');
    });

    it('#5: a drain failure after approval FAILS the task instead of stranding it running', async () => {
      const router = createCoreRouter();
      const client = new InProcessTransport(router);
      const ingested = await client.stagingIngest({
        source: 'chat',
        sourceId: 'nodata-1',
        data: { body: 'x' },
      });
      await client.stagingClaim(1);
      // Raw resolve with NO classified `data` → the pending_unlock row has no
      // classified_item, so drainForApproval THROWS during the approve.
      const raw = new TextEncoder().encode(
        JSON.stringify({ id: ingested.itemId, persona: 'health', persona_open: false }),
      );
      await router.handle({
        method: 'POST',
        path: '/v1/staging/resolve',
        query: {},
        headers: {},
        body: { id: ingested.itemId, persona: 'health', persona_open: false },
        rawBody: raw,
        params: {},
        trustedInProcess: true,
      });
      const approvalId = getItem(ingested.itemId)?.approval_id ?? '';
      await expect(client.approveWorkflowTask(approvalId)).rejects.toThrow();
      // Terminal 'failed', NOT a stuck 'running' zombie.
      expect(getWorkflowService()?.store().getById(approvalId)?.status).toBe('failed');
    });
  });

  // ---------------------------------------------------------------------------
  // PLG-31 route-level input validation. These POST directly through the router
  // as an in-process (owner) caller so the route guards are exercised.
  // ---------------------------------------------------------------------------
  describe('input validation (PLG-31)', () => {
    async function post(path: string, bodyObj: Record<string, unknown>) {
      const router = createCoreRouter();
      const raw = new TextEncoder().encode(JSON.stringify(bodyObj));
      return router.handle({
        method: 'POST',
        path,
        query: {},
        headers: {},
        body: bodyObj,
        rawBody: raw,
        params: {},
        trustedInProcess: true,
      });
    }

    async function ingestAndClaim(sourceId: string): Promise<string> {
      const router = createCoreRouter();
      const client = new InProcessTransport(router);
      const ing = await client.stagingIngest({ source: 'chat', sourceId, data: { body: 'x' } });
      await client.stagingClaim(1);
      return ing.itemId;
    }

    it('#9: rejects an over-deep data object (400) before staging', async () => {
      // 30 levels of nesting > MAX_INGEST_DEPTH (24).
      let deep: Record<string, unknown> = { leaf: 1 };
      for (let i = 0; i < 30; i++) deep = { child: deep };
      const resp = await post('/v1/staging/ingest', {
        source: 'chat',
        source_id: 'deep-1',
        data: deep,
      });
      expect(resp.status).toBe(400);
      expect((resp.body as { error: string }).error).toMatch(/nests deeper/);
    });

    it('#9: rejects a data object with an oversized string (400)', async () => {
      const resp = await post('/v1/staging/ingest', {
        source: 'chat',
        source_id: 'bigstr-1',
        data: { body: 'a'.repeat(200 * 1024) }, // > 128 KiB
      });
      expect(resp.status).toBe(400);
      expect((resp.body as { error: string }).error).toMatch(/string over/);
    });

    it('#10: clamps a far-future expires_at into the retention window', async () => {
      const resp = await post('/v1/staging/ingest', {
        source: 'chat',
        source_id: 'exp-future',
        data: { body: 'x' },
        expires_at: 99_999_999_999, // year 5138 — must be clamped
      });
      expect(resp.status).toBe(201);
      const id = (resp.body as { id: string }).id;
      const nowSec = Math.floor(Date.now() / 1000);
      const expiresAt = getItem(id)?.expires_at ?? 0;
      // Clamped to at most now + 7d TTL (well below the year-5138 value).
      expect(expiresAt).toBeLessThanOrEqual(nowSec + 7 * 24 * 3600 + 5);
      expect(expiresAt).toBeGreaterThan(nowSec);
    });

    it('#10: clamps a past expires_at forward so it is not swept immediately', async () => {
      const resp = await post('/v1/staging/ingest', {
        source: 'chat',
        source_id: 'exp-past',
        data: { body: 'x' },
        expires_at: 1, // 1970 — a past value would drop on the next sweep
      });
      expect(resp.status).toBe(201);
      const id = (resp.body as { id: string }).id;
      const nowSec = Math.floor(Date.now() / 1000);
      expect(getItem(id)?.expires_at ?? 0).toBeGreaterThanOrEqual(nowSec + 60);
    });

    it('#11: resolve rejects a non-object data (array) with 400', async () => {
      const id = await ingestAndClaim('resolve-baddata');
      const resp = await post('/v1/staging/resolve', {
        id,
        persona: 'general',
        persona_open: true,
        data: ['not', 'an', 'object'],
      });
      expect(resp.status).toBe(400);
      expect((resp.body as { error: string }).error).toMatch(/data must be an object/);
    });

    it('#7: resolve dedupes a repeated persona in the personas array', async () => {
      const id = await ingestAndClaim('resolve-dupe');
      const resp = await post('/v1/staging/resolve', {
        id,
        personas: ['general', 'general'],
        persona_access: { general: true },
        data: { id: 'dupe-v', type: 'note', summary: 'x' },
      });
      expect(resp.status).toBe(200);
      // The duplicate collapses to a single target — not double-counted.
      expect((resp.body as { personas: string[] }).personas).toEqual(['general']);
    });

    it.each([
      ['negative', -5],
      ['zero', 0],
      ['fractional', 1.5],
      ['NaN', Number.NaN],
      ['over the cap', 8 * 24 * 3600],
    ])('#8: extend-lease rejects a %s seconds value (400)', async (_label, seconds) => {
      const id = await ingestAndClaim(`lease-${_label}`);
      const resp = await post('/v1/staging/extend-lease', { id, seconds });
      expect(resp.status).toBe(400);
      expect((resp.body as { error: string }).error).toMatch(/positive integer/);
    });

    it('#15: resolve rejects a classified `data` that violates the ingest caps', async () => {
      const id = await ingestAndClaim('resolve-caps');
      // A string over 128 KiB — ingest would reject it; resolve must too, since
      // this becomes a PERSISTENT vault row.
      const resp = await post('/v1/staging/resolve', {
        id,
        persona: 'general',
        persona_open: true,
        data: { id: 'big', type: 'note', summary: 'a'.repeat(200 * 1024) },
      });
      expect(resp.status).toBe(400);
      expect((resp.body as { error: string }).error).toMatch(/string over/);
    });

    it('#16: multi-persona resolve canonicalizes + dedupes noncanonical names', async () => {
      const id = await ingestAndClaim('resolve-canon');
      const resp = await post('/v1/staging/resolve', {
        id,
        // 'health', ' health ', and 'Health' are ONE logical persona.
        personas: ['health', ' health ', 'Health'],
        persona_access: { health: false },
        data: { id: 'canon-v', type: 'note', summary: 'x' },
      });
      expect(resp.status).toBe(200);
      // Collapsed to a single canonical target — not three separate approvals.
      expect((resp.body as { personas: string[] }).personas).toEqual(['health']);
    });

    it('#16: resolve rejects a persona name with invalid grammar (400)', async () => {
      const id = await ingestAndClaim('resolve-badname');
      const resp = await post('/v1/staging/resolve', {
        id,
        persona: 'health!!drop',
        persona_open: true,
        data: { id: 'v', type: 'note', summary: 'x' },
      });
      expect(resp.status).toBe(400);
      expect((resp.body as { error: string }).error).toMatch(/invalid characters/);
    });

    it('#16: resolve rejects more than MAX personas (400)', async () => {
      const id = await ingestAndClaim('resolve-toomany');
      const personas = Array.from({ length: 65 }, (_, i) => `p${i}`);
      const persona_access = Object.fromEntries(personas.map((p) => [p, false]));
      const resp = await post('/v1/staging/resolve', {
        id,
        personas,
        persona_access,
        data: { id: 'v', type: 'note', summary: 'x' },
      });
      expect(resp.status).toBe(400);
      expect((resp.body as { error: string }).error).toMatch(/too many personas/);
    });
  });
});
