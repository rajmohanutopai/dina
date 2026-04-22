/**
 * Bus Driver tool factories — mocked dependency tests.
 */

import {
  createGeocodeTool,
  createSearchProviderServicesTool,
  createQueryServiceTool,
  createFindPreferredProviderTool,
  type PreferredContactsClient,
  type FindPreferredProviderResult,
} from '../../src/reasoning/bus_driver_tools';
import type { Contact } from '../../../core/src/contacts/directory';
import type { ServiceProfile } from '../../src/appview_client/http';
import type { ServiceQueryOrchestrator } from '../../src/service/service_query_orchestrator';

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return jest.fn(async (input, init) =>
    impl(String(input), init ?? {}),
  ) as unknown as typeof globalThis.fetch;
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createGeocodeTool', () => {
  const SF_LAT = 37.76;
  const SF_LNG = -122.42;

  it('returns lat/lng/display_name for a valid address', async () => {
    const fetchFn = mockFetch(() =>
      okJson([
        {
          lat: String(SF_LAT),
          lon: String(SF_LNG),
          display_name: 'Castro, San Francisco, California, USA',
        },
      ]),
    );
    const tool = createGeocodeTool({ fetch: fetchFn, minGapMs: 0 });
    const result = (await tool.execute({ address: 'Castro, SF' })) as {
      lat: number;
      lng: number;
      display_name: string;
    };
    expect(result.lat).toBe(SF_LAT);
    expect(result.lng).toBe(SF_LNG);
    expect(result.display_name).toContain('San Francisco');
  });

  it('sends User-Agent header per Nominatim usage policy', async () => {
    const fetchFn = mockFetch(() => okJson([{ lat: '0', lon: '0' }]));
    const tool = createGeocodeTool({
      fetch: fetchFn,
      userAgent: 'test-ua/1.0 (dev@example.com)',
      minGapMs: 0,
    });
    await tool.execute({ address: 'Anywhere' });
    const [, init] = (fetchFn as jest.Mock).mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('test-ua/1.0 (dev@example.com)');
  });

  it('throws on empty address', async () => {
    const fetchFn = mockFetch(() => okJson([]));
    const tool = createGeocodeTool({ fetch: fetchFn, minGapMs: 0 });
    await expect(tool.execute({ address: '' })).rejects.toThrow(/required/);
  });

  it('throws when Nominatim returns no results', async () => {
    const fetchFn = mockFetch(() => okJson([]));
    const tool = createGeocodeTool({ fetch: fetchFn, minGapMs: 0 });
    await expect(tool.execute({ address: 'Atlantis' })).rejects.toThrow(/no result/);
  });

  it('throws with HTTP status on non-2xx', async () => {
    const fetchFn = mockFetch(() => new Response('', { status: 503 }));
    const tool = createGeocodeTool({ fetch: fetchFn, minGapMs: 0 });
    await expect(tool.execute({ address: 'X' })).rejects.toThrow(/HTTP 503/);
  });

  it('throws on malformed coordinates', async () => {
    const fetchFn = mockFetch(() => okJson([{ lat: 'banana', lon: 'oops' }]));
    const tool = createGeocodeTool({ fetch: fetchFn, minGapMs: 0 });
    await expect(tool.execute({ address: 'x' })).rejects.toThrow(/malformed/);
  });

  it('rate-limits between calls (gap >= minGapMs)', async () => {
    const fetchFn = mockFetch(() => okJson([{ lat: '0', lon: '0' }]));
    const tool = createGeocodeTool({ fetch: fetchFn, minGapMs: 50 });
    const t0 = Date.now();
    await tool.execute({ address: 'a' });
    await tool.execute({ address: 'b' });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });
});

