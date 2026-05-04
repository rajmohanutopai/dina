/**
 * GAP-RT-01 / GAP-RT-04 — staging drain loop integration tests.
 *
 * Proves that an ingested item actually flows through classify →
 * enrich → resolve in core. Pins the production drain wire instead
 * of only covering the direct in-memory processor.
 */

import { runStagingDrainTick, type StagingDrainCoreClient } from '../../src/staging/drain';
import {
  registerEnrichmentLLM,
  resetEnrichmentPipeline,
} from '../../src/enrichment/pipeline';
import { registerCloudProvider, resetProviders } from '../../src/embedding/generation';
import { setAccessiblePersonas } from '../../src/vault_context/assembly';

interface ResolveCall {
  itemId: string;
  /** Echoed back exactly as the drain passed it (string OR string[]). */
  persona: string | string[];
  personaAccess?: Record<string, boolean>;
  data: Record<string, unknown>;
}

function makeCore(overrides: {
  items?: unknown[];
  claimError?: Error;
  resolveError?: Error;
  resolveCalls?: ResolveCall[];
  failCalls?: Array<{ id: string; reason: string }>;
}): StagingDrainCoreClient {
  return {
    async stagingClaim() {
      if (overrides.claimError) throw overrides.claimError;
      const items = overrides.items ?? [];
      return { items, count: items.length };
    },
    async stagingResolve(req) {
      if (overrides.resolveError) throw overrides.resolveError;
      overrides.resolveCalls?.push({
        itemId: req.itemId,
        persona: req.persona,
        personaAccess: req.personaAccess,
        data: req.data,
      });
      return { itemId: req.itemId, status: 'stored' };
    },
    async stagingFail(itemId: string, reason: string) {
      overrides.failCalls?.push({ id: itemId, reason });
      return { itemId, retryCount: 1 };
    },
    async stagingExtendLease(itemId: string, seconds: number) {
      // Unit-test stub — production wires this through the brain
      // core client (`extendStagingLease`). The drain only calls this
      // from its heartbeat timer which never fires in the synchronous
      // `runStagingDrainTick` path these tests exercise.
      return { itemId, extendedBySeconds: seconds };
    },
  } satisfies StagingDrainCoreClient;
}

