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
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

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
    expect(getVaultItem('general', 'multi-gate-vault')).not.toBeNull();
    expect(getVaultItem('health', 'multi-gate-vault')).toBeNull();
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
    expect(getVaultItem('general', 'single-store-vault')).not.toBeNull();
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
    expect(getVaultItem('health', 'locked-approval-vault')).not.toBeNull();
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
});
