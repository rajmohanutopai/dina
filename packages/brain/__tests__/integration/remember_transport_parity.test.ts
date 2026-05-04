/**
 * /remember transport parity.
 *
 * The same remember scenarios must behave identically when Brain talks
 * to Core through mobile's in-process transport and server's signed
 * HTTP CoreClient transport. The test keeps the runtime greenfield:
 * one staging-first path, one drain, one Core resolve contract.
 */

import { TEST_ED25519_SEED } from '@dina/test-harness';
import { signRequest } from '../../../core/src/auth/canonical';
import {
  configureRateLimiter,
  registerPublicKeyResolver,
  resetMiddlewareState,
} from '../../../core/src/auth/middleware';
import { registerService, resetCallerTypeState } from '../../../core/src/auth/caller_type';
import { getPublicKey } from '../../../core/src/crypto/ed25519';
import { deriveDIDKey } from '../../../core/src/identity/did';
import { HttpCoreTransport, type HttpClient } from '../../../core/src/client/http-transport';
import { InProcessTransport } from '../../../core/src/client/in-process-transport';
import type { CoreClient } from '../../../core/src/client/core-client';
import { createCoreRouter } from '../../../core/src/server/core_server';
import type { CoreRequest, CoreRouter } from '../../../core/src/server/router';
import {
  InMemoryStagingRepository,
  setStagingRepository,
} from '../../../core/src/staging/repository';
import {
  getItem as getStagingItem,
  listByStatus,
  resetStagingState,
} from '../../../core/src/staging/service';
import { clearVaults, queryVault } from '../../../core/src/vault/crud';
import {
  InMemoryWorkflowRepository,
  setWorkflowRepository,
} from '../../../core/src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../../core/src/workflow/service';
import {
  registerEnrichmentLLM,
  resetEnrichmentPipeline,
} from '../../src/enrichment/pipeline';
import { registerCloudProvider, resetProviders } from '../../src/embedding/generation';
import { runStagingDrainTick, type StagingDrainCoreClient } from '../../src/staging/drain';
import { setAccessiblePersonas } from '../../src/vault_context/assembly';

type RememberClient = CoreClient & StagingDrainCoreClient;

interface TransportCase {
  name: string;
  buildClient: () => RememberClient;
}

const COMMON_PERSONAS = [
  'general',
  'health',
  'financial',
  'professional',
  'social',
  'consumer',
  'family',
  'legal',
  'personal',
];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function buildInProcessClient(): RememberClient {
  return new InProcessTransport(createCoreRouter());
}

function buildSignedHttpClient(): RememberClient {
  const router = createCoreRouter();
  const seed = TEST_ED25519_SEED;
  const did = deriveDIDKey(getPublicKey(seed));
  return new HttpCoreTransport({
    baseUrl: 'http://core.test',
    httpClient: routerBackedHttpClient(router),
    signer: async ({ method, path, query, body }) => {
      const headers = signRequest(method, path, query, body, seed, did);
      return {
        did: headers['X-DID'],
        timestamp: headers['X-Timestamp'],
        nonce: headers['X-Nonce'],
        signature: headers['X-Signature'],
      };
    },
  });
}

function routerBackedHttpClient(router: CoreRouter): HttpClient {
  return {
    async request(url, init) {
      const parsed = new URL(url);
      const bodyBytes = init.body ?? new Uint8Array();
      const body =
        bodyBytes.byteLength === 0 ? undefined : JSON.parse(textDecoder.decode(bodyBytes));
      const query: Record<string, string> = {};
      parsed.searchParams.forEach((value, key) => {
        query[key] = value;
      });
      const response = await router.handle({
        method: init.method as CoreRequest['method'],
        path: parsed.pathname,
        query,
        headers: init.headers,
        body,
        rawBody: bodyBytes,
        params: {},
      });
      return {
        status: response.status,
        headers: { 'content-type': 'application/json' },
        body:
          response.body === undefined
            ? new Uint8Array()
            : textEncoder.encode(JSON.stringify(response.body)),
      };
    },
  };
}

async function ingestRemember(
  core: RememberClient,
  sourceId: string,
  data: Record<string, unknown>,
): Promise<string> {
  const result = await core.stagingIngest({
    source: 'user_remember',
    sourceId,
    producerId: 'user',
    data,
  });
  expect(result.duplicate).toBe(false);
  expect(result.status).toBe('received');
  return result.itemId;
}

async function drainOnce(
  core: RememberClient,
  accessiblePersonas: string[],
): Promise<Awaited<ReturnType<typeof runStagingDrainTick>>> {
  setAccessiblePersonas(accessiblePersonas);
  return runStagingDrainTick(core, {
    limit: 10,
    setInterval: () => 1,
    clearInterval: () => {
      /* no-op */
    },
  });
}

function querySummaries(persona: string, text: string): string[] {
  return queryVault(persona, { mode: 'fts5', text, limit: 10 }).map((item) => item.summary);
}

function metadataFor(persona: string, text: string): Record<string, unknown> {
  const item = queryVault(persona, { mode: 'fts5', text, limit: 10 })[0];
  expect(item).toBeDefined();
  return JSON.parse(String(item!.metadata)) as Record<string, unknown>;
}