describe('createSearchProviderServicesTool', () => {
  const sampleProfile: ServiceProfile = {
    did: 'did:plc:busdriver',
    name: 'Bus 42',
    capabilities: ['eta_query'],
    responsePolicy: { eta_query: 'auto' },
    capabilitySchemas: {
      eta_query: {
        params: {},
        result: {},
        schemaHash: 'sha256:abc',
      },
    },
    isDiscoverable: true,
    distanceKm: 2.3,
  };

  it('calls AppView with the right params and returns trimmed profiles', async () => {
    const calls: unknown[] = [];
    const tool = createSearchProviderServicesTool({
      appViewClient: {
        async searchServices(params) {
          calls.push(params);
          return [sampleProfile];
        },
      },
    });
    const result = await tool.execute({
      capability: 'eta_query',
      lat: 37.77,
      lng: -122.41,
      radius_km: 5,
    });
    expect(calls[0]).toMatchObject({
      capability: 'eta_query',
      lat: 37.77,
      lng: -122.41,
      radiusKm: 5,
    });
    const profiles = result as Array<{
      did: string;
      capability_schemas?: Record<
        string,
        {
          params_schema: Record<string, unknown>;
          schema_hash: string;
          description?: string;
          default_ttl_seconds?: number;
        }
      >;
    }>;
    expect(profiles).toHaveLength(1);
    expect(profiles[0].did).toBe('did:plc:busdriver');
    expect(profiles[0].capability_schemas).toEqual({
      eta_query: { params_schema: {}, schema_hash: 'sha256:abc' },
    });
  });

  it('throws on missing capability', async () => {
    const tool = createSearchProviderServicesTool({
      appViewClient: { searchServices: async () => [] },
    });
    await expect(tool.execute({ capability: '' })).rejects.toThrow(/required/);
  });

  it('caps results to resultLimit', async () => {
    const manyProfiles = Array.from({ length: 10 }, (_, i) => ({
      ...sampleProfile,
      did: `did:plc:bus${i}`,
    }));
    const tool = createSearchProviderServicesTool({
      appViewClient: { searchServices: async () => manyProfiles },
      resultLimit: 3,
    });
    const result = await tool.execute({ capability: 'eta_query' });
    expect((result as unknown[]).length).toBe(3);
  });

  it('omits capability_schemas when no profile carries one', async () => {
    const tool = createSearchProviderServicesTool({
      appViewClient: {
        async searchServices() {
          return [{ ...sampleProfile, capabilitySchemas: undefined }];
        },
      },
    });
    const [profile] = (await tool.execute({ capability: 'eta_query' })) as Array<
      Record<string, unknown>
    >;
    expect(profile.capability_schemas).toBeUndefined();
  });

  it('surfaces description + default_ttl_seconds + params_schema per capability (GAP-PROF-04)', async () => {
    const tool = createSearchProviderServicesTool({
      appViewClient: {
        async searchServices() {
          return [
            {
              ...sampleProfile,
              capabilitySchemas: {
                eta_query: {
                  params: {
                    type: 'object',
                    required: ['route_id'],
                    properties: { route_id: { type: 'string' } },
                  },
                  result: { type: 'object' },
                  schemaHash: 'sha256:abc',
                  description: 'Returns ETA in minutes for a route',
                  defaultTtlSeconds: 120,
                },
              },
            },
          ];
        },
      },
    });
    const [profile] = (await tool.execute({ capability: 'eta_query' })) as Array<
      Record<string, unknown>
    >;
    const schemas = profile.capability_schemas as Record<string, Record<string, unknown>>;
    expect(schemas.eta_query.schema_hash).toBe('sha256:abc');
    expect(schemas.eta_query.description).toBe('Returns ETA in minutes for a route');
    expect(schemas.eta_query.default_ttl_seconds).toBe(120);
    expect(schemas.eta_query.params_schema).toMatchObject({ required: ['route_id'] });
  });
});