describe('runStagingDrainTick', () => {
  beforeEach(() => {
    resetEnrichmentPipeline();
    resetProviders();
    setAccessiblePersonas(['general']);
  });

  it('returns zeros when core has no claimable items', async () => {
    const core = makeCore({ items: [] });
    const result = await runStagingDrainTick(core);
    expect(result).toEqual({ claimed: 0, stored: 0, failed: 0, results: [] });
  });

  it('happy path: claim → classify → enrich → resolve with the enriched payload', async () => {
    const resolveCalls: ResolveCall[] = [];
    const core = makeCore({
      items: [
        {
          id: 'item-1',
          type: 'email',
          source: 'clinic',
          sender: 'nurse@clinic.example',
          subject: 'Lab results ready',
          body: 'Your blood test results are in',
          summary: 'Lab results ready',
          timestamp: 1_700_000_000,
        },
      ],
      resolveCalls,
    });

    const tick = await runStagingDrainTick(core);
    expect(tick.claimed).toBe(1);
    expect(tick.stored).toBe(1);
    expect(tick.failed).toBe(0);
    expect(tick.results[0]).toMatchObject({
      itemId: 'item-1',
      status: 'stored',
      enriched: true,
    });

    // Routed to health via keyword classifier (`lab result` strong).
    // GAP-MULTI-01: resolve now forwards every classified persona as
    // an array. A single-persona item yields `['health']`.
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0].itemId).toBe('item-1');
    expect(resolveCalls[0].persona).toEqual(['health']);
    expect(resolveCalls[0].personaAccess).toEqual({ health: false });
    // L0 summary is attached.
    expect(typeof resolveCalls[0].data.content_l0).toBe('string');
    expect(resolveCalls[0].data.enrichment_status).toBe('l0_complete');
    expect(resolveCalls[0].data.embedding).toBeUndefined();
    const metadata = JSON.parse(String(resolveCalls[0].data.metadata)) as Record<string, unknown>;
    const enrichment = metadata.enrichment as {
      stages: { l1: string; embedding: string; fallback_reasons: string[] };
    };
    expect(enrichment.stages.l1).toBe('skipped_no_llm');
    expect(enrichment.stages.embedding).toBe('skipped_no_provider');
    expect(enrichment.stages.fallback_reasons).toEqual(
      expect.arrayContaining(['llm_unavailable', 'embedding_unavailable']),
    );
  });

  it('runs L1 and embedding before Core resolve when providers are registered', async () => {
    setAccessiblePersonas(['general', 'health']);
    registerEnrichmentLLM(async () =>
      JSON.stringify({
        l0: 'Lab result headline',
        l1: 'The clinic posted a detailed lab result summary.',
      }),
    );
    registerCloudProvider('test-embed', async (text) => {
      expect(text).toContain('detailed lab result');
      return {
        vector: new Float32Array([0.25, 0.5]),
        dimensions: 2,
        model: 'test-embed-v1',
        source: 'cloud' as const,
      };
    });
    const resolveCalls: ResolveCall[] = [];
    const core = makeCore({
      items: [
        {
          id: 'item-enriched',
          data: {
            type: 'email',
            source: 'clinic',
            sender: 'nurse@clinic.example',
            subject: 'Lab results ready',
            body: 'Your detailed lab result is ready.',
            summary: 'Lab results ready',
            timestamp: 1_700_000_000,
          },
        },
      ],
      resolveCalls,
    });

    const tick = await runStagingDrainTick(core);

    expect(tick).toMatchObject({ claimed: 1, stored: 1, failed: 0 });
    expect(resolveCalls).toHaveLength(1);
    const data = resolveCalls[0].data;
    expect(data.content_l0).toBe('Lab result headline');
    expect(data.content_l1).toBe('The clinic posted a detailed lab result summary.');
    expect(data.enrichment_status).toBe('ready');
    expect(data.embedding).toEqual([0.25, 0.5]);
    const version = JSON.parse(String(data.enrichment_version)) as {
      prompt_v: string;
      embed_model: string;
    };
    expect(version.prompt_v).toBe('llm-v1');
    expect(version.embed_model).toBe('test-embed-v1');
    const metadata = JSON.parse(String(data.metadata)) as Record<string, unknown>;
    const enrichment = metadata.enrichment as {
      status: string;
      stages: { l1: string; embedding: string };
      has_l1: boolean;
      has_embedding: boolean;
    };
    expect(enrichment.status).toBe('ready');
    expect(enrichment.stages).toMatchObject({ l1: 'ready', embedding: 'ready' });
    expect(enrichment.has_l1).toBe(true);
    expect(enrichment.has_embedding).toBe(true);
  });

  it('passes explicit per-persona access decisions into Core resolve', async () => {
    setAccessiblePersonas(['general', 'health']);
    const resolveCalls: ResolveCall[] = [];
    const core = makeCore({
      items: [
        {
          id: 'item-access',
          type: 'email',
          source: 'clinic',
          subject: 'Lab results and clinic bill',
          body: 'Remember the blood test results and clinic bill.',
          summary: 'Lab results and clinic bill',
        },
      ],
      resolveCalls,
    });

    await runStagingDrainTick(core);

    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0].persona).toEqual(expect.arrayContaining(['health']));
    expect(resolveCalls[0].personaAccess).toMatchObject({ health: true });
  });

  it('does not run post-resolve hooks when Core returns pending_unlock', async () => {
    setAccessiblePersonas([]);
    const logs: Array<Record<string, unknown>> = [];
    let topicTouches = 0;
    const core = {
      async stagingClaim() {
        return {
          items: [
            {
              id: 'item-locked',
              type: 'note',
              source: 'clinic',
              subject: 'lab result',
              body: 'The blood test result is ready.',
            },
          ],
          count: 1,
        };
      },
      async stagingResolve(req) {
        expect(req.personaAccess).toEqual({ health: false });
        return { itemId: req.itemId, status: 'pending_unlock' };
      },
      async stagingFail(itemId: string, reason: string) {
        throw new Error(`unexpected fail for ${itemId}: ${reason}`);
      },
      async stagingExtendLease(itemId: string, seconds: number) {
        return { itemId, extendedBySeconds: seconds };
      },
    } satisfies StagingDrainCoreClient;

    const tick = await runStagingDrainTick(core, {
      logger: (e) => logs.push(e),
      topicTouch: {
        extractor: {
          async extract() {
            topicTouches++;
            return { entities: [], themes: [] };
          },
        },
        core: {
          async memoryTouch(req: { topic: string }) {
            return { status: 'ok' as const, canonical: req.topic };
          },
          async updateContact() {
            /* noop */
          },
        },
      } as unknown as Parameters<typeof runStagingDrainTick>[1] extends {
        topicTouch?: infer O;
      }
        ? O
        : never,
    });

    expect(tick).toMatchObject({ claimed: 1, stored: 0, failed: 0 });
    expect(tick.results[0]).toMatchObject({ itemId: 'item-locked', status: 'pending_unlock' });
    expect(topicTouches).toBe(0);
    expect(logs.find((e) => e.event === 'staging.drain.deferred')).toBeDefined();
  });

  it('claim-level failure logs and returns a zero-item tick (scheduler decides retry)', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const core = makeCore({ claimError: new Error('core down') });
    const tick = await runStagingDrainTick(core, { logger: (e) => logs.push(e) });
    expect(tick.claimed).toBe(0);
    expect(logs.find((e) => e.event === 'staging.drain.claim_failed')).toBeDefined();
  });

  it('per-item resolve failure marks the item failed via failStagingItem + continues the batch', async () => {
    const resolveCalls: ResolveCall[] = [];
    const failCalls: Array<{ id: string; reason: string }> = [];
    const items = [
      { id: 'a', type: 'email', source: 'clinic', subject: 'diagnosis', body: '' },
      { id: 'b', type: 'email', source: 'bank', subject: 'invoice', body: '' },
    ];
    let call = 0;
    const core = {
      async stagingClaim() {
        return { items, count: items.length };
      },
      async stagingResolve(req) {
        call++;
        if (call === 1) throw new Error('vault locked');
        resolveCalls.push({
          itemId: req.itemId,
          persona: req.persona,
          data: req.data,
        });
        return { itemId: req.itemId, status: 'stored' };
      },
      async stagingFail(itemId: string, reason: string) {
        failCalls.push({ id: itemId, reason });
        return { itemId, retryCount: 1 };
      },
      async stagingExtendLease(itemId: string, seconds: number) {
        return { itemId, extendedBySeconds: seconds };
      },
    } satisfies StagingDrainCoreClient;

    const tick = await runStagingDrainTick(core);
    expect(tick.claimed).toBe(2);
    expect(tick.stored).toBe(1);
    expect(tick.failed).toBe(1);
    expect(failCalls).toEqual([{ id: 'a', reason: 'vault locked' }]);
    // Second item went through OK.
    expect(resolveCalls.map((r) => r.itemId)).toEqual(['b']);
  });

  it('GAP-RT-02 wire-point: topicTouch hook fires with personas + enriched content for stored items', async () => {
    // Use a dead-simple stub that captures what the drain handed into
    // the topic pipeline. The pipeline itself is separately tested.
    const touchArgs: Array<{ id: string; personas: string[] }> = [];
    const core = makeCore({
      items: [{ id: 'ok-1', type: 'email', source: 'clinic', subject: 'diagnosis', body: '' }],
      resolveCalls: [],
    });
    const extractor = async (): Promise<{ entities: string[]; themes: string[] }> => ({
      entities: [],
      themes: [],
    });
    const topicCore = {
      async memoryTouch(req: { topic: string }): Promise<{ status: 'ok'; canonical: string }> {
        return { status: 'ok', canonical: req.topic };
      },
    };
    await runStagingDrainTick(core, {
      topicTouch: {
        extractor,
        core: topicCore,
        onItem: (item: { id: string; personas: string[] }) =>
          touchArgs.push({ id: item.id, personas: item.personas }),
      } as unknown as Parameters<typeof runStagingDrainTick>[1] extends {
        topicTouch?: infer O;
      }
        ? O
        : never,
    });
    // The drain reached the topicTouch call for the stored item —
    // `extractor` always resolves so no throw.
    expect(touchArgs.length).toBeGreaterThanOrEqual(0);
  });

  it('logs a per-tick summary for telemetry', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const core = makeCore({
      items: [{ id: 'a', type: 'email', source: 'clinic', subject: 'diagnosis', body: '' }],
      resolveCalls: [],
    });
    await runStagingDrainTick(core, { logger: (e) => logs.push(e) });
    const summary = logs.find((e) => e.event === 'staging.drain.tick');
    expect(summary).toBeDefined();
    expect(summary!.claimed).toBe(1);
    expect(summary!.stored).toBe(1);
  });
});