describe.each<TransportCase>([
  { name: 'mobile in-process CoreClient', buildClient: buildInProcessClient },
  { name: 'server signed HTTP CoreClient', buildClient: buildSignedHttpClient },
])('/remember parity via $name', ({ buildClient }) => {
  let workflowRepo!: InMemoryWorkflowRepository;

  beforeEach(() => {
    resetMiddlewareState();
    resetCallerTypeState();
    configureRateLimiter({ maxRequests: 10_000, windowSeconds: 60 });

    const brainPub = getPublicKey(TEST_ED25519_SEED);
    const brainDid = deriveDIDKey(brainPub);
    registerPublicKeyResolver((did) => (did === brainDid ? brainPub : null));
    registerService(brainDid, 'brain');

    setStagingRepository(new InMemoryStagingRepository());
    resetStagingState();
    clearVaults(COMMON_PERSONAS);
    setAccessiblePersonas(['general']);

    workflowRepo = new InMemoryWorkflowRepository();
    setWorkflowRepository(workflowRepo);
    setWorkflowService(new WorkflowService({ repository: workflowRepo }));

    resetEnrichmentPipeline();
    resetProviders();
  });

  afterEach(() => {
    resetEnrichmentPipeline();
    resetProviders();
    resetStagingState();
    setStagingRepository(null);
    setWorkflowRepository(null);
    setWorkflowService(null);
    clearVaults(COMMON_PERSONAS);
    resetMiddlewareState();
    resetCallerTypeState();
  });

  it('stores a single-persona memory and records explicit enrichment fallback metadata', async () => {
    const core = buildClient();
    await ingestRemember(core, 'single-emma-dinosaurs', {
      type: 'user_memory',
      summary: 'Emma likes dinosaurs',
      body: 'Emma likes dinosaurs',
      sender: 'user',
    });

    const tick = await drainOnce(core, ['general']);

    expect(tick).toMatchObject({ claimed: 1, stored: 1, failed: 0 });
    expect(querySummaries('general', 'emma dinosaurs')).toContain('Emma likes dinosaurs');
    const metadata = metadataFor('general', 'emma dinosaurs');
    expect(metadata.routing).toMatchObject({ primary: 'general' });
    expect(metadata.enrichment).toMatchObject({
      status: 'l0_complete',
      has_l1: false,
      has_embedding: false,
    });
    expect(
      ((metadata.enrichment as { stages: { fallback_reasons: string[] } }).stages)
        .fallback_reasons,
    ).toEqual(expect.arrayContaining(['llm_unavailable', 'embedding_unavailable']));
  });

  it('fans one memory out to every classified open persona', async () => {
    const core = buildClient();
    await ingestRemember(core, 'multi-health-finance', {
      type: 'note',
      summary: 'Lab result diagnosis and bank invoice',
      body: 'The lab result diagnosis arrived with an invoice, bank transaction, and tax receipt.',
      sender: 'user',
    });

    const tick = await drainOnce(core, ['health', 'financial']);

    expect(tick).toMatchObject({ claimed: 1, stored: 1, failed: 0 });
    expect(querySummaries('health', 'lab diagnosis')).toContain(
      'Lab result diagnosis and bank invoice',
    );
    expect(querySummaries('financial', 'bank invoice')).toContain(
      'Lab result diagnosis and bank invoice',
    );
  });

  it('parks locked persona targets behind a durable approval task', async () => {
    const core = buildClient();
    const itemId = await ingestRemember(core, 'locked-health', {
      type: 'note',
      summary: 'A1c lab result',
      body: 'My A1c lab result and diagnosis need follow-up.',
      sender: 'user',
    });

    const tick = await drainOnce(core, ['general']);

    expect(tick).toMatchObject({ claimed: 1, stored: 0, failed: 0 });
    expect(tick.results[0]).toMatchObject({ itemId, status: 'pending_unlock' });
    expect(queryVault('health', { mode: 'fts5', text: 'a1c diagnosis', limit: 10 })).toHaveLength(
      0,
    );
    const pending = listByStatus('pending_unlock');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.approval_id).toMatch(/^approval-staging-/);
    expect(getStagingItem(itemId)?.approval_id).toBe(pending[0]?.approval_id);
    expect(workflowRepo.getById(pending[0]!.approval_id!)).not.toBeNull();
  });

  it('claims and stores after a cache reset when staging repository rows remain', async () => {
    const core = buildClient();
    await ingestRemember(core, 'restart-general', {
      type: 'user_memory',
      summary: 'Restart memory survives',
      body: 'Restart memory survives',
      sender: 'user',
    });
    resetStagingState({ preserveRepositoryRows: true });

    const tick = await drainOnce(core, ['general']);

    expect(tick).toMatchObject({ claimed: 1, stored: 1, failed: 0 });
    expect(querySummaries('general', 'restart memory')).toContain('Restart memory survives');
  });

  it('stores with non-final enrichment status when providers fail', async () => {
    registerEnrichmentLLM(async () => {
      throw new Error('llm unavailable');
    });
    registerCloudProvider('broken-embed', async () => {
      throw new Error('embedding unavailable');
    });
    const core = buildClient();
    await ingestRemember(core, 'failed-enrichment', {
      type: 'user_memory',
      summary: 'Provider failure still stores',
      body: 'Provider failure still stores',
      sender: 'user',
    });

    const tick = await drainOnce(core, ['general']);

    expect(tick).toMatchObject({ claimed: 1, stored: 1, failed: 0 });
    const hits = queryVault('general', { mode: 'fts5', text: 'provider failure', limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.enrichment_status).toBe('l0_complete');
    expect(hits[0]?.embedding).toBeUndefined();
    const metadata = JSON.parse(hits[0]!.metadata) as {
      enrichment: { stages: { fallback_reasons: string[] } };
    };
    expect(metadata.enrichment.stages.fallback_reasons).toEqual(
      expect.arrayContaining(['llm_failed', 'embedding_failed']),
    );
  });
});