describe('createQueryServiceTool', () => {
  it('calls orchestrator.issueQueryToDID with the exact operator_did + schema_hash (issue #7/#8)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tool = createQueryServiceTool({
      orchestrator: {
        async issueQueryToDID(req) {
          calls.push(req as unknown as Record<string, unknown>);
          return {
            queryId: 'q-1',
            taskId: 'svc-q-1',
            toDID: req.toDID,
            serviceName: req.serviceName ?? req.toDID,
            deduped: false,
          };
        },
      },
    });
    const result = (await tool.execute({
      operator_did: 'did:plc:busdriver',
      capability: 'eta_query',
      params: { route: '42' },
      schema_hash: 'sha256:abc',
      ttl_seconds: 60,
    })) as Record<string, unknown>;
    expect(result).toMatchObject({
      task_id: 'svc-q-1',
      query_id: 'q-1',
      to_did: 'did:plc:busdriver',
      deduped: false,
      status: 'pending',
    });
    // The tool MUST forward the LLM's chosen DID + schema_hash verbatim
    // — this is the whole point of the refactor.
    expect(calls[0]).toMatchObject({
      toDID: 'did:plc:busdriver',
      capability: 'eta_query',
      params: { route: '42' },
      ttlSeconds: 60,
      schemaHash: 'sha256:abc',
      originChannel: 'ask',
    });
  });

  it('throws when operator_did or capability is empty', async () => {
    const tool = createQueryServiceTool({
      orchestrator: {
        issueQueryToDID: async () => {
          throw new Error('unreachable');
        },
      },
    });
    await expect(
      tool.execute({
        operator_did: '',
        capability: 'eta_query',
        params: {},
      }),
    ).rejects.toThrow(/required/);
    await expect(
      tool.execute({
        operator_did: 'did:plc:x',
        capability: '',
        params: {},
      }),
    ).rejects.toThrow(/required/);
  });

  // -------------------------------------------------------------------
  // WM-BRAIN-06d — schema auto-fetch
  // -------------------------------------------------------------------

  function makeOrch() {
    const calls: Array<Record<string, unknown>> = [];
    const orchestrator: Pick<ServiceQueryOrchestrator, 'issueQueryToDID'> = {
      async issueQueryToDID(req) {
        calls.push(req as unknown as Record<string, unknown>);
        return {
          queryId: 'q-1',
          taskId: 'svc-q-1',
          toDID: req.toDID,
          serviceName: req.serviceName ?? req.toDID,
          deduped: false,
        };
      },
    };
    return { orchestrator, calls };
  }

  const autoFetchProfile: ServiceProfile = {
    did: 'did:plc:drcarl',
    name: 'Dr Carl',
    capabilities: ['appointment_status'],
    isDiscoverable: true,
    capabilitySchemas: {
      appointment_status: {
        params: { type: 'object' },
        result: { type: 'object' },
        schemaHash: 'sha256:canonical',
      },
    },
  };

  it('WM-BRAIN-06d: auto-fetches schema_hash + service_name when caller omits them', async () => {
    const { orchestrator, calls } = makeOrch();
    const tool = createQueryServiceTool({
      orchestrator,
      appViewClient: {
        async searchServices() {
          return [autoFetchProfile];
        },
      },
    });
    await tool.execute({
      operator_did: 'did:plc:drcarl',
      capability: 'appointment_status',
      params: {},
      // schema_hash + service_name deliberately omitted
    });
    expect(calls[0].schemaHash).toBe('sha256:canonical');
    expect(calls[0].serviceName).toBe('Dr Carl');
  });

  it('WM-BRAIN-06d: caller-supplied schema_hash wins over AppView fetch', async () => {
    const { orchestrator, calls } = makeOrch();
    const tool = createQueryServiceTool({
      orchestrator,
      appViewClient: {
        async searchServices() {
          return [autoFetchProfile];
        },
      },
    });
    await tool.execute({
      operator_did: 'did:plc:drcarl',
      capability: 'appointment_status',
      params: {},
      schema_hash: 'sha256:caller-wins',
    });
    // AppView is still consulted (for paramsSchema + TTL autofetch) but
    // the caller-supplied schema_hash wins.
    expect(calls[0].schemaHash).toBe('sha256:caller-wins');
  });

  it('WM-BRAIN-06d: no AppView client → skipped silently (no throw)', async () => {
    const { orchestrator, calls } = makeOrch();
    const tool = createQueryServiceTool({ orchestrator }); // no appViewClient
    await tool.execute({
      operator_did: 'did:plc:drcarl',
      capability: 'appointment_status',
      params: {},
    });
    expect(calls[0].schemaHash).toBeUndefined();
  });

  it('WM-BRAIN-06d: matching profile without a schemaHash → dispatch without hash', async () => {
    const { orchestrator, calls } = makeOrch();
    const tool = createQueryServiceTool({
      orchestrator,
      appViewClient: {
        async searchServices() {
          return [{ ...autoFetchProfile, capabilitySchemas: undefined }];
        },
      },
    });
    await tool.execute({
      operator_did: 'did:plc:drcarl',
      capability: 'appointment_status',
      params: {},
    });
    // service_name IS populated from the profile even without schemaHash.
    expect(calls[0].serviceName).toBe('Dr Carl');
    expect(calls[0].schemaHash).toBeUndefined();
  });

  it('WM-BRAIN-06d: DID not in the returned list → no hash populated', async () => {
    const { orchestrator, calls } = makeOrch();
    const tool = createQueryServiceTool({
      orchestrator,
      appViewClient: {
        async searchServices() {
          return [{ ...autoFetchProfile, did: 'did:plc:someoneElse' }];
        },
      },
    });
    await tool.execute({
      operator_did: 'did:plc:drcarl',
      capability: 'appointment_status',
      params: {},
    });
    expect(calls[0].schemaHash).toBeUndefined();
    expect(calls[0].serviceName).toBeUndefined();
  });

  it('WM-BRAIN-06d: AppView throws → logs + dispatch still succeeds without hash', async () => {
    const { orchestrator, calls } = makeOrch();
    const logEntries: Array<Record<string, unknown>> = [];
    const tool = createQueryServiceTool({
      orchestrator,
      appViewClient: {
        async searchServices() {
          throw new Error('AppView 500');
        },
      },
      logger: (e) => logEntries.push(e),
    });
    await tool.execute({
      operator_did: 'did:plc:drcarl',
      capability: 'appointment_status',
      params: {},
    });
    expect(calls[0].schemaHash).toBeUndefined();
    const warn = logEntries.find(
      (e) => e.event === 'tool_executor.query_service.schema_autofetch_failed',
    );
    expect(warn).toBeDefined();
    expect(warn!.operator_did).toBe('did:plc:drcarl');
    expect(warn!.capability).toBe('appointment_status');
    expect(warn!.error).toBe('AppView 500');
  });

  it('WM-BRAIN-06d: empty schema_hash string counts as "missing" and triggers fetch', async () => {
    // An LLM may emit `schema_hash: ""` from a stale template. Treat
    // that as "no cache" and fetch rather than forwarding an empty.
    const { orchestrator, calls } = makeOrch();
    const tool = createQueryServiceTool({
      orchestrator,
      appViewClient: {
        async searchServices() {
          return [autoFetchProfile];
        },
      },
    });
    await tool.execute({
      operator_did: 'did:plc:drcarl',
      capability: 'appointment_status',
      params: {},
      schema_hash: '',
    });
    expect(calls[0].schemaHash).toBe('sha256:canonical');
  });

  // -------------------------------------------------------------------
  // GAP-PROF-05 — default TTL + params schema auto-fetch
  // -------------------------------------------------------------------

  const drcarlWithTtl: ServiceProfile = {
    did: 'did:plc:drcarl',
    name: 'Dr Carl',
    capabilities: ['appointment_status'],
    isDiscoverable: true,
    capabilitySchemas: {
      appointment_status: {
        params: {
          type: 'object',
          required: ['patient_id', 'visit_id'],
          properties: {
            patient_id: { type: 'string' },
            visit_id: { type: 'string' },
          },
        },
        result: { type: 'object' },
        schemaHash: 'sha256:canonical',
        defaultTtlSeconds: 120,
      },
    },
  };

  it('GAP-PROF-05: falls back to published defaultTtlSeconds when caller omits ttl_seconds', async () => {
    const { orchestrator, calls } = makeOrch();
    const tool = createQueryServiceTool({
      orchestrator,
      appViewClient: {
        async searchServices() {
          return [drcarlWithTtl];
        },
      },
    });
    await tool.execute({
      operator_did: 'did:plc:drcarl',
      capability: 'appointment_status',
      params: { patient_id: 'self', visit_id: 'v1' },
    });
    expect(calls[0].ttlSeconds).toBe(120);
  });

  it('GAP-PROF-05: caller-supplied ttl_seconds wins over published defaultTtlSeconds', async () => {
    const { orchestrator, calls } = makeOrch();
    const tool = createQueryServiceTool({
      orchestrator,
      appViewClient: {
        async searchServices() {
          return [drcarlWithTtl];
        },
      },
    });
    await tool.execute({
      operator_did: 'did:plc:drcarl',
      capability: 'appointment_status',
      params: { patient_id: 'self', visit_id: 'v1' },
      ttl_seconds: 30,
    });
    expect(calls[0].ttlSeconds).toBe(30);
  });

  // -------------------------------------------------------------------
  // GAP-AUTOFILL-01 — requester-identity autofill
  // -------------------------------------------------------------------

  it('GAP-AUTOFILL-01: fills requester-identity fields with "self" when caller omits them', async () => {
    const { orchestrator, calls } = makeOrch();
    const logEntries: Array<Record<string, unknown>> = [];
    const tool = createQueryServiceTool({
      orchestrator,
      appViewClient: {
        async searchServices() {
          return [drcarlWithTtl];
        },
      },
      logger: (e) => logEntries.push(e),
    });
    await tool.execute({
      operator_did: 'did:plc:drcarl',
      capability: 'appointment_status',
      // visit_id supplied, patient_id omitted (identity slot → 'self')
      params: { visit_id: 'v1' },
    });
    expect((calls[0].params as Record<string, unknown>).patient_id).toBe('self');
    expect((calls[0].params as Record<string, unknown>).visit_id).toBe('v1');
    const entry = logEntries.find(
      (e) => e.event === 'tool_executor.query_service.requester_autofill',
    );
    expect(entry).toBeDefined();
    expect(entry!.filled).toEqual(['patient_id']);
  });

  it('GAP-AUTOFILL-01: preserves caller-supplied identity values (no overwrite)', async () => {
    const { orchestrator, calls } = makeOrch();
    const tool = createQueryServiceTool({
      orchestrator,
      appViewClient: {
        async searchServices() {
          return [drcarlWithTtl];
        },
      },
    });
    await tool.execute({
      operator_did: 'did:plc:drcarl',
      capability: 'appointment_status',
      params: { patient_id: 'did:plc:other', visit_id: 'v1' },
    });
    expect((calls[0].params as Record<string, unknown>).patient_id).toBe('did:plc:other');
  });

  it('GAP-AUTOFILL-01: no-op when AppView client absent (no paramsSchema available)', async () => {
    const { orchestrator, calls } = makeOrch();
    const tool = createQueryServiceTool({ orchestrator });
    await tool.execute({
      operator_did: 'did:plc:drcarl',
      capability: 'appointment_status',
      params: { visit_id: 'v1' },
    });
    expect((calls[0].params as Record<string, unknown>).patient_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PC-BRAIN-07 / PC-TEST-02 — find_preferred_provider tool
// ---------------------------------------------------------------------------

describe('createFindPreferredProviderTool (PC-BRAIN-07)', () => {
  function contactFixture(
    overrides: Partial<Contact> & { did: string; displayName: string },
  ): Contact {
    return {
      did: overrides.did,
      displayName: overrides.displayName,
      trustLevel: overrides.trustLevel ?? 'trusted',
      sharingTier: overrides.sharingTier ?? 'summary',
      relationship: overrides.relationship ?? 'acquaintance',
      dataResponsibility: overrides.dataResponsibility ?? 'external',
      aliases: overrides.aliases ?? [],
      notes: overrides.notes ?? '',
      createdAt: overrides.createdAt ?? 0,
      updatedAt: overrides.updatedAt ?? 0,
      preferredFor: overrides.preferredFor,
    };
  }

  function coreWith(contacts: Contact[] | Error): PreferredContactsClient {
    return {
      async findContactsByPreference(_cat) {
        if (contacts instanceof Error) throw contacts;
        return contacts;
      },
    };
  }

  it('happy path: returns providers + capabilities from AppView', async () => {
    const drcarl = contactFixture({
      did: 'did:plc:drcarl',
      displayName: "Dr Carl's Clinic",
      trustLevel: 'trusted',
      preferredFor: ['dental'],
    });
    const tool = createFindPreferredProviderTool({
      core: coreWith([drcarl]),
      appViewClient: {
        async isDiscoverable(did) {
          expect(did).toBe('did:plc:drcarl');
          return { isDiscoverable: true, capabilities: ['appointment_status'] };
        },
      },
    });
    const out = (await tool.execute({ category: 'dental' })) as FindPreferredProviderResult;
    expect(out.count).toBe(1);
    expect(out.providers).toHaveLength(1);
    expect(out.providers[0]).toEqual({
      contact_did: 'did:plc:drcarl',
      contact_name: "Dr Carl's Clinic",
      trust_level: 'trusted',
      capabilities: [{ name: 'appointment_status' }],
    });
    expect(out.message).toBeUndefined();
  });

  it('no contacts match → empty providers + fallback message (no throw)', async () => {
    const tool = createFindPreferredProviderTool({
      core: coreWith([]),
      appViewClient: {
        async isDiscoverable() {
          return { isDiscoverable: false, capabilities: [] };
        },
      },
    });
    const out = (await tool.execute({ category: 'dental' })) as FindPreferredProviderResult;
    expect(out.providers).toEqual([]);
    expect(out.count).toBeUndefined();
    expect(out.message).toMatch(/search_provider_services/);
    expect(out.message).toMatch(/"dental"/);
  });

  it('empty category → error surface (no core call, no appview call)', async () => {
    const coreCalls: string[] = [];
    const tool = createFindPreferredProviderTool({
      core: {
        async findContactsByPreference(c) {
          coreCalls.push(c);
          return [];
        },
      },
    });
    for (const bad of ['', '   ', '\t\n']) {
      const out = (await tool.execute({ category: bad })) as FindPreferredProviderResult;
      expect(out.error).toBe('category is required');
      expect(out.providers).toEqual([]);
    }
    expect(coreCalls).toEqual([]);
  });

  it('core throws → empty providers + message (fail-soft)', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const tool = createFindPreferredProviderTool({
      core: coreWith(new Error('core down')),
      logger: (e) => logs.push(e),
    });
    const out = (await tool.execute({ category: 'dental' })) as FindPreferredProviderResult;
    expect(out.providers).toEqual([]);
    expect(out.message).toMatch(/contact lookup failed: core down/);
    expect(
      logs.find((l) => l.event === 'tool_executor.find_preferred_contacts_failed'),
    ).toMatchObject({ category: 'dental', error: 'core down' });
  });

  it('no AppView client → providers returned with empty capabilities', async () => {
    const drcarl = contactFixture({
      did: 'did:plc:drcarl',
      displayName: 'Dr Carl',
      trustLevel: 'trusted',
      preferredFor: ['dental'],
    });
    const tool = createFindPreferredProviderTool({
      core: coreWith([drcarl]),
      // appViewClient intentionally omitted
    });
    const out = (await tool.execute({ category: 'dental' })) as FindPreferredProviderResult;
    expect(out.providers).toEqual([
      {
        contact_did: 'did:plc:drcarl',
        contact_name: 'Dr Carl',
        trust_level: 'trusted',
        capabilities: [],
      },
    ]);
  });

  it('AppView throws → providers returned but capabilities empty + event logged', async () => {
    const drcarl = contactFixture({
      did: 'did:plc:drcarl',
      displayName: 'Dr Carl',
      trustLevel: 'trusted',
      preferredFor: ['dental'],
    });
    const logs: Array<Record<string, unknown>> = [];
    const tool = createFindPreferredProviderTool({
      core: coreWith([drcarl]),
      appViewClient: {
        async isDiscoverable() {
          throw new Error('AppView 500');
        },
      },
      logger: (e) => logs.push(e),
    });
    const out = (await tool.execute({ category: 'dental' })) as FindPreferredProviderResult;
    expect(out.providers).toHaveLength(1);
    expect(out.providers[0].capabilities).toEqual([]);
    expect(
      logs.find((l) => l.event === 'tool_executor.find_preferred_appview_failed'),
    ).toMatchObject({ did: 'did:plc:drcarl', error: 'AppView 500' });
  });

  it('multiple contacts + multi-capability provider', async () => {
    const cpa = contactFixture({
      did: 'did:plc:cpa',
      displayName: 'Linda CPA',
      trustLevel: 'trusted',
      preferredFor: ['tax', 'accounting'],
    });
    const jr = contactFixture({
      did: 'did:plc:jr',
      displayName: 'Junior Accountant',
      trustLevel: 'unknown',
      preferredFor: ['tax'],
    });
    const tool = createFindPreferredProviderTool({
      core: coreWith([cpa, jr]),
      appViewClient: {
        async isDiscoverable(did) {
          if (did === 'did:plc:cpa') {
            return { isDiscoverable: true, capabilities: ['tax_prep', 'financial_review'] };
          }
          return { isDiscoverable: true, capabilities: [] };
        },
      },
    });
    const out = (await tool.execute({ category: 'tax' })) as FindPreferredProviderResult;
    expect(out.count).toBe(2);
    expect(out.providers[0]).toMatchObject({
      contact_did: 'did:plc:cpa',
      capabilities: [{ name: 'tax_prep' }, { name: 'financial_review' }],
    });
    expect(out.providers[1]).toMatchObject({
      contact_did: 'did:plc:jr',
      trust_level: 'unknown',
      capabilities: [],
    });
  });

  it('trims the category before passing to core', async () => {
    const seen: string[] = [];
    const tool = createFindPreferredProviderTool({
      core: {
        async findContactsByPreference(c) {
          seen.push(c);
          return [];
        },
      },
    });
    await tool.execute({ category: '  dental  ' });
    expect(seen).toEqual(['dental']);
  });

  it('description mentions "find_preferred_provider" hook + fall-back guidance', () => {
    const tool = createFindPreferredProviderTool({
      core: coreWith([]),
    });
    // Spot-check the contract the system prompt relies on (PC-BRAIN-08
    // system prompt still to land, but the tool description itself
    // carries the usage guidance for tool-channel LLMs).
    expect(tool.description).toMatch(/established service relationship/i);
    expect(tool.description).toMatch(/my dentist|my lawyer|my accountant/);
    expect(tool.description).toMatch(/search_provider_services/);
  });

  it('drops non-string / empty-string capability names', async () => {
    const drcarl = contactFixture({
      did: 'did:plc:drcarl',
      displayName: 'Dr Carl',
      preferredFor: ['dental'],
    });
    const tool = createFindPreferredProviderTool({
      core: coreWith([drcarl]),
      appViewClient: {
        async isDiscoverable() {
          return {
            isDiscoverable: true,
            // Pathological input: empties + non-strings would leak
            // into the LLM's tool output if we didn't filter.
            capabilities: ['appointment_status', '', 42 as unknown as string, 'billing'],
          };
        },
      },
    });
    const out = (await tool.execute({ category: 'dental' })) as FindPreferredProviderResult;
    expect(out.providers[0].capabilities.map((c) => c.name)).toEqual([
      'appointment_status',
      'billing',
    ]);
  });
});
